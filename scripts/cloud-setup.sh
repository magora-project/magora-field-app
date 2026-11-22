#!/usr/bin/env bash
# Setup for a Claude Code cloud environment (spec §4.2), and for the CI contract
# job. The cloud environment's setup script is `bash scripts/cloud-setup.sh`; it
# runs as root before the session starts and its result is cached.
#
#   1. installs the Supabase CLI at the pinned version (checksum-verified);
#   2. runs `npm ci`;
#   3. fetches supabase/migrations/ and supabase/functions/storage-upload/ from
#      magora-portal at the commit in portal-pin.txt, into .portal/.
#
# It fails loudly: any error stops it with a non-zero exit. It holds no secret and
# needs none.
set -euo pipefail

SUPABASE_CLI_VERSION="2.118.0"
# sha256 of supabase_${SUPABASE_CLI_VERSION}_linux_<arch>.tar.gz, from that
# release's checksums.txt.
SUPABASE_CLI_SHA256_amd64="f6089a86fb9d9221c958193a277338daddd6822f706929943812fa32e106c86d"
SUPABASE_CLI_SHA256_arm64="0cd35fea97c2c93dce8a2cd661311be88c107233946cbe3692566196238859c5"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${root}"

say() { printf 'cloud-setup: %s\n' "$*"; }

installed_cli_version() {
  if command -v supabase >/dev/null 2>&1; then
    supabase --version 2>/dev/null | head -n 1 | tr -d '[:space:]'
  fi
}

install_cli() {
  if [ "$(installed_cli_version)" = "${SUPABASE_CLI_VERSION}" ]; then
    say "Supabase CLI ${SUPABASE_CLI_VERSION} already installed"
    return
  fi
  if [ "$(uname -s)" != "Linux" ]; then
    say "Supabase CLI ${SUPABASE_CLI_VERSION} is required; found '$(installed_cli_version)'. Install it by hand on this OS." >&2
    exit 1
  fi
  local arch sha
  case "$(uname -m)" in
    x86_64 | amd64) arch="amd64"; sha="${SUPABASE_CLI_SHA256_amd64}" ;;
    aarch64 | arm64) arch="arm64"; sha="${SUPABASE_CLI_SHA256_arm64}" ;;
    *) say "unsupported architecture $(uname -m)" >&2; exit 1 ;;
  esac
  local tarball="supabase_${SUPABASE_CLI_VERSION}_linux_${arch}.tar.gz"
  local work
  work="$(mktemp -d "${TMPDIR:-/tmp}/supabase-cli.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '${work}'" RETURN
  say "downloading ${tarball}"
  curl -fsSL -o "${work}/${tarball}" \
    "https://github.com/supabase/cli/releases/download/v${SUPABASE_CLI_VERSION}/${tarball}"
  echo "${sha}  ${work}/${tarball}" | sha256sum -c - >/dev/null
  tar -xzf "${work}/${tarball}" -C "${work}" supabase
  local bin_dir="/usr/local/bin"
  if [ -w "${bin_dir}" ]; then
    install -m 0755 "${work}/supabase" "${bin_dir}/supabase"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo install -m 0755 "${work}/supabase" "${bin_dir}/supabase"
  else
    say "cannot write ${bin_dir} (not root, no passwordless sudo)" >&2
    exit 1
  fi
  hash -r
  if [ "$(installed_cli_version)" != "${SUPABASE_CLI_VERSION}" ]; then
    say "installed CLI reports '$(installed_cli_version)', expected ${SUPABASE_CLI_VERSION}" >&2
    exit 1
  fi
  say "Supabase CLI ${SUPABASE_CLI_VERSION} installed"
}

check_baseline_rule() {
  # Spec §4.2: once supabase/contract-schema.sql is deleted (the first pin bump
  # after the portal's baseline lands), a pin without the baseline is refused.
  if [ ! -f supabase/contract-schema.sql ] &&
    [ ! -f .portal/supabase/migrations/20260625_baseline_prehistory.sql ]; then
    say "portal-pin.txt names a commit without supabase/migrations/20260625_baseline_prehistory.sql, and supabase/contract-schema.sql is gone" >&2
    exit 1
  fi
}

install_cli
say "npm ci"
npm ci
say "fetching magora-portal at $(tr -d '[:space:]' < portal-pin.txt)"
bash scripts/fetch-portal.sh .portal
check_baseline_rule
say "done"
