# Milestone 2: Task Agent System Prompt and Session Init

## Goal

Build the system prompt, initial task message builder, and `AgentSessionInit` factory for Task Agent sessions. This mirrors the pattern established in `custom-agent.ts` for step agents but is specifically designed for the orchestrator role.

## Tasks

### Task 2.1: Build Task Agent System Prompt

**Description:** Create the system prompt builder for Task Agent sessions. The Task Agent prompt defines it as a workflow orchestrator that uses MCP tools to manage sub-sessions, does not execute code directly, and surfaces human gates.

**Subtasks:**
1. Create `packages/daemon/src/lib/space/agents/task-agent.ts`
2. Define `TaskAgentContext` interface containing: task (`SpaceTask`), workflow (`SpaceWorkflow`), workflowRun (`SpaceWorkflowRun`), space (`Space`), available agents list, previous task summaries
3. Implement `buildTaskAgentSystemPrompt(context: TaskAgentContext): string` that generates a system prompt covering:
   - Role: "You are a Task Agent -- a workflow orchestrator that manages the execution of a specific task"
   - Available MCP tools and when to use each one
   - Workflow execution instructions: spawn step agents, monitor completion, advance workflow
   - Human gate handling: when a human gate is encountered, use `request_human_input` and wait
   - Rules: do not execute code directly, delegate to step agents, do not bypass human gates
   - Task context: title, description, priority, dependencies
4. Implement `buildTaskAgentInitialMessage(context: TaskAgentContext): string` that generates the first user message sent to the Task Agent containing:
   - The task assignment details
   - The workflow structure (steps, transitions, conditions)
   - Available agents and their roles
   - Previous task results for context continuity
5. Write unit tests verifying the prompt contains expected sections and handles edge cases (no workflow, no previous tasks, etc.)
6. Run `bun run typecheck` and `make test-daemon`

**Acceptance Criteria:**
- `buildTaskAgentSystemPrompt` produces a prompt that clearly defines the Task Agent's role, available tools, and behavioral constraints
- `buildTaskAgentInitialMessage` includes task details, workflow structure, and available agents
- Edge cases (no workflow, no agents, no previous tasks) produce valid prompts without errors
- Unit tests cover both functions

**Dependencies:** Task 1.1 (needs `space_task_agent` session type)

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.

---

### Task 2.2: Create Task Agent Session Init Factory

**Description:** Implement the `createTaskAgentInit()` factory function that produces an `AgentSessionInit` for a Task Agent session, following the pattern in `createCustomAgentInit()`.

**Subtasks:**
1. In `packages/daemon/src/lib/space/agents/task-agent.ts`, define `TaskAgentSessionConfig` interface with: `taskId`, `sessionId`, `space`, `task`, `workflow`, `workflowRun`, `workspacePath`
2. Implement `createTaskAgentInit(config: TaskAgentSessionConfig): AgentSessionInit` that:
   - Sets `type: 'space_task_agent'`
   - Sets `systemPrompt` using `buildTaskAgentSystemPrompt()`
   - Sets `features` with rewind/worktree/coordinator disabled, sessionInfo enabled
   - Sets `context` with `{ spaceId: space.id, taskId: task.id }`
   - Uses the space's default model (or a configured orchestrator model)
   - Sets `contextAutoQueue: false`
   - Does NOT include MCP servers -- those are attached at runtime by the TaskAgentManager
3. Export the factory function and types from `packages/daemon/src/lib/space/index.ts`
4. Write unit tests verifying the init structure matches expectations
5. Run `bun run typecheck` and `make test-daemon`

**Acceptance Criteria:**
- `createTaskAgentInit` returns a valid `AgentSessionInit` with correct session type, prompt, and features
- The init does not include MCP servers (they are attached at runtime)
- Factory function is exported from the space module index
- Unit tests verify the init structure

**Dependencies:** Task 2.1 (needs the prompt builders)

**Agent Type:** coder

Changes must be on a feature branch with a GitHub PR created via `gh pr create`.
