---
name: brainstorming
description: "You MUST use this before any creative work - creating features, building components, adding functionality, or modifying behavior. Turns an idea into a reviewed spec before any plan or code."
---

# Brainstorming Ideas Into Specs

Turn an idea into a written, reviewed spec through collaborative dialogue. This is stage 2 and 3 of the repo process: see `.claude/rules/process.md` under `## Stages`. Declare the lane first (`## Lanes`); a Specced change comes through here, a Direct one does not need a spec.

<HARD-GATE>
Do NOT write any code, scaffold anything, or invoke any implementation skill until you have presented a design and the user has approved it. This applies to every Specced change, however simple it looks. The design can be a few sentences for a small change, but it must be presented and approved.
</HARD-GATE>

## Checklist

Create a task for each item and complete them in order:

1. **Explore project context:** files, docs, recent commits, and any peer branch or PR already working on this.
2. **Ask clarifying questions:** one per message, multiple choice where possible. Focus on purpose, constraints, success criteria. If the request spans several independent subsystems, say so at once and decompose into sub-projects first; each gets its own spec, plan and implementation.
3. **Propose 2-3 approaches** with trade-offs. Lead with your recommendation and why.
4. **Present the design** in sections scaled to their complexity (architecture, components, data flow, error handling, testing). Ask after each section whether it looks right. Get approval.
5. **Write the spec** to `docs/superpowers/specs/` as `YYYY-MM-DD-<topic>-design.md` and commit it.
6. **Self-review the spec** (below).
7. **Spec review** (below).
8. **User reviews the written spec.** Wait for approval. If they ask for changes, make them and repeat steps 6 and 7.
9. **Invoke `writing-plans`.** It is the only skill invoked after brainstorming.

## Designing

- Break the system into units with one clear purpose, a well-defined interface, and explicit dependencies. Someone should be able to understand a unit without reading its internals.
- In an existing codebase, follow its patterns. Include targeted improvements only where the existing code blocks the work; no unrelated refactoring.
- YAGNI: remove features that are not needed from every design.
- Go back and clarify whenever something stops making sense.

## Spec self-review

Read the spec once with fresh eyes and fix inline:

1. **Placeholders:** any "TBD", "TODO", or vague requirement.
2. **Consistency:** sections that contradict each other, or an architecture that does not match the described features.
3. **Scope:** focused enough for a single plan, or does it need decomposition.
4. **Ambiguity:** a requirement that reads two ways; pick one and say so.

## Spec review

Have a reviewer subagent from a different model read the spec fresh (a Codex or Gemini reviewer where one is available, else a fresh Claude subagent with no context from this session), and fix what it finds. An empty reviewer reply is an unrun review, not a pass; say so in the PR. Fix findings inline. What blocks and what is a nit is in `.claude/rules/process.md` under `## What blocks`; after two rounds where the new findings all sit in the previous round's fixes, apply `## Stop rule`. Review again after any change to the spec.

## After approval

Tell the user: "Spec written and committed to `<path>`. Review done. Please read it and say if you want changes before I write the plan." Wait. Then invoke `writing-plans`, using that short name, not `superpowers:writing-plans`: the repo's copy in `.claude/skills/` is the one this process uses, and a cloud session has no plugin copy.

## Visual questions

If upcoming questions are genuinely visual (layouts, mockups, diagrams), offer to show them in a browser, in a message containing only that offer. Use the browser only for questions the user would understand better by seeing; use text for scope, requirements and trade-offs. Serve any mockup from a throwaway static file server on an unused port, and do not point the app at any real backend for it.

## Principles

- One question at a time.
- Multiple choice over open-ended.
- Always propose alternatives before settling.
- Validate incrementally; get approval before moving on.
