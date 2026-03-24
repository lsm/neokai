# Milestone 2: Skills Registry Data Model and Backend

## Milestone Goal

Implement the `AppSkill` types in the shared package, the `SkillRepository` (SQLite), the `SkillsManager` service in the daemon, and all RPC handlers for CRUD operations. Persistence follows the established SQLite + repository pattern (same as `goal-repository.ts`). Input validation is enforced at the manager layer to prevent injection attacks.

## Tasks

---

### Task 2.1: AppSkill Types in Shared Package

**Agent type:** coder

**Description:**
Add the `AppSkill` type family and related interfaces to `packages/shared/src/` so they are available to both the daemon and the web UI.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Create `packages/shared/src/types/skills.ts` with:
   - `SkillSourceType = 'builtin' | 'plugin' | 'mcp_server'`
   - `BuiltinSkillConfig = { commandName: string }` — references a `.claude/commands/` slash command
   - `PluginSkillConfig = { pluginPath: string }` — absolute path to a local plugin directory
   - `McpServerSkillConfig = { command: string; args?: string[]; env?: Record<string, string> }` — an MCP server used as a skill source
   - `AppSkillConfig = BuiltinSkillConfig | PluginSkillConfig | McpServerSkillConfig`
   - `AppSkill` interface: `{ id: string; name: string; displayName: string; description: string; sourceType: SkillSourceType; config: AppSkillConfig; enabled: boolean; builtIn: boolean; createdAt: string }`
   - `CreateSkillParams` (omit id, createdAt, builtIn)
   - `UpdateSkillParams` (partial of CreateSkillParams fields)
3. Export `AppSkill`, `SkillSourceType`, `CreateSkillParams`, `UpdateSkillParams` and all config types from `packages/shared/src/types/skills.ts`.
4. Re-export the new types from `packages/shared/src/mod.ts` (or the appropriate barrel file).
5. Run `bun run typecheck` to confirm no type errors.
6. Write unit tests in `packages/shared/src/types/skills.test.ts` — type guards, ensure discriminated union is correct.

**Acceptance criteria:**
- `packages/shared/src/types/skills.ts` exists with all types
- Types exported correctly from shared barrel
- `bun run typecheck` passes
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 1.2: Skills Registry Architecture Design"]

---

### Task 2.2: SkillRepository (SQLite) and SkillsManager

**Agent type:** coder

**Description:**
Implement the `SkillRepository` class (SQLite persistence) and `SkillsManager` service in the daemon. Persistence follows the existing `goal-repository.ts` pattern — a `skills` table in the NeoKai SQLite database. `SkillsManager` enforces input validation for security-sensitive fields before persisting.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Create `packages/daemon/src/storage/repositories/skill-repository.ts` following the same pattern as `goal-repository.ts`:
   - `ensureTable()` — creates `skills` table with columns: `id TEXT PRIMARY KEY`, `name TEXT UNIQUE NOT NULL`, `display_name TEXT NOT NULL`, `description TEXT NOT NULL`, `source_type TEXT NOT NULL`, `config TEXT NOT NULL` (JSON), `enabled INTEGER NOT NULL DEFAULT 1`, `built_in INTEGER NOT NULL DEFAULT 0`, `created_at TEXT NOT NULL`
   - `findAll(): Promise<AppSkill[]>`
   - `findById(id: string): Promise<AppSkill | null>`
   - `findEnabled(): Promise<AppSkill[]>`
   - `insert(skill: AppSkill): Promise<void>`
   - `update(id: string, fields: Partial<AppSkill>): Promise<void>`
   - `delete(id: string): Promise<void>`
   - Use the shared `Database` instance from `packages/daemon/src/storage/database.ts`; do NOT open a separate DB file.
3. Create `packages/daemon/src/lib/skills-manager.ts` with class `SkillsManager`:
   - Constructor: `(repo: SkillRepository)`
   - `listSkills(): Promise<AppSkill[]>`
   - `getSkill(id: string): Promise<AppSkill | null>`
   - `addSkill(params: CreateSkillParams): Promise<AppSkill>` — calls `validateSkillConfig()` first, then generates UUID, sets `createdAt`, `builtIn=false`
   - `updateSkill(id: string, params: UpdateSkillParams): Promise<AppSkill>` — calls `validateSkillConfig()` on any updated config
   - `removeSkill(id: string): Promise<boolean>` — returns false if built-in or not found
   - `getEnabledSkills(): Promise<AppSkill[]>`
   - `initializeBuiltins(): Promise<void>` — upserts default built-in skills on startup
   - **Private `validateSkillConfig(sourceType, config)`** — enforces:
     - `plugin`: `pluginPath` must be an absolute path (starts with `/`), must not contain `../`, must not be empty
     - `mcp_server`: `command` must be a non-empty non-whitespace string; `args` entries must be strings; `env` keys must match `/^[A-Z_][A-Z0-9_]*$/i` (no injection via env var names); `env` values must be strings
     - `builtin`: `commandName` must be a non-empty string
     - Throw a descriptive `Error` on validation failure
4. Register `SkillRepository` and `SkillsManager` in `packages/daemon/src/app.ts`.
5. Run `bun run typecheck`.
6. Write unit tests in `packages/daemon/tests/unit/skills-manager.test.ts`:
   - Test CRUD operations with an in-memory SQLite DB (use `':memory:'` path in test setup)
   - Test that built-in skills cannot be removed
   - Test persistence across load cycles
   - Test `getEnabledSkills()` filtering
   - **Test all validation rules**: path traversal rejected, empty command rejected, invalid env key rejected
   - Test that valid configs pass validation

**Acceptance criteria:**
- `SkillRepository` uses the shared SQLite DB, not a separate file
- `SkillsManager` enforces input validation with descriptive errors for invalid configs
- All CRUD operations work correctly
- Built-in skills are protected from deletion
- Unit tests pass, including all validation boundary cases
- `bun run typecheck` passes
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 2.1: AppSkill Types in Shared Package"]

---

### Task 2.3: Skills RPC Handlers

**Agent type:** coder

**Description:**
Add RPC handlers for Skills CRUD operations so the web UI can manage skills via MessageHub. Create `packages/daemon/src/lib/rpc-handlers/skills-handlers.ts` and register it in the daemon hub.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Add skill-related RPC method types to `packages/shared/src/api.ts`:
   - `skills.list` → `{ skills: AppSkill[] }`
   - `skills.get` → `{ id: string }` → `{ skill: AppSkill | null }`
   - `skills.add` → `{ params: CreateSkillParams }` → `{ skill: AppSkill }`
   - `skills.update` → `{ id: string; params: UpdateSkillParams }` → `{ skill: AppSkill }`
   - `skills.remove` → `{ id: string }` → `{ success: boolean }`
   - `skills.setEnabled` → `{ id: string; enabled: boolean }` → `{ skill: AppSkill }`
3. Create `packages/daemon/src/lib/rpc-handlers/skills-handlers.ts` implementing all handlers using `SkillsManager`.
4. Register `registerSkillsHandlers` in `packages/daemon/src/lib/rpc-handlers/index.ts`.
5. Ensure `SkillsManager` is passed through the app context to handlers.
6. Run `bun run typecheck`.
7. Write unit tests in `packages/daemon/tests/unit/rpc-handlers/skills-handlers.test.ts`:
   - Mock SkillsManager, test each handler's success and error paths.
   - Verify that validation errors from `SkillsManager.addSkill` are surfaced as RPC errors.

**Acceptance criteria:**
- All 6 RPC handlers implemented and registered
- API types defined in shared package
- Validation errors returned as proper RPC error responses (not crashes)
- Unit tests cover success and error cases
- `bun run typecheck` passes
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 2.2: SkillRepository (SQLite) and SkillsManager"]
