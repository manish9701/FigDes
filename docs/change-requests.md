# Change requests, tags and feedback history

Implements issue #11 Part D items 12, 13 and 15. Item 14 (the ChatGPT handoff)
is covered in `bridges-and-handoff.md`.

## The lifecycle

```
request_change         name the targets and the constraints   (nothing changes)
plan_change            propose the operations                  (validated, not applied)
apply_change           commit one transaction                 (returns "committed-awaiting-verification")
verify_change          review + render, record findings       (only now can it become "applied")
```

`apply_change` deliberately does **not** return `applied`. Operations executing
is not the same as the result being correct, and a status field that conflates
them is a status field nobody can trust. `transition()` enforces it: reaching
`applied` without `verified: true` throws.

## Targets survive rename, and never get substituted

Targets are stored as **node ids**, with names kept separately as a human-readable
label that is allowed to go stale. This is the difference between a request that
works next week and one that silently edits the wrong thing.

- **Rename** → the id is unchanged, so the target still resolves.
- **Reorder** → same.
- **Deletion or replacement** → the request moves to `needs-re-resolution` and
  FigDes stops. It does not fall back to a name match, because "the button called
  Cancel" today may be a different button tomorrow.

`reresolve_change_request` is the way out: the user confirms which node is meant,
and FigDes records that *they* chose it.

## Constraints are structured, not sentences

"Do not change the topology" is the constraint most likely to be violated by an
otherwise reasonable edit, and a sentence cannot be checked against a diff. So a
constraint names the nodes it protects, optionally the property, and whether it
blocks. `plan_change` refuses a plan whose operations touch a protected node —
before anything is committed, not after.

## Tags

`tag_design_targets` attaches a label to the current selection or explicit nodes.
A set can then be addressed later ("everything tagged onboarding"). Tagging is
separate from change requests so grouping does not imply work.

Tags store node ids for the same reason targets do.

## History

Every request records its status, the target ids, the constraints, the
transaction id, before/after finding counts, verification state and timestamps.
`list_feedback` reconciles targets against the live file on read, so a rename
that happened days ago is still visible.

## Reuse

```json
{ "fn": "request_change",
  "request": "Make these three buttons consistent",
  "constraints": [{ "id": "keep-primary", "description": "do not restyle the primary action",
                    "protectNodeIds": ["1:9"], "property": "fill", "blocking": true }] }
```