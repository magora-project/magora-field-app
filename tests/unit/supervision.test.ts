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

// A leader that exits on SIGTERM, with a child that ignores SIGTERM.
const treeScript = (marker: string, leaderTail: string) =>
  `(trap '' TERM; exec sleep ${marker}) & ${leaderTail}`;

describe('bounded.mjs', () => {
  test('kills a TERM-ignoring descendant after its leader exits on TERM', () => {
    const marker = newMarker();
    try {
      const t0 = Date.now();
      const r = spawnSync('node', [BOUNDED, '1', '--', 'bash', '-c', treeScript(marker, 'sleep 1000')], {
        // No pipes: a surviving descendant would hold them open and hang
        // spawnSync. The timeout makes a regression fail instead of hang.
        stdio: 'ignore',
        timeout: 20_000,
        env: { ...process.env, BOUNDED_DEPTH: '' },
      });
      const secs = (Date.now() - t0) / 1000;
      expect(r.status).toBe(124);
      // 1 s limit + 5 s grace + reap wait, with slack; never unbounded.
      expect(secs).toBeLessThan(12);
      expect(sleepersAfter(marker)).toEqual([]);
    } finally {
      killSleepers(marker);
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

  test('signals nothing, and keeps the record, when the member list cannot be saved', () => {
    const marker = newMarker();
    let leader = 0;
    try {
      startRecorded(marker);
      leader = Number(fs.readFileSync(path.join(dir, 'svc.pid'), 'utf8').split('\n')[0]);
      fs.chmodSync(dir, 0o555); // .members.tmp cannot be created
      const r = stopRecorded(marker);
      fs.chmodSync(dir, 0o755);
      expect(r.status).toBe(0);
      expect(isAlive(leader)).toBe(true);
      expect(sleepers(marker)).toHaveLength(1);
      expect(fs.existsSync(path.join(dir, 'svc.pid'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'svc.members'))).toBe(false);
    } finally {
      fs.chmodSync(dir, 0o755);
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
