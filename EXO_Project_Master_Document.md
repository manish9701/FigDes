# EXO Labs — Product + UX + Design Master Document

## 0. Document purpose

This document is the single source of truth for the EXO product direction, UX architecture, interface system, screen inventory, interaction rules, visual language, enterprise model, and implementation intent.

The Figma project is the visual source. This file is the product/design source.

---

# 1. Product definition

## EXO

**EXO is the operating layer for AI compute you own.**

EXO discovers computers on a local network, understands their hardware and network topology, distributes model shards across available machines, and exposes the resulting compute through familiar APIs.

The central idea is not “manage a cluster.”

The central idea is:

> Your machines become one AI computer.

---

# 2. Product thesis

Traditional local-AI tooling makes the user think about:

```text
device
GPU
memory
network
model files
placement
runtime
API
```

EXO should absorb that complexity.

The user should mostly think about:

```text
What do I want to run?
How well can my system run it?
How do I use it?
```

EXO handles:

```text
discovery
network understanding
compatibility
placement
sharding
routing
runtime management
```

---

# 3. Core product principles

## Automatic discovery

Devices discover one another automatically.

Do not make the primary flow:

```text
Add device
Enter IP
Choose network
Pair
Scan QR code
```

Instead:

```text
EXO found 4 devices.
```

---

## Automatic topology understanding

EXO reads:

```text
memory
compute capability
network links
bandwidth
latency
availability
```

Network information is state, not configuration.

---

## Automatic model placement

Users choose the model.

EXO decides where model shards should go.

The interface explains the decision rather than forcing manual placement.

---

## Compute-first interface

EXO is not primarily:

```text
chat app
analytics dashboard
monitoring SaaS
```

It is a compute operating layer and should feel like an instrument for understanding and controlling a distributed AI system.

---

# 4. Main user flow

```text
Discover
   ↓
Understand compute
   ↓
Choose model
   ↓
Check fit
   ↓
Download / prepare
   ↓
Deploy
   ↓
Observe runtime
   ↓
Connect external tools
```

In product terms:

```text
Discover → Fit → Prepare → Deploy → Measure → Use
```

---

# 5. Information architecture

## Consumer / individual

```text
Home
Compute
Models
Deployments
Activity / Operations
Integrations
Settings
```

## Enterprise

```text
Organization
  └── Region
       └── Site
            └── Pool
                 └── Cluster
                      └── Node
                           └── Deployment
```

Heterogeneous hardware should be represented through capabilities instead of simplistic device labels.

---

# 6. Screen inventory

## 01 — Home / AI computer

### Primary question

> Is my AI computer ready, and what should I run next?

### Main content

```text
system health
cluster memory
online devices
running deployments
recommended model
active deployment
recent actions
```

### Main visual

The cluster as one system rather than four independent device cards.

### Primary action

Run or inspect the highest-value model recommendation.

---

# 7. Screen 02 — Compute / Topology

### Primary question

> What hardware is EXO seeing?

### Main visual

A topology map showing:

```text
EXO
nodes
connections
latency
bandwidth
health
available memory
```

### Interaction

Selecting a node opens contextual detail.

The user never chooses a network interface manually.

---

# 8. Screen 03 — Models / Library

### Primary question

> What can I run well?

### Model row information

```text
model
purpose
context length
memory required
recommended device(s)
fit state
installation state
speed estimate
action
```

### Ranking

Model ordering should consider:

```text
memory fit
network quality
hardware compatibility
purpose
current runtime load
```

---

# 9. Screen 04 — Model fit

### Primary question

> Can I run this model?

### Required hierarchy

```text
Model
 ↓
Fit verdict
 ↓
Why
 ↓
Memory budget
 ↓
Recommended placement
 ↓
Compatibility
 ↓
Primary action
```

### Important UX rule

Never make “model fits” a vague green badge only.

The user should understand why EXO believes the model will work.

---

# 10. Screen 05 — Model download / install

### Primary question

> Is the model ready?

### Pipeline

```text
Download
   ↓
Verify
   ↓
Prepare
   ↓
Place
   ↓
Serve
```

The user should see:

```text
progress
speed
storage
source
verification
queue
failed items
resume state
```

Downloads should resume automatically.

---

# 11. Screen 06 — Deployment

### Primary question

> Where is the model running?

### Main visual

Model-to-node placement.

Example:

```text
Qwen3
 ├── shard 01 → Studio North
 ├── shard 02 → Studio South
 └── shard 03 → Aria MacBook
```

Show why the placement exists:

```text
memory
bandwidth
latency
accelerator
availability
```

---

# 12. Screen 07 — Performance / Health

### Primary question

> Is the system performing well?

### Main metrics

```text
throughput
time to first token
latency
memory pressure
queue pressure
errors
node utilization
connection health
```

### Visual style

Use real charts and system relationships rather than four large KPI tiles whenever possible.

---

# 13. Screen 08 — Integrations / EXO Profiles

### Primary question

> How do I use EXO from other tools?

### Core concept

```text
EXO Profile
    ↓
Model selection / routing
    ↓
Local endpoint
    ↓
External client
```

### Example profiles

```text
EXO AUTO
EXO FAST
EXO CODE
EXO REASON
EXO VISION
```

Profiles abstract model choice and placement from the user.

---

# 14. API / integration model

EXO should support familiar interfaces:

```text
OpenAI Chat Completions
OpenAI Responses
Claude Messages
Ollama-compatible APIs
```

### Conceptual API architecture

```text
Client
  ↓
EXO Provider
  ↓
Model Profile
  ↓
Router
  ↓
Placement engine
  ↓
Cluster runtime
```

---

# 15. Coding-agent integration

EXO should work naturally with tools such as coding agents.

The user should not need to understand the underlying cluster.

A developer should be able to configure:

```text
Endpoint
API compatibility
Profile
Authentication
```

Then use EXO like an ordinary model provider.

---

# 16. Consumer experience

Consumer users need:

```text
simple defaults
automatic discovery
automatic placement
clear recommendations
minimal configuration
```

The system should answer:

> “Can I run this?”

before presenting unnecessary complexity.

---

# 17. Developer experience

Developers need access to:

```text
model configuration
API endpoints
runtime state
latency
logs
placement explanation
hardware capability
```

The UI should progressively disclose complexity rather than hiding it permanently.

---

# 18. Enterprise experience

Enterprise adds:

```text
organization
users
roles
sites
fleets
clusters
hardware pools
policies
observability
access controls
```

### Enterprise deployment hierarchy

```text
Organization
 ↓
Site
 ↓
Pool
 ↓
Cluster
 ↓
Node
 ↓
Deployment
```

---

# 19. Enterprise fleet

Fleet view should answer:

```text
What do we have?
Where is it?
What is healthy?
What is overloaded?
Which pools are available?
Which deployments are active?
```

Avoid a generic enterprise analytics dashboard.

The fleet should still feel like infrastructure tooling.

---

# 20. Enterprise policy layer

Future policy examples:

```text
Allowed models
Maximum resource usage
Preferred hardware pools
Required encryption
Data locality
API access rules
User permissions
Deployment approval
```

---

# 21. Visual design system

## Canvas

```text
#F7F5EF
```

## Surface

```text
#FFFDF9
```

## Sidebar

```text
#ECE9E1
```

## Text

```text
#242521
```

## Muted

```text
#6F716A
```

## Border

```text
#D9D6CD
```

## Action yellow

```text
#F2C94C
```

## Soft yellow

```text
#FFF3BE
```

## Health green

```text
#2D7A4D
```

## Health soft

```text
#E6F3E9
```

## Runtime dark

```text
#343631
```

---

# 22. Typography

Use:

```text
Inter
JetBrains Mono
```

### Inter

Interface and editorial hierarchy.

### JetBrains Mono

Use for:

```text
latency
bandwidth
memory
ports
URLs
API endpoints
hashes
model identifiers
technical metrics
```

Suggested ramp:

```text
Page title      24–32
Section title   18–24
Body            13–14
Label           10–12
Caption         9–11
Technical       10–12 mono
```

---

# 23. Layout system

Base:

```text
8px grid
```

Core spacing:

```text
8
12
16
20
24
32
40
48
64
```

Common desktop shell:

```text
Window chrome: 46px
Sidebar:       216px
Content gap:   20px
Content inset: 20–24px
```

---

# 24. Shape language

Use:

```text
8px radius for controls and compact panels
12px radius for major surfaces
1px borders
very limited shadows
```

Avoid:

```text
999px pills everywhere
heavy card elevation
excessive rounded rectangles
```

Status pills are an exception when they communicate state.

---

# 25. EXO visual identity

The name EXO comes from the idea of the **exocortex** — intelligence extending outside the biological core.

The public brand does not need to literally use “exocortex.”

The visual system should communicate:

```text
external intelligence
connection
distributed cognition
systems becoming one
```

The strongest logo direction is a **Connected X** concept:

```text
many nodes
   ↓
connected pathways
   ↓
X / EXO
   ↓
one intelligence layer
```

Avoid a literal brain icon.

---

# 26. Interaction language

## Active navigation

Use the established warm-yellow active state.

## Primary button

Yellow.

## Secondary button

White or neutral surface with rule.

## Runtime action

Dark where stronger emphasis is required.

## Health

Green.

## Warning

Warm orange/brown.

## Error

Muted red with text context.

Never communicate important state with colour alone.

---

# 27. Error and edge states

Every important workflow needs:

```text
Loading
Empty
Unavailable
Failed
Interrupted
Retrying
Success
Degraded
Offline
Partial fit
No compatible hardware
```

### Example

“No compatible device” should explain:

```text
Required: 48 GB
Available: 32 GB
Fastest eligible device: 24 GB
Recommendation: use a smaller model
```

Not simply:

> Not supported.

---

# 28. Data model concepts

Core entities:

```text
Device
Hardware capability
Connection
Topology
Model
Model artifact
Model profile
Placement
Shard
Deployment
Endpoint
Integration
Organization
Site
Pool
Cluster
User
Role
Policy
Telemetry event
```

---

# 29. Device model

A device should expose:

```text
name
platform
CPU
GPU / accelerator
unified memory
storage
network interfaces
bandwidth
latency
health
availability
capabilities
```

---

# 30. Model model

Each model should expose:

```text
name
provider
parameters
context length
quantization
memory requirement
capabilities
modalities
license
artifact state
fit score
recommended placement
```

---

# 31. Deployment model

Deployment state:

```text
planning
downloading
verifying
preparing
placing
starting
running
degraded
stopped
failed
```

Deployment data:

```text
model
profile
nodes
shards
endpoint
throughput
latency
memory
errors
start time
```

---

# 32. Performance system

Telemetry should be grouped into:

```text
Compute
Memory
Network
Runtime
Errors
```

Example:

```text
42 tok/s
620 ms TTFT
178 GB memory
8 μs network latency
0.4% errors
```

---

# 33. Current V4 Figma frames

```text
67:1371 — V4 · 01 Home · AI computer
67:1589 — V4 · 02 Compute · Topology
67:1785 — V4 · 03 Models · Library
67:1993 — V4 · 04 Model fit · Qwen2.5 Coder 72B
67:2216 — V4 · 05 Download · Model install
67:2425 — V4 · 06 Deployment · qwen-coder-local
67:2648 — V4 · 07 Performance · qwen-coder-local
67:2876 — V4 · 08 Integrations · EXO Profiles
67:3097 — V4 · Design Guide · Source of Truth
```

The V4 screens were derived from the older 15-screen EXO system, which remains the strongest visual benchmark currently in the file.

---

# 34. Older reference screens

```text
01 Onboarding · Add device
02 Home · Compute overview
03 Devices
04 Device detail
05 Models
06 Model detail · Can I run this?
07 Download state
08 Deployment setup
09 Deployment detail
10 Performance · Health
11 Topology
12 Integrations · EXO Profiles
13 Enterprise overview
14 Enterprise fleet
15 Enterprise deployment
```

These should be treated as the historical design benchmark when creating new screens.

---

# 35. V4 design direction

V4 should evolve the older screens rather than replace their visual maturity.

Direction:

```text
Established EXO desktop shell
+
stronger decision-first information architecture
+
more spatial system visualizations
+
less generic dashboard composition
+
clearer model-fit logic
+
more explicit placement explanation
+
stronger technical instrumentation
```

---

# 36. What should not return

```text
Generic SaaS dashboards
Three-card KPI walls as the primary structure
Chat as the main screen
Manual device pairing
Manual network selection
Manual shard dragging as the default flow
Overly decorative AI gradients
Excessive rounded cards
Unexplained green “success” badges
```

---

# 37. V4 quality bar

A screen is finished only when:

```text
1. The primary decision is obvious.
2. The visual hierarchy has a clear dominant relationship.
3. The information density is purposeful.
4. The system feels like EXO, not a generic admin template.
5. Technical information is visually distinct.
6. User actions are obvious.
7. Important states are accessible without relying on colour alone.
8. Topology / placement / runtime relationships are understandable.
9. The screen has been rendered and visually inspected.
10. Structural QA is clean.
```

---

# 38. Recommended build process

```text
Research
 ↓
Define decision
 ↓
Plan composition
 ↓
Create using semantic components
 ↓
Populate real data
 ↓
Render
 ↓
Visual review
 ↓
Structural review
 ↓
Accessibility review
 ↓
Refine
 ↓
Final render
```

Never jump directly from a feature list to rectangles.

---

# 39. Current plugin constraint

Design Agent 3 is now the preferred authoring tool for this project, but its current implementation still has important limitations:

```text
dynamic-page component access
weak component discovery
lack of real project variables/styles
raw-ID targeting
runtime primitive schema mismatch
limited visual-diff workflow
limited semantic topology controls
```

See:

`EXO_Plugin_Upgrade_Spec.md`

for the required plugin work.

---

# 40. Product north star

EXO should make the user feel:

> “I have one AI computer.”

Not:

> “I am managing a bunch of machines.”

That distinction should guide the product, architecture, UX, and visual design decisions going forward.
