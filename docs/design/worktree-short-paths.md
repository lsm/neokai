# Worktree Short Path Design Options

## Problem

Room task worktree paths are excessively long (146 chars to worktree root, up to 235 chars to deep files), risking OS path-length limits and hurting readability.

## Current Path Anatomy

```
/Users/lsm/.neokai/projects/dev-neokai-ec0a1deb/worktrees/coder-04062505-780f-4881-a3be-9cb9062790fb-f23fddc6-fec3-4e19-9810-186f9aeebf22-3ca78c48
```

| Segment | Example | Chars | Notes |
|---------|---------|-------|-------|
| Home dir | `/Users/lsm/` | 11 | Fixed |
| Base dir | `.neokai/projects/` | 18 | Convention |
| Project key | `dev-neokai-ec0a1deb/` | 20 | Short key from PR #792 |
| Worktrees segment | `worktrees/` | 10 | Literal |
| **Session ID leaf** | `coder-04062505-...-3ca78c48` | **88** | **The problem** |
| **Total to root** | | **146** | |
| Deepest file | `packages/daemon/tests/online/.../continuity.test.ts` | **235** | Dangerously close to 260-char Windows limit |

### Root Cause

The session ID format for room tasks is `{role}:{roomId}:{taskId}:{8-char-uuid}`. After colon-to-dash sanitization, this 88-char string becomes the worktree directory name. PR #792's `getProjectShortKey()` shortened the project directory (~8 chars saved) but left the session ID leaf untouched.

### DB Path Inconsistency

`config.ts` still uses the old `encodeRepoPath()` for the database path while `worktree-manager.ts` uses the newer `getProjectShortKey()`. These should be unified.

```
DB (current):  ~/.neokai/projects/-Users-lsm-focus-dev-neokai/database/daemon.db  (74 chars from /)
DB (short key): ~/.neokai/projects/dev-neokai-ec0a1deb/database/daemon.db          (57 chars from /)
```

## What Information Needs to Be in the Path

Currently encoded in the worktree directory name:
- **Role** (`coder`, `leader`) — useful for debugging, not essential
- **Room ID** (UUID) — identifies which room the task belongs to
- **Task ID** (UUID) — identifies the specific task
- **Session UUID suffix** (8 chars) — disambiguates multiple sessions for the same task

Only **uniqueness** is truly required. Debugging context (role, room, task) can be stored in a mapping file or DB lookup.

## Proposed Options

### Option A: Short Hash Leaf

Replace session-ID leaf with a 12-char hash of the session ID.

```
~/.neokai/projects/dev-neokai-ec0a1deb/wt/a3b2c1d4f5e6/
```

**Total path: ~63 chars from home → 83 chars saved**

| Pros | Cons |
|------|------|
| Minimal code change (only `createWorktree` + rename `worktrees/` to `wt/`) | Opaque names — can't tell which task a dir belongs to |
| Deterministic (same session → same hash) | Need DB/file mapping to resolve hash → session |
| No collision risk with 12 hex chars (48 bits) | |

### Option B: Sequential Counter per Project

Monotonically incrementing integer per project, persisted in a counter file.

```
~/.neokai/projects/dev-neokai-ec0a1deb/wt/42/
```

**Total path: ~52 chars from home → 94 chars saved**

| Pros | Cons |
|------|------|
| Ultra-short, most compact option | Requires persistent counter file |
| Easy to scan (`wt/41/`, `wt/42/`) | Counter drift if file corrupted |
| No collision risk | Sequential numbers leak ordering info |

### Option C: Human-Readable Slug + Short Hash

Derive from branch name (already computed from task title) + 4-char hash suffix.

```
~/.neokai/projects/dev-neokai-ec0a1deb/wt/fix-login-btn-a3b2/
```

**Total path: ~70-80 chars from home → 66-76 chars saved**

| Pros | Cons |
|------|------|
| Human-readable — `ls` output immediately useful | Slightly longer than hash/counter |
| Consistent with Space worktree naming (`worktreeSlug()`) | Need max-length cap on slug portion |
| Branch name already computed in `task-group-manager.ts:263` | Slug collision handling needed |

### Option D: Flatten Base Directory

Move all worktrees to a shared top-level dir, eliminate per-project nesting.

```
~/.neokai/wt/{proj4}-{hash8}/
e.g., ~/.neokai/wt/nkai-a3b2c1d4/
```

**Total path: ~40 chars from home → 106 chars saved**

| Pros | Cons |
|------|------|
| Absolute shortest possible | All projects share one flat namespace |
| Minimal nesting depth | Breaks `~/.neokai/projects/{key}/` convention |
| | Harder to find worktrees per project |

### Option E: Hybrid — Short Base + Slug Leaf (Recommended)

Combine `wt/` (instead of `worktrees/`) with capped human-readable slug leaf. Also unify DB path to use short key.

```
Worktree: ~/.neokai/projects/dev-neokai-ec0a1deb/wt/fix-login-btn-a3b2/
DB:       ~/.neokai/projects/dev-neokai-ec0a1deb/db/daemon.db
```

**Worktree path: ~68 chars from home → 78 chars saved**
**DB path: ~50 chars from home → 24 chars saved**

| Pros | Cons |
|------|------|
| Best balance of readability and compactness | Not absolute minimum (~68 chars) |
| Consistent with Space worktree naming | Need to pass branch/task title into path generation |
| DB path also shortened | Migration needed for existing DB locations |
| Reuses existing `worktreeSlug()` infrastructure | |
| Branch name already available at call site | |

## Summary Comparison

| Option | Path (from /) | Savings | Readability | Complexity |
|--------|---------------|---------|-------------|------------|
| Current | 146 chars | — | Low (UUID soup) | — |
| A: Short Hash | ~74 | -72 | Low | Low |
| B: Sequential | ~55 | -91 | Medium | Medium |
| C: Slug+Hash | ~80 | -66 | High | Medium |
| D: Flat Base | ~51 | -95 | Low | High |
| **E: Hybrid** | **~68** | **-78** | **High** | **Medium** |

## Key Files to Modify

| File | What Changes |
|------|-------------|
| `packages/daemon/src/lib/worktree-manager.ts` | `createWorktree()` — use slug instead of session ID for dir name; rename `worktrees/` to `wt/` |
| `packages/daemon/src/lib/room/runtime/task-group-manager.ts` | Pass branch name / task title to `createWorktree()` |
| `packages/daemon/src/config.ts` | Switch `encodeRepoPath()` to `getProjectShortKey()` for DB path |
| `packages/daemon/src/lib/space/worktree-slug.ts` | Possibly reuse/share slug logic with room worktrees |

## Migration Strategy

- **New worktrees** get short paths immediately.
- **Existing worktrees** continue working at their old paths until sessions end and they are cleaned up naturally.
- **DB path migration** requires a symlink or directory move on first startup detecting the old path. Alternatively, check both old and new locations.
