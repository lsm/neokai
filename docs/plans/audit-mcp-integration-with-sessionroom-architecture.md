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
| G1 | Space task agent sessions do not receive `skillsManager` or `appMcpServerRepo` in `AgentSession.fromInit()`, so skills (plugins + MCP server skills) are never injected via `QueryOptionsBuilder` | High | `packages/daemon/src/lib/space/runtime/task-agent-manager.ts:304` |
| G2 | Space sub-sessions (node agents created by `createSubSessionFactory`) also lack skills injection | High | `packages/daemon/src/lib/space/runtime/task-agent-manager.ts:444` |
| G3 | Space global agent session (`provisionGlobalAgent`) lacks skills injection | Medium | `packages/daemon/src/lib/space/provision-global-agent.ts` |
| G4 | No per-space skill override mechanism exists (rooms have `RoomSkillOverride`, spaces have nothing equivalent) | Low | N/A (new feature) |
| G5 | After daemon restart, recovered room worker sessions lose user-configured MCP servers (file-based + registry). Only role-specific in-process MCP servers (planner-tools, leader-agent-tools) are restored | Low | `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` (documented limitation) |

### Out of Scope

- The `builtin` skill sourceType (slash commands from `.claude/commands/`) is defined in types but not injected by `QueryOptionsBuilder`. This is documented and intentional -- not a gap.
- Hot-reload of MCP registry changes for short-lived worker/task sessions is intentionally deferred (changes take effect on next session creation).

## Approach

Fix gaps G1-G3 by threading `skillsManager` and `appMcpServerRepo` through to space session creation paths. G4 (per-space skill overrides) is deferred as low priority -- spaces can be addressed later when the space system matures. G5 is an accepted limitation for short-lived worker sessions.

---

## Task 1: Inject skills into space task agent sessions (G1 + G2)

**Description:** Pass `skillsManager` and `appMcpServerRepo` through the space `TaskAgentManager` config so that `AgentSession.fromInit()` calls for task agents and sub-sessions include skills injection. This ensures globally-enabled skills (plugin and MCP server types) are available to space task agents.

**Agent type:** coder

**Subtasks:**
1. Add `skillsManager` and `appMcpServerRepo` fields to the `TaskAgentManagerConfig` interface in `packages/daemon/src/lib/space/runtime/task-agent-manager.ts`
2. Pass them through the `AgentSession.fromInit()` call at line ~304 (task agent creation) and at line ~444 (sub-session creation)
3. Update `SpaceRuntimeService` (or wherever `TaskAgentManager` is instantiated) to provide the new config fields from the daemon app context
4. Add unit tests verifying that `AgentSession.fromInit()` receives `skillsManager` and `appMcpServerRepo` when creating space task agent sessions
5. Add an online test confirming that a space task agent session has access to a globally-enabled MCP server skill
6. Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Acceptance criteria:**
- `TaskAgentManagerConfig` includes optional `skillsManager` and `appMcpServerRepo` fields
- Both main task agent sessions and sub-sessions pass these through to `AgentSession.fromInit()`
- Existing space tests continue to pass
- New unit tests confirm skills are threaded through
- New online test confirms an enabled MCP server skill appears in SDK options for a space task agent

**Dependencies:** None

---

## Task 2: Inject skills into space global agent session (G3)

**Description:** The `provisionGlobalAgent()` function in `packages/daemon/src/lib/space/provision-global-agent.ts` creates the global spaces agent session but does not pass `skillsManager` or `appMcpServerRepo`. Add these parameters so the global agent also gets skills.

**Agent type:** coder

**Subtasks:**
1. Add `skillsManager` and `appMcpServerRepo` to the `ProvisionGlobalAgentConfig` (or equivalent parameter interface) in `packages/daemon/src/lib/space/provision-global-agent.ts`
2. Pass them through to the `AgentSession.fromInit()` or `new AgentSession()` call for the global agent
3. Update the caller(s) of `provisionGlobalAgent()` to supply these from the daemon app context
4. Add a unit test verifying the global agent session receives skills manager
5. Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Acceptance criteria:**
- Global agent session is created with `skillsManager` and `appMcpServerRepo`
- Existing global agent tests continue to pass
- New unit test confirms skills are threaded through

**Dependencies:** None (can run in parallel with Task 1)

---

## Task 3: Restore MCP servers for recovered room worker sessions (G5)

**Description:** After daemon restart, room worker sessions (coder/general) recovered by `restoreSession()` do not have the merged file-based + registry MCP server configs reapplied. Only in-process MCP servers (planner-tools, leader-agent-tools) are restored. While this is an accepted limitation for short-lived sessions, fixing it improves resilience for sessions that survive across restarts.

**Agent type:** coder

**Subtasks:**
1. In `RoomRuntimeService.restoreSession()` (or the recovery path in `runtime-recovery.ts`), after restoring a worker session, apply the same file-based + registry MCP server merge logic used in `createSessionFactory()` for coder/general roles
2. Extract the MCP merge logic into a shared helper to avoid duplication between `createSessionFactory()` and the recovery path
3. Add a unit test that verifies a restored coder session has merged MCP servers after recovery
4. Changes must be on a feature branch with a GitHub PR created via `gh pr create`

**Acceptance criteria:**
- After daemon restart, recovered coder/general worker sessions have file-based + registry MCP servers applied
- The merge logic is shared (no copy-paste duplication)
- New unit test confirms restored worker sessions get MCP servers
- Existing recovery tests continue to pass

**Dependencies:** None (can run in parallel with Tasks 1 and 2)
