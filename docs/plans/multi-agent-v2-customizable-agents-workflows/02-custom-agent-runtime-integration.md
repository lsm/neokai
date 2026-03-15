# Milestone 2: Custom Agent Runtime Integration

## Goal

Wire custom agent definitions from the data layer into the `TaskGroupManager` and `RoomRuntime` so that custom agents can execute tasks alongside the four built-in agents (Planner, Coder, General, Leader).

## Scope

- New `createCustomAgentInit()` factory function
- `TaskGroupManager.spawn()` learns to resolve custom agent definitions
- `RoomRuntime.tick()` uses assigned agent (built-in or custom) when spawning groups
- Update `AgentType` to support custom agent IDs
- Unit and online tests for custom agent execution

---

### Task 2.1: Custom Agent Session Init Factory

**Agent:** coder
**Priority:** high
**Depends on:** Task 1.3

**Description:**

Create a factory function that builds an `AgentSessionInit` from a `CustomAgent` definition, analogous to `createCoderAgentInit()` and `createGeneralAgentInit()`.

**Subtasks:**

1. Create `packages/daemon/src/lib/room/agents/custom-agent.ts` with:
   - `CustomAgentConfig` interface containing: `customAgent: CustomAgent`, `task: NeoTask`, `goal: RoomGoal | null`, `room: Room`, `sessionId: string`, `workspacePath: string`, `previousTaskSummaries?: string[]`
   - `buildCustomAgentSystemPrompt(customAgent: CustomAgent): string` -- uses the custom agent's `systemPrompt` field as the base, prepends role identification and mandatory git workflow instructions (reuse from coder-agent.ts pattern), and appends bypass markers and review feedback sections
   - `buildCustomAgentTaskMessage(config: CustomAgentConfig): string` -- builds the initial task message with task context, goal context, room context (same pattern as buildCoderTaskMessage)
   - `createCustomAgentInit(config: CustomAgentConfig): AgentSessionInit` -- builds the session init using `customAgent.tools` for the tool list, `customAgent.model` for the model, and the custom system prompt

2. Handle the three roles differently:
   - `worker` role: use `claude_code` preset with custom prompt appended, standard tool set from `customAgent.tools`
   - `reviewer` role: will be used by Milestone 4 (workflow steps), for now just create the init with appropriate defaults
   - `orchestrator` role: reserved for future use, for now treat same as worker

3. Write unit tests:
   - Verify `AgentSessionInit` is correctly built for each role
   - Verify system prompt includes git workflow instructions
   - Verify tool list from `CustomAgent` is propagated to session init
   - Verify model/provider from `CustomAgent` is used

**Acceptance criteria:**
- `createCustomAgentInit()` produces a valid `AgentSessionInit` for custom agents
- System prompt includes both custom content and mandatory infrastructure (git workflow, bypass markers)
- Tool list is configurable via the `CustomAgent.tools` field
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 2.2: Extend AgentType and Task Assignment for Custom Agents

**Agent:** coder
**Priority:** high
**Depends on:** Task 2.1

**Description:**

Currently `AgentType = 'coder' | 'general'` is a string union. Extend the system so tasks can be assigned to custom agents by their ID.

**Subtasks:**

1. In `packages/shared/src/types/neo.ts`:
   - Change `AgentType` to `'coder' | 'general' | string` (keeping backward compat while allowing custom agent IDs)
   - Add a `customAgentId?: string` field to `NeoTask` to explicitly reference a custom agent when `assignedAgent` is a custom ID
   - Add `customAgentId?: string` to `CreateTaskParams` and `UpdateTaskParams`

2. In `packages/daemon/src/storage/schema/migrations.ts`:
   - Add migration to add `custom_agent_id TEXT` column to the `tasks` table

3. In `packages/daemon/src/storage/repositories/task-repository.ts`:
   - Handle the new `custom_agent_id` column in create/update/read operations

4. In the `TaskManager`:
   - When creating a task with `customAgentId`, validate the referenced custom agent exists in the same room

5. Write unit tests:
   - Create task with custom agent assignment
   - Validate custom agent reference
   - Read back task with customAgentId field

**Acceptance criteria:**
- Tasks can reference custom agents via `customAgentId`
- Built-in agent types (`coder`, `general`) continue to work unchanged
- Task creation validates custom agent existence
- DB migration adds column cleanly
- Unit tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`

---

### Task 2.3: Wire Custom Agents into TaskGroupManager and RoomRuntime

**Agent:** coder
**Priority:** high
**Depends on:** Task 2.2

**Description:**

Update `TaskGroupManager` and `RoomRuntime` to resolve and use custom agent definitions when spawning task execution groups.

**Subtasks:**

1. Add `CustomAgentManager` as a dependency of `RoomRuntimeConfig` and `TaskGroupManagerConfig`:
   - Pass it through from `RoomRuntimeService.createOrGetRuntime()`

2. In `RoomRuntime.ts`, update the `buildWorkerConfig()` method (or equivalent tick logic that determines which agent factory to use):
   - When a task has `customAgentId` set, look up the `CustomAgent` from `CustomAgentManager`
   - Use `createCustomAgentInit()` and `buildCustomAgentTaskMessage()` instead of the built-in factories
   - Fall back to built-in `assignedAgent` resolution if `customAgentId` is not set

3. In `TaskGroupManager.spawn()`:
   - Accept a `WorkerConfig` that can be built from either built-in or custom agents
   - No changes needed if `RoomRuntime` already builds the `WorkerConfig` -- verify this

4. Update `resolveAgentModel()` in `RoomRuntime`:
   - For custom agents, use the model from the `CustomAgent` definition directly
   - Fall back to room default model if custom agent model is empty

5. Write integration tests:
   - Spawn a task group with a custom agent worker
   - Verify the session init uses the custom agent's model, tools, and prompt
   - Verify built-in agents still work correctly (regression test)

6. Write an online test that creates a room with a custom agent, creates a task assigned to it, and verifies the agent session starts correctly

**Acceptance criteria:**
- Tasks assigned to custom agents spawn with the correct session configuration
- Built-in agent flow is unchanged (no regression)
- Model, tools, and system prompt from CustomAgent are used
- Integration and online tests pass
- Changes must be on a feature branch with a GitHub PR created via `gh pr create`
