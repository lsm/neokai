# Multi-Agent V2: Customizable Agents & Workflows

## Goal

Enable full user customization of multi-agent behavior in NeoKai rooms. Users should be able to create custom agents with configurable names, models, providers, tools, and system prompts. These agents can be composed into custom workflows that define agent interactions, runtime gates, and rules. A pure data layer underpins everything, enabling future sharing and marketplace capabilities.

## High-Level Approach

The current system has four hardcoded agent roles (Planner, Coder, General, Leader) stored via `room.config.agentModels` and `room.config.agentSubagents`. Workflows are implicit in the `RoomRuntime` tick loop: goal -> planning group -> task execution group -> review cycle.

This plan introduces:

1. **Custom Agent Definitions** -- a new `custom_agents` table and corresponding types so users can define agents with arbitrary names, models, tools, and system prompts. Each agent belongs to a room.

2. **Custom Workflows** -- a new `workflows` table that defines sequences of agent steps, runtime gates between steps, and rules. Workflows belong to a room and can be selected by the room agent based on task/goal context.

3. **Runtime Integration** -- the `RoomRuntime` and `TaskGroupManager` learn to resolve agent definitions from the data layer instead of only using hardcoded factories. Lifecycle hooks become configurable per-workflow step.

4. **Frontend UI** -- agent creation/editing forms, workflow builder, and workflow selection in the room dashboard. Built on top of existing `RoomAgents.tsx` patterns.

5. **Data Layer & Sharing Foundation** -- export/import format for agents and workflows, preparing for future marketplace.

## Milestones

1. **Custom Agent Data Model** -- Define shared types, DB schema (migration), repository, and CRUD RPC handlers for custom agent definitions stored per-room.
2. **Custom Agent Runtime Integration** -- Wire custom agent definitions into `TaskGroupManager` and `RoomRuntime` so custom agents can execute tasks alongside built-in agents.
3. **Workflow Data Model** -- Define shared types, DB schema, repository, and CRUD RPC handlers for workflow definitions with agent steps, gates, and rules.
4. **Workflow Runtime Engine** -- Build a workflow executor that replaces the hardcoded planning/execution/review cycle with configurable step sequences.
5. **Frontend: Agent Creation UI** -- Build the UI for creating, editing, and managing custom agents within a room.
6. **Frontend: Workflow Builder UI** -- Build the visual workflow builder for composing agents into steps with gates and rules.
7. **Workflow Selection & Intelligence** -- Enable room agent/goal to auto-select workflows based on task context, plus manual override.
8. **Data Layer: Export/Import & Sharing Foundation** -- Implement export/import of agent definitions and workflows as JSON, laying groundwork for sharing.

## Cross-Milestone Dependencies and Sequencing

- **Milestone 1 must complete before 2**: runtime integration needs the data model.
- **Milestone 3 must complete before 4**: workflow runtime needs the workflow data model.
- **Milestone 1 must complete before 5**: frontend agent UI needs CRUD RPCs and types.
- **Milestones 3 and 4 must complete before 6**: workflow builder needs both data model and runtime.
- **Milestones 2 and 4 must complete before 7**: auto-selection needs both custom agents and workflow runtime.
- **Milestones 1 and 3 must complete before 8**: export/import needs both data models.
- **Milestones 2 and 5 can proceed in parallel** once Milestone 1 is done.
- **Milestones 4 and 6 can proceed in parallel** once Milestone 3 is done.

```
M1 (Agent Data) --> M2 (Agent Runtime)  --+
     |                                     +--> M7 (Selection Intelligence) --> M8 (Export/Import)
     +--> M5 (Agent UI)                   |
                                          |
M3 (Workflow Data) --> M4 (Workflow Runtime) --+
     |                                     |
     +--> M6 (Workflow Builder UI) --------+
```

## Total Estimated Task Count

26 tasks across 8 milestones.
