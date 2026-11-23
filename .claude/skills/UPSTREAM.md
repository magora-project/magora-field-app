# Skill provenance

Where each skill in `.claude/skills/` comes from.

| Skill | Source | Commit | Changes |
|---|---|---|---|
| `brainstorming` | `magora-portal`, `.claude/skills/brainstorming/SKILL.md` | `576897580f9e8c045e76bb50f24d60deda42ba88` | Removed the Semgrep scan, `codex-review` skill, `scripts/review/` and `npm run review` steps and the spec record; spec review is a fresh reviewer subagent. Dropped the portal-only claim that a repo hook denies the plugin copy of `writing-plans`. |
| `writing-plans` | `magora-portal`, `.claude/skills/writing-plans/SKILL.md` | `576897580f9e8c045e76bb50f24d60deda42ba88` | Removed the plan-review script, Semgrep, `checkExisting`, `conformance` and record references; plan review is a hand check of the typed targets plus a fresh reviewer subagent. `superpowers:` skill names point at the repo skill `subagent-driven-development`; `executing-plans` is not vendored, so in-session execution is described in prose. Dropped the portal's "spec §5.4" citation, which this repo's spec doesn't have. |
| `subagent-driven-development` | `obra/superpowers`, `skills/subagent-driven-development/` (tag `v7.0.0`) | `bb92a77741419a4ab5f06e711a283343f1ada0c3` | None. Copied whole, including `scripts/`. |
| `test-driven-development` | `obra/superpowers`, `skills/test-driven-development/` (tag `v7.0.0`) | `bb92a77741419a4ab5f06e711a283343f1ada0c3` | None. Copied whole. |

## obra/superpowers license (MIT)

The notice below is `LICENSE` at that commit, reproduced verbatim for the two superpowers skills:

    MIT License
    
    Copyright (c) 2025 Jesse Vincent
    
    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:
    
    The above copyright notice and this permission notice shall be included in all
    copies or substantial portions of the Software.
    
    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
    SOFTWARE.
