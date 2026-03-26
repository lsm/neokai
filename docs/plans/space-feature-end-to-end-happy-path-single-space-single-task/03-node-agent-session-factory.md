# Milestone 3: Node Agent Session Factory Improvements

## Goal and Scope

Ensure node agent sessions created by `TaskAgentManager` have proper worktree isolation, feature flags, and MCP tool access for PR operations. The session factory must produce sessions that can actually perform git operations, create PRs, and post reviews.

## Tasks

### Task 3.1: Add Worktree Support to Node Agent Sessions

**Description**: Node agents need isolated worktrees (similar to Room's worker sessions) so they can create branches, commit, and push without affecting other agents' work. Currently, `TaskAgentManager.spawnSubSession()` may not configure worktree paths correctly.

**Subtasks**:
1. Review `TaskAgentManager.spawnSubSession()` to understand how sessions are created
2. Ensure worktree paths are resolved from the Space's `workspacePath` for each node agent
3. Verify that `workspacePath` in `AgentSessionInit` points to an isolated worktree directory
4. Add worktree lifecycle management: create worktree before spawning, clean up after completion
5. Ensure the `WorktreeManager` (from Room system) can be reused for Space worktrees

**Acceptance Criteria**:
- Each node agent session operates in an isolated worktree
- Worktrees are cleaned up after session completion
- Git operations in one agent don't affect another agent's worktree
- Unit tests verify worktree isolation

**Depends on**: Task 1.1 (coder prompt with git workflow)

**Agent type**: coder

---

### Task 3.2: Configure Feature Flags for Node Agent Sessions

**Description**: Node agents need specific feature flags to match their capabilities. Reviewers should not have rewind/worktree features; coders need full tool access.

**Subtasks**:
1. Define feature flag profiles per agent role:
   - `coder`: `rewind: false, worktree: false, coordinator: false, archive: false, sessionInfo: false` (same as Room)
   - `reviewer`: same flags + no Write/Edit tools (already handled by agent tools config)
   - `planner`: same flags as coder
   - `general`: same flags as coder
2. Apply the correct feature flags in `TaskAgentManager.spawnSubSession()` based on the node agent's role
3. Ensure feature flags are correctly passed through to `createCustomAgentInit()`

**Acceptance Criteria**:
- Node agents have correct feature flags for their role
- Reviewers cannot use Write/Edit tools (enforced by tool list, not feature flags)
- Unit tests verify feature flag configuration per role

**Depends on**: nothing

**Agent type**: coder

---

### Task 3.3: Ensure MCP Tool Access for PR Operations

**Description**: Node agents need access to MCP tools for PR operations (posting reviews, merging PRs, etc.) and for Space-level tools (task creation, status updates). Verify the MCP server composition in `TaskAgentManager`.

**Subtasks**:
1. Audit the MCP servers composed into node agent sessions in `TaskAgentManager`
2. Ensure `node-agent-tools` MCP server provides: `send_message`, `report_done`, `list_peers`, `list_reachable_agents`
3. Ensure no git/gh access is blocked by the session configuration
4. Verify that `createCustomAgentInit()` properly connects the agent's tools to the session
5. Add a unit test that verifies the MCP tool composition for each agent role

**Acceptance Criteria**:
- All MCP tools are correctly registered for each agent type
- Git/gh CLI commands work in node agent sessions
- No tool access errors during agent execution
- Unit test validates MCP tool composition

**Depends on**: Task 3.1, Task 3.2

**Agent type**: coder
