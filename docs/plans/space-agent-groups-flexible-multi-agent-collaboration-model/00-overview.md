# Space Agent Groups: Flexible Multi-Agent Collaboration Model

## Goal

Redesign the Space session group system to support flexible multi-agent collaboration with parallel step execution and cross-agent messaging. The current `SpaceSessionGroup` model was built for Room's fixed leader/worker pattern but Space uses data-driven agents (SpaceAgent records with user-defined roles) coordinated by a Task Agent. Since Space is not in production, schema changes can be consolidated.

## Approach

Three phases, each building on the previous:

1. **Flexible Session Group Model** -- Redesign schema for N members with freeform roles, wire TaskAgentManager to persist groups, add events for frontend reactivity.
2. **Multi-Agent Workflow Steps** -- Allow workflow steps to specify multiple agents for parallel execution, update executor and editor.
3. **Cross-Agent Messaging** -- Enable agents within a group to communicate, starting with Task Agent mediated routing and adding direct peer messaging.

## Milestones

1. **Schema and Type Updates** -- New migration adding `task_id`, `agent_id`, `status` columns; update shared types to freeform roles; update repository CRUD.
2. **TaskAgentManager Group Persistence** -- Wire `spawnTaskAgent()` and `createSubSession()` to create/update session groups and members; emit events via DaemonHub.
3. **Frontend Session Group Reactivity** -- Add `sessionGroups` signal to SpaceStore, subscribe to group events, display active agents in SpaceTaskPane.
4. **Multi-Agent Workflow Steps (Types and Executor)** -- Extend `WorkflowStep` with `agents` array, update `WorkflowExecutor.advance()` to create multiple tasks per step, update step completion logic.
5. **Multi-Agent Export/Import and Visual Editor** -- Update `ExportedWorkflowStep` for multi-agent format, update visual workflow editor to show/edit multiple agents per step.
6. **Cross-Agent Messaging** -- Implement Task Agent mediated messaging and direct peer-to-peer MCP tools within groups.

## Cross-Milestone Dependencies

- Milestone 2 depends on Milestone 1 (schema must exist before wiring persistence).
- Milestone 3 depends on Milestone 2 (events must be emitted before frontend can subscribe).
- Milestone 4 depends on Milestone 1 (needs freeform types and updated repository).
- Milestone 5 depends on Milestone 4 (export/import and editor need the `agents` array type).
- Milestone 6 depends on Milestones 2 and 4 (needs group persistence and multi-agent steps).
- Milestone 3 and Milestone 4 can proceed in parallel once their respective dependencies (2 and 1) are complete.

## Key Sequencing Decisions

- All schema changes (Phase 1 + Phase 2) go in a single new migration (next available migration number, determined at implementation time) since Space is pre-production and consolidation avoids unnecessary ALTER TABLEs.
- Backward compatibility: `WorkflowStep.agentId` is kept; `agents` array is additive. Resolution: if `agents` is provided, use it; else fall back to `agentId`. If both are provided, `agents` takes precedence (and a warning is logged).
- Cross-agent messaging starts with Task Agent mediated (Option C) as it leverages existing coordinator architecture, then adds direct peer tools.
- Event names follow existing codebase convention: `spaceSessionGroup.created`, `spaceSessionGroup.memberAdded`, `spaceSessionGroup.memberUpdated` (camelCase without domain separator dots, matching `spaceAgent.created`, `spaceWorkflow.created`).

## Key Design Decisions

### Parallel Task Failure Semantics (Phase 2)
When one parallel task in a multi-agent step fails while others are still running:
- **Fail-fast**: Remaining active tasks are NOT cancelled automatically — they continue running to completion (cancellation is complex and may waste useful partial work).
- **Step status**: The step is marked `failed` if ANY parallel task fails, once all tasks reach a terminal state (completed or failed).
- **Result aggregation**: The Task Agent receives completion/failure callbacks for each task individually and can decide whether to retry failed tasks or advance with partial results.
- **Retry**: Retry is per-task, not per-step. The Task Agent can re-spawn a failed agent without re-running successful ones.

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

26 tasks across 6 milestones.
