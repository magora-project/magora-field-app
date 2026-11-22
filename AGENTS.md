# AGENTS.md: magora-field-app

For agents and contributors (Claude Code via `CLAUDE.md`, Codex directly). Design: `docs/superpowers/specs/2026-11-21-field-app-design.md`; plan: `docs/superpowers/plans/2026-11-21-field-app.md`.

CLOUD-RULES-MARKER: magora-field-app v1

## Cloud rules

Claude Code cloud sessions run this repo in a fresh VM and see only what the repo carries. These rules apply to every cloud session (spec §4.4):

- Push only `claude/*` branches, and open PRs as drafts.
- Never push to, merge into, or change settings on `main`.
- Never add a secret to the repo, a hook, the environment or a commit message. Never point the app at a real Supabase URL or the production portal.
- Every task names a test that runs against the local stack.
- Backend changes are proposed as a portal issue, never made here.

The local Supabase stack, started by `bash scripts/cloud-session-start.sh`, is the only database a session may use.

## Commands

- `npm ci`: install
- `npm run typecheck`: `tsc --noEmit`
- `npm run lint`: ESLint
- `npm test`: Jest unit tests (`tests/unit`); needs no backend
- `npm run test:contract`: contract tests against the local Supabase stack (start it first)
- `bash scripts/cloud-session-start.sh`: starts the local Supabase stack and loads the schema and seed (Task 4)

## Flow

- Trunk: branch from and PR to `main`. No long-lived branches.
- Squash merge only. A maintainer merges once required checks pass.
- Resolve each review thread before merge, after reading bot findings.
- **Agents never push, merge, or change repo settings without their operator's explicit approval.** In a cloud session the operator's approval is the session's task; the cloud rules above still bound it.
- Every agent follows `.claude/rules/process.md`; Claude Code loads skills from `.claude/skills/`.

## Depth labels (exactly one per PR)

| Label | Use for |
|---|---|
| `mechanical` | docs, renames, formatting |
| `standard` | ordinary changes |
| `subtle-correctness` | anything touching recording, upload or auth; anything touching the harness (`.claude/`, `.github/`, `AGENTS.md`, `CLAUDE.md`, `scripts/`, `portal-pin.txt`, `package.json`, `package-lock.json`, or a tool config such as `jest.config.js`, `eslint.config.js`, `tsconfig.json` or `app.config.ts`); concurrency; anything subtle |

Review and what blocks: `.claude/rules/process.md`.

## Fork PRs

A fork's content is untrusted code, and running it runs whatever it carries: tests, lint and build configs, dependencies installed by `npm ci`, the `.claude/` settings, hooks and skills an agent session loads. A maintainer reads the PR's whole diff (on the PR page, or `git fetch` then `git diff`, which run none of it) before checking the branch out, and before any install, test, lint, build or agent session from that checkout. Never authorize a deployment or a cloud session for a fork PR.

## Backend

The backend (Supabase schema, migrations, Edge Functions, auth) belongs to magora-portal. Do not change it here. When a task needs a backend change, write it up as a magora-portal issue and stop.

## Secrets

Cloud sessions have no secrets at all: do not look for any, ask for any, or create any. Tests run against the local Supabase stack with its throwaway local keys. On the operator's Mac, agents use `op run` and `op inject` only, never `op read`, `op item get` or anything that prints a secret; env files hold `op://` references only.
