# Room Autonomy Design Spec — Fresh Start

Status: Draft v0.12
Date: 2026-02-23

## Context

NeoKai has a solid human-AI app with multi-session/worktree support. We've been trying to add room autonomy (agents working toward room goals autonomously while allowing human intervention) but the current implementation doesn't work. The architecture drifted from the original "neo" design to a complex "room self agent" design with too many moving parts.

**The core problem**: A room has goals. Work should happen on those goals continuously and autonomously. Humans should be able to intervene at any point.

## Why the Current Design Doesn't Work

The current `RoomSelfService` uses an **LLM as the orchestrator** — a persistent Claude session that receives injected messages and is expected to call tools (`room_create_task`, `room_spawn_worker`, etc.). This fails because:

1. **LLM orchestration is unreliable** — doesn't consistently call the right tools at the right time
2. **Too many states** — 7 lifecycle states with complex transition rules
3. **Double LLM cost** — orchestrator runs constantly alongside workers
4. **Event soup** — complex event subscription/unsubscription patterns
5. **Mixed responsibilities** — ~1300 lines handling everything

## The Fundamental Insight

> A room is like a small organization. You need someone thinking about goals and strategy (high-level), and someone doing the detailed work (execution). No one can hold everything in their head. These two levels need a mechanism to work together.

---

## The Core Abstraction: Craft → Lead Loop

Everything in this system follows the same meta-process. **Planning, coding, researching, designing** — they're all just activities. The abstraction is always the same: one agent crafts, one agent leads and gives feedback.

```mermaid
graph LR
    A[Something needs doing] --> B["Craft Agent works on it<br/>(any activity: planning, coding,<br/>research, design)"]
    B --> C["Craft Agent reaches terminal state<br/>(result / error / question)"]
    C --> D["Room Runtime observes terminal state,<br/>collects all assistant messages<br/>from Craft's last turn"]
    D --> E["Lead Agent receives Craft output<br/>as user message, reviews"]
    E -->|"send_to_craft(feedback)"| B
    E -->|"complete_task(summary)"| F[Done]
    E -->|"escalate(reason)"| G[Human intervenes]
    G -->|guidance to Craft| B
    G -->|decision to Lead| E
```

The **Craft → Lead loop** is universal:

| Activity | Craft Agent does | Lead Agent does |
|---|---|---|
| **Planning** | Examines codebase, proposes task breakdown | Reviews plan quality, suggests adjustments |
| **Coding** | Implements feature, writes tests | Reviews code, checks correctness, requests fixes |
| **Research** | Investigates options, gathers findings | Evaluates findings, asks deeper questions |
| **Design** | Drafts architecture, creates specs | Reviews design, identifies gaps, validates approach |
| **PR Review** | Addresses review comments, pushes fixes | Reads diff, leaves feedback, approves/requests changes |

The loop is always between two parties: a **Craft Agent** and a **Lead Agent**. The Lead can be an agent, a human, or both, or a process involving many parties (like a PR review).

### The (Craft, Lead) Pair

Every task in the system creates a **(Craft, Lead) pair** — two agent sessions that collaborate:

```mermaid
graph LR
    subgraph TaskPair["Task: Implement auth endpoint"]
        Craft["Craft Agent<br/>(AgentSession)"]
        Lead["Lead Agent<br/>(AgentSession)"]
    end

    RT["Room Runtime"]

    Craft -->|"reaches terminal state"| RT
    RT -->|"sends all Craft messages<br/>from last turn"| Lead
    Lead -->|"send_to_craft(feedback)<br/>routed through Runtime"| RT
    RT -->|"injects as user message"| Craft
    Lead -->|"complete_task() / fail_task()<br/>routed through Runtime"| RT
    Human -->|joins conversation| Craft
    Human -->|provides guidance| Lead
```

- **Craft Agent**: Full AgentSession with activity-appropriate tools. It does the work and naturally reaches a terminal state when done. Planning Craft Agents additionally get `create_task` tools for writing tasks to DB — this is an activity-specific tool, not a completion signal.
- **Lead Agent**: Full AgentSession that reviews Craft Agent's output. Created once per task and **reused across all feedback iterations** (maintains full review context). Room Runtime sends all Craft Agent assistant messages from its last turn as a user message to Lead. Lead evaluates and uses tools to respond.
- **Room Runtime**: All message routing between Craft and Lead goes through Runtime. Runtime observes session terminal states, collects messages, and routes them. Human messages to Craft are **queued** while Lead is actively reviewing (MVP).
- **Human**: Can participate at any time — send messages to Craft Agent directly, or provide guidance to Lead Agent.

### Message Routing Through Room Runtime

All inter-agent communication is routed through the Room Runtime:

```mermaid
sequenceDiagram
    participant C as Craft Agent
    participant RT as Room Runtime
    participant L as Lead Agent
    participant H as Human

    RT->>C: Create session, send task description
    C->>C: Works on task...
    C-->>RT: Session reaches terminal state (result)
    Note over RT: Collects all Craft assistant<br/>messages from last turn
    RT->>L: User message with Craft's output
    L->>L: Evaluates against goal/task

    alt Accepted
        L->>L: Calls complete_task(summary) tool
        Note over L,RT: Tool routes through Runtime
        RT->>RT: Updates task status in DB
    else Needs more work
        L->>L: Calls send_to_craft(feedback) tool
        Note over L,RT: Tool routes through Runtime
        RT->>C: Injects feedback as user message
        C->>C: Continues working...
        C-->>RT: Reaches terminal state again
        Note over RT: Collects latest messages
        RT->>L: User message with Craft's update
    else Needs human
        L->>L: Calls escalate(reason) tool
        Note over L,RT: Runtime notifies human
        H->>C: Human sends message to Craft
        C->>C: Incorporates guidance...
        C-->>RT: Reaches terminal state
        RT->>L: User message with Craft's update
    end
```

**Why all routing goes through Runtime**:
1. Runtime tracks state — knows when to re-observe Craft's next terminal state
2. All inter-agent messages flow through one place — auditable
3. Runtime can enforce guard rails (e.g., max feedback iterations)
4. Consistent routing pattern in both directions

### Lead Agent Tools

Lead Agent has a focused tool set, all routed through Room Runtime:

| Tool | Purpose | Runtime action |
|---|---|---|
| `send_to_craft(message)` | Send feedback/follow-up to Craft Agent | Injects as user message into Craft session |
| `complete_task(summary)` | Accept the work, mark task done | Updates task status in DB |
| `fail_task(reason)` | Task is not achievable | Updates task status, notifies Room Agent |
| `escalate(reason)` | Flag for human attention | Notifies human via Room Agent / UI |
| `read_craft_messages(limit, offset?)` | Read Craft messages from previous iterations | Returns messages from Craft session |
| `run_verification(command)` | Run tests/linting independently of Craft | Executes command, returns output |

### Task Chat View: Sub-Agent Blocks

The (Craft, Lead) pair is rendered in the UI as a **single conversation** using **sub-agent blocks**. Each agent's complete turn (thinking + tool uses + result) is grouped into one collapsible block:

```
┌─────────────────────────────────────────────────┐
│ Task: Implement auth endpoint                    │
├─────────────────────────────────────────────────┤
│                                                  │
│ ┌─ 🔨 Craft Agent ────────────────────────────┐ │
│ │ I'll start by examining the existing route   │ │
│ │ structure...                                 │ │
│ │ ▸ Read src/routes/index.ts                   │ │
│ │ ▸ Read src/routes/auth.ts                    │ │
│ │ ▸ Edit src/routes/auth.ts (+42 lines)        │ │
│ │ ▸ Edit src/middleware/validate.ts (+18 lines) │ │
│ │                                              │ │
│ │ Created the POST /api/auth/login endpoint    │ │
│ │ with JWT token generation.                   │ │
│ └──────────────────────────────────────────────┘ │
│                                                  │
│ ┌─ 👁 Lead Agent ─────────────────────────────┐ │
│ │ The endpoint looks good but you missed       │ │
│ │ input validation. Add zod schema validation  │ │
│ │ for the request body.                        │ │
│ │ ▸ send_to_craft("Add zod schema...")         │ │
│ └──────────────────────────────────────────────┘ │
│                                                  │
│ ┌─ 🔨 Craft Agent ────────────────────────────┐ │
│ │ Good catch. Adding zod validation now...     │ │
│ │ ▸ Edit src/routes/auth.ts (+12 lines)        │ │
│ │                                              │ │
│ │ Added zod schema for login request body.     │ │
│ └──────────────────────────────────────────────┘ │
│                                                  │
│ 👤 Human: Also make sure to rate-limit the      │
│    login endpoint                                │
│                                                  │
│ ┌─ 🔨 Craft Agent ────────────────────────────┐ │
│ │ Adding rate limiting...                      │ │
│ │ ▸ Edit src/middleware/rate.ts (+25 lines)     │ │
│ │ ▸ Edit src/routes/auth.ts (+3 lines)         │ │
│ │                                              │ │
│ │ Added rate limiting middleware to the login   │ │
│ │ endpoint (max 5 attempts per minute).        │ │
│ └──────────────────────────────────────────────┘ │
│                                                  │
│ ┌─ 👁 Lead Agent ─────────────────────────────┐ │
│ │ Looks complete. All requirements met.        │ │
│ │ ▸ complete_task("Implemented auth endpoint   │ │
│ │   with JWT, validation, and rate limiting")  │ │
│ └──────────────────────────────────────────────┘ │
│                                                  │
│ ✅ Task completed                                │
└─────────────────────────────────────────────────┘
```

**Rendering rules**:
- **Craft Agent turns** → sub-agent block with 🔨 icon, assistant color scheme. Each complete turn (all thinking + tool uses + result) is one collapsible block.
- **Lead Agent turns** → sub-agent block with 👁 icon, distinct color scheme. Each complete turn is one block.
- **Human messages** → standard user message style (not in a sub-agent block)
- **Turns are interleaved chronologically** from both sessions

**Behind the scenes**:
- Craft Agent session: receives Lead feedback and Human messages as user messages
- Lead Agent session: receives Craft output (all assistant messages from last turn) as user messages from Runtime
- Human messages to Craft are real user messages in the Craft session
- Lead's `send_to_craft()` tool calls route through Runtime → injected as user messages in Craft session

---

## Design: The Room Runtime

### Architecture Overview

```mermaid
graph TB
    subgraph Room["Room Runtime (deterministic scheduler)"]
        direction TB
        Tick[Tick Loop]
        Rules[Scheduling Rules]
        Router[Message Router]
    end

    subgraph Agents["Agent Sessions"]
        RoomAgent["Room Agent<br/>(always-on, human-facing)<br/>The department head"]

        subgraph Task1["Task 1: (Craft, Lead) pair"]
            Craft1["Craft Agent"]
            Lead1["Lead Agent"]
        end

        subgraph Task2["Task 2: (Craft, Lead) pair"]
            Craft2["Craft Agent"]
            Lead2["Lead Agent"]
        end
    end

    Human["Human Operator"]

    Human <-->|"chat, commands,<br/>goal/task management"| RoomAgent
    RoomAgent -->|"creates goals/tasks<br/>via tools"| Room
    Room -->|"spawns (Craft, Lead) pair"| Task1
    Room -->|"spawns (Craft, Lead) pair"| Task2
    Craft1 -->|"terminal state → Runtime collects messages"| Room
    Room -->|"Craft output as user msg"| Lead1
    Lead1 -->|"send_to_craft / complete_task<br/>routed through Runtime"| Room
    Room -->|"feedback as user msg"| Craft1
    Craft2 -->|terminal state| Room
    Room -->|"Craft output"| Lead2
    Lead2 -->|"tools route through Runtime"| Room
    Human -->|"joins task conversation"| Craft1
    Human -->|"joins task conversation"| Craft2
```

### The Actors

#### 1. Room Runtime (deterministic code — no LLM)

The Room Runtime is the **scheduler and router**. It's a simple loop driven by triggers (timer, events). It makes no decisions about WHAT work to do — it decides WHEN to create (Craft, Lead) pairs, routes messages between them, and executes Lead Agent tool calls.

**Scheduling rules (hardcoded, not LLM-decided)**:
- A goal needs planning when: it's active AND has no pending/in-progress/draft/escalated tasks AND `planning_attempts < max_planning_attempts` (default: 3)
- A task is ready to execute when: status is `pending`
- Planning is itself a task: "Plan goal X" → creates a (Craft, Lead) pair where Craft Agent plans
- If all tasks for a goal have `failed` and `planning_attempts >= max_planning_attempts`, the goal enters `needs_human` status — Runtime stops auto-planning and notifies human via Room Agent
- **`needs_human` recovery**: Human can mark a `needs_human` goal back to `active` via Room Agent's `update_goal` tool. This resets `planning_attempts` to 0, allowing Runtime to re-plan on the next tick

**Routing rules**:
- When Craft Agent reaches terminal state → collect all assistant messages from its last turn → send to Lead Agent as user message. **If a human sent messages to Craft during this iteration**, include them in the forwarding with a note: `[Human intervened: "{message}"]` so Lead understands why Craft may have changed direction
- When Craft Agent emits `AskUserQuestion` → route question to Lead Agent first. Lead can answer via `send_to_craft()` or `escalate()` to human
- When Lead Agent calls `send_to_craft()` → inject message into Craft Agent session as user message
- When Lead Agent calls `complete_task()` / `fail_task()` → update task in DB → trigger next tick
- When human sends message to Craft during Lead review → queue message until Lead's current review cycle completes. **Delivery rules per Lead terminal action**:
  - `send_to_craft()` → deliver queued human messages to Craft after Lead's feedback
  - `complete_task()` / `fail_task()` → surface queued messages to Room Agent as "FYI: human said X but task already completed/failed"
  - `escalate()` → deliver to Lead along with escalation context (already specified)
- **Human interrupt**: Human can flag a message as "interrupt" in the task chat UI. An interrupt message is **queued and delivered to Lead after its current turn completes**, transitioning the pair to `awaiting_lead` (not `awaiting_human`, because the interrupt IS the human's input — Lead must now act on it). This is a "pause and inject" — Lead retains its full session context and the interrupt is delivered as an additional user message. Lead must re-evaluate with the interrupt context before calling any terminal tool. This handles "Stop, use Preact not React" scenarios where the human wants to redirect, not cancel.
- **Urgent control actions** (`cancel_task`, `pause runtime`) bypass the message queue and execute immediately via Room Agent tools, even if Lead is mid-review

**State**: `running` | `paused`. That's it.

**Tick respects capacity**: Each tick checks `maxConcurrentPairs`. If at capacity, pending tasks wait — no wasted ticks.

#### 2. Room Agent (persistent AgentSession — human-facing)

The Room Agent is the **department head**. It's always available for human conversation. Note: "always available" means the session exists in DB and can be activated on demand — it is NOT a persistently-running LLM consuming tokens. It only costs tokens when the human actually sends a message.

This is a full **AgentSession** with:
- **Tools** for room management (see table below)
- **Access to room context**: goals, tasks, active (Craft, Lead) pairs, room instructions
- **Conversation persisted to DB** (like any other session)
- **Human can chat naturally** — "what's the status?", "prioritize the auth work", "add a goal for..."

**Room Agent Tools**:

| Tool | Purpose |
|---|---|
| `create_goal(title, description)` | Create a new goal for the room |
| `update_goal(goalId, updates)` | Update goal title/description/status |
| `list_goals()` | List all goals with their status |
| `create_task(goalId, title, description)` | Manually create a task for a goal |
| `update_task(taskId, updates)` | Update task details or priority |
| `cancel_task(taskId)` | Kill the active (Craft, Lead) pair, mark task failed |
| `retry_task(taskId)` | Kill current pair, create new (Craft, Lead) pair |
| `get_task_status(taskId)` | Get task state including recent Craft/Lead messages |
| `list_tasks(goalId?)` | List tasks, optionally filtered by goal |
| `get_room_status()` | Overview: runtime state, active pairs, goal/task summary |

The Room Agent is NOT the scheduler. It's the human interface. When the human creates a goal via conversation, the Room Agent calls its tools → data goes to DB → Room Runtime picks it up.

**Context compaction**: Room Agent is a long-lived session that accumulates conversation over days/weeks. It uses the existing AgentSession compaction mechanism. Since Room Agent primarily does CRUD via tools (not deep reasoning), aggressive compaction of older conversations is safe — retain recent exchanges and a summary of older ones. **Important**: recent tool-call results (e.g., newly created goal/task IDs) must survive compaction so the human can reference them in follow-up messages.

**Coordination with Runtime**: Room Agent tools that modify task state (`cancel_task`, `retry_task`, `update_task`) use **optimistic locking** — they check `task.version` before writing, and fail gracefully if Runtime has already transitioned the task. This prevents races where Room Agent cancels a task that Runtime just completed. On conflict, the tool returns the current state so Room Agent can inform the human.

#### 3. Craft Agent (on-demand AgentSession — per task)

The Craft Agent works on a task. It's a standard AgentSession with tools appropriate for the activity:
- **Coding task**: bash, edit, read, write, glob, grep (standard coding tools)
- **Planning task**: read, glob, grep (codebase exploration) + `create_task(goalId, title, description)` for writing tasks to DB. **Tasks created by planning Craft are created with status `draft`** and tagged with `created_by_task_id` pointing to the planning task — Runtime does not schedule them until the planning task itself is `completed` (i.e., Lead has approved the plan), at which point only `draft` tasks matching that `created_by_task_id` are promoted to `pending` in a single DB transaction. If a planning task fails, Runtime cleans up its associated `draft` tasks (marks them `failed`) also in a single transaction.
- **Research task**: read, web search, etc.
- **Design task**: read, write (spec writing)

The Craft Agent has **no special completion-signaling tools**. It doesn't tell the system it's done — the system observes it. Activity-specific tools (like `create_task` for planning) are allowed. When the Craft Agent finishes, the SDK emits a terminal state:
- **Result** (`type: "result"`, `subtype: "success"`) — normal turn completion → Runtime collects output, sends to Lead
- **Error** (`type: "result"`, `subtype: "error"`) — turn failed → Runtime sends error context to Lead
- **AskUserQuestion** (tool use detected via `canUseTool` callback) — session enters `waiting_for_input` → Runtime routes question to Lead first

**Safety net**: A cron job (every 60s) queries DB for all in-progress sessions (stateless, no in-memory index — survives daemon restarts) to catch missed terminal states. Scenarios it guards against:
- SDK event listener detached after hot module reload during development
- Event callback threw an unhandled exception, preventing state transition
- Race condition where session reached terminal state between observer setup and first check
- Process recovered from an uncaught exception that disrupted the event loop

Human can open this session and interact with it directly.

#### 4. Lead Agent (on-demand AgentSession — per task)

The Lead Agent reviews Craft Agent's work. It's a full AgentSession with tools routed through Room Runtime.

**Lifecycle**: Created **once per task** and reused across all feedback iterations. This gives Lead full accumulated context of the entire review history. The Lead session lives for the duration of the task.

**Tools** (all routed through Room Runtime):

| Tool | Purpose |
|---|---|
| `send_to_craft(message)` | Send feedback/follow-up to Craft Agent |
| `complete_task(summary)` | Accept the work, mark task done |
| `fail_task(reason)` | Task is not achievable |
| `escalate(reason)` | Flag for human attention (see Escalation Flow) |
| `read_craft_messages(limit, offset?)` | Read Craft messages from previous iterations for deeper context (e.g., understanding decisions made in earlier turns). Reads Craft session directly (bypasses message queue — intentional, read-only) |
| `run_verification(command)` | Run a verification command (e.g., `bun test`, `bun run check`) independently of Craft. Executes in the **Craft session's working directory/worktree**, not the base branch. Restricted to commands in the room's `allowed_verification_commands` list (default: `["bun test", "bun run check", "bun run typecheck"]`). Not arbitrary bash. Trust, but verify. |

**System prompt includes**:
- The goal description this task belongs to
- The specific task description and acceptance criteria
- Room-level instructions/guidelines (coding standards, review policy, etc.)
- **Activity-specific review instructions** based on `task_type`:
  - `planning`: Review task breakdown quality — are tasks well-scoped, ordered logically, covering the full goal?
  - `coding`: Review code correctness, test coverage, style. Use `run_verification` to confirm tests/linting pass.
  - `research`: Review findings completeness, source quality, actionability.
  - `design`: Review architectural soundness, completeness, alignment with goals.
  - `goal_review`: Verify all task summaries satisfy the original goal.
- Available tools and when to use each
- **Verification requirements**: Before calling `complete_task`, Lead must verify the work meets acceptance criteria. For coding tasks: use `run_verification` to confirm tests pass and linting is clean. Do not accept based solely on Craft's claim of completion. **If `run_verification` fails**, Lead must not attempt to debug or fix the issue — immediately call `send_to_craft()` with the verification output so Craft can address it.
- **AskUserQuestion answer policy**: Lead may answer Craft's questions about architectural choices, code patterns, and technical decisions based on goal/task context. Lead must **always escalate** questions about: secrets/API keys/credentials, subjective human preferences, access permissions, or anything outside the goal/task scope. When escalating a Craft question, Lead must call `escalate()` with the Craft's original question included verbatim in the reason, so the human has full context without needing to read the Craft session.

**Context management**: Each message from Runtime to Lead includes a structured header:
- **Immutable context** (in system prompt): goal, task description, room instructions
- **Rolling context** (accumulated in session): all previous review exchanges
- **Latest delta** (in user message): Craft's output from this iteration, in structured format:
  ```
  [CRAFT OUTPUT] Iteration: {n} / Task: {task_title}
  Task description: {task_description}  ← included every time, survives compaction
  Task type: {task_type}
  Terminal state: {success|error|question}
  Tool calls: ["Edit src/auth.ts (+42 lines)", "Bash: bun test (exit 0)"]
  Human interventions: [{message}]  ← if any during this iteration
  ---
  {craft_assistant_messages}
  ```
  Including `task_description` in every forwarded message ensures Lead can always compare "what was asked" vs "what was delivered," even after older context has been compacted.

Lead session may need **context compaction** on long-running tasks. When Lead's conversation exceeds ~80% of the context window, Runtime summarizes older review exchanges before injecting the next Craft output. This uses the existing AgentSession compaction mechanism. **Compaction rules**:
- Immutable context (goal description, task description, room instructions) is always retained verbatim
- Only the rolling conversation history (previous review exchanges) is summarized
- The latest Craft output delta is never summarized
- Compaction preserves **structured feedback→resolution pairs** (e.g., "Lead requested input validation → Craft added zod schema → Lead accepted") rather than generic summaries. This prevents Lead from re-raising feedback that was already addressed.

The Lead Agent is triggered when Room Runtime sends it a user message containing Craft Agent's output. It evaluates the output against the goal/task context and uses its tools to respond.

**Lead tool contract**: Lead Agent must call **exactly one terminal tool** per turn: `complete_task`, `fail_task`, `escalate`, or `send_to_craft`. If Lead emits text with no tool call, or calls multiple conflicting tools, Runtime treats it as an error: it retries once with a system nudge ("You must call exactly one of: send_to_craft, complete_task, fail_task, or escalate"). If the second attempt also fails, Runtime escalates to human.

**Lead Agent question handling**: If Lead Agent itself triggers `AskUserQuestion`, Runtime transitions the pair to `awaiting_human` and routes the question directly to the human (unlike Craft questions which route to Lead first). This is because Lead is already the review layer — there's no higher agent to route to. When the human responds, the pair transitions back to `awaiting_lead` and the response is delivered to Lead. Lead's `AskUserQuestion` follows the same escalation SLA timeout as `escalate()` — if no human response within 2h, pair hibernates.

**Turn boundary tracking**: Task pairs track `last_forwarded_message_id` — the ID of the last Craft message forwarded to Lead. When Craft reaches a terminal state, Runtime collects all assistant messages with ID > `last_forwarded_message_id`, forwards them, and updates the marker. This prevents duplicate or skipped reviews across restarts.

**Loop termination guards**:
- `max_feedback_iterations`: default 10 per task. After N `send_to_craft` cycles without `complete_task`/`fail_task`, Runtime auto-escalates to human
- `task_timeout`: wall-clock timeout per task (default: 30 minutes), counting only **active work time** (`awaiting_craft` + `awaiting_lead` states). Clock is paused during `awaiting_human` and `hibernated` states to avoid conflicting with the escalation SLA (2h). Timeout is **soft** — if Craft is mid-tool-call when timeout fires, Runtime waits for the current turn to complete before pausing the pair and escalating. This prevents corrupted state from interrupted file edits or partial operations
- All thresholds configurable per room

### Planning as a (Craft, Lead) Pair

Planning is not a special actor — it's just another activity for a (Craft, Lead) pair:

```mermaid
graph TD
    A["Goal created: 'Implement user auth'"] --> B["Runtime: no tasks for goal<br/>→ create planning task"]
    B --> C["Spawn (Craft, Lead) pair<br/>Craft: plan the goal<br/>Lead: review the plan"]
    C --> D["Craft Agent examines codebase,<br/>proposes task breakdown via tools"]
    D --> E["Craft reaches terminal state →<br/>Runtime collects output → sends to Lead"]
    E --> F["Lead reviews plan<br/>quality and completeness"]
    F -->|"plan accepted → complete_task()"| G["Tasks saved to DB<br/>Planning task marked complete"]
    F -->|"plan needs work → send_to_craft(feedback)"| H["Runtime routes feedback<br/>to Craft Agent"]
    H --> D
    G --> I["Runtime: pending tasks exist<br/>→ spawn coding (Craft, Lead) pairs"]
```

### Data Flow: A Complete Cycle

```mermaid
graph TD
    A["Human → Room Agent:<br/>'Implement user authentication'"] --> B["Room Agent creates Goal in DB"]
    B --> C["Runtime tick: active goal, no tasks<br/>→ create planning task"]
    C --> D["Spawn planning (Craft, Lead) pair"]
    D --> E["Craft Agent plans: examines code,<br/>creates 3 tasks in DB"]
    E --> F["Runtime sends Craft output to Lead"]
    F --> G["Lead reviews plan → complete_task()"]
    G --> H["Runtime tick: pending task 1<br/>→ spawn coding (Craft, Lead) pair"]
    H --> I["Craft Agent codes task 1...<br/>reaches terminal state"]
    I --> J["Runtime sends Craft output to Lead"]
    J --> K["Lead reviews code"]
    K -->|"send_to_craft(feedback)"| L["Runtime routes to Craft"]
    L --> I
    K -->|"complete_task()"| M["Mark task 1 complete"]
    M --> N["Runtime tick: pending task 2<br/>→ spawn (Craft, Lead) pair"]
    N --> O["...repeat for remaining tasks"]
    O --> P["All tasks done → goal completed"]
```

### Human Intervention

Human intervention is NOT a special state. It works at multiple levels:

**Level 1: Room Agent conversation (the department head)**
- "What's the status of the auth feature?"
- "Prioritize the testing tasks"
- "Skip task 3, we don't need it"
- "Add a goal to refactor the database layer"
- "The worker seems stuck, tell it to use JWT instead of sessions"

**Level 2: Direct task participation (join the group chat)**
- Open a task view → see Craft and Lead conversation in sub-agent blocks
- Send a message → goes to Craft Agent as user input
- Human becomes a third participant in the (Craft, Lead) loop

**Level 3: Traditional app controls**
| Action | Effect |
|---|---|
| Pause/Resume runtime | Stops/starts scheduling |
| Add/edit/delete goals | DB changes → Runtime picks up on next tick |
| Add/edit/delete tasks | DB changes → Runtime picks up on next tick |
| Reorder task priority | Affects which task Runtime picks next |

### State Model

**Room Runtime**: `running` | `paused`

**Goals**: `active` | `needs_human` | `completed` | `archived`

**Tasks**: `draft` | `pending` | `in_progress` | `escalated` | `completed` | `failed`

**Task pair lifecycle** (explicit state machine for deterministic recovery):

```mermaid
stateDiagram-v2
    [*] --> awaiting_craft : pair created, Craft starts working
    awaiting_craft --> awaiting_lead : Craft reaches terminal state
    awaiting_lead --> awaiting_craft : Lead calls send_to_craft()
    awaiting_lead --> awaiting_human : Lead calls escalate()
    awaiting_lead --> awaiting_human : Lead triggers AskUserQuestion
    awaiting_lead --> awaiting_lead : Human interrupt delivered to Lead
    awaiting_human --> awaiting_lead : Human responds to Lead
    awaiting_human --> hibernated : Escalation SLA timeout (2h)
    hibernated --> awaiting_lead : Human responds, pair reactivated
    awaiting_lead --> completed : Lead calls complete_task()
    awaiting_lead --> failed : Lead calls fail_task()
    awaiting_craft --> awaiting_lead : Craft errors (sent to Lead)
```

| Pair state | Meaning | Who acts next |
|---|---|---|
| `awaiting_craft` | Craft Agent is working or about to receive feedback | Craft |
| `awaiting_lead` | Craft output collected, waiting for Lead review | Lead |
| `awaiting_human` | Escalated or Lead asked question, pair paused until human responds | Human |
| `hibernated` | Escalation SLA expired, pair preserved but not observed | Human (eventually) |
| `completed` | Lead accepted, task done | — |
| `failed` | Lead rejected or unrecoverable error | — |

No `planning`, `executing`, `reviewing`, `waiting`, `error` states for the room itself.

### When Does the Runtime Tick?

Event-driven with a timer fallback:

1. **Timer**: Every 30 seconds (safety net for missed events)
2. **Goal created/updated**: Immediate tick
3. **Craft Agent session reaches terminal state**: Immediate tick
4. **Lead Agent tool call executed**: Immediate tick (after `complete_task`, `fail_task`)
5. **Task status changed**: Immediate tick

Each tick runs the same deterministic logic. No special handling per trigger type.

**Tick idempotency**: Runtime uses a single-flight mutex — only one tick executes at a time. If multiple events fire concurrently (timer + session terminal state), the first acquires the lock, subsequent triggers queue a single re-tick after the current one completes. This prevents double-spawning pairs, double-delivering feedback, or duplicate `complete_task` processing. Note: for parallel mode (`maxConcurrentPairs > 1`), this single-threaded tick architecture may need to evolve into a per-pair event loop.

### Error Handling

- **Craft Agent session errors**: Runtime sends error context to Lead Agent as a structured user message:
  ```
  [CRAFT ERROR] Task: {task_title}
  Error type: {sdk_error_subtype}
  Last tool call: {tool_name}({args_summary})
  Error message: {error_message}
  Craft's last assistant message before error: {last_message_excerpt}
  ```
  Lead decides: `send_to_craft` (retry with guidance), `fail_task`, or `escalate`.
- **Lead Agent session fails**: Recovery protocol: (1) Re-send the pending Craft output to the same Lead session on next tick. (2) If Lead fails 3 times consecutively, kill the Lead session and create a new one with a summary of prior review exchanges injected into the system prompt. (3) If the replacement Lead also fails, escalate to human.
- **Too many consecutive errors**: Runtime pauses itself, notifies human via Room Agent.

All errors are recoverable by re-running the tick. No stuck states.

### Escalation Flow

When Lead Agent calls `escalate(reason)`:

```mermaid
sequenceDiagram
    participant L as Lead Agent
    participant RT as Room Runtime
    participant RA as Room Agent
    participant H as Human

    L->>L: Calls escalate(reason)
    Note over L,RT: Tool routes through Runtime
    RT->>RT: Set task status to "escalated"
    RT->>RT: Pause the (Craft, Lead) pair
    RT->>RA: Notify Room Agent with reason
    RA->>H: Surface notification (Room Agent message + UI badge/banner)
    H->>L: Human responds to Lead with guidance
    Note over RT: Lead reviews guidance
    L->>L: Calls send_to_craft(revised_instruction)
    RT->>RT: Resume pair, set task back to "in_progress"
    RT-->>L: Route continues normally
```

**Task state during escalation**: `escalated` (a sub-state of `in_progress`). The pair is paused — Lead waits for human input, Craft is idle. Human responds **directly to Lead** (since Lead has the review context), and Lead translates guidance into actionable feedback for Craft.

**Escalation notification**: Runtime injects a message into Room Agent's conversation describing the escalation (task name, reason, link to task). The UI surfaces an **escalation badge** on the room and the specific task. Push notifications are out of scope for MVP.

**Queued messages on escalation**: When Lead calls `escalate()`, any human messages that were queued during Lead's review are **delivered to Lead** along with the escalation context. This way the human's earlier input isn't lost — Lead sees both the escalation reason and any human messages that arrived during review.

**Escalation SLA**: If an escalated task receives no human response within a configurable timeout (default: 2 hours), Runtime transitions the pair to `hibernated` state — sessions are preserved in DB but not actively observed. This prevents blocking the task queue indefinitely. When the human eventually responds, the human message is stored in the message queue, triggering a tick. The tick loop checks for pending messages on hibernated pairs — if found, it reactivates the pair (transitions to `awaiting_lead`), delivers the message to Lead, and resumes normal flow. If the room has other pending tasks, Runtime can proceed with those while the escalated task hibernates.

### Goal Completion

When all tasks for a goal are completed, Runtime triggers a **goal review** (Craft, Lead) pair:

1. Runtime detects: all tasks for goal X have status `completed`
2. Runtime creates a special task: "Review goal: X"
3. Spawns a (Craft, Lead) pair where Craft Agent receives via system prompt:
   - The original goal description
   - All completed task summaries (from `complete_task(summary)` calls)
   - The Craft Agent then verifies the goal is satisfied (may use `read`, `glob`, `grep` tools to inspect actual results)
   - Either confirms completion or creates additional tasks via `create_task` tool
4. Lead Agent reviews the assessment
5. If confirmed → Runtime marks goal as `completed`
6. If gaps found → new tasks created → Runtime picks them up on next tick

**Goal review cycle cap**: Maximum 2 goal review cycles per goal. If the second review still finds gaps, Runtime marks the goal as `needs_human` and notifies via Room Agent rather than creating endless review loops.

### Daemon Restart / Recovery

Runtime state is **reconstructed from DB on startup**. No in-memory-only state.

**Recovery procedure**:
1. On daemon start, Runtime queries DB for all non-terminal tasks (`in_progress`, `escalated`) with active task pairs (pair state NOT IN `completed`, `failed`)
2. For each task pair, check pair state and session status:
   - **Pair `awaiting_craft`**: Check Craft session — re-observe if idle, attach observer if processing, re-route if waiting_for_input
   - **Pair `awaiting_lead`**: Check Lead session — re-observe if idle, attach observer if processing
   - **Pair `awaiting_human`**: No action needed — pair is waiting for human input, just register for human message events
   - **Pair `hibernated`**: No action needed — pair is preserved but not actively observed, just register for human reactivation
   - **Session gone** (process crashed): Mark task as `failed` with reason `session_lost`
3. Runtime resumes `running` state and continues normal tick loop

**Message queue recovery**: On restart, Runtime scans `task_messages` for entries with `status = 'pending'` and reprocesses them in `created_at` order. Since messages are scoped to `pair_id` + `to_session_id`, only messages for still-active pairs are delivered. Messages targeting sessions that no longer exist are marked `dead_letter`.

**Delivery idempotency**: For Craft→Lead forwarding, `last_forwarded_message_id` serves as an idempotency guard — if a message ID is already ≤ the marker, it's skipped. For Lead→Craft messages via the queue, delivery and `status = 'delivered'` update happen within the same single-flight tick transaction, minimizing the crash window. A `processing` intermediate state is deferred to parallel mode where concurrent delivery makes it necessary.

**Non-idempotent task recovery**: When a Craft session is lost after it has already made changes (edited files, ran commands), blind retry is dangerous — it could duplicate side effects. For lost sessions, Runtime marks the task `failed` and **does not auto-retry**. The human must acknowledge and decide: retry (if workspace state is safe) or manually intervene. Room Agent surfaces these failures prominently.

**Key invariant**: All state that matters (goals, tasks, task pairs, session IDs) lives in the DB. Runtime is stateless and reconstructable.

### Message Queue (Prerequisite)

The message routing between agents requires a **DB-backed queue system** to ensure reliability:

- Messages between Craft and Lead must survive daemon restarts
- Human messages sent during Lead review must be queued and delivered in order
- Messages are scoped to a specific `pair_id` + `to_session_id` to prevent misdelivery on task retry
- Urgent control actions (cancel, pause) bypass the queue entirely

This is a **prerequisite component** that should be designed and implemented before the Craft→Lead loop.

### Capacity Management

- `maxConcurrentPairs`: configurable per room (default: 1 for MVP)
- Runtime only spawns (Craft, Lead) pairs when below capacity
- **`awaiting_human` and `hibernated` pairs do NOT count** toward the concurrency limit — they're idle and blocking them would stall the queue for up to 2h. Only `awaiting_craft` and `awaiting_lead` pairs count as active
- Each tick checks capacity before spawning — pending tasks wait without wasted ticks
- Tasks execute sequentially (MVP)

### Database Schema

```sql
-- Tasks: add task_type and depends_on (existing table, new columns)
-- task_type determines Craft tool set and Lead review prompt
-- depends_on is nullable, ignored in sequential MVP, required for parallel mode
ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'coding';
    -- 'planning' | 'coding' | 'research' | 'design' | 'goal_review'
ALTER TABLE tasks ADD COLUMN depends_on TEXT;
    -- JSON array of task IDs, nullable
ALTER TABLE tasks ADD COLUMN created_by_task_id TEXT;
    -- References the planning task that created this task (for draft scoping)

-- Goals: add planning_attempts counter (existing table, new column)
ALTER TABLE goals ADD COLUMN planning_attempts INTEGER NOT NULL DEFAULT 0;

-- Task pairs: tracks the (Craft, Lead) sessions for each task
CREATE TABLE task_pairs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    craft_session_id TEXT NOT NULL,
    lead_session_id TEXT NOT NULL,
    pair_state TEXT NOT NULL DEFAULT 'awaiting_craft',
        -- awaiting_craft | awaiting_lead | awaiting_human | hibernated | completed | failed
    last_forwarded_message_id TEXT,  -- turn boundary marker
    feedback_iteration INTEGER NOT NULL DEFAULT 0,
    active_work_started_at INTEGER,  -- tracks active work time for soft timeout
    active_work_elapsed INTEGER NOT NULL DEFAULT 0,  -- accumulated ms in awaiting_craft + awaiting_lead
    hibernated_at INTEGER,  -- when pair entered hibernated state (for SLA tracking)
    version INTEGER NOT NULL DEFAULT 0,  -- optimistic locking (Room Agent tools only; Runtime is sole writer of pair state)
    created_at INTEGER NOT NULL,
    completed_at INTEGER
);

-- Message queue: reliable inter-agent message delivery
CREATE TABLE task_messages (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    pair_id TEXT NOT NULL REFERENCES task_pairs(id),
    from_role TEXT NOT NULL,       -- 'craft' | 'lead' | 'human'
    to_role TEXT NOT NULL,         -- 'craft' | 'lead'
    to_session_id TEXT NOT NULL,   -- target session (prevents misdelivery on retry)
    payload TEXT NOT NULL,         -- JSON message content
    status TEXT NOT NULL DEFAULT 'pending',  -- pending | delivered | dead_letter
    created_at INTEGER NOT NULL,
    delivered_at INTEGER
);
```

---

## What We Reuse

- **AgentSession infrastructure** — for ALL agents (Room Agent, Craft, Lead)
- **Session persistence** — all conversations stored in DB automatically
- **Sub-agent block UI components** — already exist, used for Task Chat View
- **Database schema** — rooms, goals, tasks tables
- **DaemonHub events** — for session state change observations
- **MessageHub** — for UI communication

## What We Replace

- **RoomSelfService** → new `RoomRuntime` (deterministic scheduler + router)
- **Room agent tools MCP** → new Room Agent tools (goal/task CRUD, room state queries)
- **RoomSelfLifecycleManager** → not needed (only 2 states)
- **Worker tools (worker_complete_task etc.)** → Lead Agent tools instead
- **WorkerManager** → replaced by (Craft, Lead) pair manager

## New Components

1. **RoomRuntime** — deterministic scheduler loop + message router
2. **Room Agent tools** — MCP tools for goal/task CRUD, room state queries, task cancel/retry
3. **Lead Agent tools** — MCP tools: `send_to_craft`, `complete_task`, `fail_task`, `escalate`, `read_craft_messages`
4. **Task pair manager** — creates and tracks (Craft, Lead) pairs for tasks
5. **Session observer** — detects terminal states (Result/Error/AskQuestion) + cron safety net
6. **DB-backed message queue** — reliable inter-agent message delivery with human message queueing
7. **Task Chat View UI** — unified chat rendering with sub-agent blocks for (Craft, Lead, Human)

## Design Decisions (Resolved)

1. **Task execution**: Sequential only. One (Craft, Lead) pair at a time (MVP).
2. **Review policy**: Every Craft Agent terminal state triggers Lead Agent review via Runtime.
3. **Planning is a task**: Not a special actor. Planning creates a (Craft, Lead) pair like any other task.
4. **All agents are AgentSessions**: Room Agent, Craft, Lead all reuse existing session infrastructure. All conversations persisted.
5. **Craft Agents have no completion-signaling tools**: They just work and reach terminal state. Activity-specific tools (e.g., `create_task` for planning) are allowed.
6. **Lead Agent tools route through Runtime**: `send_to_craft`, `complete_task`, etc. all go through Runtime for consistent routing, tracking, and guard rails.
7. **Runtime collects all messages from Craft's last turn**: When Craft reaches terminal state, Runtime collects all assistant messages since the last user message and sends to Lead.
8. **Lead session created once, reused**: Lead Agent is created when the task starts and reused across all feedback iterations, maintaining full review context.
9. **Human interface**: Room Agent is always-on department head. Humans can also join any task's group chat.
10. **Task Chat View**: (Craft, Lead) pair rendered as unified conversation with sub-agent blocks per turn.
11. **Naming**: Craft Agent (does the work) + Lead Agent (reviews and directs).
12. **AskUserQuestion routes to Lead first**: When Craft asks a question, Runtime sends it to Lead. Lead can answer or escalate to human.
13. **Human messages queued during Lead review**: Prevents race conditions. Messages delivered after Lead's current review cycle.
14. **Goal completion triggers review**: When all tasks done, Runtime spawns a goal-review (Craft, Lead) pair to verify the goal is truly met.
15. **Recovery from DB**: Runtime is stateless and reconstructable. All state lives in DB. On restart, Runtime queries in-progress tasks and re-attaches.
16. **DB-backed message queue**: Prerequisite for reliable inter-agent message delivery.
17. **Session idle detection**: SDK terminal states (Result/Error/AskQuestion) + cron job safety net every 60s.
18. **Model selection**: Use room default model for both Craft and Lead (configurable later).
19. **Tick idempotency**: Single-flight mutex prevents concurrent ticks from double-spawning or double-delivering.
20. **Explicit pair state machine**: Pairs have 6 states (`awaiting_craft`, `awaiting_lead`, `awaiting_human`, `hibernated`, `completed`, `failed`) for deterministic recovery.
21. **Lead tool contract**: Exactly one terminal tool per turn. Invalid responses get one retry with system nudge, then escalate.
22. **Turn boundary tracking**: `last_forwarded_message_id` on task pairs prevents duplicate/skipped reviews.
23. **Loop termination**: `max_feedback_iterations` (10), wall-clock timeout (30min). All configurable.
24. **Non-idempotent recovery**: Lost sessions mark task `failed` without auto-retry. Human must acknowledge.
25. **Optimistic locking**: Room Agent tools check `task.version` to prevent races with Runtime state transitions.
26. **Goal review cap**: Max 2 goal review cycles, then `needs_human`.
27. **Planning attempt cap**: Max 3 planning attempts per goal before `needs_human`.
28. **Urgent controls bypass queue**: `cancel_task`, `pause runtime` execute immediately, not queued.
29. **Lead questions route to human**: Lead Agent's `AskUserQuestion` goes directly to human (no higher review layer).
30. **Lead verification tool**: Lead can independently run verification commands (`run_verification`) to confirm tests/linting pass before accepting.
31. **Lead answer policy**: Lead may answer Craft's architectural/technical questions but must escalate secrets, credentials, permissions, and subjective preferences.
32. **Human interrupt**: Human can interrupt Lead mid-review for redirect messages (not just cancel). Transitions pair to `awaiting_human`.
33. **Escalation SLA**: Unresponded escalations hibernate after 2h (configurable). Pair preserved, not observed. Unblocks task queue.
34. **Room Agent is on-demand**: "Always available" means session exists in DB, not persistently-running LLM. Only costs tokens when human chats.
35. **Planning tasks created as `draft`**: Tasks created by planning Craft are `draft` until Lead approves the plan, then promoted to `pending`. Prevents unapproved tasks from executing.
36. **Task type determines agent behavior**: `task_type` field on tasks determines Craft's tool set and Lead's activity-specific review prompt.
37. **Human interventions forwarded to Lead**: When human sends messages to Craft during an iteration, those messages are included in the Craft→Lead forwarding so Lead understands context changes.
38. **Lead failure recovery**: Re-send pending output to same Lead. After 3 consecutive failures, replace Lead session with summary. After replacement also fails, escalate.
39. **Structured Craft→Lead message format**: Runtime sends structured envelope with iteration number, task description, tool call summary, terminal state, and human interventions.
40. **Structured compaction**: Lead compaction preserves feedback→resolution pairs, not generic summaries.
41. **Planning trigger includes all non-terminal states**: Re-planning only triggers when goal has no `pending`/`in_progress`/`draft`/`escalated` tasks. Prevents duplicate planning when tasks are escalated or drafts linger.
42. **Draft tasks scoped to planning task**: `created_by_task_id` links drafts to the planning task that created them. Only matching drafts are promoted on approval. Failed planning cleans up its drafts.
43. **Recovery includes all non-terminal tasks**: Startup queries `in_progress` AND `escalated` tasks, handles all pair states including `awaiting_human` and `hibernated`.
44. **Task timeout pauses during human waits**: `task_timeout` only counts active work time (`awaiting_craft` + `awaiting_lead`). Clock pauses during `awaiting_human`/`hibernated` to avoid conflicting with escalation SLA.
45. **Human interrupt goes to `awaiting_lead`**: Interrupt is delivered to Lead after its current turn, keeping pair in `awaiting_lead` (not `awaiting_human`) because the interrupt IS the human's input.
46. **Lead `AskUserQuestion` transitions to `awaiting_human`**: Lead's questions route to human, pair pauses. Human responds → pair returns to `awaiting_lead`. Same SLA timeout as escalation.
47. **Delivery idempotency via markers**: Craft→Lead uses `last_forwarded_message_id` as guard. Lead→Craft delivery within single-flight tick transaction. `processing` queue state deferred to parallel mode.
48. **Hibernation reactivation via message queue**: Human messages to hibernated pairs are stored in queue, tick detects pending messages and reactivates the pair.
49. **`run_verification` restricted to allowlist**: Commands scoped to room's `allowed_verification_commands` config (default: test/lint). Not arbitrary bash.
50. **Soft task timeout**: Waits for current tool call to complete before pausing. Prevents corrupted state from interrupted operations.
51. **`awaiting_human`/`hibernated` don't count toward concurrency**: Idle pairs free the concurrency slot immediately, preventing 2h queue blocking on escalation.
52. **Goal `needs_human` recovery**: Human marks goal `active` via Room Agent → resets `planning_attempts` to 0 → Runtime re-plans on next tick.
53. **Draft promotion is atomic**: Single DB transaction for promoting drafts on approval or cleaning up drafts on failure.
54. **Human interrupt is "pause and inject"**: Lead retains full session context. Interrupt delivered as additional user message after Lead's current turn.
55. **Runtime is sole writer of pair state**: No optimistic locking needed on `task_pairs`. `version` field exists for Room Agent tool coordination only.
56. **Cron safety net is stateless**: Queries DB directly, no in-memory index. Survives daemon restarts.
57. **Escalation notification via Room Agent + UI badge**: Runtime injects message into Room Agent conversation. UI shows escalation badge on room and task. Push notifications out of scope for MVP.

## Open Questions (For Future Iterations)

1. **Parallel (Craft, Lead) pairs**: Multiple pairs for different tasks/goals. Requires: per-room scheduler lock, **worktree-per-pair isolation** (two Craft Agents editing the same files will corrupt each other), fair task selection, starvation prevention, and per-pair event loop. Not MVP.
2. **Task dependency management**: Priority/dependency constraints across goals/tasks need first-class representation for parallel mode. Sequential MVP sidesteps this but it must be solved before `maxConcurrentPairs > 1`.
3. **Multi-reviewer**: Multiple Lead Agents with different models reviewing the same work (consensus-based review). The Craft→Lead loop supports this naturally.
4. **Room Agent as Lead**: Should the Room Agent serve as Lead for tasks, or should each task get its own dedicated Lead? Trade-off: shared context vs. isolation.
5. **Cross-task context**: Should a subsequent Craft Agent get context from previous tasks' sessions?
6. **External review integration**: PR reviews, CI results as input to Lead Agent.

---

## Implementation Plan

### Phase 0: Prerequisites
- DB-backed message queue system (task_messages table + queue logic)
- Database schema additions (task_pairs, task_messages tables)

### Phase 1: Foundation
- RoomRuntime scheduler loop (tick loop, event-driven + timer fallback)
- Session observation (detect terminal states: Result/Error/AskQuestion + cron safety net)
- Room Agent with goal/task management tools (full tool set)
- Capacity management (maxConcurrentPairs check per tick)

### Phase 2: Craft → Lead Loop
- Task pair manager (create Craft + Lead sessions per task, Lead reused across iterations)
- Lead Agent tools (`send_to_craft`, `complete_task`, `fail_task`, `escalate`, `read_craft_messages`)
- Lead Agent system prompt with goal/task/room context
- Runtime message collection (Craft terminal state → collect all messages from last turn → send to Lead)
- Runtime message routing (Lead `send_to_craft()` → inject into Craft session via message queue)
- AskUserQuestion routing (Craft question → Lead first → escalate if needed)
- Human message queueing during Lead review
- Integration test: task → Craft works → Lead reviews → feedback loop → accepted

### Phase 3: Planning + Goal Completion
- Planning (Craft, Lead) pair for goal decomposition (Craft gets `create_task` tool)
- Goal completion review (Craft, Lead) pair
- Full cycle test: goal → plan → tasks → execute → review → complete → goal review

### Phase 4: Recovery + Resilience
- Daemon restart recovery (reconstruct Runtime state from DB)
- Escalation flow (pause pair, notify Room Agent, human responds to Lead)
- Error recovery (Lead handles Craft errors, circuit breaker on repeated failures)

### Phase 5: Human Intervention
- Room Agent conversation flows
- Human joins task group chat (message routing through queue)
- Pause/resume, task editing, cancel/retry tasks

### Phase 6: Task Chat View UI
- Sub-agent blocks for Craft turns (🔨) and Lead turns (👁)
- Human messages rendered inline
- Chronological interleaving from both sessions
- Task controls within the view

### Verification (end-to-end acceptance criteria)
- Create a room, chat with Room Agent: "Add a health check endpoint to the API"
- Room Agent creates goal → Runtime creates planning task → plan reviewed → coding tasks created
- Runtime spawns (Craft, Lead) pair → Craft codes → Lead reviews → iterates → accepts
- Repeat for remaining tasks → goal marked complete
- Human can: pause, chat with Room Agent, join task group chat, edit tasks
- Add another goal and verify continuous operation
- Restart daemon mid-execution and verify recovery (no stuck states)
