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
- Milestones 3 and 4 can proceed in parallel after Milestone 2 and 1 respectively.

## Key Sequencing Decisions

- All schema changes (Phase 1 + Phase 2) go in a single new migration (migration 40) since Space is pre-production and consolidation avoids unnecessary ALTER TABLEs.
- Backward compatibility: `WorkflowStep.agentId` is kept; `agents` array is additive. Resolution: if `agents` is provided, use it; else fall back to `agentId`.
- Cross-agent messaging starts with Task Agent mediated (Option C) as it leverages existing coordinator architecture, then adds direct peer tools.

## Estimated Task Count

22 tasks across 6 milestones.
