# Moodboards: scoped context, not always-on injection

Implements issue #11 Part C. The design decision and the reasoning are in
`mcp-server/src/moodboard/model.ts`; this file is the operating guide.

## The three stores

| Store | Lifetime | Injected by default? |
|---|---|---|
| **Reference library** — saved moodboards and their source frames | Durable | **No** |
| **Visual brief** — extracted observations with evidence and confidence | Durable | **No** |
| **Approved profile** — the small set of rules a user approved | Durable | **Yes** |
| **Task attachments** — opt-in per request | Until the task ends | Only for that task |

Keeping every saved moodboard permanently active would burn tokens on every
turn, turn irrelevant images into relevant-looking signals, leak references from
one task into another, and make "why did you choose this?" unanswerable. The
approved profile exists so the common case needs no attachment at all — and it is
capped at a few dozen rules precisely so it stays readable.

## The workflow

```
save_moodboard        select frames/images → library          (nothing active)
analyse_moodboard     measure + merge your readings → brief  (still nothing active)
update_visual_brief   correct what was misread              (optional)
approve_observations  the only path into the profile        (now applies by default)
attach_moodboard      opt a reference into ONE task
moodboard_context     check what that task actually receives
end_task_context      drop the attachments, keep the library
```

Saving is not approving. Analysing is not attaching. Each is a separate call,
because each is a decision.

## Scoping

- **influence** `subtle | balanced | strong` — how many approved observations
  survive into the context. Expressed as a count, because an influence the
  assembler cannot honour is not an influence.
- **scope** `project | screen | components | task` — narrower wins when scopes
  overlap, because the narrower statement is the more specific intent.
- **roles** `visual-style | layout | typography | interaction | data-visualization | component-pattern`
  — a typography reference does not dictate layout.
- **exclusions** — traits that must not be carried over. Hard-filtered.
- **expiry** — task-only attachments leave context when the task ends. The
  moodboard stays in the library.

## Provenance

Every injected line carries its origin, confidence and how it was derived:

```
- [palette, 0.75 confidence, measured] Surfaces are dominated by #FAF6EF (from mb-1/obs-1, evidence: header)
- [typography, 0.6 confidence, inferred] The heading reads editorial (from mb-2/prop-1, evidence: whole image)
```

`measured` means this server read it from the node tree. `inferred` means a model
supplied it. An observation supplied by a caller is **downgraded to `inferred`**
on the way in — otherwise an unverified claim could enter the approved profile
wearing the authority of a measurement.

## Partial analysis

A source that cannot be read produces no observations and a recorded reason. The
brief is marked `partial`, and the partial state is injected alongside the
observations so a consumer cannot mistake "we analysed three of five frames" for
"we analysed this moodboard".

## Conflicts

An attached reference that contradicts the approved profile is reported, with a
resolution. At `subtle` and `balanced` influence the approved profile wins and the
conflict is surfaced for the user; at `strong` the attachment wins for that task
and the conflict is recorded. Nothing is silently merged.

Detection is deliberately narrow — only opposite assertions about the same axis
count. A detector that cries wolf gets ignored, and then the real conflict is
missed too.

## Budget

The assembled context is capped (2400 characters by default) and **reports what it
dropped and why** — `influence`, `role-excluded`, `exclusion`, `out-of-scope`,
`budget`, `missing-moodboard`. Silent truncation is how a scoped reference
quietly becomes an unscoped one.

Call `moodboard_context` before generating to see exactly what will be injected.