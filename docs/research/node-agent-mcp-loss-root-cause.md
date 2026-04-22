# Root cause analysis: Node agents losing MCP tools

**Task:** #72 — Research root cause of `mcp__node-agent__send_message` returning "No such tool available" and related MCP-server-loss incidents.
**Scope:** `packages/daemon/src/lib/space/runtime/**`, `packages/daemon/src/lib/agent/**`, `packages/daemon/src/lib/rpc-handlers/config-handlers.ts`, `packages/daemon/src/storage/repositories/session-repository.ts`, `packages/daemon/src/lib/mcp/**`, `packages/daemon/src/lib/space/tools/node-agent-tools.ts`.
**Baseline commit:** `4b3cb74dc` (branch `space/research-root-cause-of-node-agents-losing-mcp-tools`, diverged from `dev`).
**Method:** Static read of all MCP attach/replace/restore code paths; cross-referenced with historical fixes (`#1535`, `#1540`, `#1579`, `4b3cb74dc`).

---

## TL;DR

Node agents lose MCP tools for **five distinct, compounding reasons** — none of them is "the" bug on its own; together they produce the intermittent pattern observed in production.

| # | Failure mode | Severity | Triggered by | Fix class |
|---|--------------|----------|--------------|-----------|
| 1 | `AgentSession.setRuntimeMcpServers` has **replace** semantics — the 5 call sites that use it clobber anything not in their own payload | **Critical** | Any concurrent attach (e.g. `SpaceRuntimeService.attachSpaceToolsToMemberSession` racing with `TaskAgentManager.reinjectNodeAgentMcpServer`) | API redesign |
| 2 | `config.mcp.update/addServer/removeServer` RPC path REPLACES the whole runtime map, wiping `node-agent`/`task-agent`/`space-agent-tools`/`db-query` | **High** (user-reachable) | User edits MCP config in the UI while a workflow is running | Route through merge API |
| 3 | `reinjectNodeAgentMcpServer` (and `restore_node_agent` tool callback) do **not restart the SDK query** — the running turn keeps the old tool registry | **High** | Any self-heal attempted mid-turn | Restart on re-inject |
| 4 | Session-reuse path in `TaskAgentManager.createSubSession` skips `setRuntimeMcpServers` entirely for the 2nd+ execution of the same named agent, leaving a **stale closure** in the previously-built `node-agent` server (wrong `workflowNodeId`, stale `execution` row, stale channel resolver) | **Medium** — tools are present but mis-scoped | Workflow re-entry, multi-cycle workflows | Rebuild + re-attach on reuse |
| 5 | `TaskAgentManager.rehydrate` (daemon restart path) for **task-agent** sessions omits `space-agent-tools`; sub-session rehydrate omits it too. `SpaceRuntimeService` only attaches space-tools via the `session.created` event, which is **not** fired for `fromInit`/`restore` sessions | **Medium** | Daemon restart while a workflow is in flight | Attach space-tools in rehydrate paths |

Secondary observations: registry MCP server configs are stateless plain objects (safe to share). In-process MCP servers (`node-agent`, `task-agent`, `db-query`, `space-agent-tools`) are **live `McpServer` instances** created per session — never shared. `session.config.mcpServers` is intentionally stripped from SQLite persistence (`session-repository.ts:143`), so every restart requires re-attach by design — the bugs are in how the re-attach is done.

---

## 1. Background: the MCP server taxonomy

Two categories of MCP servers flow into `session.config.mcpServers`:

| Kind | Example | Lifetime | Shared across sessions? | Persisted to DB? |
|------|---------|----------|-------------------------|------------------|
| **In-process SDK servers** (`type: 'sdk'`) | `node-agent`, `task-agent`, `space-agent-tools`, `db-query` | Per session | **No** — fresh `createSdkMcpServer(...)` per call, captures its session's context in closures | No (would have circular refs) |
| **Registry subprocess servers** (`type: 'stdio'`/`'sse'`/`'http'`) | Skills-registered MCP servers, user-added MCP servers | Config object | Config yes, subprocess no (SDK spawns one per query) | No (stripped at persist — see below) |
| **Skills MCP servers** | `chrome-devtools-mcp`, `playwright`, custom plugin MCPs | Config object | Same as registry | No — re-computed fresh each query build from `SkillsManager.getEnabledSkills()` |

**Persistence invariant.** `SessionRepository.createSession` and `updateSession` both serialize `config` through a replacer that drops `mcpServers` and functions (`packages/daemon/src/storage/repositories/session-repository.ts` lines 32–36 and 143–147). This is intentional — live SDK `McpServer` instances contain un-serializable state — but it means **the only source of MCP servers after a daemon restart is explicit runtime re-attach**. There is no "resume from DB and you're done" path.

```ts
// session-repository.ts:143
serializedConfig = JSON.stringify(mergedConfig, (key, val) => {
    if (key === 'mcpServers') return undefined;
    if (typeof val === 'function') return undefined;
    return val;
});
```

---

## 2. The five replace-semantics call sites

Every call to `setRuntimeMcpServers` is a **full replacement** of the runtime map:

```ts
// packages/daemon/src/lib/agent/agent-session.ts:670
setRuntimeMcpServers(mcpServers: Record<string, McpServerConfig>) {
    if (!this.session.config) this.session.config = {};
    this.session.config.mcpServers = mcpServers;   // <-- REPLACES
}

// Contrast: mergeRuntimeMcpServers (safe)
// agent-session.ts:687
mergeRuntimeMcpServers(additions: Record<string, McpServerConfig>) {
    this.session.config.mcpServers = {
        ...(this.session.config.mcpServers ?? {}),
        ...additions,
    };
}
```

The 5 call sites of `setRuntimeMcpServers` inside `packages/daemon/src/lib/space/runtime/task-agent-manager.ts`:

| Line | Phase | Payload |
|------|-------|---------|
| 637 | Task-agent spawn | `{...registry, task-agent, space-agent-tools, db-query}` |
| 1026 | Sub-session first-spawn | `{...registry, ...init.mcpServers}` — `init.mcpServers` contains `node-agent` |
| 2178 | Task-agent rehydrate | `{...registry, task-agent, db-query}` — **missing** `space-agent-tools` |
| 2311 | Sub-session rehydrate | `{...registry, node-agent}` — **missing** `space-agent-tools` |
| 2582 | `reinjectNodeAgentMcpServer` | `{...current, node-agent}` — merges current map, then replaces |

`config-handlers.ts` also has an indirect path: `agentSession.updateConfig({mcpServers: ...})` → `SessionConfigHandler.updateConfig` does `session.config = {...session.config, ...configUpdates}`. Spreading `{mcpServers: X}` **replaces the whole `mcpServers` key**, so `node-agent`/`task-agent`/etc are lost if the caller did not include them (and they can't — the handler has no live server instances).

---

## 3. Root cause #1 — replace semantics + concurrent attach

### Code path

1. A workflow sub-session is spawned. `TaskAgentManager.createSubSession` calls `setRuntimeMcpServers({...registry, node-agent})` at line 1026. Map is now `{registry..., node-agent}`.
2. `AgentSession.fromInit` + `sessionManager.registerSession` register the session. **But `SessionLifecycle.createSession` is NOT used**, so the `session.created` daemon event is **not** emitted — `SpaceRuntimeService.attachSpaceToolsToMemberSession` is never invoked for this session. Sub-sessions never receive `space-agent-tools` in this path today. (Confirmed: `spawnWorkflowNodeAgentForExecution` → `createSubSession` at `task-agent-manager.ts:836`, no `SessionLifecycle` usage in that file.)
3. A second attach call can still arrive via three routes: (a) user RPC (`config.mcp.addServer`), (b) `mcp.registry.changed` broadcast, or (c) `restore_node_agent` tool handler. Each of these invokes `setRuntimeMcpServers` with a map that does not include the other runtime servers.

Because `setRuntimeMcpServers` is replace-only, any such second call **nukes whatever the first call attached** unless the caller painstakingly reconstructs every live server by hand — which requires the caller to know about every in-process server type, their closures, and their repository dependencies. Most call sites don't.

The only safe call site today is `reinjectNodeAgentMcpServer` (line 2582), which defends itself by spreading `currentMcpServers` first. Every other caller is a foot-gun.

### Evidence of concurrent attack

- `RoomRuntimeService` (`packages/daemon/src/lib/room/runtime/room-runtime-service.ts`, lines 984–1022): subscribes to `mcp.registry.changed` and re-applies MCP config for room-chat sessions. Task-agent manager does not subscribe, but the task-agent and sub-session APIs share `AgentSession`. If a registry change handler ever gets pointed at a workflow session (future refactor, misrouted hub event, or a second handler), it nukes `node-agent`.
- `config-handlers.ts` lines 381–495: the RPC handlers for `config.mcp.update`, `config.mcp.addServer`, `config.mcp.removeServer` all end at `agentSession.updateConfig({mcpServers: merged})`. If the UI of a user-spawned sub-session offers MCP editing (direct RPC or a future feature), this wipes runtime servers.
- `SpaceRuntimeService.attachSpaceToolsToMemberSession`: uses **mergeRuntimeMcpServers** — safe by design, and explicitly documented as such. But it runs asynchronously from the `session.created` listener; if two member-session events fire back to back, the second merge sees state that either the first merge or the sub-session spawn produced.

### Recommended fix

- Rename `setRuntimeMcpServers` to `replaceAllRuntimeMcpServers` (or delete it and make `mergeRuntimeMcpServers` the only public API).
- Every call site that currently replaces should be audited: if it truly needs to delete a server, it should call a new `detachRuntimeMcpServer(name)` API that removes one key.
- All five `TaskAgentManager` call sites (637, 1026, 2178, 2311, 2582) should be converted to merge + an explicit `detach` list for servers being rotated out.

---

## 4. Root cause #2 — `config.mcp.*` RPC replaces the whole map

### Code path

`packages/daemon/src/lib/rpc-handlers/config-handlers.ts` lines 381–495 handles `config.mcp.update`, `config.mcp.addServer`, `config.mcp.removeServer`. Each handler:

1. Builds a new `mcpServers: Record<string, McpServerConfig>` from the user's payload (subprocess configs only — no live SDK instances).
2. Calls `agentSession.updateConfig({ mcpServers: newMap })`.
3. `SessionConfigHandler.updateConfig` at `session-config-handler.ts:45` does `session.config = { ...session.config, ...configUpdates }`. Because `configUpdates.mcpServers` is the full replacement map, all in-process servers (`node-agent`, `task-agent`, `space-agent-tools`, `db-query`) vanish from `session.config.mcpServers`.
4. On the **next query restart** (e.g. when `updateToolsConfig` calls `restartQuery`, or on any startStreamingQuery), `QueryOptionsBuilder` reads `session.config.mcpServers` and sees only the user-supplied subprocess servers. Skills are still merged in (step 5 below), but `node-agent` is gone.

### Why it isn't always catastrophic

- If the user is editing MCP on a non-workflow session (plain chat, room-chat), there's nothing to break.
- Workflow sub-sessions normally aren't user-facing for MCP editing, so this is latent.
- BUT: `SpaceRuntimeService.subscribeToSpaceEvents` reacts to arbitrary `session.created` — a user could open a Space session manually and trigger the flow. Also: the UI surfaces `config.mcp.update` for any session with `spaceId`; the sub-session has `spaceId` set.

### Recommended fix

- `session-config-handler.ts:45` must special-case `mcpServers` — either (a) forbid merging through `updateConfig` entirely, (b) preserve all in-process servers, or (c) push the edit to a separate `sessionManager.updateUserMcpServers()` API that merges into the existing map and lists which "slots" the user may rotate.

---

## 5. Root cause #3 — `reinjectNodeAgentMcpServer` has no query restart

### Code path

`QueryRunner.startStreamingQuery` (`packages/daemon/src/lib/agent/query-runner.ts` lines 239–295) builds `Options` from `session.config` **once** and passes them to the SDK `query(...)` call. The SDK reads `mcpServers` at query-start and mounts every server as a durable tool surface for the whole streaming session. After that point, mutating `session.config.mcpServers` has **zero effect on the running query** — the SDK has no hook to re-read it.

So:

- `reinjectNodeAgentMcpServer` updates the in-memory map, but the currently-streaming turn has already captured the old tool surface.
- `restore_node_agent` is an agent-callable tool that invokes `reinjectNodeAgentMcpServer` via the `onRestoreNodeAgent` callback (`task-agent-manager.ts:2707`). **If the tool is callable at all, `node-agent` is already attached** — the tool call is proof of attachment. And if it were truly unattached, calling it wouldn't restore the turn's tool set anyway: we'd need `ensureQueryStarted`/`restartQuery` to rebuild options.

Paradox chain:

1. Agent reports "no such tool." → it truly doesn't have the tools in its tool list.
2. Agent tries `mcp__node-agent__restore_node_agent`. → the very tool it wants to call is in the same namespace. Can't call it.
3. Even if it could, the re-inject happens but doesn't take effect until the next turn.

### What's actually happening in the wild

The reported failure ("`mcp__node-agent__send_message`: No such tool available") happens **during a turn** — the model sees a tool in its system prompt that isn't actually in the registered tool list. The most plausible causes under the current code are:

- **Root cause #1 race** — something called `setRuntimeMcpServers` between query build and this turn, and a query restart happened (e.g. `updateToolsConfig` flipped `disabledMcpServers`, which calls `restartQuery`). When the query was restarted, the rebuilt `Options` had no `node-agent`.
- **Root cause #4 stale reuse** — the session is being reused; the `node-agent` server present is stale but registered. `send_message` fails for topology reasons (peer not resolvable with the stale `workflowNodeId`), but the user-visible error from the SDK wrapper can surface as "no such tool" if the tool handler throws in a way the SDK treats as unknown tool.
- **Root cause #5 rehydrate omission** — daemon restarted mid-task; `node-agent` was re-attached to the sub-session, but the agent's conversation history references tools like `mcp__space-agent-tools__*` (list peers, etc.) that were NOT re-attached. The model sees the tool in history and tries to call it; SDK responds "no such tool." The user-visible message names whichever tool the model was trying to call, so reports conflate several distinct tool losses.

### Recommended fix

- `reinjectNodeAgentMcpServer` must call `await session.restartQuery()` (via `QueryLifecycleManager`) after setting the map — behind a guard that only restarts if a query is currently running. The current turn will be discarded; the SDK will resume from DB conversation history. This matches how `updateToolsConfig` already treats `disabledMcpServers` changes (`sdk-runtime-config.ts:175`).
- `restore_node_agent` tool handler should (a) call `reinjectNodeAgentMcpServer`, (b) restart the query, (c) return a message telling the model to retry — acknowledging the turn will be interrupted.
- Alternatively: expose `restore_node_agent` at a layer **outside** the MCP tool namespace (e.g. as a Space runtime RPC callable from `space-agent-tools`), so the tool is not itself susceptible to the "tool missing" failure.

---

## 6. Root cause #4 — session reuse skips re-attach

### Code path

`TaskAgentManager.createSubSession` lines 927–994:

```ts
if (memberInfo?.agentName) {
    const parentTask = this.config.taskRepo.getTask(taskId);
    if (parentTask?.workflowRunId) {
        const existingExecs = this.config.nodeExecutionRepo
            .listByWorkflowRun(parentTask.workflowRunId)
            .filter((e) => e.agentName === memberInfo.agentName && e.agentSessionId);
        const prevExec = existingExecs.at(-1);
        if (prevExec?.agentSessionId) {
            const existing =
                this.agentSessionIndex.get(prevExec.agentSessionId) ??
                (await this.rehydrateSubSession(prevExec.agentSessionId));
            if (existing) {
                // ... register callback, flush pending, return
                return existingSessionId;   // <-- early return
            }
        }
    }
}
```

The reuse path **never calls `setRuntimeMcpServers`** with the new `init.mcpServers`. The `node-agent` MCP server built at spawn time in `spawnWorkflowNodeAgentForExecution` (line 819 with the **new** `execution.workflowNodeId`) is thrown away. The session retains the OLD `node-agent` server whose closure was built with the PREVIOUS execution's `workflowNodeId`.

### Why this matters

`buildNodeAgentMcpServerForSession` (line 2597) captures several values in tool-handler closures:

- `workflowNodeId` (used by `send_message` to resolve `from` and channel topology)
- `execution` row (used to determine `isEndNode`, alias variants)
- `channelResolver` (built from workflow channels — mostly stable, but the channels list is read **once** from the workflow snapshot)
- `workspacePath` (stable per task)

On node re-entry (e.g. Coder → Reviewer → Coder again in a feedback loop), the re-used session's `node-agent` still thinks it's the previous node. `send_message` uses the stale `workflowNodeId` to resolve `fromNode`, producing wrong topology decisions — reported to users as "my peer isn't receiving messages" but in earlier incarnations surfaced as a failed tool call.

This is not a true "lost tool" but a **mis-scoped tool**. It explains several "message never arrived" reports and is upstream of PR #1579 (peer-routing fallback fixes that patch the symptom without fixing the closure).

### Recommended fix

When reusing a session in `createSubSession`:

```ts
if (existing) {
    // Rebuild node-agent for the new node context and re-merge.
    const freshNodeAgent = this.buildNodeAgentMcpServerForSession(
        taskId,
        existingSessionId,
        memberInfo.agentName,
        spaceId,
        workflowRunId,
        workspacePath,
        memberInfo.nodeId,
    );
    existing.mergeRuntimeMcpServers({ 'node-agent': freshNodeAgent });
    await existing.restartQueryIfRunning(); // reason: tool closure changed
    // ... existing reuse logic
}
```

---

## 7. Root cause #5 — rehydrate paths omit `space-agent-tools`

### Code path

`TaskAgentManager.rehydrate` (task-agent path, lines 2140–2178):

```ts
const rehydrateMcpServers: Record<string, McpServerConfig> = {
    ...rehydrateRegistryMcpServers,
    'task-agent': mcpServer as unknown as McpServerConfig,
};
if (this.config.dbPath) {
    rehydrateMcpServers['db-query'] = rehydrateDbQueryServer;
}
agentSession.setRuntimeMcpServers(rehydrateMcpServers);
```

No `space-agent-tools`.

`TaskAgentManager.rehydrateSubSession` (sub-session path, lines 2306–2311):

```ts
const registryMcpServers = this.config.appMcpManager?.getEnabledMcpConfigs() ?? {};
const mergedMcpServers: Record<string, McpServerConfig> = {
    ...registryMcpServers,
    'node-agent': nodeAgentMcpServer as unknown as McpServerConfig,
};
agentSession.setRuntimeMcpServers(mergedMcpServers);
```

Same — no `space-agent-tools`.

The original `spawnTaskAgent` path at line 637 explicitly merges in `space-agent-tools`. The rehydrate paths both drop it. The `SpaceRuntimeService.attachSpaceToolsToMemberSession` safety-net relies on the `session.created` event from `SessionLifecycle.createSession` — which is not emitted by `AgentSession.restore` + `SessionManager.registerSession`.

### Blast radius

Any task in a Space that gets rehydrated (daemon restart during a running workflow) loses `space-agent-tools` until something else re-attaches it. Nothing else re-attaches it today. The agent sees "list_peers / send_message / write_gate / read_gate" all returning "no such tool" for the rest of the session lifetime.

### Recommended fix

- Explicitly add `space-agent-tools` to both rehydrate payloads. `space-agent-tools` is built by `SpaceRuntimeService`; expose a builder the rehydrate paths can call directly, or fan an explicit event into `SpaceRuntimeService` from `TaskAgentManager.rehydrate*` so it can `mergeRuntimeMcpServers` the tool.
- Or: make `session.created` fire from `SessionManager.registerSession` when the session was just restored-from-DB, so the existing listener fires. Less intrusive but changes event semantics.

---

## 8. Race-condition / concurrency map

| Producer | Consumer | Ordering invariant | Current enforcement | Gap |
|----------|----------|--------------------|---------------------|-----|
| `spawnWorkflowNodeAgentForExecution` → `createSubSession` (line 1026) | `QueryRunner.startStreamingQuery` | `setRuntimeMcpServers` must complete before query starts | Sequential in same `async` chain | OK |
| `SpaceRuntimeService.attachSpaceToolsToMemberSession` | `QueryRunner.startStreamingQuery` | Attach must happen before query starts, else requires restart | Runs off `session.created` event, not in spawn chain — **not guaranteed before first turn** | **Race**: workflow sub-sessions don't fire `session.created` so this never attaches anyway (see #5). Regular spawn paths may first-turn before the event listener completes. |
| `TaskAgentManager.reinjectNodeAgentMcpServer` (self-heal) | current streaming query | Either restart query or no-op | No restart | **Broken by design** (see #3) |
| `config.mcp.update` RPC | current session's query | Full RCU through `updateConfig` + `restartQuery` | Eventually restarts via `updateToolsConfig` | **Replaces map** without preserving in-process servers — loses them on restart (see #2) |
| `mcp.registry.changed` broadcast | room-chat / worker sessions | Hot-reload | `room-runtime-service.ts:984` re-applies | Applies only to room chat; doesn't affect sub-sessions (which is intentional for stability but means the sub-session can drift from the user's MCP config) |
| Concurrent `createSubSession` for same `agentName` | Each other | One wins, other reuses | `spawningExecutionIds` guard at line 699 for top-level execution spawn | Guard protects same `execution.id`; does not guard against the same `agentName` across two different node activations converging — if both get to `createSubSession` before either persists the session id, both could create. (Practically rare because `nodeExecutionRepo` writes a row at activation time.) |

---

## 9. Sharing model

- **Registry MCP server configs**: `AppMcpLifecycleManager.getEnabledMcpConfigs()` (lines 53–67) builds a fresh plain object per call. Subprocess instances are managed by the SDK per query — not cached at the daemon level. Shape-only, safe to share by reference.
- **Skills MCP servers**: `QueryOptionsBuilder.getMcpServersFromSkills()` (lines 963–984) reads the skills registry and returns fresh configs at every `buildOptions()`. Never persisted.
- **In-process `McpServer` instances** (`createSdkMcpServer`): created per session, closures bind that session's identity (sessionId, agentName, workflowNodeId, taskId, channelResolver, router instances). **Not shared, not ref-counted, not poolable.**

Sharing a single `McpServer` instance across sessions would be actively wrong — the closures encode per-session identity. This is why the "just re-use the same server" instinct won't work; the rebuild is unavoidable whenever session context changes.

---

## 10. `restore_node_agent` evaluation

**Is it effective?** Partially — and it has a design paradox.

- Handler: `node-agent-tools.ts:1011-1037` + `task-agent-manager.ts:2707-2735`.
- Behavior: on call, looks up the live `AgentSession` by `subSessionId`, calls `reinjectNodeAgentMcpServer`. Logs success or a warning if no session found.
- **Paradox**: the tool is *inside* the `mcp__node-agent__*` namespace. If `node-agent` is not attached, the tool is not callable — so the tool is only reachable in cases where `node-agent` is already attached. Its re-attach is therefore a no-op for the original failure mode.
- **Query restart gap** (see #3): even when callable and when the re-inject does something meaningful (e.g. swapping a stale closure for a fresh one), the SDK's already-running query has mounted the old server — the new one takes effect only after a query restart, which the handler does not trigger.

**Failure modes observed in code:**

1. `liveSession` is `null` → warning logged, no-op. Happens when the session was cancelled between the tool's invocation and the handler's lookup.
2. `reinjectNodeAgentMcpServer` throws (rare — only if `buildNodeAgentMcpServerForSession` throws). Error is caught and logged; tool still reports success to the agent.
3. Normal case: re-injects, logs success, returns. Agent assumes tools are back; they were there already. On the NEXT turn, closure changes would take effect — but there's nothing in the handler signalling that the turn-boundary matters.

**Usage data:** no instrumentation counts calls. The log line `TaskAgentManager.onRestoreNodeAgent: re-attached node-agent for sub-session …` is grep-able but not metricised.

**Recommendation:** either

- (a) Keep the tool but (i) restart the query inside the handler, (ii) make the handler fire even when `node-agent` *appears* missing by routing the callback through `space-agent-tools` instead, and (iii) add a metrics counter.
- (b) Remove the tool and replace with a Space-runtime-level self-heal that runs on turn start for workflow sub-sessions (`ensureNodeAgentAttached` already exists — fire it in `QueryRunner` prologue, not just at spawn).

---

## 11. Specific recommendations (ranked)

### P0 — Stop the replace-semantics foot-gun

1. **Deprecate `setRuntimeMcpServers`**. Make `mergeRuntimeMcpServers` plus an explicit `detachRuntimeMcpServer(name: string)` the only public API. Convert the 5 call sites in `task-agent-manager.ts` one by one, passing an explicit "servers to detach" list where rotation is needed.
2. **Fix `SessionConfigHandler.updateConfig`**: when `configUpdates.mcpServers` is present, filter out any key that is a live in-process server (tag them with a marker), or reject the update outright. Route subprocess-MCP edits through a new `sessionManager.updateUserMcpServers()` method.
3. **Add query restart to `reinjectNodeAgentMcpServer`**: after the merge, if `queryLifecycleManager.isRunning()`, call `restartQuery({ reason: 'mcp-server-rebuild' })`. This makes self-heal actually heal.

### P1 — Fix the rehydrate + reuse gaps

4. **Session reuse path** (`createSubSession` lines 946–990): rebuild `node-agent` with the new `nodeId`, merge into `existing`, restart query. Otherwise stale closures produce silent routing errors.
5. **Rehydrate paths** (lines 2178, 2311): include `space-agent-tools` in the merged payload. Either build it directly here or fire an event that `SpaceRuntimeService.attachSpaceToolsToMemberSession` honours for restored-from-DB sessions.
6. **`session.created` emit for restore**: evaluate whether `SessionManager.registerSession` should emit a `session.restored` event — let `SpaceRuntimeService` subscribe and re-attach space-tools. Clean separation between "new session" and "rehydrated session" semantics.

### P2 — Observability so the next regression surfaces fast

7. **Metrics / dev-mode log** in `QueryOptionsBuilder` when a workflow sub-session's `Options.mcpServers` at query-start lacks any of: `node-agent`, `space-agent-tools`, `db-query` (task-agent only). Already exists as a log at `query-runner.ts:239-264` — promote to structured metric and include `taskId`/`workflowRunId` for joinable diagnosis.
8. **Invariant assertion**: in debug builds, make `AgentSession.startStreamingQuery` throw when a workflow session's `mcpServers` is missing required servers. Belt-and-braces over the self-heal.

### P3 — Redesign `restore_node_agent`

9. Move the self-heal out of the `mcp__node-agent__*` namespace — expose it at `mcp__space-agent-tools__restore_node_agent` so it isn't self-referentially broken when the thing it restores is missing.
10. Restart the query inside the handler, and return a synthetic message to the model explaining the turn was interrupted.

---

## 12. Files referenced (evidence index)

| File | Lines | Relevance |
|------|-------|-----------|
| `packages/daemon/src/lib/agent/agent-session.ts` | 430-441, 556-567, 670-675, 687-696 | `fromInit`, `buildRuntimeInitFingerprint`, `setRuntimeMcpServers` (replace), `mergeRuntimeMcpServers` (merge) |
| `packages/daemon/src/lib/agent/query-options-builder.ts` | 657-664, 963-984 | `mergeMcpServers` precedence; skills merge is build-time only |
| `packages/daemon/src/lib/agent/query-runner.ts` | 239-264, 295 | Options built once; `mcpServers` frozen for the streaming query |
| `packages/daemon/src/lib/agent/query-lifecycle-manager.ts` | 323-370, 509-571 | `restart` rebuilds options; `ensureQueryStarted` only fires when not running |
| `packages/daemon/src/lib/agent/sdk-runtime-config.ts` | 175-211 | `updateToolsConfig` calls `restartQuery` when `disabledMcpServers` changes |
| `packages/daemon/src/lib/agent/session-config-handler.ts` | 45-56 | `updateConfig` replaces `mcpServers` key |
| `packages/daemon/src/lib/rpc-handlers/config-handlers.ts` | 381-495 | `config.mcp.*` RPCs — replace runtime map |
| `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` | 637, 687-907, 921-994, 1026, 2050-2211, 2230-2359, 2295-2311, 2496-2540, 2554-2583, 2597-2771 | All 5 `setRuntimeMcpServers` call sites; reuse; rehydrate; self-heal |
| `packages/daemon/src/lib/space/runtime/space-runtime-service.ts` | 270-301, 571 | `attachSpaceToolsToMemberSession` (merge — safe); `setupSpaceAgentSession` (replace) |
| `packages/daemon/src/lib/space/tools/node-agent-tools.ts` | 1011-1037, 1049-1170, 186-196 | `restore_node_agent` handler; `createNodeAgentMcpServer`; wiring |
| `packages/daemon/src/lib/room/runtime/room-runtime-service.ts` | 876, 984-1022 | `mcp.registry.changed` handler for room chat (not sub-sessions) |
| `packages/daemon/src/lib/session/session-lifecycle.ts` | 281 | `session.created` emit — only path for `attachSpaceToolsToMemberSession` |
| `packages/daemon/src/lib/mcp/app-mcp-lifecycle-manager.ts` | 53-67 | Stateless fresh config per `getEnabledMcpConfigs` call |
| `packages/daemon/src/storage/repositories/session-repository.ts` | 32-36, 143-147 | `mcpServers` stripped from DB — rehydrate **must** re-attach |

---

## 13. Historical context

- **PR #1535** (`8bd60e87f`) — the original "workflow sub-sessions missing MCP tools" fix. Widened `space-agent-tools` to all Space sessions via the `session.created` listener. Did **not** cover the rehydrate path (Root cause #5 is a regression surface left by this PR).
- **PR #1540** (`67948fd73`) — "node-agent injection invariant + agent-callable restore." Added `ensureNodeAgentAttached` and `restore_node_agent`. Does not address Root causes #3 (no query restart) or #4 (session reuse).
- **PR #1579** (`37d6ed65f`) — "list_peers shows topology peers; send_message queues for inactive nodes." Patches the topology-resolution symptoms that Root cause #4 produces, without fixing the stale closure.

Each fix was correct in isolation but left failure modes adjacent — they form the five-cause pattern above.

---

*End of analysis.*
