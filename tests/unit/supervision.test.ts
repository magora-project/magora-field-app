/**
 * @jest-environment node
 */
// Process supervision in the stack scripts (plan Task 4). Each test starts only
// its own `sleep <marker>` processes, with a random marker, and kills whatever
// is left of them by PID afterwards. Needs bash, node, ps and pgrep; no stack.
import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = path.resolve(__dirname, '..', '..');
const BOUNDED = path.join(root, 'scripts/lib/bounded.mjs');
const SPAWN_DAEMON = path.join(root, 'scripts/lib/spawn-daemon.mjs');
const STACK_BODY = path.join(root, 'scripts/lib/stack-body.sh');

jest.setTimeout(40_000);

const newMarker = () => String(700000 + Math.floor(Math.random() * 200000));

/** PIDs of running `sleep <marker>` processes. */
function sleepers(marker: string): number[] {
  const r = spawnSync('pgrep', ['-f', `^sleep ${marker}$`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().split('\n').map(Number) : [];
}

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
