/**
 * @jest-environment node
 */
// Process supervision in the stack scripts (plan Task 4). Each test starts only
// its own `sleep <marker>` processes, with a random marker, and kills whatever
// is left of them by PID afterwards. Needs bash, node, ps and pgrep; no stack.
import { execFileSync, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = path.resolve(__dirname, '..', '..');
const BOUNDED = path.join(root, 'scripts/lib/bounded.mjs');
const SPAWN_DAEMON = path.join(root, 'scripts/lib/spawn-daemon.mjs');
const STACK_BODY = path.join(root, 'scripts/lib/stack-body.sh');

jest.setTimeout(40_000);

const newMarker = () => String(700000 + Math.floor(Math.random() * 200000));

/** PIDs of running `sleep <marker>` processes. Throws if pgrep itself fails, so
 * a broken probe never reads as "no process left". */
function sleepers(marker: string): number[] {
  const r = spawnSync('pgrep', ['-f', `^sleep ${marker}$`], { encoding: 'utf8' });
  if (r.status === 0) return r.stdout.trim().split('\n').map(Number);
  if (r.status === 1) return [];
  throw new Error(`pgrep failed (status ${r.status}): ${r.stderr || r.error}`);
}

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Polls briefly, since an orphan killed just now may not be reaped yet. */
function sleepersAfter(marker: string, ms = 1500): number[] {
  const end = Date.now() + ms;
  let found = sleepers(marker);
  while (found.length && Date.now() < end) {
    execFileSync('sleep', ['0.1']);
    found = sleepers(marker);
  }
  return found;
}

function killSleepers(marker: string) {
  for (const pid of sleepers(marker)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** A directory holding a `ps` wrapper, to put first on PATH. With
 * PS_FAIL=<text>, a `ps` call whose arguments contain <text> prints nothing and
 * exits 1; with PS_SLOW=<text>, it first sleeps 0.5 s (under spawn-daemon's
 * 800 ms `ps` timeout); with PS_SHIFT=<text>, its
 * output has each line's trailing year replaced by 1999 (a different start
 * time). Other calls run the real ps. */
function psShim(dir: string): string {
  const realPs = execFileSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).trim();
  const bin = path.join(dir, 'shim-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'ps'),
    [
      '#!/bin/sh',
      'case "$*" in',
      `  *"\${PS_FAIL:-@none@}"*) exit 1 ;;`,
      `  *"\${PS_SLOW:-@none@}"*) sleep 0.5 ;;`,
      `  *"\${PS_SHIFT:-@none@}"*) '${realPs}' "$@" | sed 's/[0-9][0-9][0-9][0-9]\\( *\\)$/1999\\1/'; exit 0 ;;`,
      'esac',
      `exec '${realPs}' "$@"`,
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return bin;
}

// A leader that exits on SIGTERM, with a child that ignores SIGTERM. The
// `sleep <marker>` process exists only after the trap is set, since it is
// exec'd from the trapped subshell.
const treeScript = (marker: string, leaderTail: string) =>
  `(trap '' TERM; exec sleep ${marker}) & ${leaderTail}`;

describe('bounded.mjs', () => {
  test('kills a TERM-ignoring descendant after its leader exits on TERM', () => {
    const marker = newMarker();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervision-'));
    const armed = path.join(dir, 'armed');
    try {
      // The leader writes `armed` only once the child is `sleep <marker>`, so
      // TERM-ignoring, and only then waits. Without `armed`, the deadline's
      // TERM may have come first and the test would prove nothing.
      const leaderTail =
        `while ! pgrep -f '^sleep ${marker}$' > /dev/null; do sleep 0.05; done; ` +
        `: > '${armed}'; sleep 1000`;
      const t0 = Date.now();
      const r = spawnSync('node', [BOUNDED, '2', '--', 'bash', '-c', treeScript(marker, leaderTail)], {
        // No pipes: a surviving descendant would hold them open and hang
        // spawnSync. The timeout makes a regression fail instead of hang.
        stdio: 'ignore',
        timeout: 20_000,
        env: { ...process.env, BOUNDED_DEPTH: '' },
      });
      const secs = (Date.now() - t0) / 1000;
      expect(fs.existsSync(armed)).toBe(true);
      expect(r.status).toBe(124);
      // 2 s limit + 5 s grace + reap wait, with slack; never unbounded.
      expect(secs).toBeLessThan(13);
      expect(sleepersAfter(marker)).toEqual([]);
    } finally {
      killSleepers(marker);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('stop_recorded (stack-body.sh)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervision-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function startRecorded(marker: string) {
    execFileSync('node', [
      SPAWN_DAEMON,
      path.join(dir, 'svc.pid'),
      path.join(dir, 'svc.log'),
      '--',
      'bash',
      '-c',
      treeScript(marker, 'wait'),
    ]);
    const end = Date.now() + 3000;
    while (!sleepers(marker).length && Date.now() < end) execFileSync('sleep', ['0.1']);
    expect(sleepers(marker)).toHaveLength(1);
  }

  const stopRecorded = (marker: string) =>
    spawnSync('bash', [STACK_BODY, '--fn', 'stop_recorded', 'svc', `sleep ${marker}`], {
      stdio: 'ignore',
      timeout: 30_000,
      env: { ...process.env, STACK_STATE_DIR: dir },
    });

  test('kills a TERM-ignoring group member after the leader exits on TERM', () => {
    const marker = newMarker();
    try {
      startRecorded(marker);
      const r = stopRecorded(marker);
      expect(r.status).toBe(0);
      expect(sleepersAfter(marker)).toEqual([]);
      expect(fs.existsSync(path.join(dir, 'svc.pid'))).toBe(false);
    } finally {
      killSleepers(marker);
    }
  });

  test('never signals a recorded PID whose start time differs', () => {
    const marker = newMarker();
    let leader = 0;
    try {
      startRecorded(marker);
      const pidfile = path.join(dir, 'svc.pid');
      leader = Number(fs.readFileSync(pidfile, 'utf8').split('\n')[0]);
      fs.writeFileSync(pidfile, `${leader}\nThu Jan  1 00:00:00 1970\n`);
      stopRecorded(marker);
      expect(sleepers(marker)).toHaveLength(1);
      expect(() => process.kill(leader, 0)).not.toThrow();
    } finally {
      // The daemon this test started leads its own group: kill that group.
      if (leader) {
        try {
          process.kill(-leader, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      killSleepers(marker);
    }
  });

  test('reports, and never signals, the group of a leader that is already gone', () => {
    const marker = newMarker();
    try {
      // The leader exits after 1 s; its TERM-ignoring child stays in the group.
      execFileSync('node', [
        SPAWN_DAEMON,
        path.join(dir, 'svc.pid'),
        path.join(dir, 'svc.log'),
        '--',
        'bash',
        '-c',
        treeScript(marker, 'sleep 1'),
      ]);
      const leader = Number(fs.readFileSync(path.join(dir, 'svc.pid'), 'utf8').split('\n')[0]);
      const end = Date.now() + 5000;
      const alive = () => {
        try {
          process.kill(leader, 0);
          return true;
        } catch {
          return false;
        }
      };
      while (alive() && Date.now() < end) execFileSync('sleep', ['0.1']);
      expect(alive()).toBe(false);
      const [child] = sleepers(marker);
      expect(child).toBeGreaterThan(0);

      const r = stopRecorded(marker);
      expect(r.status).toBe(0);
      expect(sleepers(marker)).toEqual([child]);
      const log = fs.readFileSync(path.join(dir, 'session-start.log'), 'utf8');
      expect(log).toContain(`process group ${leader} still has PIDs ${child}; not signalled`);
      expect(fs.existsSync(path.join(dir, 'svc.pid'))).toBe(false);
    } finally {
      killSleepers(marker);
    }
  });

  test('a stop interrupted during its grace is finished by the next run', async () => {
    const marker = newMarker();
    try {
      startRecorded(marker);
      const [child] = sleepers(marker);
      const log = path.join(dir, 'session-start.log');
      // Interrupt the stop inside its 10 s grace, after the SIGTERM.
      const first = spawn('bash', [STACK_BODY, '--fn', 'stop_recorded', 'svc', `sleep ${marker}`], {
        stdio: 'ignore',
        env: { ...process.env, STACK_STATE_DIR: dir },
      });
      const exited = new Promise((resolve) => first.on('exit', resolve));
      const leader = Number(fs.readFileSync(path.join(dir, 'svc.pid'), 'utf8').split('\n')[0]);
      const end = Date.now() + 5000;
      while (!(fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('stopping svc')) && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 100));
      }
      // The leader exits on SIGTERM: once it is gone, TERM has been sent and the
      // stop is inside its grace.
      while (isAlive(leader) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      expect(isAlive(leader)).toBe(false);
      first.kill('SIGKILL');
      await exited;

      // The record survives the interruption, and the child is still running.
      expect(sleepers(marker)).toEqual([child]);
      expect(fs.existsSync(path.join(dir, 'svc.pid'))).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'svc.members'), 'utf8')).toContain(`${child} `);

      const r = stopRecorded(marker);
      expect(r.status).toBe(0);
      expect(sleepersAfter(marker)).toEqual([]);
      expect(fs.existsSync(path.join(dir, 'svc.pid'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'svc.members'))).toBe(false);
    } finally {
      killSleepers(marker);
    }
  });

  test('keeps an interrupted stop\'s records, and fails, when a member cannot be identified', async () => {
    const marker = newMarker();
    try {
      startRecorded(marker);
      const [child] = sleepers(marker);
      const log = path.join(dir, 'session-start.log');
      // As above: interrupt the stop after TERM, leaving the TERM-ignoring child.
      const first = spawn('bash', [STACK_BODY, '--fn', 'stop_recorded', 'svc', `sleep ${marker}`], {
        stdio: 'ignore',
        env: { ...process.env, STACK_STATE_DIR: dir },
      });
      const exited = new Promise((resolve) => first.on('exit', resolve));
      const leader = Number(fs.readFileSync(path.join(dir, 'svc.pid'), 'utf8').split('\n')[0]);
      const end = Date.now() + 5000;
      while (!(fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('stopping svc')) && Date.now() < end) {
        await new Promise((r) => setTimeout(r, 100));
      }
      while (isAlive(leader) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
      expect(isAlive(leader)).toBe(false);
      first.kill('SIGKILL');
      await exited;
      expect(sleepers(marker)).toEqual([child]);

      // The next run cannot read start times: the child is alive but unidentified.
      const bin = psShim(dir);
      const r = spawnSync('bash', [STACK_BODY, '--fn', 'stop_recorded', 'svc', `sleep ${marker}`], {
        stdio: 'ignore',
        timeout: 30_000,
        env: { ...process.env, STACK_STATE_DIR: dir, PATH: `${bin}:${process.env.PATH}`, PS_FAIL: 'lstart=' },
      });
      expect(r.status).toBe(1);
      expect(sleepers(marker)).toEqual([child]);
      expect(fs.existsSync(path.join(dir, 'svc.members'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'svc.pid'))).toBe(true);
    } finally {
      killSleepers(marker);
    }
  });

  test('signals nothing, and keeps the record, when the member list cannot be saved', () => {
    const marker = newMarker();
    let leader = 0;
    try {
      startRecorded(marker);
      leader = Number(fs.readFileSync(path.join(dir, 'svc.pid'), 'utf8').split('\n')[0]);
      // A directory where the temporary list goes: the write fails for any
      // user, root included (permission bits would not stop root).
      fs.mkdirSync(path.join(dir, 'svc.members.tmp'));
      const r = stopRecorded(marker);
      expect(r.status).toBe(1);
      expect(isAlive(leader)).toBe(true);
      expect(sleepers(marker)).toHaveLength(1);
      expect(fs.existsSync(path.join(dir, 'svc.pid'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'svc.members'))).toBe(false);
    } finally {
      if (leader) {
        try {
          process.kill(-leader, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      killSleepers(marker);
    }
  });

  const killGroup = (leader: number) => {
    if (!leader) return;
    try {
      process.kill(-leader, 'SIGKILL');
    } catch {
      // already gone
    }
  };

  test.each([
    ['start time', 'lstart='],
    ['command', 'command='],
  ])('signals nothing, and keeps the record, when a live process\'s %s cannot be read', (_what, psArg) => {
    const marker = newMarker();
    let leader = 0;
    try {
      startRecorded(marker);
      leader = Number(fs.readFileSync(path.join(dir, 'svc.pid'), 'utf8').split('\n')[0]);
      const bin = psShim(dir);
      const r = spawnSync('bash', [STACK_BODY, '--fn', 'stop_recorded', 'svc', `sleep ${marker}`], {
        stdio: 'ignore',
        timeout: 30_000,
        env: { ...process.env, STACK_STATE_DIR: dir, PATH: `${bin}:${process.env.PATH}`, PS_FAIL: psArg },
      });
      expect(r.status).toBe(1);
      expect(isAlive(leader)).toBe(true);
      expect(sleepers(marker)).toHaveLength(1);
      expect(fs.existsSync(path.join(dir, 'svc.pid'))).toBe(true);
    } finally {
      killGroup(leader);
      killSleepers(marker);
    }
  });

  test('signals nothing when the member snapshot does not show the recorded leader', () => {
    const marker = newMarker();
    let leader = 0;
    try {
      startRecorded(marker);
      leader = Number(fs.readFileSync(path.join(dir, 'svc.pid'), 'utf8').split('\n')[0]);
      // Only the group read (`-A ... lstart=`) is altered: the identity check
      // before it passes, as when the group empties and its ID is reused
      // between that check and the read.
      const bin = psShim(dir);
      const r = spawnSync('bash', [STACK_BODY, '--fn', 'stop_recorded', 'svc', `sleep ${marker}`], {
        stdio: 'ignore',
        timeout: 30_000,
        env: {
          ...process.env,
          STACK_STATE_DIR: dir,
          PATH: `${bin}:${process.env.PATH}`,
          PS_SHIFT: 'pid=,pgid=,lstart=',
        },
      });
      expect(r.status).toBe(1);
      expect(isAlive(leader)).toBe(true);
      expect(sleepers(marker)).toHaveLength(1);
      expect(fs.existsSync(path.join(dir, 'svc.pid'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'svc.members'))).toBe(false);
    } finally {
      killGroup(leader);
      killSleepers(marker);
    }
  });

  test('keeps the record, and fails, when the group survives SIGKILL', () => {
    const marker = newMarker();
    let leader = 0;
    try {
      // A leader that ignores TERM, and a `kill` that cannot SIGKILL (a bash
      // function overrides the builtin), so the group outlives the stop.
      execFileSync('node', [
        SPAWN_DAEMON,
        path.join(dir, 'svc.pid'),
        path.join(dir, 'svc.log'),
        '--',
        'bash',
        '-c',
        `trap '' TERM; (exec sleep ${marker}) & wait`,
      ]);
      const end = Date.now() + 3000;
      while (!sleepers(marker).length && Date.now() < end) execFileSync('sleep', ['0.1']);
      leader = Number(fs.readFileSync(path.join(dir, 'svc.pid'), 'utf8').split('\n')[0]);
      const r = spawnSync('bash', [STACK_BODY, '--fn', 'stop_recorded', 'svc', `sleep ${marker}`], {
        stdio: 'ignore',
        timeout: 30_000,
        env: {
          ...process.env,
          STACK_STATE_DIR: dir,
          'BASH_FUNC_kill%%': '() { [ "$1" = -KILL ] && return 0; builtin kill "$@"; }',
        },
      });
      expect(r.status).toBe(1);
      expect(isAlive(leader)).toBe(true);
      expect(fs.existsSync(path.join(dir, 'svc.pid'))).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'session-start.log'), 'utf8')).toContain('still present after SIGKILL');
    } finally {
      killGroup(leader);
      killSleepers(marker);
    }
  });

  test('ends startup, before starting anything, when a previous service cannot be stopped', () => {
    const marker = newMarker();
    let leader = 0;
    try {
      // A recorded `functions serve`: its command line carries the fragment.
      execFileSync('node', [
        SPAWN_DAEMON,
        path.join(dir, 'functions.pid'),
        path.join(dir, 'functions.log'),
        '--',
        'bash',
        '-c',
        treeScript(marker, 'wait'),
        'functions',
        'serve',
      ]);
      const end = Date.now() + 3000;
      while (!sleepers(marker).length && Date.now() < end) execFileSync('sleep', ['0.1']);
      expect(sleepers(marker)).toHaveLength(1);
      leader = Number(fs.readFileSync(path.join(dir, 'functions.pid'), 'utf8').split('\n')[0]);
      const record = fs.readFileSync(path.join(dir, 'functions.pid'), 'utf8');

      // A directory where the temporary list goes, so saving it fails for any user.
      fs.mkdirSync(path.join(dir, 'functions.members.tmp'));
      const r = spawnSync('bash', [STACK_BODY, '--fn', 'stop_previous'], {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, STACK_STATE_DIR: dir },
      });

      // fail() reports and exits: nothing after step 1 runs.
      expect(r.stdout).toContain('STACK FAILED: stop the previous functions serve');
      expect(isAlive(leader)).toBe(true);
      expect(sleepers(marker)).toHaveLength(1);
      expect(fs.readFileSync(path.join(dir, 'functions.pid'), 'utf8')).toBe(record);
    } finally {
      if (leader) {
        try {
          process.kill(-leader, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      killSleepers(marker);
    }
  });
});

describe('spawn-daemon.mjs', () => {
  test('a TERM while starting is held until the service is recorded', async () => {
    const marker = newMarker();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervision-'));
    const pidfile = path.join(dir, 'svc.pid');
    let leader = 0;
    try {
      // A slow start-time read keeps spawn-daemon between the spawn and the
      // record for 0.5 s; the TERM lands inside that window.
      const bin = psShim(dir);
      const daemon = spawn('node', [SPAWN_DAEMON, pidfile, path.join(dir, 'svc.log'), '--', 'sleep', marker], {
        stdio: 'ignore',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PS_SLOW: 'lstart=' },
      });
      const exited = new Promise<number | null>((resolve) => daemon.on('exit', (code) => resolve(code)));
      const end = Date.now() + 3000;
      while (!sleepers(marker).length && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      expect(sleepers(marker)).toHaveLength(1);
      expect(fs.existsSync(pidfile)).toBe(false);
      daemon.kill('SIGTERM');
      expect(await exited).toBe(143);

      const [pid] = fs.readFileSync(pidfile, 'utf8').split('\n');
      leader = Number(pid);
      expect(sleepers(marker)).toEqual([leader]);
    } finally {
      if (leader) {
        try {
          process.kill(-leader, 'SIGKILL');
        } catch {
          // already gone
        }
      }
      killSleepers(marker);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('stops the service when its PID file cannot be written', () => {
    const marker = newMarker();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'supervision-'));
    try {
      // The PID file's directory does not exist, so the write fails after the
      // service has started.
      const r = spawnSync(
        'node',
        [SPAWN_DAEMON, path.join(dir, 'missing', 'svc.pid'), path.join(dir, 'svc.log'), '--', 'sleep', marker],
        { stdio: 'ignore', timeout: 20_000 },
      );
      expect(r.status).toBe(1);
      expect(sleepersAfter(marker)).toEqual([]);
      expect(fs.existsSync(path.join(dir, 'missing'))).toBe(false);
    } finally {
      killSleepers(marker);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
