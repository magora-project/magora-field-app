#!/usr/bin/env bash
# Starts the local stack for a session (spec §4.2, plan Task 4). The SessionStart
# hook in .claude/settings.json runs it at every Claude Code session start,
# resumes included, local sessions included.
#
# It does the full start only in a Claude Code cloud session (CLAUDE_CODE_REMOTE
# is "true"), in CI (CI is "true"), or when asked (FIELD_STACK=1). Anywhere else
# it prints STACK SKIPPED and exits 0, so a local session never starts Docker.
#
# The full start is scripts/lib/stack-body.sh (its header lists the steps). It
# prints one result line: STACK READY, or STACK FAILED: <step>. This script
# always exits 0, so a failure leaves the session usable for work that needs no
# database. Step output goes to .stack/session-start.log.
#
# Time bound: the hook's timeout is 600 s. The body runs under
# scripts/lib/bounded.mjs with a DEADLINE_SECS limit, in its own process group.
# Inside it, each step that can block runs under its own bounded.mjs and limit.
# At the deadline bounded.mjs sends the body's group SIGTERM, then SIGKILL after
# a 5 s grace (a step's own bounded.mjs stops that step's group within 3 s of the
# SIGTERM), and exits 124; this script then prints
# STACK FAILED: <step from .stack/step> (deadline). Background services are
# started in their own sessions, so they survive it. Needs Node (22), no GNU
# `timeout` (macOS, Linux).

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ] && [ "${CI:-}" != "true" ] && [ "${FIELD_STACK:-}" != "1" ]; then
  echo "STACK SKIPPED: not a cloud session (FIELD_STACK=1 starts it locally)"
  exit 0
fi

set -uo pipefail

DEADLINE_SECS=540          # body limit; with the grace, well under the hook's 600 s
# STACK_DEADLINE_SECS may only LOWER the deadline (used to test the time bound).
if [ -n "${STACK_DEADLINE_SECS:-}" ] && [ "${STACK_DEADLINE_SECS}" -ge 10 ] 2>/dev/null \
   && [ "${STACK_DEADLINE_SECS}" -lt "${DEADLINE_SECS}" ]; then
  DEADLINE_SECS="${STACK_DEADLINE_SECS}"
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${root}" || { echo "STACK FAILED: cd to repo root"; exit 0; }
command -v node > /dev/null 2>&1 || { echo "STACK FAILED: node (not installed)"; exit 0; }

STATE="${root}/.stack"
mkdir -p "${STATE}" || { echo "STACK FAILED: create .stack"; exit 0; }
LOG="${STATE}/session-start.log"
: > "${LOG}"
printf 'start\n' > "${STATE}/step"

node "${root}/scripts/lib/bounded.mjs" "${DEADLINE_SECS}" -- \
  bash "${root}/scripts/lib/stack-body.sh" < /dev/null 2>> "${LOG}"
rc=$?

# The body prints its own result line and exits 0. Otherwise it was stopped
# before it could: report the step it was on.
if [ "${rc}" -ne 0 ]; then
  step="$(sed -n 1p "${STATE}/step" 2>/dev/null)"
  if [ "${rc}" -eq 124 ]; then
    printf '[deadline] stopped at %ss during: %s\n' "${DEADLINE_SECS}" "${step}" >> "${LOG}"
    echo "STACK FAILED: ${step:-unknown step} (deadline)"
  else
    printf '[exit %s] body ended during: %s\n' "${rc}" "${step}" >> "${LOG}"
    echo "STACK FAILED: ${step:-unknown step} (exit ${rc})"
  fi
fi
exit 0
