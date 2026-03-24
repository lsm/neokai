# Milestone 2: Skills Registry Data Model and Backend

## Milestone Goal

Implement the `AppSkill` types in the shared package, the `SkillsManager` service in the daemon, and all RPC handlers for CRUD operations. This is the core data layer for the Skills registry.

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

### Task 2.2: SkillsManager Service

**Agent type:** coder

**Description:**
Implement the `SkillsManager` class in `packages/daemon/src/lib/skills-manager.ts`. It persists skills to `~/.neokai/skills.json`, auto-registers built-in skills on first run, and exposes CRUD methods.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. Create `packages/daemon/src/lib/skills-manager.ts` with class `SkillsManager`:
   - Constructor: `(neokaiConfigDir: string)` — typically `~/.neokai`
   - Private `skillsFilePath = join(neokaiConfigDir, 'skills.json')`
   - `load(): Promise<AppSkill[]>` — reads file, parses, validates
   - `save(skills: AppSkill[]): Promise<void>` — writes file atomically
   - `listSkills(): Promise<AppSkill[]>`
   - `getSkill(id: string): Promise<AppSkill | null>`
   - `addSkill(params: CreateSkillParams): Promise<AppSkill>` — generates UUID, sets createdAt, builtIn=false
   - `updateSkill(id: string, params: UpdateSkillParams): Promise<AppSkill>`
   - `removeSkill(id: string): Promise<boolean>` — returns false if built-in or not found
   - `getEnabledSkills(): Promise<AppSkill[]>`
   - `initializeBuiltins(): Promise<void>` — registers default built-in skills (e.g., a "merge-session" builtin skill wrapping the existing built-in command)
3. Register `SkillsManager` in `packages/daemon/src/app.ts` — instantiate with `~/.neokai` config dir.
4. Run `bun run typecheck`.
5. Write unit tests in `packages/daemon/tests/unit/skills-manager.test.ts`:
   - Test CRUD operations with a temp directory
   - Test that built-in skills cannot be removed
   - Test persistence across load/save cycles
   - Test `getEnabledSkills()` filtering

**Acceptance criteria:**
- `SkillsManager` class is implemented and tested
- All CRUD operations work correctly
- Built-in skills are protected from deletion
- Unit tests pass (`bun test packages/daemon/tests/unit/skills-manager.test.ts`)
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

**Acceptance criteria:**
- All 6 RPC handlers implemented and registered
- API types defined in shared package
- Unit tests cover success and error cases
- `bun run typecheck` passes
- Changes are on a feature branch with a GitHub PR created via `gh pr create`

**depends_on:** ["Task 2.2: SkillsManager Service"]
