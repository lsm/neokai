# M1: Core Types and RPC Infrastructure

## Milestone Goal

Define the shared types for the @ reference system, create backend RPC handlers for searching and resolving references, implement a workspace file index with caching, and create the reference resolution service.

## Scope

- Shared type definitions for reference types and resolved entities
- RPC handlers for searching entities (`reference.search`)
- RPC handlers for resolving individual references (`reference.resolve`)
- Workspace file index with caching for fast file/folder search
- Context-aware search (room tasks, space tasks, workspace files)
- Graceful fallback for sessions without room/space context

---

## Tasks

### Task 1.1: Define Reference Types in Shared Package

**Description:** Create the core type definitions for the @ reference system in `packages/shared/src/types/reference.ts`.

**Subtasks:**
1. Create `packages/shared/src/types/reference.ts` with:
   - `ReferenceType` union type: `'task' | 'goal' | 'file' | 'folder'` (not an enum — matches existing codebase patterns like `SessionType`)
   - `ReferenceMention` interface: `{ type: ReferenceType; id: string; displayText: string }`
   - `ReferenceSearchResult` interface: `{ type: ReferenceType; id: string; shortId?: string; displayText: string; subtitle?: string }`
   - `ResolvedReference` interface: `{ type: ReferenceType; id: string; data: unknown }` (polymorphic based on type)
   - `ResolvedTaskReference`, `ResolvedGoalReference`, `ResolvedFileReference`, `ResolvedFolderReference` interfaces
   - `ReferenceMetadata` interface: `Map<string, { type: ReferenceType; id: string; displayText: string; status?: string }>` — stored in message blob
   - Regex constant for parsing: `REFERENCE_PATTERN = /@ref\{([^}:]+):([^}]+)\}/g`
2. Export types from `packages/shared/src/types/index.ts`
3. Add barrel export in `packages/shared/src/mod.ts`

**Acceptance Criteria:**
- Types compile without errors
- Types are accessible via `@neokai/shared` import
- `ReferenceType` is a union type, not an enum
- `REFERENCE_PATTERN` correctly matches `@ref{task:t-42}` and rejects normal markdown links
- Unit test in `packages/shared/src/types/__tests__/reference.test.ts` validates type shapes and regex pattern

**Depends on:** None

**Agent Type:** coder

---

### Task 1.2: Implement Workspace File Index with Caching

**Description:** Create a workspace file tree index that caches directory listings and is updated via file-watcher events, enabling fast fuzzy file/folder search without recursive directory listing on every query.

**Subtasks:**
1. Create `packages/daemon/src/lib/file-index.ts`:
   - `FileIndex` class with dependency injection for workspace path
   - `init(workspacePath: string): Promise<void>` — initial recursive scan of workspace
   - `search(query: string, limit?: number): FileIndexEntry[]` — fuzzy search across cached entries
   - `invalidate(path: string): void` — remove single path from cache
   - `invalidateAll(): void` — clear entire cache (e.g., on workspace change)
   - `isReady(): boolean` — whether initial scan is complete
   - Entry type: `{ path: string; name: string; type: 'file' | 'folder' }`
2. Implement fuzzy matching:
   - Case-insensitive substring matching as baseline
   - Optional: fts5 SQLite-based search for large workspaces
   - Score by: exact match > starts with > contains > path segment match
3. Integrate with file-watcher events:
   - Listen for create/delete/rename events from existing file-watcher infrastructure
   - Update cache incrementally (no full re-scan needed for individual file changes)
   - Debounce rapid changes (e.g., git checkout with many file changes)
4. Add path traversal prevention:
   - Reject paths containing `..` segments
   - Reject absolute paths outside workspace root
   - Normalize paths before storing

**Acceptance Criteria:**
- File index populates from workspace on init
- Search returns results within 10ms for typical workspaces (vs hundreds of ms for recursive listing)
- Cache updates incrementally on file-watcher events
- Path traversal attempts are rejected
- Unit tests cover init, search, invalidation, and path traversal prevention
- Test file: `packages/daemon/tests/unit/file-index.test.ts`

**Depends on:** None

**Agent Type:** coder

---

### Task 1.3: Implement Reference Search RPC Handler

**Description:** Create the backend RPC handler that searches across tasks, goals, files, and folders based on a query string.

**Subtasks:**
1. Create `packages/daemon/src/lib/rpc-handlers/reference-handlers.ts`
2. Implement `reference.search` RPC:
   - Parameters: `{ sessionId: string; query: string; types?: ReferenceType[] }`
   - Returns: `{ results: ReferenceSearchResult[] }`
   - Search logic:
     - For `task`: Query room tasks via `TaskRepository` using current session's room context. If session has no room context, skip task results.
     - For `goal`: Query goals via `GoalRepository` using current session's room context. If session has no room context, skip goal results.
     - For `file`/`folder`: Query `FileIndex.search()` for cached results. Always available regardless of room context.
   - Limit results to 10 per category
   - Combine and sort results by relevance (exact match > starts with > contains)
3. Register handler in `packages/daemon/src/lib/daemon-hub.ts`
4. Handle standalone sessions (no room/space):
   - Return only file/folder results
   - Do not throw or return errors for task/goal queries — just return empty results for those types

**Acceptance Criteria:**
- `reference.search` returns matching tasks, goals, files, and folders
- Results are context-aware (uses session's room ID or space ID)
- Standalone sessions return only file/folder results
- File/folder search uses `FileIndex` (not recursive directory listing)
- Path traversal in file queries is rejected
- Unit tests cover each entity type search, standalone sessions, and path traversal
- Test file: `packages/daemon/tests/unit/reference-handlers.test.ts`

**Depends on:** Task 1.1, Task 1.2

**Agent Type:** coder

---

### Task 1.4: Implement Reference Resolve RPC Handler

**Description:** Create the backend RPC handler that resolves a single reference to its full entity data.

**Subtasks:**
1. Add `reference.resolve` RPC to `reference-handlers.ts`:
   - Parameters: `{ sessionId: string; type: ReferenceType; id: string }`
   - Returns: `{ resolved: ResolvedReference | null }`
   - Resolution logic:
     - For `task`: Fetch full `NeoTask` or `SpaceTask` via repository. If no room context, return null.
     - For `goal`: Fetch full `RoomGoal` via `GoalRepository`. If no room context, return null.
     - For `file`: Read file content via `FileManager.readFile`, truncate to reasonable size. Validate path is within workspace root.
     - For `folder`: List folder contents via `FileManager.listDirectory`. Validate path is within workspace root.
2. Handle missing entities gracefully (return null)
3. Add rate limiting consideration (file reads should be limited)

**Acceptance Criteria:**
- `reference.resolve` returns full entity data for valid references
- Returns null for missing entities or invalid room context without throwing
- File content is truncated to prevent oversized payloads
- Path traversal is prevented for file/folder access
- Unit tests cover each entity type resolution and path traversal prevention
- Test file: `packages/daemon/tests/unit/reference-handlers.test.ts`

**Depends on:** Task 1.1, Task 1.3

**Agent Type:** coder

---

### Task 1.5: Create Reference Resolution Service

**Description:** Create a reusable service class that handles reference parsing from text and resolution orchestration. This is the core service used by both RPC handlers and the message preprocessor.

**Subtasks:**
1. Create `packages/daemon/src/lib/agent/reference-resolver.ts`:
   - `ReferenceResolver` class with dependency injection for repositories
   - `extractReferences(text: string): ReferenceMention[]` — Parse @ref mentions from text using `REFERENCE_PATTERN`
   - `resolveReference(mention: ReferenceMention, context: ResolutionContext): Promise<ResolvedReference | null>`
   - `resolveAllReferences(text: string, context: ResolutionContext): Promise<Map<string, ResolvedReference>>`
   - Context interface: `{ roomId?: string; spaceId?: string; workspacePath: string }`
2. Handle edge cases:
   - Invalid reference format (not matching pattern)
   - Unknown reference type
   - Missing room/space context (task/goal references return null)
3. Path validation:
   - All file/folder paths are validated against workspace root
   - Paths with `..`, absolute paths, or paths outside workspace are rejected
4. Provide clear error separation: `resolveAllReferences` returns partial results (successful resolutions) and logs warnings for failures

**Acceptance Criteria:**
- `extractReferences` correctly parses all valid `@ref{}` formats
- `extractReferences` ignores normal text and markdown links
- `resolveReference` returns appropriate data for each type
- `resolveReference` returns null for tasks/goals when no room context
- File/folder paths are validated against workspace root
- Service is testable with mock repositories
- Unit tests cover parsing, resolution, standalone sessions, and path traversal
- Test file: `packages/daemon/tests/unit/reference-resolver.test.ts`

**Depends on:** Task 1.1

**Agent Type:** coder

---

## Notes

- Reference syntax uses `@ref{type:id}` format for persistence — no collision with markdown
- Short IDs (e.g., `t-42`, `g-7`) are used for tasks and goals to make references human-readable
- File/folder paths are stored as-is (not short IDs)
- The `ReferenceResolver` service will be reused in M3 for message preprocessing
- The `FileIndex` provides fast file/folder search without blocking the event loop
- All file/folder access is path-validated against workspace root to prevent traversal attacks
