#!/usr/bin/env bash
# shellcheck disable=SC2329  # the step functions are called through --fn
# The stack start itself (spec §4.2, plan Task 4). scripts/cloud-session-start.sh
# runs it under scripts/lib/bounded.mjs, which owns the overall deadline; read
# that script's header first.
#
#   bash scripts/lib/stack-body.sh               the full start
#   bash scripts/lib/stack-body.sh --fn <f> ...  runs one function below (used
#                                                for steps run under bounded.mjs)
#
# The full start:
#   1. stops the background processes a previous run recorded, only when the
#      recorded PID still has the recorded start time and command;
#   2. starts Docker if it is not running, then `supabase stop --no-backup` (a
#      no-op when the stack is down) and `supabase start`: a fresh, empty stack
#      with the current supabase/config.toml, whether or not one was running;
#   3. into that fresh database, applies the schema (the pinned portal
#      migrations, baseline first, when the pin has
#      20260625_baseline_prehistory.sql; otherwise supabase/contract-schema.sql),
#      then supabase/seed.sql. So every run starts from the same seeded state;
#   4. writes .env.local from `supabase status` (the local stack's throwaway keys);
#   5. starts `supabase functions serve storage-upload` (the pinned function) and
#      scripts/fakes/server.mjs in the background, each in its own session
#      (scripts/lib/spawn-daemon.mjs), so the deadline's group kill never reaches
#      them. Their logs and PID files are in .stack/ (gitignored).
#
# It prints STACK READY, or STACK FAILED: <step>, and exits 0. Step output goes
# to .stack/session-start.log. Before each step it writes the step's name to
# .stack/step, which cloud-session-start.sh reports if the deadline stops it.
#
# Every command that can block runs under bounded.mjs with its own limit, in
# its own process group: on the limit the whole group gets SIGTERM, then SIGKILL,
# and the step fails. A step that is a shell function runs as
# `bash stack-body.sh --fn <function>`, so the group holds the real command.

set -uo pipefail

PROJECT_ID="magora-field-app"
DB_CONTAINER="supabase_db_${PROJECT_ID}"
SUPABASE_URL="http://127.0.0.1:54321"
PORTAL_ORIGIN="http://127.0.0.1:8787"
BASELINE="20260625_baseline_prehistory.sql"
CURL=(curl -s --connect-timeout 2 --max-time 5)

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${root}" || { echo "STACK FAILED: cd to repo root"; exit 0; }
SELF="${root}/scripts/lib/stack-body.sh"
BOUNDED=(node "${root}/scripts/lib/bounded.mjs")
# STACK_STATE_DIR is for tests/unit/supervision.test.ts only: it runs
# `--fn stop_recorded` and `--fn stop_previous` against a temporary state
# directory.
STATE="${STACK_STATE_DIR:-${root}/.stack}"
LOG="${STATE}/session-start.log"
# Surviving members of a dead recorded leader's group, for the port-8787 failure.
LEFTOVER=""

note() { printf '[%3ss] %s\n' "${SECONDS}" "$*" >> "${LOG}"; }

fail() {
  note "FAILED: $1"
  echo "STACK FAILED: $1 (log: .stack/session-start.log)"
  exit 0
}

# step <name>: records the current step for the deadline report.
step() {
  printf '%s\n' "$1" > "${STATE}/step.tmp" && mv -f "${STATE}/step.tmp" "${STATE}/step"
}

# bounded <seconds> <command...>: the command under bounded.mjs, stdin
# /dev/null. Returns its status, or 124 if it outlived <seconds>.
bounded() {
  local limit="$1"
  shift
  "${BOUNDED[@]}" "${limit}" -- "$@" < /dev/null
}

# run_step <name> <seconds> <command...>: runs the command with its output in
# the log, and fails the step if it exits non-zero or outlives its limit.
run_step() {
  local name="$1" limit="$2" rc
  shift 2
  step "${name}"
  note "step: ${name} (limit ${limit}s): $*"
  bounded "${limit}" "$@" >> "${LOG}" 2>&1
  rc=$?
  [ "${rc}" -eq 124 ] && fail "${name} (timed out after ${limit}s)"
  [ "${rc}" -eq 0 ] || fail "${name}"
}

# wait_for <name> <seconds> <command...>: polls the command, each try bounded
# (at most 10 s), until it succeeds or <seconds> pass.
wait_for() {
  local name="$1" limit="$2" end try
  shift 2
  step "${name}"
  end=$((SECONDS + limit))
  note "wait: ${name} (limit ${limit}s)"
  while :; do
    try=$((end - SECONDS))
    [ "${try}" -gt 10 ] && try=10
    [ "${try}" -le 0 ] && fail "${name} (not ready after ${limit}s)"
    bounded "${try}" "$@" > /dev/null 2>> "${LOG}" && return 0
    [ "${SECONDS}" -ge "${end}" ] && fail "${name} (not ready after ${limit}s)"
    sleep 1
  done
}

# ── Process identity ────────────────────────────────────────────────────────
# A PID file holds the PID, then the process start time (`ps -o lstart=`). A PID
# can be reused, so a recorded process is signalled only while both its start
# time and its command still match, checked immediately before each signal.
start_time_of() { LC_ALL=C ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ' | sed 's/^ //; s/ $//'; }
command_of() { ps -o command= -p "$1" 2>/dev/null; }
# group_members <pgid>: PIDs in that process group, space-separated.
group_members() {
  ps -A -o pid=,pgid= 2>/dev/null | awk -v g="$1" '$2 == g { printf "%s%s", sep, $1; sep = " " }'
}
# signal_target <pid>: "-<pid>" (its whole process group) when the process leads
# its own group, as spawn-daemon.mjs starts it, so helpers it spawned stop with
# it; otherwise the PID alone.
signal_target() {
  local pgid
  pgid="$(ps -o pgid= -p "$1" 2>/dev/null | tr -d ' ')"
  if [ "${pgid}" = "$1" ]; then printf -- '-%s' "$1"; else printf '%s' "$1"; fi
}

# is_recorded <pid> <start time> <expected command fragment>
is_recorded() {
  local now cmd
  now="$(start_time_of "$1")"
  [ -n "${now}" ] && [ "${now}" = "$2" ] || return 1
  cmd="$(command_of "$1")"
  case "${cmd}" in *"$3"*) return 0 ;; *) return 1 ;; esac
}

# stop_recorded <name> <expected command fragment>
# Stops the process a previous run recorded in .stack/<name>.pid, only if it is
# still that process. A PID file without a start time is never signalled.
# Never stops anything by name.
#
# Each signal is sent straight after an is_recorded check, with no sleep
# between them. A window remains between the check (two `ps` reads) and the
# signal: if the process exited and its PID was reused inside that window, the
# signal would reach the new process. It is microseconds long and inherent to
# signalling by PID; macOS has no pidfd to close it.
#
# The PID file, and the members file written before the first signal, are
# removed only once the stop has finished. If the stop is interrupted (the
# deadline, or an outside signal), the next run finishes it first: see
# finish_interrupted_stop.
stop_recorded() {
  local name="$1"
  finish_interrupted_stop "${name}"
  [ -f "${STATE}/${name}.pid" ] || return 0
  # A non-zero return means nothing was signalled: keep the record for a retry,
  # and pass the failure on (see stop_previous).
  stop_recorded_leader "$@" || return 1
  rm -f "${STATE}/${name}.pid" "${STATE}/${name}.members"
}

# stop_previous: step 1. A stop that fails ends the run before anything new
# starts, because the replacement's PID file would overwrite the kept record
# and leave the old process untracked.
stop_previous() {
  stop_recorded fake "scripts/fakes/server.mjs" \
    || fail "stop the previous fake server (its record is kept; see the log)"
  stop_recorded functions "functions serve" \
    || fail "stop the previous functions serve (its record is kept; see the log)"
}

# record_members <name> <leader pid>: writes .stack/<name>.members, one
# "<pid> <start time>" line per member of the leader's process group. Called
# only while the leader is verified alive, so no unrelated process can be in
# its group. Each row's PID, group and start time come from one `ps` read of
# that process, so a member that exits and whose PID is reused cannot have the
# new process's start time recorded against it.
# Returns non-zero, with no members file, if the list cannot be read or saved.
record_members() {
  if LC_ALL=C ps -A -o pid=,pgid=,lstart= 2>/dev/null \
    | awk -v g="$2" '$2 == g { pid = $1; $1 = ""; $2 = ""; sub(/^ +/, ""); print pid, $0 }' \
      > "${STATE}/$1.members.tmp" \
    && [ -s "${STATE}/$1.members.tmp" ] \
    && mv -f "${STATE}/$1.members.tmp" "${STATE}/$1.members"; then
    return 0
  fi
  rm -f "${STATE}/$1.members.tmp"
  return 1
}

# finish_interrupted_stop <name>: a members file left by a stop that never
# finished. SIGKILLs each listed PID whose start time still matches (it was
# already sent SIGTERM), waits up to 2 s for them to go, then removes the file.
finish_interrupted_stop() {
  local name="$1" members="${STATE}/$1.members" m t left i
  [ -f "${members}" ] || return 0
  note "finishing an interrupted stop of ${name}"
  while read -r m t; do
    [ -n "${m}" ] && [ -n "${t}" ] || continue
    if [ "$(start_time_of "${m}")" = "${t}" ]; then
      note "${name}: PID ${m} (started ${t}) survived an interrupted stop; sending SIGKILL"
      kill -KILL "${m}" 2>/dev/null
    fi
  done < "${members}"
  for ((i = 0; i < 20; i++)); do
    left=""
    while read -r m t; do
      [ -n "${m}" ] && [ "$(start_time_of "${m}")" = "${t}" ] && left="${left} ${m}"
    done < "${members}"
    [ -z "${left}" ] && break
    sleep 0.1
  done
  [ -n "${left}" ] && note "${name}: PIDs${left} still present after SIGKILL"
  rm -f "${members}"
}

# stop_recorded_leader <name> <expected command fragment>: the stop itself,
# from .stack/<name>.pid. Leaves both files for stop_recorded to remove.
stop_recorded_leader() {
  local name="$1" expect="$2" pidfile="${STATE}/$1.pid" pid started i
  pid="$(sed -n 1p "${pidfile}" | tr -cd '0-9')"
  started="$(sed -n 2p "${pidfile}")"
  [ -n "${pid}" ] || { note "not stopping ${name}: PID file has no PID"; return 0; }
  if [ -z "$(start_time_of "${pid}")" ]; then
    # The leader is gone, so a process still in group <pid> cannot be proven to
    # be its descendant (the group ID may have been reused). Report it, never
    # signal it.
    local left
    left="$(group_members "${pid}")"
    if [ -n "${left}" ]; then
      note "${name} (PID ${pid}) is no longer running, but process group ${pid} still has PIDs ${left}; not signalled: with the leader gone they cannot be proven to be its descendants. Stop them yourself if they are."
      LEFTOVER="${LEFTOVER}${LEFTOVER:+; }${name} group ${pid}: PIDs ${left}"
    else
      note "${name} (PID ${pid}) is no longer running"
    fi
    return 0
  fi
  if [ -z "${started}" ]; then
    note "not stopping PID ${pid}: no recorded start time, so its identity is unresolved"
    return 0
  fi
  if ! is_recorded "${pid}" "${started}" "${expect}"; then
    note "not stopping PID ${pid}: start time or command differs from the recorded ${name} (PID reused)"
    return 0
  fi
  note "stopping ${name} (PID ${pid}, started ${started})"
  # The target is fixed here, while the identity check above still holds. For a
  # group leader it is the whole group ("-<pid>"), and the group is supervised
  # to the end, not just its leader: a member that ignores SIGTERM is killed
  # even if the leader has already exited. A group ID cannot be handed out
  # again while any member exists, and each group signal follows a signal-0
  # probe that found it populated.
  local target
  target="$(signal_target "${pid}")"
  # Without a saved member list an interrupted stop could not be finished
  # later, so nothing is signalled until the list is saved.
  if ! record_members "${name}" "${pid}"; then
    note "not stopping ${name} (PID ${pid}): cannot save its group members to ${STATE}/${name}.members; its record is kept for the next run"
    return 1
  fi
  kill -TERM -- "${target}" 2>/dev/null
  for ((i = 0; i < 20; i++)); do
    sleep 0.5
    target_alive "${target}" "${pid}" "${started}" "${expect}" || { note "${name} (PID ${pid}) stopped"; return 0; }
  done
  note "${name} (PID ${pid}) ignored SIGTERM for 10 s; sending SIGKILL"
  target_alive "${target}" "${pid}" "${started}" "${expect}" || return 0
  kill -KILL -- "${target}" 2>/dev/null
  # Wait (no more signals) so its ports are free before the new start.
  for ((i = 0; i < 20; i++)); do
    target_alive "${target}" "${pid}" "${started}" "${expect}" || return 0
    sleep 0.1
  done
  note "${name} (PID ${pid}) still present after SIGKILL"
  return 0
}

# target_alive <target> <pid> <start time> <command fragment>: for a group target
# ("-<pid>"), true while the group has any member; for a bare PID, true while
# that PID is still the recorded process.
target_alive() {
  case "$1" in
    -*) kill -0 -- "$1" 2>/dev/null ;;
    *) is_recorded "$2" "$3" "$4" ;;
  esac
}

# start_daemon <name> <command...>: starts the command in its own session, with
# its output in .stack/<name>.log and its PID and start time in .stack/<name>.pid.
start_daemon() {
  local name="$1"
  shift
  note "start: ${name}: $*"
  bounded 15 node "${root}/scripts/lib/spawn-daemon.mjs" \
    "${STATE}/${name}.pid" "${STATE}/${name}.log" -- "$@" >> "${LOG}" 2>&1
}

# ── Step functions (run as `bash stack-body.sh --fn <name>` under bounded) ───
docker_up() { exec docker info > /dev/null 2>&1; }

# psql_file <file>: applies one SQL file inside the stack's Postgres container,
# stopping on the first error. Needs no psql on the host.
psql_file() {
  exec docker exec -i "${DB_CONTAINER}" psql -v ON_ERROR_STOP=1 -q -U postgres -d postgres < "$1"
}

# Its stdout lists the stack's keys, so only stderr goes to the log.
supabase_start() {
  exec supabase start -x imgproxy,logflare,vector,supavisor,studio,postgres-meta > /dev/null
}

functions_ready() {
  [ "$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X OPTIONS "${SUPABASE_URL}/functions/v1/storage-upload")" = "200" ]
}

fake_ready() { exec "${CURL[@]}" -f "${PORTAL_ORIGIN}/health" > /dev/null; }

port_free() { ! "${CURL[@]}" -o /dev/null "$1"; }

if [ "${1:-}" = "--fn" ]; then
  shift
  "$@"
  exit $?
fi

# ── The full start ──────────────────────────────────────────────────────────
# A SIGTERM from bounded.mjs (the deadline) waits for the running step's own
# bounded.mjs to stop its group, then ends this script. No result line here:
# cloud-session-start.sh prints it from .stack/step.
trap 'note "stopped by SIGTERM during: $(cat "${STATE}/step" 2>/dev/null)"; exit 143' TERM

start_docker() {
  step "Docker"
  bounded 15 bash "${SELF}" --fn docker_up 2>> "${LOG}" && return 0
  command -v docker > /dev/null 2>&1 || fail "docker (not installed)"
  note "Docker is not running; starting it"
  case "$(uname -s)" in
    Darwin)
      run_step "start Docker Desktop" 30 open -a Docker
      ;;
    *)
      local sudo=()
      [ "$(id -u)" -ne 0 ] && sudo=(sudo -n)
      # Each try is bounded; a failed or timed-out try falls through to the next.
      if command -v systemctl > /dev/null 2>&1 \
         && bounded 60 ${sudo[@]+"${sudo[@]}"} systemctl start docker >> "${LOG}" 2>&1; then
        :
      elif command -v service > /dev/null 2>&1 \
         && bounded 60 ${sudo[@]+"${sudo[@]}"} service docker start >> "${LOG}" 2>&1; then
        :
      elif command -v dockerd > /dev/null 2>&1; then
        start_daemon dockerd ${sudo[@]+"${sudo[@]}"} dockerd || fail "start dockerd"
      else
        fail "start Docker (no systemctl, service or dockerd)"
      fi
      ;;
  esac
  wait_for "Docker" 120 bash "${SELF}" --fn docker_up
}

apply_schema() {
  local f
  if [ -f ".portal/supabase/migrations/${BASELINE}" ]; then
    note "schema: pinned portal migrations, baseline first"
    # The baseline's 20260625 prefix sorts first; rollbacks/ is not applied.
    for f in .portal/supabase/migrations/*.sql; do
      run_step "apply ${f##*/}" 60 bash "${SELF}" --fn psql_file "${f}"
    done
  else
    [ -f supabase/contract-schema.sql ] || fail "apply schema (no baseline at the pin and no contract-schema.sql)"
    note "schema: supabase/contract-schema.sql (the pin has no ${BASELINE})"
    run_step "apply schema" 60 bash "${SELF}" --fn psql_file supabase/contract-schema.sql
  fi
}

# Reads one variable from `supabase status -o env` without printing it.
status_var() {
  printf '%s\n' "${STATUS_ENV}" | sed -n "s/^$1=\"\{0,1\}\([^\"]*\)\"\{0,1\}\$/\1/p" | head -n 1
}

write_env_local() {
  local anon service url
  url="$(status_var API_URL)"
  anon="$(status_var ANON_KEY)"
  service="$(status_var SERVICE_ROLE_KEY)"
  [ "${url}" = "${SUPABASE_URL}" ] || { note "supabase status API_URL is not ${SUPABASE_URL}"; return 1; }
  [ -n "${anon}" ] && [ -n "${service}" ] || { note "supabase status has no ANON_KEY or SERVICE_ROLE_KEY"; return 1; }
  SERVICE_ROLE_KEY="${service}"
  (
    umask 077
    cat > .env.local <<EOF
# Written by scripts/cloud-session-start.sh from \`supabase status\`. Gitignored.
# Only the local stack's throwaway keys: never a real Supabase URL or key.
EXPO_PUBLIC_APP_ENV=local
EXPO_PUBLIC_SUPABASE_URL=${SUPABASE_URL}
EXPO_PUBLIC_SUPABASE_ANON_KEY=${anon}
EXPO_PUBLIC_PORTAL_ORIGIN=${PORTAL_ORIGIN}
# For the contract tests' setup and checks only (tests/contract/stack.ts). Not
# EXPO_PUBLIC_, so Expo never puts it in the app bundle.
LOCAL_SUPABASE_SERVICE_ROLE_KEY=${service}
EOF
  )
}

# ── 1. Stop what a previous run started ─────────────────────────────────────
step "stop previous processes"
stop_previous

# ── 2. Docker, CLI, portal sources, supabase start ──────────────────────────
start_docker
step "supabase CLI"
command -v supabase > /dev/null 2>&1 || fail "supabase CLI (not installed: run scripts/cloud-setup.sh)"
# `exec` in each command substitution below: the subshell becomes bounded.mjs
# itself, so a deadline SIGTERM finds this script waiting on bounded.mjs (and
# the trap waits for it) rather than on a subshell that dies at once.
cli_version="$(exec "${BOUNDED[@]}" 15 -- supabase --version < /dev/null 2>> "${LOG}")"
cli_version="${cli_version%%$'\n'*}"
note "supabase CLI ${cli_version}"

pin="$(tr -d '[:space:]' < portal-pin.txt 2>/dev/null)"
if [ "$(tr -d '[:space:]' < .portal/PIN 2>/dev/null)" != "${pin}" ]; then
  run_step "fetch portal" 120 bash scripts/fetch-portal.sh .portal
fi
step "copy storage-upload"
[ -f .portal/supabase/functions/storage-upload/index.ts ] || fail "portal storage-upload source"
mkdir -p supabase/functions || fail "create supabase/functions"
rm -rf supabase/functions/storage-upload
cp -R .portal/supabase/functions/storage-upload supabase/functions/storage-upload || fail "copy storage-upload"

# A clean start every run: stopping without a backup drops the previous run's
# database volume, and a restart is also what applies supabase/config.toml
# changes. `supabase stop` acts on this project's containers only.
run_step "supabase stop" 120 supabase stop --no-backup
run_step "supabase start" 420 bash "${SELF}" --fn supabase_start

# ── 3. Database: schema, seed ────────────────────────────────────────
wait_for "database" 60 docker exec "${DB_CONTAINER}" pg_isready -U postgres
apply_schema
run_step "load seed" 60 bash "${SELF}" --fn psql_file supabase/seed.sql

# ── 4. .env.local ───────────────────────────────────────────────────────────
step "supabase status"
STATUS_ENV="$(exec "${BOUNDED[@]}" 30 -- supabase status -o env < /dev/null 2>> "${LOG}")" || fail "supabase status"
SERVICE_ROLE_KEY=""
step "write .env.local"
write_env_local || fail "write .env.local"
STATUS_ENV=""

# ── 5. Background: functions serve and the fake ─────────────────────────────
# By name, as the plan's interface says (the CLI serves every function under
# supabase/functions/ either way; storage-upload is the only one there).
step "start functions serve"
start_daemon functions supabase functions serve storage-upload || fail "start functions serve"
wait_for "functions serve (storage-upload)" 150 bash "${SELF}" --fn functions_ready

step "fake server"
port_free "${PORTAL_ORIGIN}/health" || fail "port 8787 is in use by a process this script did not record${LEFTOVER:+ (left over from a dead recorded service, not signalled: ${LEFTOVER})}"
# The key reaches the fake through its environment, never its arguments.
(
  export SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY}"
  start_daemon fake node scripts/fakes/server.mjs
) || fail "start fake server"
SERVICE_ROLE_KEY=""
wait_for "fake server" 30 bash "${SELF}" --fn fake_ready

note "ready"
echo "STACK READY"
exit 0
