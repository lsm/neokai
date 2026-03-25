# M1: Core Types and RPC Infrastructure

## Milestone Goal

Define the shared types for the @ reference system and create backend RPC handlers that allow the frontend to search and resolve references across tasks, goals, files, and folders.

## Scope

- Shared type definitions for reference types and resolved entities
- RPC handlers for searching entities (`reference.search`)
- RPC handlers for resolving individual references (`reference.resolve`)
- Context-aware search (room tasks, space tasks, workspace files)

---

## Tasks

### Task 1.1: Define Reference Types in Shared Package

**Description:** Create the core type definitions for the @ reference system in `packages/shared/src/types/reference.ts`.

**Subtasks:**
1. Create `packages/shared/src/types/reference.ts` with:
   - `ReferenceType` enum: `'task' | 'goal' | 'file' | 'folder'`
   - `ReferenceMention` interface: `{ type: ReferenceType; id: string; displayText: string }`
   - `ReferenceSearchResult` interface: `{ type: ReferenceType; id: string; shortId?: string; displayText: string; subtitle?: string }`
   - `ResolvedReference` interface: `{ type: ReferenceType; id: string; data: unknown }` (polymorphic based on type)
   - `ResolvedTaskReference`, `ResolvedGoalReference`, `ResolvedFileReference`, `ResolvedFolderReference` interfaces
2. Export types from `packages/shared/src/types/index.ts`
3. Add barrel export in `packages/shared/src/mod.ts`

**Acceptance Criteria:**
- Types compile without errors
- Types are accessible via `@neokai/shared` import
- Unit test in `packages/shared/src/types/__tests__/reference.test.ts` validates type shapes

**Depends on:** None

**Agent Type:** coder

---

### Task 1.2: Implement Reference Search RPC Handler

**Description:** Create the backend RPC handler that searches across tasks, goals, files, and folders based on a query string.

**Subtasks:**
1. Create `packages/daemon/src/lib/rpc-handlers/reference-handlers.ts`
2. Implement `reference.search` RPC:
   - Parameters: `{ sessionId: string; query: string; types?: ReferenceType[] }`
   - Returns: `{ results: ReferenceSearchResult[] }`
   - Search logic:
     - For `task`: Query room tasks via `TaskRepository` using current session's room context
     - For `goal`: Query goals via `GoalRepository` using current session's room context
     - For `file`/`folder`: Query filesystem via `FileManager.listDirectory` with fuzzy matching
   - Limit results to 10 per category
   - Combine and sort results by relevance (exact match > starts with > contains)
3. Register handler in `packages/daemon/src/lib/daemon-hub.ts`

**Acceptance Criteria:**
- `reference.search` returns matching tasks, goals, files, and folders
- Results are context-aware (uses session's room ID or space ID)
- File/folder search respects workspace path boundaries
- Unit tests cover each entity type search

**Depends on:** Task 1.1

**Agent Type:** coder

---

### Task 1.3: Implement Reference Resolve RPC Handler

**Description:** Create the backend RPC handler that resolves a single reference to its full entity data.

**Subtasks:**
1. Add `reference.resolve` RPC to `reference-handlers.ts`:
   - Parameters: `{ sessionId: string; type: ReferenceType; id: string }`
   - Returns: `{ resolved: ResolvedReference | null }`
   - Resolution logic:
     - For `task`: Fetch full `NeoTask` or `SpaceTask` via repository
     - For `goal`: Fetch full `RoomGoal` via `GoalRepository`
     - For `file`: Read file content via `FileManager.readFile`, truncate to reasonable size
     - For `folder`: List folder contents via `FileManager.listDirectory`
2. Handle missing entities gracefully (return null)
3. Add rate limiting consideration (file reads should be limited)

**Acceptance Criteria:**
- `reference.resolve` returns full entity data for valid references
- Returns null for missing entities without throwing
- File content is truncated to prevent oversized payloads
- Unit tests cover each entity type resolution

**Depends on:** Task 1.1, Task 1.2

**Agent Type:** coder

---

### Task 1.4: Create Reference Resolution Service

**Description:** Create a reusable service class that handles reference resolution logic, to be used by both RPC handlers and the message preprocessor.

**Subtasks:**
1. Create `packages/daemon/src/lib/agent/reference-resolver.ts`:
   - `ReferenceResolver` class with dependency injection for repositories
   - `extractReferences(text: string): ReferenceMention[]` - Parse @ mentions from text
   - `resolveReference(mention: ReferenceMention, context: ResolutionContext): Promise<ResolvedReference | null>`
   - `resolveAllReferences(text: string, context: ResolutionContext): Promise<Map<string, ResolvedReference>>`
   - Regex pattern for matching `[@:type:id](displayText)` format
   - Context interface: `{ roomId?: string; spaceId?: string; workspacePath: string }`
2. Handle edge cases:
   - Invalid reference format
   - Unknown reference type
   - Circular reference prevention (for folders containing symlinks)

**Acceptance Criteria:**
- `extractReferences` correctly parses all valid reference formats
- `resolveReference` returns appropriate data for each type
- Service is testable with mock repositories
- Unit tests cover parsing and resolution logic

**Depends on:** Task 1.1

**Agent Type:** coder

---

## Notes

- Reference syntax uses markdown-style links for persistence: `[@:type:id](displayText)`
- Short IDs (e.g., `t-42`, `g-7`) are used for tasks and goals to make references human-readable
- File/folder paths are stored as-is (not short IDs)
- The `ReferenceResolver` service will be reused in M3 for message preprocessing
