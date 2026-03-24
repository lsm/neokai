# Milestone 4 — Worktree Path Shortening

## Goal

Shorten the worktree base directory path by replacing the full encoded repo path (e.g., `-Users-lsm-focus-dev-neokai`) with a short project key derived from the repo path. The git branch name remains unchanged. Existing worktrees continue to work via the old path; new worktrees use the shorter path.

## Context

Current worktree path format:
```
~/.neokai/projects/{full-encoded-repo-path}/worktrees/{safeSessionId}
```
Example:
```
/Users/lsm/.neokai/projects/-Users-lsm-focus-dev-neokai/worktrees/planner-04062505-...
```

The long encoded path comes from `WorktreeManager.encodeRepoPath()` in `packages/daemon/src/lib/worktree-manager.ts`. The `getWorktreeBaseDir()` method uses this encoding to produce the base directory.

Proposed short key: last path component of the repo root + first 8 characters of a deterministic hash of the full path. Example: `dev-neokai-a3b2c1d4`. This is human-readable, unique, and deterministic (same repo path always produces the same short key).

The `WorktreeManager` does not store anything in the DB — it operates purely on the filesystem. The path shortening is purely a filesystem naming change.

**Backward compatibility**: The old long path must still be recognized when checking if an existing session's worktree path is valid (`verifyWorktree`). The DB `worktree_path` column stores the actual path of the worktree directory, so old sessions already have the long path stored. New sessions get the short path. Both coexist.

## Tasks

---

### Task 4.1 — Implement Project Short Key Generation in WorktreeManager

**Description**: Add a `getProjectShortKey(repoPath: string): string` method to `WorktreeManager` that produces a short, deterministic, human-readable directory name for a given repo path, and update `getWorktreeBaseDir` to use it.

**Subtasks**:
1. In `packages/daemon/src/lib/worktree-manager.ts`, add a private method `getProjectShortKey(repoPath: string): string`:
   - Extract the last component of the path: `basename(repoPath)` — e.g., `dev-neokai`
   - Compute a 8-character hex hash of the full normalized path using `Bun.hash()` or a simple djb2/FNV-1a hash (avoid importing crypto for this small utility)
   - Return `${lastComponent}-${hash8chars}` — e.g., `dev-neokai-a3b2c1d4`
   - Sanitize: replace characters invalid in directory names with `-` (keep alphanumeric, hyphens, underscores)
2. Update `getWorktreeBaseDir(gitRoot: string)` to call `getProjectShortKey(gitRoot)` instead of `encodeRepoPath(gitRoot)`, so new worktrees go into the short path
3. Keep `encodeRepoPath` — it is still used by `cleanupOrphanedWorktrees` to detect session worktrees (the `.includes('.neokai/projects')` check still works regardless of key format)
4. Write unit tests for `getProjectShortKey`:
   - Same path always returns the same key (deterministic)
   - Different paths return different keys (collision resistance via hash)
   - Output contains only safe filesystem characters
   - Output is shorter than the full encoded path

**Acceptance Criteria**:
- `getProjectShortKey('/Users/alice/code/my-project')` returns a string like `my-project-a3b2c1d4`
- The key is deterministic — calling twice with the same input returns the same result
- New worktrees are created at `~/.neokai/projects/{shortKey}/worktrees/...`
- Old worktrees (with long paths) continue to work — `verifyWorktree` checks the `worktreePath` stored in DB, so existing records still point to the old path which still exists on disk
- Unit tests pass

**Depends on**: Milestone 1 complete (can run in parallel with Milestones 2–3)

**Agent type**: coder

**Branch/PR**: Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

---

### Task 4.2 — Update TEST_WORKTREE_BASE_DIR Handling and Integration Tests

**Description**: The `WorktreeManager` has a `TEST_WORKTREE_BASE_DIR` environment variable override for tests. Ensure test infrastructure continues to work with the new short key. Also run the worktree manager unit tests and fix any failures.

**Subtasks**:
1. Run existing `WorktreeManager` unit tests (`cd packages/daemon && bun test tests/unit/worktree/`) and confirm they still pass after the `getWorktreeBaseDir` change
2. If tests use hardcoded path expectations that include the old encoded format, update them to use the new short key format
3. Add a unit test that verifies `getWorktreeBaseDir` with the new format still respects `TEST_WORKTREE_BASE_DIR` when set
4. Add a unit test that verifies a worktree created with the old long path format is still recognized by `verifyWorktree` (simulate old-format path in the DB record)

**Acceptance Criteria**:
- All worktree unit tests pass
- The `TEST_WORKTREE_BASE_DIR` override still works correctly
- The transition test (old path format still valid in `verifyWorktree`) passes

**Depends on**: Task 4.1

**Agent type**: coder

**Branch/PR**: Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.
