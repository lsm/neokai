# Milestone 4: Worktree Isolation (One Per Task)

## Goal and Scope

Implement git worktree isolation for Space tasks. Each task gets **one worktree** shared by all agents in that task (planner, coder, reviewer, QA all work in the same worktree). Worktree folder names are short, human-readable, and memorable (e.g., `alpha-3`, `nova-7`, `flux-2`).

## Key Design Decisions

1. **One worktree per task, not per agent**. Agents work sequentially within a task, so there are no conflicts. This is simpler to manage and matches the Room system's approach.

2. **Short, human-readable names**. Format: `{adjective}-{number}` (e.g., `alpha-3`, `nova-7`, `flux-2`, `spark-12`). Similar to how Codex names its sandboxes. The name doesn't need to encode session IDs or task IDs — the DB links everything.

3. **Name generation**: Pick from a curated word list (~50 short adjectives: alpha, beta, nova, flux, spark, blaze, drift, frost, etc.) + sequential number. Check for uniqueness against existing worktrees.

4. **Worktree lifecycle**: Created when task workflow starts, cleaned up when task completes or is cancelled.

## Tasks

### Task 4.1: Implement Worktree Name Generator

**Description**: Create a name generator that produces short, memorable, unique worktree folder names.

**Subtasks**:
1. Create `packages/daemon/src/lib/space/worktree-names.ts` with:
   - A curated word list of ~50 short adjectives (alpha, beta, nova, flux, spark, blaze, drift, frost, pulse, quark, etc.)
   - `generateWorktreeName(existingNames: string[]): string` — picks a random adjective + incrementing number, ensures uniqueness
2. Names are 2-8 characters for the adjective, 1-3 digits for the number
3. Unit tests: uniqueness, format validation, collision handling

**Acceptance Criteria**:
- Generated names are short and human-readable (e.g., `alpha-3`, `nova-7`)
- No collisions with existing worktree names
- Unit tests verify format and uniqueness

**Depends on**: nothing

**Agent type**: coder

---

### Task 4.2: Implement Space Worktree Manager

**Description**: Create a `SpaceWorktreeManager` that manages git worktrees for Space tasks. One worktree per task, created from the space's repository.

**Subtasks**:
1. **Investigate existing WorktreeManager**: Read `packages/daemon/src/lib/room/managers/worktree-manager.ts` and decide: reuse (with modifications) or new implementation.
   - Decision criteria: if reusing requires >3 non-trivial modifications or would break Room functionality, create new.
2. Create `SpaceWorktreeManager` in `packages/daemon/src/lib/space/`:
   - `createTaskWorktree(spaceId: string, taskId: string, baseBranch?: string): Promise<{ path: string, name: string }>` — creates worktree with short name, returns path and name
   - `removeTaskWorktree(spaceId: string, taskId: string): Promise<void>` — cleans up
   - `getTaskWorktreePath(spaceId: string, taskId: string): Promise<string | null>` — looks up existing worktree for a task
   - `listWorktrees(spaceId: string): Promise<Array<{ name: string, taskId: string, path: string }>>` — lists all worktrees for a space
   - `cleanupOrphaned(spaceId: string): Promise<void>` — removes worktrees for completed/cancelled tasks
3. Worktree location: `{spaceWorkspacePath}/.worktrees/{worktree-name}/` (e.g., `.worktrees/alpha-3/`)
4. Persist worktree ↔ task mapping in SQLite (table: `space_worktrees` with columns: `id`, `space_id`, `task_id`, `name`, `path`, `created_at`)
5. Branch naming: `space/{taskId}/{worktree-name}` (e.g., `space/task-abc/alpha-3`)
6. Unit tests: create, remove, lookup, list, orphan cleanup

**Acceptance Criteria**:
- One worktree per task with short, readable name
- Worktree ↔ task mapping persisted in SQLite
- Create/remove/lookup/list/cleanup all work
- Unit tests cover lifecycle

**Depends on**: Task 4.1

**Agent type**: coder

---

### Task 4.3: Wire Worktree into TaskAgentManager

**Description**: Update `TaskAgentManager.spawnSubSession()` to use the task's worktree instead of the raw space workspace path.

**Subtasks**:
1. Before spawning the first node agent for a task, call `SpaceWorktreeManager.createTaskWorktree()`
2. Store the worktree path in the workflow run metadata
3. All subsequent `spawnSubSession()` calls for the same task use the same worktree path as `workspacePath`
4. On workflow run completion (Done node), call `SpaceWorktreeManager.removeTaskWorktree()`
5. On workflow run cancellation, clean up the worktree
6. On daemon restart, run `cleanupOrphaned()` to remove worktrees from stale runs
7. Unit tests: worktree creation at run start, reuse across nodes, cleanup at completion/cancellation

**Acceptance Criteria**:
- All node agents in a task share the same worktree
- Worktree is created at workflow run start and cleaned up at completion
- Cancellation cleans up the worktree
- Daemon restart cleans up orphaned worktrees
- Unit tests verify lifecycle

**Depends on**: Task 4.2

**Agent type**: coder

---

### Task 4.4: Configure Feature Flags and Tool Access per Role

**Description**: Node agents need specific feature flags and tool access based on their role.

**Subtasks**:
1. Define feature flag profiles per role:
   - `coder`: `rewind: false, worktree: false, coordinator: false, archive: false, sessionInfo: false`
   - `reviewer`: same (tool restrictions handled by tool list, not feature flags)
   - `planner`: same as coder
   - `qa`: same as reviewer
2. Define tool access per role:
   - `coder`: full tool access (Read, Write, Edit, Bash, Grep, Glob + MCP tools)
   - `planner`: full tool access
   - `reviewer`: read-only (Read, Bash, Grep, Glob — no Write/Edit)
   - `qa`: read-only + bash for running tests (Read, Bash, Grep, Glob)
3. Apply in `TaskAgentManager.spawnSubSession()` and `createCustomAgentInit()`
4. Unit tests verify configuration per role

**Acceptance Criteria**:
- Correct feature flags per role
- Reviewers and QA cannot use Write/Edit
- Unit tests verify configuration

**Depends on**: nothing (parallel with other M4 tasks)

**Agent type**: coder
