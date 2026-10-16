# Bridges and handoff (issue #11 #14)

## What exists today

The MCP flow allows ChatGPT to invoke FigDes: the plugin connects over a
WebSocket, the server exposes tools, and the model drives them. That direction is
proven.

**The opposite direction does not exist.** FigDes cannot post a message into the
ChatGPT conversation that is currently driving it.

## Why not

Posting into a live conversation requires a host API that accepts outbound
messages into a specific thread. Nothing in the MCP specification provides one —
MCP is a tool-execution protocol, not a messaging protocol. There is no
"reply to this conversation" operation that a third-party server can call.

Any implementation that appeared to do this would be doing one of:

- **Screen-scraping the host**, which breaks on every UI change and is not
  something to build a product on.
- **Emailing yourself a link** and hoping the user follows it, which is not the
  feature anyone asked for.
- **Claiming support it does not have**, which is the failure mode this file
  exists to prevent.

## What is available instead

1. **In-plugin chat.** The structured change-request API built alongside this
   (`request_change` → `plan_change` → `apply_change` → `verify_change`) is the
   supported path for "the user is talking to FigDes directly". It carries
   selection context, targets and constraints as data, and every change is
   undoable and reviewable.

2. **Shared structured brief.** A `design_brief` or a `change_request` is a
   portable record: target ids, constraints, status, verification state and
   before/after evidence. It can be pasted into any assistant, and read back by
   FigDes. This is the bridge that works today and needs no host support.

3. **Round-tripping.** Because the brief is data rather than prose, work started
   in one assistant can be completed in another by handing over the request id.

## If a host bridge is wanted

The prerequisites, none of which FigDes controls:

- A documented, supported API on the host for outbound messages into a thread.
- An authentication and consent model the user has explicitly granted.
- Idempotency and retry semantics, so a retry cannot double-post.

Until a host exposes that, the honest statement — which is what
`request_change` and friends return — is that **only in-plugin chat and the
shared brief are available**. No tool in this repository claims otherwise, and
adding one that did would be a promise the system cannot keep.