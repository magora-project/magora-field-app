#!/usr/bin/env bash
# Usage: scripts/fetch-portal.sh <dest>
#
# Shallow-fetches the magora-portal commit named in portal-pin.txt and copies its
# supabase/migrations/ and supabase/functions/storage-upload/ into
# <dest>/supabase/. Writes the fetched SHA to <dest>/PIN. Exits non-zero if the
# SHA can't be fetched. Needs no credentials: magora-portal is public.
set -euo pipefail

PORTAL_REPO="https://github.com/magora-project/magora-portal.git"

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="${1:?usage: scripts/fetch-portal.sh <dest>}"

pin="$(tr -d '[:space:]' < "${root}/portal-pin.txt")"
if ! [[ "${pin}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "fetch-portal: portal-pin.txt must hold one full 40-hex SHA" >&2
  exit 1
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/fetch-portal.XXXXXX")"
trap 'rm -rf "${work}"' EXIT

git -C "${work}" init -q
# Never prompt for or send credentials: a public fetch either works or fails.
if ! GIT_TERMINAL_PROMPT=0 git -C "${work}" -c credential.helper= fetch -q --depth 1 "${PORTAL_REPO}" "${pin}"; then
  echo "fetch-portal: could not fetch ${pin} from ${PORTAL_REPO}" >&2
  exit 1
fi
got="$(git -C "${work}" rev-parse FETCH_HEAD)"
if [ "${got}" != "${pin}" ]; then
  echo "fetch-portal: fetched ${got}, expected ${pin}" >&2
  exit 1
fi
git -C "${work}" checkout -q FETCH_HEAD -- supabase/migrations supabase/functions/storage-upload

mkdir -p "${dest}"
rm -rf "${dest}/supabase"
mkdir -p "${dest}/supabase/functions"
cp -R "${work}/supabase/migrations" "${dest}/supabase/migrations"
cp -R "${work}/supabase/functions/storage-upload" "${dest}/supabase/functions/storage-upload"
printf '%s\n' "${pin}" > "${dest}/PIN"
echo "fetch-portal: ${pin} -> ${dest}"
