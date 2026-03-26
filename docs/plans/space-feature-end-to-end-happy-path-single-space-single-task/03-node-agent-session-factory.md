# Milestone 3: Node Agent Session Factory Improvements

## Goal and Scope

Implement worktree isolation for node agent sessions so each agent operates in its own git worktree. Configure feature flags and MCP tool access per agent role. The session factory must produce sessions that can actually perform git operations, create PRs, and post reviews without interfering with each other.

## Current State (Critical Finding)

Currently, `TaskAgentManager.spawnSubSession()` passes `workspacePath: space.workspacePath` directly — **no worktree isolation exists**. All node agents share the same working directory. The `CUSTOM_AGENT_FEATURES` constant has `worktree: false` which is a feature flag that controls UI behavior (whether the worktree button appears), NOT actual worktree creation. This milestone must **implement** worktree isolation, not just verify it.

## Worktree Isolation Strategy

Each node agent session gets its own git worktree created from the same repository:
- **Coder**: Gets a worktree with a feature branch (e.g., `space/{spaceId}/task/{taskId}/code`). Can commit, push, create PRs.
- **Planner**: Gets a worktree with a plan branch (e.g., `space/{spaceId}/task/{taskId}/plan`). Creates plan files, pushes, creates plan PRs.
- **Reviewer**: Gets a worktree checked out at the PR's head commit (read-only review). Does NOT commit or push.
- **QA**: Gets a worktree checked out at the PR's head commit. Runs tests locally but does NOT commit.

**Worktree lifecycle**:
1. Before spawning a node agent session, create the worktree via `git worktree add`.
2. Set the worktree path as `workspacePath` in `AgentSessionInit`.
3. After the node agent completes, clean up the worktree via `git worktree remove`.
4. If the workflow run is cancelled, clean up all active worktrees.

**WorktreeManager reuse**: Investigate whether the Room system's `WorktreeManager` (in `packages/daemon/src/lib/room/managers/worktree-manager.ts`) can be reused for Space worktrees. If not, create a lightweight wrapper that provides `createWorktree(repoPath, branchName)` and `removeWorktree(worktreePath)` methods. The Room system's WorktreeManager is likely tightly coupled to Room concepts (session groups, room IDs) — the Space system may need a simpler, standalone implementation.

## Tasks

### Task 3.1: Implement Worktree Isolation for Node Agent Sessions

**Description**: Create worktree management for Space node agent sessions. Each node agent gets an isolated git worktree for its work.

**Owner**: This task owns the full implementation of worktree isolation — investigation, implementation, lifecycle management, and cleanup.

**Subtasks**:
1. **Investigate existing WorktreeManager (bounded)**: Read `packages/daemon/src/lib/room/managers/worktree-manager.ts` and produce a decision document with one of two outcomes:
   - **Reusable (with modifications)**: The Room WorktreeManager can be adapted. Document the required changes (e.g., parameterizing room-specific concepts). Proceed with modifications.
   - **New implementation required**: The Room WorktreeManager is too tightly coupled to Room concepts (session groups, room IDs, etc.). Create a new `SpaceWorktreeManager` class in `packages/daemon/src/lib/space/` with a simpler API:
     - `createWorktree(repoPath: string, branchName: string, baseBranch?: string): Promise<string>` — returns worktree path
     - `removeWorktree(worktreePath: string): Promise<void>` — cleans up worktree
     - `listWorktrees(repoPath: string): Promise<string[]>` — lists all space worktrees
   - **Decision criteria**: If reusing requires >3 non-trivial modifications to the existing class or would break Room functionality, choose new implementation.
2. **Implement worktree creation in TaskAgentManager**: Before calling `spawnSubSession()`, create a worktree for the node agent. The branch naming convention: `space/{spaceId}/task/{taskId}/{nodeRole}`.
3. **Update spawnSubSession()**: Pass the worktree path as `workspacePath` in `AgentSessionInit` instead of the raw `space.workspacePath`.
4. **Implement worktree cleanup**:
   - After node agent completion (successful `report_done`), remove the worktree.
   - On workflow run cancellation, remove all active worktrees for that run.
   - On daemon shutdown/restart, clean up orphaned space worktrees (worktrees whose workflow runs are no longer active).
5. **Handle reviewer worktree specially**: Reviewers should have a worktree checked out at the PR head commit (read-only). They should NOT create a new branch or push.
6. **Handle QA worktree specially**: QA should have a worktree at the PR head commit. It runs tests locally but does NOT commit.
7. **Add unit tests**:
   - Worktree creation and removal
   - Worktree isolation (git operations in one worktree don't affect another)
   - Cleanup on completion and cancellation
   - Orphan cleanup on daemon restart

**Acceptance Criteria**:
- Each node agent session operates in an isolated git worktree
- Worktrees are created before session spawn and cleaned up after completion
- Git operations in one agent's worktree don't affect another agent's worktree
- Reviewer and QA worktrees are read-only (no push access)
- Cleanup works on completion, cancellation, and daemon restart
- Unit tests verify all worktree lifecycle scenarios

**Depends on**: Task 1.1 (coder prompt with git workflow — defines what git operations the coder needs)

**Agent type**: coder

---

### Task 3.2: Configure Feature Flags for Node Agent Sessions

**Description**: Node agents need specific feature flags to match their capabilities. Reviewers should not have rewind/worktree features; coders need full tool access.

**Subtasks**:
1. Define feature flag profiles per agent role:
   - `coder`: `rewind: false, worktree: false, coordinator: false, archive: false, sessionInfo: false` (same as Room)
   - `reviewer`: same flags (tool-level restrictions are handled by agent tools config, not feature flags)
   - `planner`: same flags as coder
   - `qa`: same flags as reviewer (read-only + bash for running tests)
   - `general`: same flags as coder
2. Apply the correct feature flags in `TaskAgentManager.spawnSubSession()` based on the node agent's role
3. Ensure feature flags are correctly passed through to `createCustomAgentInit()`

**Acceptance Criteria**:
- Node agents have correct feature flags for their role
- Reviewers and QA cannot use Write/Edit tools (enforced by tool list, not feature flags)
- Unit tests verify feature flag configuration per role

**Depends on**: nothing (can run in parallel with Task 2.1)

**Agent type**: coder

---

### Task 3.3: Ensure MCP Tool Access for PR Operations

**Description**: Node agents need access to MCP tools for PR operations (posting reviews, merging PRs, etc.) and for Space-level tools (task creation, status updates). Verify and fix the MCP server composition in `TaskAgentManager`.

**Subtasks**:
1. Audit the MCP servers composed into node agent sessions in `TaskAgentManager`
2. Ensure `node-agent-tools` MCP server provides: `send_message`, `report_done`, `list_peers`, `list_reachable_agents`
3. Ensure no git/gh access is blocked by the session configuration — verify that `Bash` tool is available for coder/planner/reviewer/qa agents (needed for `git` and `gh` CLI commands)
4. Verify that `createCustomAgentInit()` properly connects the agent's tools to the session
5. Verify `gh` CLI authentication: ensure the `gh` CLI is available in the agent's PATH and that the daemon's GitHub token is accessible. Node agent sessions should inherit the same `gh` auth context as the daemon.
6. Add a unit test that verifies the MCP tool composition for each agent role

**Acceptance Criteria**:
- All MCP tools are correctly registered for each agent type
- Git/gh CLI commands work in node agent sessions
- `gh` CLI inherits the daemon's GitHub authentication
- No tool access errors during agent execution
- Unit test validates MCP tool composition per role

**Depends on**: Task 3.1, Task 3.2

**Agent type**: coder
