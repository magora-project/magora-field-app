#!/usr/bin/env node
// Usage: node scripts/lib/bounded.mjs <seconds> -- <cmd> [args...]
//
// Runs <cmd> with a time limit, for scripts/cloud-session-start.sh (plan Task 4).
// Node 22, no dependencies. Replaces GNU `timeout`, which macOS lacks.
//
// - <cmd> is spawned with `detached: true`, so it leads a new process group, and
//   inherits stdin, stdout and stderr. This script writes nothing to stdout; its
//   own messages go to stderr.
// - On the limit: SIGTERM to the whole group, a grace period, then SIGKILL to the
//   whole group. Exit status 124.
// - On SIGTERM or SIGINT to this script: the same TERM, grace, KILL sequence for
//   the group, then exit 128 + the signal number. So killing this script does
//   not orphan the command's tree.
// - Otherwise: the command's exit status (128 + signal number if a signal ended it;
//   127 if it could not be started).
//
// The group is signalled only while the command has not been reaped. Node reaps
// the child and sets child.exitCode / child.signalCode (then emits 'exit') in
// one synchronous step, so while both are null the child exists, at least as a
// zombie, and its PID, which is the group ID, cannot have been reused. After the
// leader exits, the group is never signalled again: a group member that outlives
// the leader and ignores SIGTERM is left running. That is the cost of never
// signalling an ID the kernel may have reused.
//
// Grace: 5 s for a top-level instance; 3 s for an instance running under another
// bounded.mjs (BOUNDED_DEPTH, set for the child below). A nested instance in the
// outer group gets the outer TERM, and must finish its own TERM, grace, KILL
// before the outer instance's KILL lands on it, or its group would be orphaned.

import { spawn } from 'node:child_process';
import { constants } from 'node:os';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const seconds = Number(argv[0]);
if (sep !== 1 || !Number.isFinite(seconds) || seconds <= 0 || argv.length < 3) {
  process.stderr.write('usage: node scripts/lib/bounded.mjs <seconds> -- <cmd> [args...]\n');
  process.exit(2);
}
const [cmd, ...args] = argv.slice(sep + 1);

const depth = Number.parseInt(process.env.BOUNDED_DEPTH ?? '0', 10) || 0;
const GRACE_MS = Math.max(1000, 5000 - 2000 * depth);
const REAP_WAIT_MS = 2000; // after SIGKILL: how long to wait for the leader's exit

const say = (msg) => process.stderr.write(`bounded.mjs: ${msg}\n`);

const child = spawn(cmd, args, {
  detached: true,
  stdio: 'inherit',
  env: { ...process.env, BOUNDED_DEPTH: String(depth + 1) },
});

const unreaped = () => child.exitCode === null && child.signalCode === null;

// Signals the child's group, only while the child is unreaped (see above).
function signalGroup(sig) {
  if (!unreaped() || child.pid === undefined) return;
  try {
    process.kill(-child.pid, sig);
  } catch (err) {
    if (err.code !== 'ESRCH') say(`kill(-${child.pid}, ${sig}): ${err.message}`);
  }
}

let stopping = null; // exit status to use once the stop sequence ends
let limitTimer = null;

function finish(status) {
  clearTimeout(limitTimer);
  process.exit(status);
}

// TERM the group; KILL it after the grace unless the leader has exited; then
// exit with <status>, waiting at most REAP_WAIT_MS for the leader after KILL.
function stop(status, why) {
  if (stopping !== null) return;
  stopping = status;
  clearTimeout(limitTimer);
  say(`${why}: SIGTERM to process group ${child.pid}`);
  signalGroup('SIGTERM');
  setTimeout(() => {
    if (!unreaped()) return; // the 'exit' handler has already finished
    say(`process group ${child.pid} outlived the ${GRACE_MS / 1000} s grace: SIGKILL`);
    signalGroup('SIGKILL');
    setTimeout(() => {
      say(`process ${child.pid} not reaped ${REAP_WAIT_MS / 1000} s after SIGKILL; exiting without it`);
      finish(status);
    }, REAP_WAIT_MS);
  }, GRACE_MS);
}

child.on('error', (err) => {
  // Spawn failed (ENOENT, EACCES): there is no process to signal.
  if (child.pid === undefined) {
    say(`cannot run ${cmd}: ${err.message}`);
    finish(127);
  }
});

child.on('exit', (code, signal) => {
  if (stopping !== null) finish(stopping);
  else if (code !== null) finish(code);
  else finish(128 + (constants.signals[signal] ?? 0));
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => stop(128 + constants.signals[sig], `received ${sig}`));
}

limitTimer = setTimeout(() => stop(124, `time limit ${seconds} s reached`), seconds * 1000);
