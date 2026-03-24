# Milestone 2: Application-Level MCP Registry (Backend)

## Milestone Goal

Implement the server-side MCP registry: SQLite schema, repository, shared types, and RPC handlers for full CRUD. This is the foundation on which all subsequent milestones depend.

## Scope

Backend only — daemon and shared packages. No UI changes yet.

---

## Task 2.1: Schema, Types, and Repository

**Agent type:** coder

**Description:**
Add the `app_mcp_servers` SQLite table and a repository class with CRUD operations. Define the shared TypeScript types for the registry entry.

**Subtasks (ordered):**

1. Run `bun install` at the worktree root.
2. In `packages/daemon/src/storage/schema/index.ts`, add `CREATE TABLE IF NOT EXISTS app_mcp_servers` with columns: `id TEXT PRIMARY KEY`, `name TEXT UNIQUE NOT NULL`, `description TEXT`, `source_type TEXT NOT NULL` (values: `stdio` | `sse` | `http`), `command TEXT`, `args TEXT` (JSON array), `env TEXT` (JSON object), `url TEXT`, `headers TEXT` (JSON object), `enabled INTEGER NOT NULL DEFAULT 1`, `created_at INTEGER`, `updated_at INTEGER`.
3. In `packages/daemon/src/storage/schema/migrations.ts`, add a new migration step that creates the `app_mcp_servers` table if it doesn't exist (safe incremental migration pattern matching existing entries).
4. In `packages/shared/src/types/`, create `app-mcp-server.ts` exporting:
   - `AppMcpServerSourceType = 'stdio' | 'sse' | 'http'`
   - `AppMcpServer` interface with: `id`, `name`, `description?`, `sourceType`, `command?`, `args?`, `env?`, `url?`, `headers?`, `enabled`
   - **Env var handling note:** The `env` field is a plain JSON object stored in SQLite. It is intended for non-secret configuration (e.g., `LOG_LEVEL=debug`). For secrets such as `BRAVE_API_KEY`, the implementation strategy is: the field stores a reference key (e.g., `BRAVE_API_KEY`) and the actual value is read from the system environment at spawn time (`process.env[key]`). This is consistent with how Claude Code settings handle API keys. The UI (Task 5.2) will show a key=value editor for env vars and display a warning if a value looks like a secret (e.g., starts with `sk-` or matches common API key patterns) advising the user to set it in their system environment instead. Do NOT store raw secret values in SQLite.
   - `CreateAppMcpServerRequest` (omit `id`)
   - `UpdateAppMcpServerRequest` (all optional except `id`)
5. Export the new types from `packages/shared/src/types.ts` and `packages/shared/src/mod.ts`.
6. Create `packages/daemon/src/storage/repositories/app-mcp-server-repository.ts` implementing: `create(req)`, `get(id)`, `getByName(name)`, `list()`, `update(id, updates)`, `delete(id)`, and `listEnabled()`.
7. Wire the repository into `packages/daemon/src/storage/database.ts` (instantiate and expose as `appMcpServers`).
8. Write unit tests in `packages/daemon/tests/unit/storage/app-mcp-server-repository.test.ts` covering CRUD operations and `listEnabled()` filtering.

**Acceptance criteria:**
- `app_mcp_servers` table is created on daemon start via the migration.
- Repository CRUD operations pass all unit tests.
- `AppMcpServer` type is exported from `@neokai/shared`.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Depends on:** (none)

---

## Task 2.2: RPC Handlers for Registry CRUD

**Agent type:** coder

**Description:**
Expose the MCP registry via RPC so the frontend and daemon internals can manage entries. Add handlers and wire them into the daemon hub.

**Subtasks (ordered):**

1. Create `packages/daemon/src/lib/rpc-handlers/app-mcp-handlers.ts` with handlers for:
   - `mcp.registry.list` — returns `AppMcpServer[]`
   - `mcp.registry.create` — validates input, calls `db.appMcpServers.create()`, emits `mcp.registry.changed` event, returns created entry
   - `mcp.registry.update` — updates entry, emits event, returns updated entry
   - `mcp.registry.delete` — removes entry, emits event
   - `mcp.registry.setEnabled` — convenience toggle, updates `enabled` field, emits event
2. Register the handlers in `packages/daemon/src/lib/rpc-handlers/index.ts` (call `registerAppMcpHandlers()`).
3. Add `mcp.registry.changed` event type to `packages/shared/src/message-hub/` event definitions.
4. Add `mcp.registry.*` request/response types to `packages/shared/src/api.ts`.
5. Write unit tests in `packages/daemon/tests/unit/rpc/app-mcp-handlers.test.ts` covering each handler with mock DB, verifying events are emitted.

**Acceptance criteria:**
- All five RPC endpoints are reachable via MessageHub.
- `mcp.registry.changed` event is emitted on create/update/delete/toggle.
- Unit tests pass with mock DB.
- Changes must be on a feature branch with a GitHub PR created via `gh pr create` targeting `dev`.

**Depends on:** Task 2.1 (Schema, Types, and Repository)
