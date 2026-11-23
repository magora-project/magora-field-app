#!/usr/bin/env node
// Usage: node scripts/lib/spawn-daemon.mjs <pidfile> <logfile> -- <cmd> [args...]
//
// Starts a background service for scripts/cloud-session-start.sh (plan Task 4).
// Node 22, no dependencies.
//
// <cmd> is spawned with `detached: true` (a new session, so a new process group),
// stdin from /dev/null, stdout and stderr appended to <logfile>. So a group kill
// aimed at the session script's steps (bounded.mjs) never reaches it, and it
// holds none of the script's output pipes. Its environment is this process's.
//
// <pidfile> gets two lines: the PID, then the process start time as
// `LC_ALL=C ps -o lstart=` prints it, spaces squeezed. The start time is read
// while the child is still this process's unreaped child, so the PID cannot
// have been reused. The file is written to <pidfile>.tmp and renamed.
//
// Exits 0 once the PID file is written. Exits non-zero, with no PID file, if
// the command could not be started, its start time could not be read, or the
// PID file could not be written; in the last two cases the started command's
// process group is SIGKILLed first, so nothing is left running unrecorded.

import { spawn, execFileSync } from 'node:child_process';
import { closeSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
if (argv[2] !== '--' || argv.length < 4) {
  process.stderr.write('usage: node scripts/lib/spawn-daemon.mjs <pidfile> <logfile> -- <cmd> [args...]\n');
  process.exit(2);
}
const [pidfile, logfile] = argv;
const [cmd, ...args] = argv.slice(3);
const say = (msg) => process.stderr.write(`spawn-daemon.mjs: ${msg}\n`);

const out = openSync(logfile, 'w');
const child = spawn(cmd, args, { detached: true, stdio: ['ignore', out, out] });
closeSync(out);

child.on('error', (err) => {
  say(`cannot run ${cmd}: ${err.message}`);
  process.exit(127);
});

if (child.pid !== undefined) {
  // execFileSync blocks this event loop, so the child cannot be reaped (and its
  // PID freed) until the start time has been read.
  let started = '';
  try {
    started = execFileSync('ps', ['-o', 'lstart=', '-p', String(child.pid)], {
      env: { ...process.env, LC_ALL: 'C' },
      encoding: 'utf8',
    })
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    started = '';
  }
  // Unrecorded, nothing could stop it later: stop it now, while its leader is
  // still this process's unreaped child (so its PID, which is also its process
  // group ID, cannot have been reused).
  const stopUnrecorded = (why) => {
    say(`${why}; stopping ${cmd} (process group ${child.pid})`);
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      // already gone
    }
    process.exit(1);
  };
  if (started === '') stopUnrecorded(`no start time for PID ${child.pid}`);
  try {
    writeFileSync(`${pidfile}.tmp`, `${child.pid}\n${started}\n`);
    renameSync(`${pidfile}.tmp`, pidfile);
  } catch (err) {
    try {
      rmSync(`${pidfile}.tmp`, { force: true });
    } catch {
      // best effort
    }
    stopUnrecorded(`cannot write ${pidfile}: ${err.message}`);
  }
  child.unref();
  process.exit(0);
}
