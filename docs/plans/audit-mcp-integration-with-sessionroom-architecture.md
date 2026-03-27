# Audit: MCP Integration with Session/Room Architecture

## Goal

Identify all gaps where MCP servers and skills are not properly integrated with the session, room, and space systems, then close those gaps with targeted code changes and tests.

## Audit Findings

### What Works (No Action Needed)

1. **Room chat sessions** (`room_chat` type) correctly receive MCP servers from three sources: file-based config, app-level registry (`AppMcpLifecycleManager`), and room-agent-tools. Skills are injected via `skillsManager` + `roomSkillOverrides` through `QueryOptionsBuilder`.

2. **Room worker sessions** (coder/general/planner) receive MCP servers from file-based + registry sources, merged in `RoomRuntimeService.createSessionFactory()`. Skills are injected via `skillsManager` + `roomSkillOverrides` passed through `AgentSession.fromInit()`.

3. **Normal sessions** (lobby/non-room) receive `skillsManager` + `appMcpServerRepo` via `SessionManager` constructor, and skills are injected via `QueryOptionsBuilder`. No room-level overrides apply, which is correct.

4. **Session lifecycle**: MCP servers are stateless SDK configs (stdio command, SSE URL, HTTP URL), not persistent connections. The SDK manages the underlying MCP connections internally. There is no connect/disconnect lifecycle gap at the NeoKai layer.

5. **Room-level skill overrides**: The `RoomSkillOverride` mechanism works correctly for rooms. Overrides can disable globally-enabled skills per room but cannot enable globally-disabled ones (by design).

### Gaps Found

| # | Gap | Severity | Location |
|---|-----|----------|----------|
| G1 | Space task agent sessions do not receive `skillsManager` or `appMcpServerRepo` in `AgentSession.fromInit()`, so skills (plugins + MCP server skills) are never injected via `QueryOptionsBuilder`. Note: `fromInit()` already accepts these as positional args 7 and 8 — no signature change needed. | High | `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` (~line 304) |
| G2 | Space sub-sessions (node agents created by `createSubSessionFactory`) also lack skills injection via `AgentSession.fromInit()` | High | `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` (~line 444) |
| G3 | Space task agent rehydration (`rehydrateTaskAgent()`) calls `AgentSession.restore()` without `skillsManager`/`appMcpServerRepo`. After daemon restart, rehydrated task agent sessions run without skills injection even if freshly spawned ones have it. Sub-session rehydration (~line 1142) has the same issue. | High | `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` (~line 993, ~line 1142) |
| G4 | No per-space skill override mechanism exists (rooms have `RoomSkillOverride`, spaces have nothing equivalent) | Low | N/A (new feature) |
| G5 | After daemon restart, recovered room worker sessions lose both user-configured MCP servers (file-based + registry) AND skills injection (`skillsManager`/`appMcpServerRepo`). `AgentSession.restore()` does not accept these parameters. Only role-specific in-process MCP servers (planner-tools, leader-agent-tools) are restored. | Medium | `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` (~line 470), `packages/daemon/src/lib/agent/agent-session.ts` (~line 468) |

**Previously reported as gap (confirmed not a gap):**

- ~~Space global agent session (`provisionGlobalAgent`) lacks skills injection~~ — **False positive.** `provisionGlobalSpacesAgent()` creates sessions via `sessionManager.createSession()` / `sessionManager.getSessionAsync()`. The `SessionManager` factory already passes `skillsManager` and `appMcpServerRepo` to every `AgentSession` it constructs, so the global agent already receives skills injection. No action needed.

### Out of Scope

- The `builtin` skill sourceType (slash commands from `.claude/commands/`) is defined in types but not injected by `QueryOptionsBuilder`. This is documented and intentional -- not a gap.
- Hot-reload of MCP registry changes for short-lived worker/task sessions is intentionally deferred (changes take effect on next session creation).

## Approach

Fix gaps G1-G3 by threading `skillsManager` and `appMcpServerRepo` through space task agent creation and rehydration paths. Fix G5 by extending `AgentSession.restore()` to accept skills parameters and re-applying MCP server configs + skills during room worker session recovery. G4 (per-space skill overrides) is deferred as low priority — spaces can be addressed later when the space system matures.

---

## Task 1: Inject skills into space task agent sessions and rehydration (G1 + G2 + G3)

**Description:** Pass `skillsManager` and `appMcpServerRepo` through the space `TaskAgentManager` so that both freshly created and rehydrated task agent sessions include skills injection. `AgentSession.fromInit()` already accepts these as positional args 7 and 8 — no signature change needed. For rehydration, `AgentSession.restore()` currently does not accept these parameters, so its signature must be extended.

**Agent type:** coder

**Subtasks:**
1. Add `skillsManager` and `appMcpServerRepo` as **required** fields to the `TaskAgentManagerConfig` interface in `packages/daemon/src/lib/space/runtime/task-agent-manager.ts`
2. Pass them as positional args 7 and 8 to `AgentSession.fromInit()` at ~line 304 (task agent creation) and ~line 444 (sub-session creation)
3. Extend `AgentSession.restore()` signature (`agent-session.ts` ~line 468) to accept optional `skillsManager` and `appMcpServerRepo` parameters
4. Pass them through in `rehydrateTaskAgent()` (~line 993) and sub-session rehydration (~line 1142)
5. Update `SpaceRuntimeService` (or wherever `TaskAgentManager` is instantiated) to provide the new config fields from the daemon app context
6. Add unit tests verifying that `AgentSession.fromInit()` receives `skillsManager` and `appMcpServerRepo` when creating space task agent sessions
7. Add unit tests verifying that rehydrated task agent sessions also receive skills injection
8. Add an online test confirming that a space task agent session has access to a globally-enabled MCP server skill
9. Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Acceptance criteria:**
- `TaskAgentManagerConfig` includes **required** `skillsManager` and `appMcpServerRepo` fields (build-time enforcement that callers provide them)
- Both main task agent sessions and sub-sessions pass these through to `AgentSession.fromInit()`
- `AgentSession.restore()` accepts optional `skillsManager` and `appMcpServerRepo` parameters
- Rehydrated task agent and sub-sessions pass these through via `AgentSession.restore()`
- Existing space tests continue to pass
- New unit tests confirm skills are threaded through for both fresh and rehydrated sessions
- New online test confirms an enabled MCP server skill appears in SDK options for a space task agent

**Dependencies:** None

---

## Task 2: Restore MCP servers and skills for recovered room worker sessions (G5)

**Description:** After daemon restart, room worker sessions (coder/general) recovered by `restoreSession()` lose both user-configured MCP servers (file-based + registry) and skills injection (`skillsManager`/`appMcpServerRepo`). `AgentSession.restore()` does not currently accept these parameters. This task extends the restore path to re-apply both MCP server configs and skills, using the `AgentSession.restore()` signature extension from Task 1.

**Agent type:** coder

**Subtasks:**
1. In `RoomRuntimeService.restoreSession()` (~line 470), after restoring a worker session, pass `skillsManager` and `appMcpServerRepo` through the `AgentSession.restore()` call (using the extended signature from Task 1)
2. Also apply the same file-based + registry MCP server merge logic used in `createSessionFactory()` for coder/general roles
3. Extract the MCP merge logic into a shared helper to avoid duplication between `createSessionFactory()` and the recovery path
4. Add unit tests verifying that a restored coder session has both merged MCP servers and skills injection after recovery
5. Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Acceptance criteria:**
- After daemon restart, recovered coder/general worker sessions have file-based + registry MCP servers applied
- After daemon restart, recovered worker sessions also have `skillsManager` and `appMcpServerRepo` for skills injection
- The MCP merge logic is shared (no copy-paste duplication)
- New unit tests confirm restored worker sessions get both MCP servers and skills
- Existing recovery tests continue to pass

**Dependencies:** Task 1 (requires the `AgentSession.restore()` signature extension)
