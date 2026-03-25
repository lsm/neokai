# M3: Backend Reference Resolution

## Milestone Goal

Implement backend message preprocessing that parses @ references from user input text and resolves them to actual entity data before sending to the agent. The resolved references are injected as structured context that the agent can understand and act upon.

## Scope

- Message preprocessing in `message.send` flow
- Reference extraction from plain text and structured format
- Entity data fetching for each reference type
- Agent context injection with resolved reference data

---

## Tasks

### Task 3.1: Implement Message Preprocessing Hook

**Description:** Extend the `message.send` RPC handler to preprocess user messages and resolve @ references before persisting.

**Subtasks:**
1. Modify `packages/daemon/src/lib/rpc-handlers/session-handlers.ts` in `message.send` handler:
   - After receiving `content`, call `ReferenceResolver.extractReferences()`
   - If references found, call `resolveAllReferences()` with session context
   - Store original text and structured references
2. Create preprocessing flow:
   - Extract references from text
   - Resolve each reference to entity data
   - Inject resolved data into message context for agent
   - Store converted text with markdown-style mentions

**Acceptance Criteria:**
- @ references in user messages are extracted and resolved
- Original text is preserved with markdown-style mentions
- Resolution errors are handled gracefully (unresolved references kept as-is)
- Unit tests cover preprocessing logic

**Depends on:** Task 1.4 (Reference Resolution Service)

**Agent Type:** coder

---

### Task 3.2: Implement Task Reference Resolver

**Description:** Implement the resolution logic for task references, supporting both room tasks and space tasks.

**Subtasks:**
1. In `ReferenceResolver.resolveReference()`:
   - Handle `task` type references
   - Parse ID format: `task-t-42` (room task) or `task-st-15` (space task)
   - Fetch task from appropriate repository based on prefix
   - Return `ResolvedTaskReference` with task summary:
     - `id`, `shortId`, `title`, `description`, `status`, `priority`, `progress`
     - For room tasks: `roomId`
     - For space tasks: `spaceId`, `workflowRunId`
2. Handle missing tasks:
   - Return null if task not found
   - Log warning for debugging

**Acceptance Criteria:**
- Room tasks resolve to full task data
- Space tasks resolve to full task data
- Missing tasks return null without throwing
- Unit tests cover both task types

**Depends on:** Task 1.4

**Agent Type:** coder

---

### Task 3.3: Implement Goal and File/Folder Resolvers

**Description:** Implement the resolution logic for goal references and file/folder references.

**Subtasks:**
1. Goal resolver in `ReferenceResolver.resolveReference()`:
   - Handle `goal` type references
   - Parse ID format: `goal-g-7`
   - Fetch goal from `GoalRepository`
   - Return `ResolvedGoalReference` with goal summary:
     - `id`, `shortId`, `title`, `description`, `status`, `progress`
     - `missionType`, `autonomyLevel`
     - `structuredMetrics` (for measurable missions)
2. File resolver:
   - Handle `file` type references
   - Parse path from ID (e.g., `file:src/lib/utils.ts`)
   - Read file content via `FileManager.readFile`
   - Return `ResolvedFileReference` with:
     - `path`, `content` (truncated to 50KB), `size`, `mtime`
     - `encoding` (utf-8 or base64 for binary)
3. Folder resolver:
   - Handle `folder` type references
   - Parse path from ID
   - List directory contents via `FileManager.listDirectory`
   - Return `ResolvedFolderReference` with:
     - `path`, `files` (list of file info), `totalCount`

**Acceptance Criteria:**
- Goals resolve to full goal data including metrics
- Files resolve to content (truncated for large files)
- Folders resolve to file listing
- Missing entities return null
- Path traversal is prevented for file/folder access
- Unit tests cover all resolvers

**Depends on:** Task 1.4

**Agent Type:** coder

---

### Task 3.4: Implement Agent Context Injection

**Description:** Create the mechanism to inject resolved reference data into the agent's context as structured data.

**Subtasks:**
1. Create `packages/daemon/src/lib/agent/reference-context-builder.ts`:
   - `buildReferenceContext(references: Map<string, ResolvedReference>): string`
   - Generates markdown-formatted context block for agent
   - Format:
     ```markdown
     ## Referenced Entities

     ### Task: t-42
     **Title:** Implement user authentication
     **Status:** in_progress
     **Priority:** high
     **Progress:** 60%
     **Description:** Add OAuth2 authentication flow...

     ### Goal: g-7
     **Title:** Q1 Revenue Target
     **Type:** measurable
     **Progress:** 75%
     **Metrics:** Revenue: $750,000 / $1,000,000

     ### File: src/lib/utils.ts
     ```
     [file content here - truncated]
     ```
     ```
2. Integrate with `message.send` flow:
   - After resolving references, build context block
   - Prepend to user message as system context
   - Mark as reference context (for potential UI display)
3. Handle large reference sets:
   - Limit total context size (e.g., 200KB)
   - Prioritize task > goal > file > folder when truncating
   - Log warning when context is truncated

**Acceptance Criteria:**
- Resolved references are formatted as readable markdown context
- Context is prepended to user message for agent
- Large contexts are truncated gracefully
- Context is clearly delimited from user message
- Unit tests cover context building and truncation

**Depends on:** Task 3.1, Task 3.2, Task 3.3

**Agent Type:** coder

---

## Notes

- Resolution happens synchronously during `message.send` to ensure references are valid before acknowledging
- Failed resolutions should not block message sending - unresolved references remain as text
- The agent context format is markdown for readability and compatibility
- Consider caching resolved references for the duration of a session to avoid repeated lookups
- File content truncation should be smart (truncate at line boundaries when possible)
