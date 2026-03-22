# Space Agent Groups: Flexible Multi-Agent Collaboration Model

## Goal

Redesign the Space session group system to support flexible multi-agent collaboration with parallel step execution and cross-agent messaging. The current `SpaceSessionGroup` model was built for Room's fixed leader/worker pattern but Space uses data-driven agents (SpaceAgent records with user-defined roles) coordinated by a Task Agent. Since Space is not in production, schema changes can be consolidated.

## Approach

Three phases, each building on the previous:

1. **Flexible Session Group Model** -- Redesign schema for N members with freeform roles, wire TaskAgentManager to persist groups, add events for frontend reactivity.
2. **Multi-Agent Workflow Steps** -- Allow workflow steps to specify multiple agents for parallel execution, update executor and editor.
3. **Cross-Agent Messaging with Declared Topology** -- Enable agents within a group to communicate via declared `channels` on workflow steps. Direct agent-to-agent messaging along declared channels is the primary model; Task Agent mediated routing is a fallback for undeclared paths.

## Milestones

1. **Schema and Type Updates** -- New migration adding `task_id`, `agent_id`, `status` columns; update shared types to freeform roles; update repository CRUD.
2. **TaskAgentManager Group Persistence** -- Wire `spawnTaskAgent()` and `createSubSession()` to create/update session groups and members; emit events via DaemonHub.
3. **Frontend Session Group Reactivity** -- Add `sessionGroups` signal to SpaceStore, subscribe to group events, display active agents in SpaceTaskPane.
4. **Multi-Agent Workflow Steps (Types, Channels, and Executor)** -- Extend `WorkflowStep` with `agents` array and `channels` topology declaration, update `WorkflowExecutor.advance()` to create multiple tasks per step, resolve channel topology at step start.
5. **Multi-Agent Export/Import and Visual Editor** -- Update `ExportedWorkflowStep` for multi-agent + channels format, update visual workflow editor to show agents and draw directed channel edges between them.
6. **Cross-Agent Messaging with Channel Enforcement** -- Implement channel-validated direct messaging as the primary model, Task Agent mediated routing as fallback for undeclared channels.

## Cross-Milestone Dependencies

- Milestone 2 depends on Milestone 1 (schema must exist before wiring persistence).
- Milestone 3 depends on Milestone 2 (events must be emitted before frontend can subscribe).
- Milestone 4 depends on Milestone 1 (needs freeform types and updated repository).
- Milestone 5 depends on Milestone 4 (export/import and editor need the `agents` array type).
- Milestone 6 depends on Milestones 2 and 4 (needs group persistence, multi-agent steps, and channel topology types).
- Milestone 3 and Milestone 4 can proceed in parallel once their respective dependencies (2 and 1) are complete.

## Key Sequencing Decisions

- All schema changes (Phase 1 + Phase 2) go in a single new migration (next available migration number, determined at implementation time) since Space is pre-production and consolidation avoids unnecessary ALTER TABLEs.
- Backward compatibility: `WorkflowStep.agentId` is kept; `agents` array is additive. Resolution: if `agents` is provided, use it; else fall back to `agentId`. If both are provided, `agents` takes precedence (and a warning is logged).
- **Messaging topology is first-class**: `WorkflowStep.channels` declares directed communication links between agents. The declared channels *are* the workflow graph — they define who can talk to whom. Direct agent-to-agent messaging along declared channels is the primary model. Task Agent mediated routing (`request_peer_input`) is a fallback for undeclared paths or when the Task Agent needs to coordinate.
- Event names follow existing codebase convention: `spaceSessionGroup.created`, `spaceSessionGroup.memberAdded`, `spaceSessionGroup.memberUpdated` (camelCase without domain separator dots, matching `spaceAgent.created`, `spaceWorkflow.created`).

## Key Design Decisions

### Parallel Task Failure Semantics (Phase 2)
When one parallel task in a multi-agent step fails while others are still running:
- **Fail-fast**: Remaining active tasks are NOT cancelled automatically — they continue running to completion (cancellation is complex and may waste useful partial work).
- **Step status**: The step is marked `failed` if ANY parallel task fails, once all tasks reach a terminal state (completed or failed).
- **Result aggregation**: The Task Agent receives completion/failure callbacks for each task individually and can decide whether to retry failed tasks or advance with partial results.
- **Retry**: Retry is per-task, not per-step. The Task Agent can re-spawn a failed agent without re-running successful ones.

### Messaging Topology as First-Class Workflow Primitive (Phase 2 + 3)
The `channels` field on `WorkflowStep` declares the directed messaging topology for that step. The channels collaboratively define the whole workflow graph — they are not an afterthought but a core part of workflow design.

**Type definition:**
```ts
interface WorkflowChannel {
  from: string;            // agentRole or '*' (wildcard = any agent in step)
  to: string | string[];   // agentRole(s) or '*'
  direction: 'one-way' | 'bidirectional';
  label?: string;          // optional semantic label, e.g. 'review-feedback'
}
```

**Supported topology patterns:**

| Pattern | Declaration | Semantics |
|---------|-------------|-----------|
| One-way | `{from: 'A', to: 'B', direction: 'one-way'}` | A sends, B cannot reply via this channel |
| Bidirectional point-to-point | `{from: 'A', to: 'B', direction: 'bidirectional'}` | Full duplex 1:1 between A and B |
| Fan-out one-way | `{from: 'A', to: ['B','C','D'], direction: 'one-way'}` | A broadcasts/multicasts to B, C, D; no replies |
| Fan-out bidirectional (hub-spoke) | `{from: 'A', to: ['B','C','D'], direction: 'bidirectional'}` | A broadcasts/multicasts to spokes + independent async replies from each spoke back to A (hub). Spokes do NOT message each other through this channel. |
| Sink | `{from: '*', to: 'B', direction: 'one-way'}` | Any agent can send to B |
| Broadcast-all | `{from: 'A', to: '*', direction: 'one-way'}` | A can send to all agents |

**Hub-spoke semantics (fan-out bidirectional):**
- **Broadcast**: Hub (A) sends one message delivered to all spokes (B, C, D) simultaneously
- **Targeted multicast**: Hub sends individual messages to a specific spoke (point-to-point within the same declared channel)
- **Independent async replies**: Each spoke replies to the hub at its own pace, independently (no synchronization barrier between spokes)
- **Spoke isolation**: Spokes do NOT message each other through this channel. B cannot send to C via an `A <-> [B,C,D]` channel — that requires a separate `B <-> C` declaration.

**Enforcement:** The `send_feedback` MCP tool validates against declared channels before routing. If no channel permits the direction, the message is rejected. The `send_feedback` tool supports: `target: 'coder'` (point-to-point), `target: '*'` (broadcast to all permitted targets on the channel), or `target: ['coder', 'reviewer']` (targeted multicast). The channel topology is resolved at step-start time and passed to each agent session's tool context so agents know their permitted communication paths.

**Fallback:** When no channels are declared on a step (or when a message doesn't match any channel), the Task Agent mediated `request_peer_input` tool remains available as a fallback — the Task Agent can relay messages at its discretion.

### `request_peer_input` Response Mechanism (Phase 3)
The `request_peer_input` tool uses an **async injection pattern**, NOT a blocking request/response:
1. Step agent calls `request_peer_input(targetRole, question)` → returns immediately with an acknowledgment.
2. The Task Agent receives the request and routes it to the appropriate peer.
3. The peer's response is injected back into the requesting agent's session as a new **user turn** (via `messageInjector`), prefixed with context like `[Peer response from {role}]: ...`.
4. The requesting agent processes the injected response on its next conversation turn.
This avoids blocking and leverages the existing `messageInjector` pattern already used for Task Agent → step agent communication.

### Cross-Agent Message Concurrency (Phase 3)
- `messageInjector` serializes writes per-session (messages are queued and injected sequentially).
- If a target session is mid-conversation with the LLM, injected messages queue behind the current turn.
- Two agents injecting into the same target will have their messages serialized — no interleaving within a single injection.
- The plan includes an integration test verifying concurrent injection ordering.

### Session Group Lifecycle
- Groups are **retained as historical records** when a task completes (not deleted).
- Member status (`active` → `completed`/`failed`) provides the filtering mechanism.
- A `status` field on `SpaceSessionGroup` itself (not just members) tracks the overall group state: `active`, `completed`, `failed`.
- Frontend queries filter by status when showing "active" vs "historical" groups.

### `count` Field Deferral
The `WorkflowStepAgent.count` field (spawn N instances of same agent) is **deferred to a future milestone**. It introduces session ID disambiguation complexity and unclear work-division semantics without a concrete use case. The `agents` array already supports explicit multi-agent by listing the same agentId multiple times if needed.

## Estimated Task Count

29 tasks across 6 milestones.
