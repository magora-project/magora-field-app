# Process rules

The repo's single process document, adapted from magora-portal's `.claude/rules/process.md` (at the commit pinned for this repo's harness). Every agent and contributor follows it. If this file and the field-app spec (`docs/superpowers/specs/2026-11-21-field-app-design.md`) disagree, the spec wins; fix this file.

Phase 1 has no `.review/` evidence gate (spec §4.4). There are no review records, no `review-gate` or `review-evidence` checks, and no `npm run review`: the rules below are discipline, and the required CI checks are the control. Bot reviews are triaged in the PR threads, as on the portal before its Spec 3.

## Lanes

Test **Specced** first. It wins any overlap.

- **Specced:** any change that alters behaviour, touches more than one module, adds a capability, or goes near auth, recording, upload, money or PII. Also any config change, unless the change is literally a comment.
- **Direct:** docs-only changes, a comment, a rename, a revert, or a one-line or single-file mechanical edit.
- **When unsure,** the lane is Specced.

Put the lane in the PR body (`Lane: specced` or `Lane: direct`). A Specced PR also names its spec path, its plan path, and the plan task IDs it covers, and lists any unfixed deviation from the plan with its justification.

## Stages

A Specced change moves through these stages, in order. A Direct change has no spec or plan stage (2-5). The portal's conformance, pre-push review record and evidence stages (its 8-10) do not exist in Phase 1, so the numbering skips them; stages 11-14 keep the portal's numbers.

1. **Lane:** Specced or Direct.
2. **Brainstorm, then spec.** Local, repo skill `brainstorming`.
3. **Spec review:** a fresh reviewer subagent (Review dispatch below).
4. **Plan**, with typed task targets. Local, repo skill `writing-plans`.
5. **Plan review:** check the typed targets against the tree, and a fresh reviewer subagent.
6. **Implement:** subagent-driven (`subagent-driven-development`, with `test-driven-development`), with per-task review by depth.
7. **Local checks,** then CI: `npm run typecheck`, `npm run lint`, `npm test`, and `npm run test:contract` against the local stack.
11. **PR:** a draft PR from a `claude/*` branch, with the lane fields and exactly one depth label.
12. **CI:** the required checks pass.
13. **Bot reviews,** then triage in the PR threads: read each bot finding, fix or answer it, and resolve the thread.
14. **Merge:** squash, by a maintainer, once required checks pass and threads are resolved. A cloud session never merges.

The vendored `subagent-driven-development` skill is upstream's, unchanged, and names superpowers skills this repo does not vendor (`finishing-a-development-branch`, `using-git-worktrees`, `requesting-code-review`, `executing-plans`). Where it does, follow the stages above instead: per-task review by depth (stage 6), then a whole-branch review before the PR, then a draft PR from a `claude/*` branch (stage 11). Never merge. For the whole-branch review, dispatch a fresh reviewer as in `## Review dispatch`. Give it the spec, the plan, the task IDs covered, any deferred per-task findings and `git diff origin/main...HEAD`. Ask it for correctness and completeness across tasks, with findings graded as in `## What blocks`.

## Depth labels

`AGENTS.md` carries the table. Exactly one per PR. The label is a floor: a PR that touches recording, upload, auth, or the harness (every path the `AGENTS.md` table lists under `subtle-correctness`) is `subtle-correctness` whatever label it carries.

## Review dispatch

The reviewer's vendor must differ from the vendor that wrote the change (Claude-written: a Codex or Gemini reviewer where one is available, else a fresh Claude subagent with no session context; Codex-written: Opus or Fable). An empty reviewer reply is an unrun review, not a pass.

Per-task review by depth during stage 6:

- `mechanical`: none.
- `standard`: one correctness reviewer.
- `subtle-correctness`: a correctness reviewer and a completeness reviewer, from different models. Completeness asks: is anything promised missing, can the tests fail, what did the fixes break.

**PR-stage bots (stage 13).**

| Depth | Required bot reviews |
|---|---|
| `mechanical` | none |
| `standard` | one of CodeRabbit or the Codex GitHub App |
| `subtle-correctness` | CodeRabbit, the Codex GitHub App, and Gemini |

After a rewrite (rebase, amend, force update), ask for a full review: `@coderabbitai full review` and `@codex review`. An incremental review alone does not restore coverage. Do not dismiss bot reviews to clear their findings.

## What blocks

Bot severity labels set the defaults; the author makes the final call.

| Category | Covers | Default for | Disposition |
|---|---|---|---|
| **Blocking** | Correctness, security, data loss, or a broken spec or plan promise | Codex P0-P2; CodeRabbit Critical and Major; every Gemini finding; reviewer-subagent findings P0-P2; anything unparseable | A fix, or pre-existing |
| **Nit** | Wording, naming, style, "consider also", theoretical edge cases | Codex P3; CodeRabbit Minor, Nitpick and Trivial; reviewer P3 | None needed |

**Reclassifying** a blocking finding to a nit needs a one-line reason written in the PR thread, which the merging maintainer can see. A nit the author thinks matters can simply be fixed.

**A fixed finding** is fixed in a new commit (not an amend or rebase of the reported commit), and the thread names that commit. Resolve the thread after the fix.

**Pre-existing** applies only when the defect is present on the base revision under the same reachable conditions; say so in the thread and link the issue that tracks it. An unchanged line that this PR newly makes reachable is this PR's regression, not pre-existing.

## Stop rule

After two rounds in a row where every new finding sits in the previous round's own fixes, stop patching and restructure. By round three, change the reviewer's question as well as the model.
