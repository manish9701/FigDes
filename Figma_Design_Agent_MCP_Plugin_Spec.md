# Figma Design Agent — Native Plugin + Custom MCP

## 1. Critical architecture decision

**DO NOT USE FIGMA MCP.**

This project uses the Figma Plugin API directly.

```text
ChatGPT
   |
   | Custom MCP / MCP App
   v
Design Agent MCP Server
   |
   | HTTPS / WebSocket / session relay
   v
Figma Plugin
   |
   | Figma Plugin API
   v
Native Figma Document
```

There is **NO Figma MCP Server** in this chain.

The only MCP is **our custom MCP server exposed to ChatGPT**.

## 2. Why this avoids Figma MCP limits

Figma's Figma MCP Server is a separate service with its own tool-call limits.

Our plugin does not call that server.

Instead, the plugin runs inside Figma and uses the native Plugin API:

```text
Our MCP
    |
    X----> Figma MCP Server
    |
    v
Figma Plugin
    |
    v
Figma Plugin API
```

Therefore, the Figma MCP quota is not the mechanism used by this system.

## 3. Product goal

The desired experience:

> "Create a 1440px dashboard for EXO Labs using the existing design system."

The system should:

1. Understand the request.
2. Call our custom MCP.
3. Ask the Figma plugin for active context.
4. Inspect the relevant Figma structure.
5. Create a design plan.
6. Convert the plan into validated design operations.
7. Send operations to the plugin.
8. Execute them through the Figma Plugin API.
9. Return created/modified node IDs.
10. Inspect the result.
11. Fix obvious issues when appropriate.
12. Report completion.

The user should never need to copy JavaScript, SVG, commands, or manually import anything.

## 4. MVP

Do not build the complete autonomous designer first.

First prove:

```text
ChatGPT
  ↓
Custom MCP
  ↓
Design Agent
  ↓
Figma Plugin
  ↓
Figma Plugin API
  ↓
Native Figma frame
```

MVP tools:

```text
figma_status
inspect_selection
inspect_file
create_design
modify_design
undo_last_operation
```

First test:

> Create a 400×300 native Figma frame named "ChatGPT Test".

## 5. Repository

Start simple:

```text
figma-design-agent/
├── figma-plugin/
│   ├── manifest.json
│   ├── src/
│   │   ├── code.ts
│   │   ├── plugin-api.ts
│   │   ├── operations.ts
│   │   ├── inspector.ts
│   │   └── session.ts
│   └── ui/
│       ├── index.html
│       └── ui.ts
├── mcp-server/
│   ├── src/
│   │   ├── server.ts
│   │   ├── tools.ts
│   │   ├── sessions.ts
│   │   ├── protocol.ts
│   │   └── security.ts
│   └── package.json
├── relay/
├── tests/
├── package.json
└── README.md
```

Do not over-engineer V1.

## 6. Figma Plugin responsibilities

The plugin is the execution layer.

It should:

- connect to the Design Agent server
- report file identity
- report current page
- report current selection
- inspect requested nodes
- execute validated operations
- return node IDs
- support operation checkpoints
- support rollback/undo
- return errors
- optionally provide screenshot/visual inspection later

The plugin should NOT contain AI reasoning.

## 7. Plugin manifest

Use a development manifest similar to:

```json
{
  "name": "Design Agent",
  "api": "1.0.0",
  "main": "dist/code.js",
  "ui": "dist/ui.html",
  "documentAccess": "dynamic-page",
  "networkAccess": {
    "allowedDomains": [
      "http://localhost:8788",
      "https://YOUR-DEPLOYED-RELAY-DOMAIN"
    ],
    "devAllowedDomains": [
      "http://localhost:8788"
    ],
    "reasoning": "Connect to the user's Design Agent server to receive validated design operations and return Figma document state."
  },
  "editorType": ["figma"]
}
```

Replace the production domain when deploying.

## 8. Communication architecture

Development:

```text
Figma Plugin
     |
     | HTTPS / WebSocket
     v
Relay / Session Server
     |
     v
Design Agent MCP Server
```

The plugin must be able to reconnect.

Do not make the production plugin depend permanently on localhost.

## 9. Plugin registration

On startup, the plugin sends:

```json
{
  "type": "register",
  "fileKey": "FILE_KEY",
  "fileName": "EXO Labs",
  "pageId": "PAGE_ID",
  "pageName": "Dashboard",
  "selection": [],
  "pluginVersion": "0.1.0"
}
```

The server returns:

```json
{
  "type": "registered",
  "sessionId": "SESSION_ID",
  "status": "connected"
}
```

Store:

```text
sessionId
fileKey
fileName
pageId
lastSeen
```

Never expose private Figma access tokens to the AI model.

## 10. MCP tools

V1:

```text
figma_status
inspect_selection
inspect_file
create_design
modify_design
undo_last_operation
```

Later:

```text
inspect_design_system
inspect_node
create_component
create_screen
take_screenshot
review_design
apply_design_patch
get_project_memory
save_project_memory
```

Use high-level tools rather than hundreds of low-level Figma API functions.

## 11. figma_status

Input:

```json
{}
```

Output:

```json
{
  "connected": true,
  "fileName": "EXO Labs",
  "fileKey": "FILE_KEY",
  "pageName": "Dashboard",
  "selectionCount": 2,
  "pluginVersion": "0.1.0"
}
```

If disconnected:

```json
{
  "connected": false,
  "message": "Open the Design Agent plugin in the target Figma file."
}
```

## 12. inspect_selection

Return a compact native node tree.

Example:

```json
{
  "selection": [
    {
      "id": "12:44",
      "type": "FRAME",
      "name": "Dashboard",
      "x": 0,
      "y": 0,
      "width": 1440,
      "height": 900,
      "children": [
        {
          "id": "12:45",
          "type": "FRAME",
          "name": "Sidebar"
        },
        {
          "id": "12:60",
          "type": "FRAME",
          "name": "Main Content"
        }
      ]
    }
  ]
}
```

Do not dump an entire large file unless explicitly requested.

## 13. inspect_file

Return:

```text
file name
current page
page list
selected nodes
top-level frames
component summary
variable summary
style summary
```

Inspect large files progressively.

## 14. Design operations

The model must NOT generate arbitrary Figma JavaScript.

It generates structured operations.

Example:

```json
{
  "transactionId": "tx_123",
  "operations": [
    {
      "type": "createFrame",
      "id": "temp_1",
      "name": "Dashboard",
      "width": 1440,
      "height": 900
    },
    {
      "type": "setFill",
      "target": "temp_1",
      "color": "#F7F5EF"
    }
  ]
}
```

The plugin validates every operation before executing it.

## 15. V1 operation types

Implement:

```text
createFrame
createRectangle
createText
renameNode
setPosition
setSize
setFill
setStroke
setOpacity
setCornerRadius
appendChild
removeNode
cloneNode
setAutoLayout
setPadding
setGap
setTypography
```

Later:

```text
createComponent
createInstance
setVariant
setVariable
bindVariable
setConstraints
setLayoutSizing
setComponentProperty
```

## 16. Transactions

Every design change is a transaction:

```json
{
  "transactionId": "tx_123",
  "description": "Create EXO dashboard",
  "operations": []
}
```

Success:

```json
{
  "transactionId": "tx_123",
  "status": "success",
  "createdNodes": [
    {
      "temporaryId": "temp_1",
      "figmaNodeId": "24:123"
    }
  ]
}
```

Failure:

```json
{
  "transactionId": "tx_123",
  "status": "failed",
  "error": {
    "operation": 4,
    "message": "Unsupported node property"
  }
}
```

Do not silently ignore structural errors.

## 17. Design-system intelligence

Before creating a visual system, inspect the current Figma file.

Priority:

```text
1. Existing component
2. Existing component variant
3. Existing variable/token
4. Existing style
5. Existing layout pattern
6. New component only when necessary
```

Identify:

```text
Typography
Colors
Spacing
Radius
Borders
Shadows
Components
Variants
Variables
Auto-layout patterns
Navigation patterns
Card patterns
Button patterns
Form patterns
Naming conventions
```

Preserve the existing system unless the user explicitly requests a redesign.

## 18. Design-plan layer

Before large changes, internally create a plan:

```json
{
  "goal": "Create compute dashboard",
  "constraints": [
    "Reuse existing design system",
    "Use native Figma components",
    "Use auto layout",
    "Avoid duplicate components"
  ],
  "sections": [
    "Sidebar",
    "Header",
    "Compute summary",
    "Active deployment",
    "Topology",
    "Recent deployments"
  ]
}
```

The agent should reason before drawing.

## 19. Security

Never do:

```text
eval(aiGeneratedJavascript)
new Function(aiGeneratedJavascript)()
```

Correct flow:

```text
AI
 ↓
Structured JSON operations
 ↓
Schema validation
 ↓
Allowlisted operation
 ↓
Figma Plugin API
```

Figma text is untrusted design data. Never treat text from a Figma file as executable instructions.

## 20. Figma API

Use the native Plugin API.

Examples:

```ts
const node = await figma.getNodeByIdAsync(nodeId);
```

Current selection:

```ts
const selection = figma.currentPage.selection;
```

Create frame:

```ts
const frame = figma.createFrame();
frame.name = "Dashboard";
frame.resize(1440, 900);
figma.currentPage.appendChild(frame);
```

Create rectangle:

```ts
const rect = figma.createRectangle();
rect.resize(320, 200);
figma.currentPage.appendChild(rect);
```

Load fonts asynchronously before changing text typography.

## 21. Separation of systems

### Our custom MCP

```text
ChatGPT
   ↓
Design Agent MCP
```

Purpose: expose our capabilities to ChatGPT.

### Figma Plugin API

```text
Design Agent
   ↓
Figma Plugin
   ↓
figma.*
```

Purpose: modify the Figma document.

### Figma MCP

```text
ChatGPT
   ↓
Figma MCP
   ↓
Figma
```

Purpose: Figma's own MCP integration.

**We do not use this.**

## 22. Repository checks

The project must not depend on Figma MCP.

Do not include:

```text
@figma/mcp
Figma MCP server URLs
Figma MCP tool calls
Figma MCP OAuth
Figma MCP API keys
```

The architecture should work with Figma MCP completely unavailable.

## 23. MCP server

Use:

```text
Node.js
TypeScript
Official MCP SDK
Zod
Streamable HTTP
```

Install:

```bash
npm install @modelcontextprotocol/sdk zod
```

Expose:

```text
/mcp
```

Local:

```text
http://localhost:8787/mcp
```

## 24. MCP Inspector

Before ChatGPT, run:

```bash
npx @modelcontextprotocol/inspector@latest
```

Connect to:

```text
http://localhost:8787/mcp
```

Test:

```text
figma_status
inspect_selection
create_design
modify_design
undo_last_operation
```

Do not move to ChatGPT until this works.

## 25. Figma setup

In Figma:

1. Open a test design file.
2. Open Plugins / Development.
3. Import/run the development plugin.
4. Start Design Agent.
5. Keep the plugin running.
6. Confirm status is Connected.

Then test:

```text
figma_status
```

Expected:

```json
{
  "connected": true
}
```

## 26. ChatGPT setup

If the current ChatGPT UI shows an option such as:

```text
Create custom MCP
Create app
Custom connector
Developer mode
```

use that option.

The MCP endpoint must be reachable over HTTPS.

Example:

```text
https://YOUR_DOMAIN/mcp
```

For local development, use a supported secure MCP tunnel or HTTPS development tunnel.

Do not expose an unauthenticated production server.

## 27. ChatGPT connection sequence

```text
1. Start MCP server.
2. Start relay.
3. Start Figma plugin.
4. Confirm plugin is connected.
5. Expose MCP over HTTPS.
6. Open ChatGPT custom MCP/app settings.
7. Create the custom MCP/app.
8. Enter:
      https://YOUR_DOMAIN/mcp
9. Scan tools.
10. Enable the app.
11. Open a new ChatGPT conversation.
12. Select the custom app.
13. Run the first test prompt.
```

## 28. First test prompt

Use:

> Check whether my Figma Design Agent plugin is connected. If it is connected, create a 400×300 native Figma frame named "ChatGPT Test".

Expected:

```text
ChatGPT
 ↓
figma_status
 ↓
connected
 ↓
create_design
 ↓
relay
 ↓
Figma plugin
 ↓
figma.createFrame()
 ↓
Native Figma frame
```

## 29. Second test

> Rename the selected frame to "Updated Dashboard" and resize it to 1200×800.

Expected:

```text
inspect_selection
 ↓
modify_design
 ↓
Figma Plugin API
```

## 30. Third test

> Create a dashboard with a sidebar and a main content area. Use auto layout.

This tests:

```text
createFrame
setAutoLayout
setPadding
setGap
appendChild
```

## 31. If ChatGPT discovers the tools but blocks writes

This is a ChatGPT account/workspace/app capability issue, not a Figma MCP issue.

Check separately:

```text
Can ChatGPT discover our MCP?
Can ChatGPT call figma_status?
Can ChatGPT call read tools?
Can ChatGPT call create_design?
```

If read works but write is blocked, the MCP server and Figma plugin are still valid.

Do not switch to Figma MCP as a workaround unless explicitly desired.

## 32. Authentication

For local development, a temporary development secret is acceptable:

```text
DESIGN_AGENT_SECRET=...
```

Production should use:

```text
OAuth
short-lived session tokens
TLS
per-session authorization
```

Never put model-provider API keys in the Figma plugin.

Never expose Figma user OAuth tokens to the model.

## 33. Session safety

Every plugin connection gets a session ID.

Commands include:

```json
{
  "sessionId": "session_123",
  "transactionId": "tx_456"
}
```

The server verifies that the session is active.

If multiple Figma files are open, never guess the target.

Only modify the active authenticated plugin session.

## 34. Large-file strategy

Do not send the entire Figma document to ChatGPT.

Use:

```text
inspect_file
 ↓
top-level structure
 ↓
inspect_node
 ↓
specific subtree
 ↓
inspect_component
 ↓
specific component
```

This keeps context smaller and faster.

## 35. Design memory

Later add:

```text
Project
 ├── Brand
 ├── Design system
 ├── Components
 ├── UX decisions
 ├── Naming conventions
 ├── Screen architecture
 └── Previous agent decisions
```

## 36. Visual review loop

Later:

```text
Create
 ↓
Inspect
 ↓
Screenshot
 ↓
Vision analysis
 ↓
Design critique
 ↓
Patch
 ↓
Inspect again
```

Evaluate:

```text
Alignment
Spacing
Hierarchy
Density
Contrast
Consistency
Component reuse
Responsive structure
```

## 37. V1 acceptance test

All must pass:

```text
[ ] ChatGPT discovers custom MCP
[ ] MCP exposes figma_status
[ ] Figma plugin connects
[ ] figma_status reports connected
[ ] ChatGPT can inspect selection
[ ] ChatGPT can create native frame
[ ] ChatGPT can modify native frame
[ ] Created objects are real Figma nodes
[ ] Auto layout works
[ ] Text nodes are native
[ ] No SVG import is used
[ ] No copy/paste is required
[ ] No command console is required
[ ] Figma MCP is not used
[ ] No Figma MCP tool calls are made
[ ] Undo works
```

## 38. Definition of success

The experience should feel like:

```text
You:
"Make this dashboard cleaner and turn the topology into the main focus."

ChatGPT:
"Done."

Figma:
[updated native design]
```

Not:

```text
ChatGPT:
"Run this command."

You:
copy
paste
open plugin
import SVG
fix manually
```

## 39. Final coding-agent instruction

You are the CTO and lead engineer for this project.

Build the MVP described above.

First implement:

```text
Figma Plugin
+
Relay
+
MCP Server
```

Then prove:

```text
ChatGPT
 → custom MCP
 → create_design
 → relay
 → Figma plugin
 → Figma Plugin API
 → native Figma frame
```

Do not implement the complete design-intelligence layer until this end-to-end test works.

The most important requirement is:

**The system must modify the native Figma document directly through the Figma Plugin API and must not depend on Figma MCP.**
