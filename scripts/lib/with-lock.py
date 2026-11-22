#!/usr/bin/env python3
"""Usage: python3 scripts/lib/with-lock.py <lockfile> -- <cmd> [args...]

Runs <cmd> while holding an exclusive, non-blocking flock on <lockfile>, for
scripts/cloud-session-start.sh (plan Task 4). If another process holds the lock,
it runs nothing and exits 75 (EX_TEMPFAIL). Otherwise it exits with <cmd>'s
status (128 + signal number if a signal ended it).

The kernel releases a flock when its holder exits, however it exits (SIGKILL
included), so the lock can never go stale. The lock file itself is left in place
and is never deleted: deleting it would let a second process lock a new file at
the same path while the first still holds the old one.
"""
import fcntl
import os
import signal
import subprocess
import sys

EX_TEMPFAIL = 75


def main() -> int:
    argv = sys.argv[1:]
    if len(argv) < 3 or argv[1] != "--":
        sys.stderr.write("usage: with-lock.py <lockfile> -- <cmd> [args...]\n")
        return 2
    path, cmd = argv[0], argv[2:]
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return EX_TEMPFAIL
    # Forward TERM and INT to the command, so stopping this wrapper stops it.
    proc = subprocess.Popen(cmd)
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda s, _f: proc.send_signal(s))
    rc = proc.wait()
    return 128 - rc if rc < 0 else rc


if __name__ == "__main__":
    sys.exit(main())
