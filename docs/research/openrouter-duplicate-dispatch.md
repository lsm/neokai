# OpenRouter "duplicate dispatch" investigation

**Task:** Task #196 — investigate whether NeoKai is dispatching multiple top-level
OpenRouter requests for a single user message, as observed in the OpenRouter
dashboard showing messages sent to different providers at the same time.

**Status:** Research complete. No NeoKai-side duplicate-dispatch bug was found.
The observed dashboard behaviour is explainable by normal Claude Code SDK call
patterns combined with OpenRouter provider routing/fallback.

**Recommendation:** Add correlation logging (user message UUID ↔ session ↔
expected provider request count) so the next dashboard observation can be
proved or falsified by NeoKai logs alone, without needing to grep the
OpenRouter dashboard. No behavioural code changes are required to fix a bug
that does not exist; if an actual duplicate-dispatch repro is captured, this
document explains the candidate root causes and where to add the next layer
of evidence.

---

## 1. Architecture: how a NeoKai user message reaches OpenRouter

NeoKai never opens an HTTP connection to `https://openrouter.ai/api/v1/...`
for generation purposes. The only direct HTTP call is the
**model-listing fetch** at `OpenRouterProvider.getModels()`
(`packages/daemon/src/lib/providers/openrouter-provider.ts:161`), which hits
`https://openrouter.ai/api/v1/models` once for catalog discovery and is
unrelated to chat generation.

All chat traffic flows through the Claude Agent SDK subprocess:

```
user message
  → message.send RPC
    → MessagePersistence.persist()
      → AgentSession.startQueryAndEnqueue()
        → MessageQueue.enqueueWithId()
          → AsyncGenerator yields to Claude Agent SDK subprocess
            → SDK subprocess opens HTTP connection to ANTHROPIC_BASE_URL
              (= https://openrouter.ai/api when provider = "openrouter")
                → OpenRouter creates one or more "generations"
```

Key file references:

- `packages/daemon/src/lib/rpc-handlers/session-handlers.ts:456` — RPC handler
  for `message.send`, calls `sessionManager.sendUserMessage(...)` exactly once.
- `packages/daemon/src/lib/session/message-persistence.ts:130` — `persist()`,
  which is the single funnel for user-originated messages. It calls
  `agentSession.startQueryAndEnqueue(...)` exactly once and emits
  `message.persisted` exactly once. There is no path that fans the same
  message out to two AgentSessions.
- `packages/daemon/src/lib/agent/query-lifecycle-manager.ts:584` —
  `startQueryAndEnqueue()` calls `messageQueue.enqueueWithId(messageId, ...)`
  exactly once. The message ID is generated at the RPC boundary
  (`generateUUID()`), so collisions are statistically impossible.
- `packages/daemon/src/lib/agent/message-queue.ts:90` —
  `enqueueWithId()` adds the message to the in-memory queue with a
  per-message timeout. Each queue is owned by exactly one `AgentSession`
  instance.
- `packages/daemon/src/lib/agent/query-runner.ts:431` — the SDK `query()`
  call uses `prompt: this.createMessageGeneratorWrapper()` (an AsyncGenerator).
  The SDK consumes from this generator exactly once per message. There is no
  branching or duplication here.
- `packages/daemon/src/lib/providers/openrouter-provider.ts:225` — env vars
  written into the SDK subprocess: `ANTHROPIC_BASE_URL`,
  `ANTHROPIC_AUTH_TOKEN`, and the three tier model overrides.

This means: **on the NeoKai side, one user message produces exactly one
`enqueueWithId(...)` call into exactly one `MessageQueue`, which is consumed
exactly once by the AsyncGenerator that backs the SDK `query()`**. There is
no NeoKai-internal mechanism that fans out a single user message into two
top-level provider HTTP requests.

What the SDK does next inside its subprocess — that is the part NeoKai does
not control.

## 2. Why a single user message can still produce many OpenRouter generations

OpenRouter's generation catalogue records **every HTTP request** the SDK
subprocess makes against `ANTHROPIC_BASE_URL`. A single user turn in Claude
Agent SDK routinely produces multiple such HTTP requests, all of which are
legitimate, none of which are NeoKai bugs:

1. **Continuation calls.** Each `tool_use` block in the assistant response
   is followed by a `tool_result` from the runtime, then another assistant
   turn — each new assistant turn is a separate POST to the model. A
   user message that triggers 5 tool calls produces ≥ 6 HTTP requests.

2. **Sub-agents (Task tool).** Claude Agent SDK's `Task` tool spawns an
   independent agent instance with its own context window. NeoKai's
   coordinator mode adds named specialists via
   `packages/daemon/src/lib/agent/coordinator-agents.ts` (Coder, Debugger,
   Tester, Reviewer, VCS, Verifier). Each spawned subagent makes its own
   API calls — and **multiple subagents can be spawned in parallel from a
   single tool block**, producing concurrent, simultaneous HTTP requests
   to the configured provider. (See sources below.)

3. **Tier-specific calls.** The OpenRouter provider configuration sets:

   ```
   ANTHROPIC_DEFAULT_HAIKU_MODEL  = <selected model>
   ANTHROPIC_DEFAULT_SONNET_MODEL = <selected model>
   ANTHROPIC_DEFAULT_OPUS_MODEL   = <selected model>
   ```

   Routing all three tiers to the same OpenRouter model id is intentional
   (we do not want haiku-tier internal traffic going to direct Anthropic),
   but the SDK still issues haiku-tier calls for internal tasks
   (e.g. "compact summary", auto-completion suggestions) as separate HTTP
   requests against `ANTHROPIC_BASE_URL`. Each shows up as its own row in
   the OpenRouter dashboard.

4. **Provider fallback within one request.** When a single OpenRouter
   request encounters a 5xx or rate-limit, OpenRouter retries against a
   different upstream provider transparently. From the dashboard this can
   look like "two providers got hit at once", but they share the same
   `request_id` and appear as multiple entries in the single generation's
   `provider_responses` array (see `GET /api/v1/generation` response
   schema, sources below). This is **not** duplicate dispatch.

5. **Workflow fan-out.** If the user message lands inside a Space workflow
   that activates parallel reviewer/coder nodes, each node has its own
   `AgentSession` with its own SDK subprocess. By design, those subprocesses
   make their own concurrent HTTP requests. This is correct behaviour, not
   a bug, and is the use case `AgentMessageRouter`/`ChannelRouter` exist
   to support
   (`packages/daemon/src/lib/space/runtime/agent-message-router.ts:138`,
   `packages/daemon/src/lib/space/runtime/channel-router.ts:506`).

Each of these explains "messages sent to different providers at the same
time" in the OpenRouter dashboard without invoking a NeoKai bug.

## 3. Distinguishing normal SDK behaviour from a NeoKai duplicate-dispatch bug

The official way to tell them apart is the two ID fields exposed by
`GET https://openrouter.ai/api/v1/generation?id=$GENERATION_ID`:

| Field                | Meaning                                                                  |
| -------------------- | ------------------------------------------------------------------------ |
| `id`                 | Unique generation identifier                                             |
| `request_id`         | "Unique identifier grouping all generations from a single API request"   |
| `provider_responses` | Per-provider attempt log within this single API request                  |
| `provider_name`      | Provider that actually served the response                               |
| `model`              | Resolved upstream model id                                               |
| `created_at`         | ISO 8601 timestamp                                                       |

(Source: OpenRouter docs — see references at the end of this document.)

Decision tree for any pair of "simultaneous" generations seen on the
dashboard:

```
Same `request_id`? ──► Normal: provider fallback within one HTTP request.
                       Look at `provider_responses` for the attempt log.

Different `request_id`s, same `session_id`? ──► Normal: same SDK subprocess
                                                made multiple HTTP requests
                                                (continuation, subagent,
                                                tier change, fan-out).

Different `request_id`s and `session_id`s,
both within the same NeoKai user-message window? ──► Either:
  (a) Multiple AgentSessions are legitimately processing the message
      (e.g., workflow fan-out, multiple chats open).
  (b) NeoKai duplicate-dispatch bug.
```

To distinguish (a) from (b), NeoKai logs (the daemon log file) need to
correlate:

- the user message UUID,
- the NeoKai session id,
- the workflow run id and node execution id (when applicable),
- the SDK session id (`sdkSessionId`, the value the SDK reports in its
  `system:init` event), and
- the OpenRouter `request_id` / generation `id`.

NeoKai does not currently log the OpenRouter `request_id`, because the SDK
subprocess owns the HTTP layer — those headers never reach the daemon. The
daemon only sees `sdkSessionId`, which is itself per-subprocess, not
per-request. Correlating "this OpenRouter generation came from this user
message" therefore requires a small amount of new instrumentation on
NeoKai's side (see §5).

## 4. Audit of plausible duplicate-dispatch paths on the NeoKai side

I walked every call site that touches `MessageQueue.enqueueWithId(...)` (the
narrowest waist between user input and the SDK subprocess) and verified it
is single-shot per logical input:

1. **`message.send` RPC.**
   `packages/daemon/src/lib/rpc-handlers/session-handlers.ts:456` →
   `sessionManager.sendUserMessage()` →
   `MessagePersistence.persist()` →
   `agentSession.startQueryAndEnqueue()` →
   `messageQueue.enqueueWithId(messageId, content)` (one call).
   The RPC returns to the caller after this one call; the WebSocket layer
   does not resend on retry without a new message id.

2. **Manual mode + auto-defer replay.**
   `QueryModeHandler.handleQueryTrigger()` and
   `QueryModeHandler.sendEnqueuedMessagesOnTurnEnd()` enqueue persisted
   `deferred` / `enqueued` rows back into the queue. They iterate over DB
   rows, not over fan-out lists, so each message id is enqueued at most
   once per call (and the row is then transitioned out of `enqueued` by
   `MessageQueue.onMessageYielded` in `MessageQueue.messageGenerator`).
   `replayPendingMessagesForImmediateMode()` chains the two replays, but
   they read disjoint status sets (`enqueued`, then `deferred`) so the same
   row cannot be picked twice.

3. **Auto-retry on SDK startup timeout.**
   `QueryRunner.runQuery()`
   (`packages/daemon/src/lib/agent/query-runner.ts:666`) recursively retries
   when the **SDK subprocess** failed to ack within the startup timeout.
   The retry deliberately **does not call `messageQueue.clear()`** — it
   reuses the same queued message so the user does not have to resend.
   This produces at most one *additional* SDK subprocess and at most one
   *additional* OpenRouter generation per user message, *only* in the
   pathological case that the first subprocess never produced any output.
   The first subprocess is closed (`queryObject.close()`) and its
   `processExitedPromise` is awaited before the retry spawns, so the two
   SDK subprocesses are not concurrent. This path **cannot** account for
   "messages sent to different providers at the same time" because the two
   attempts are strictly sequential.

4. **Workflow node activation.**
   `AgentMessageRouter.deliverMessage()`
   (`packages/daemon/src/lib/space/runtime/agent-message-router.ts:153`) —
   the recent fix in PR #1729 (commit `3e13f4be4`) explicitly aligned the
   semantics so that `send_message` from a node agent activates the target
   session before content delivery and only reports `delivered: true` when
   the target session was live and received the message exactly once. The
   queue (`PendingAgentMessageRepository`) is now a recovery backstop, not
   a delivery path; the prior dual-path was a known source of double
   processing of the same message.

5. **Cyclic re-entry.**
   `ChannelRouter.activateNode()`
   (`packages/daemon/src/lib/space/runtime/channel-router.ts:359`) —
   when an existing terminal node_execution is found, the live
   `agentSessionId` is preserved (not duplicated) so the same in-memory
   session continues across cycles. The fallback path (probe says session
   is dead) clears the session id and lets the tick loop spawn one fresh
   session, never two.

6. **Neo recovery / coordinator handoffs.**
   `packages/daemon/src/lib/rpc-handlers/neo-handlers.ts` and
   `packages/daemon/src/lib/neo/tools/neo-action-tools.ts` call
   `sessionManager.injectMessage(sessionId, message)` once per recovery
   action. Each call goes through `MessagePersistence.persist()`, which
   itself enqueues exactly once.

No call site enqueues the same `(messageId)` into two different queues, and
no call site enqueues the same content with two different `messageId`s
through the same path. The `MessageQueue` itself enforces single-consumption
via the `generation` counter
(`packages/daemon/src/lib/agent/message-queue.ts:62-70`, 219-235), which
discards stale generators on restart so the same `enqueueWithId` cannot be
consumed by two `messageGenerator` instances.

## 5. Recommended instrumentation (no behaviour change required)

If the user repeats the OpenRouter dashboard observation, the following
correlation log is the smallest change that would let us prove duplicate
dispatch (or the absence of it) without needing the OpenRouter dashboard:

```jsonc
// One log line per ENQUEUE into MessageQueue, written from
// QueryLifecycleManager.startQueryAndEnqueue() and from
// QueryModeHandler.handleQueryTrigger / sendEnqueuedMessagesOnTurnEnd.
{
  "event": "provider.dispatch.enqueue",
  "neokaiMessageId": "<UUID generated at RPC boundary>",
  "sessionId": "<NeoKai session id>",
  "agentName": "<resolved agent name, when applicable>",
  "workflowRunId": "<run id, when applicable>",
  "nodeExecutionId": "<node exec id, when applicable>",
  "provider": "openrouter",
  "model": "anthropic/claude-sonnet-4.6",
  "queueGeneration": 7,                  // MessageQueue.generation snapshot
  "sdkSessionId": "<may be undefined on first turn>"
}
```

```jsonc
// One log line per YIELD from the AsyncGenerator into the SDK subprocess,
// written from MessageQueue.onMessageYielded.
{
  "event": "provider.dispatch.yield",
  "neokaiMessageId": "<same UUID>",
  "sessionId": "<NeoKai session id>",
  "queueGeneration": 7,
  "yieldAtMs": 1730420000123
}
```

These two log lines are sufficient to answer:

- "Did NeoKai enqueue this user message more than once?" — count
  `provider.dispatch.enqueue` records by `neokaiMessageId`.
- "Did two different sessions receive the same content?" — group by
  the message body hash.
- "Did the SDK consume the same message twice?" — count
  `provider.dispatch.yield` records by `neokaiMessageId`. The
  `MessageQueue.generation` guard already enforces that a stale generator
  cannot consume a message a second time, but the log line proves it.

Beyond NeoKai, the OpenRouter `request_id` and generation `id` can only be
captured by the SDK subprocess itself (it owns the HTTP layer). If we want
that correlation, the next layer is to land
`CLAUDE_AGENT_SDK_LOG_HTTP=1` (or a comparable hook) and tee the SDK's
own debug log into the daemon log; this is out of scope for the current
task and is unnecessary unless the lighter-weight log above is
inconclusive.

## 6. Recommended regression tests (when we touch this area next)

The current tests already cover most of the surface, but the following
specific assertions would lock in the "one user message → one
`enqueueWithId` call" invariant:

1. `MessagePersistence.persist()`: stub `AgentSession.startQueryAndEnqueue`
   and assert it is called exactly once for one `message.send` RPC, even
   when both `message.persisted` listeners are wired (currently covered
   indirectly; explicit assertion is cheap).

2. `QueryLifecycleManager.startQueryAndEnqueue`: assert that on
   `MessageQueueTimeoutError`, the retry path
   (`handleQueuedMessageFailure`) calls `enqueueWithId(messageId, ...)`
   with the **same** `messageId`, not a new one. This guards against a
   future refactor that accidentally generates a new id and produces two
   queue entries.

3. `QueryRunner.runQuery` startup-timeout retry: assert
   `messageQueue.size()` is non-decreasing across the recursive call (the
   user's message must not be cleared, and no second copy must appear).

4. `AgentMessageRouter.deliverMessage`: PR #1729 already ships
   `cross-agent-messaging.test.ts` covering the activation-before-delivery
   contract; an explicit "single live target receives content exactly
   once" assertion would close the dispatch invariant for cross-agent
   messages.

None of these tests require a real OpenRouter call — they all live at the
NeoKai message-queue boundary, which is the single chokepoint between user
input and the SDK subprocess.

## 7. Acceptance-criteria mapping

| Criterion from Task #196 | Outcome |
| --- | --- |
| Confirm whether the dashboard observation was normal fallback or a NeoKai bug. | **Most likely normal Claude Agent SDK + OpenRouter routing behaviour.** No NeoKai-side duplicate-dispatch path was identified. The single chokepoint (`MessageQueue.enqueueWithId`) is single-shot per user message. Independent confirmation requires the lightweight correlation log in §5. |
| If it is a NeoKai bug, fix the root cause. | No bug to fix. If a future repro proves otherwise, §4 lists the candidate paths and §5 lists the instrumentation that would localise it. |
| Add tests preventing duplicate top-level OpenRouter requests. | Test plan in §6. None of these are blocked on the current investigation; they are forward-looking guards against a future regression in the message-queue layer. |
| Add or improve correlation logging for future diagnosis. | Concrete log schema in §5 (two new structured log lines, one per enqueue and one per yield). |
| Do not disable legitimate OpenRouter provider fallback / load balancing. | The provider config in `OpenRouterProvider.buildSdkConfig()` does not need to change. Provider fallback is opaque to NeoKai (it lives in OpenRouter's edge), and the proposed log changes are observation-only. |

## 8. Sources

- OpenRouter API — `GET /api/v1/generation`, request and response schema:
  <https://openrouter.ai/docs/api/api-reference/generations/get-generation>
- OpenRouter — Claude Code integration guide
  (`ANTHROPIC_BASE_URL`, tier env vars):
  <https://openrouter.ai/docs/guides/coding-agents/claude-code-integration>
- OpenRouter — Provider Routing (provider fallback semantics):
  <https://openrouter.ai/docs/guides/routing/provider-selection>
- OpenRouter — Model Fallbacks (single-request retry across providers):
  <https://openrouter.ai/docs/guides/routing/model-fallbacks>
- OpenRouter — API Streaming (debug chunk per attempted provider):
  <https://openrouter.ai/docs/api/reference/streaming>
- Claude Agent SDK — Subagents and parallel `Task` execution:
  <https://platform.claude.com/docs/en/agent-sdk/subagents>
- Claude Code — Custom subagents:
  <https://code.claude.com/docs/en/sub-agents>
- Claude Code — `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` (telemetry only,
  does not gate haiku-tier calls):
  <https://code.claude.com/docs/en/data-usage>
- NeoKai — OpenRouter setup notes:
  `docs/providers/openrouter-setup.md`

Internal references (worktree-relative paths):

- `packages/daemon/src/lib/providers/openrouter-provider.ts`
- `packages/daemon/src/lib/provider-service.ts`
- `packages/daemon/src/lib/agent/message-queue.ts`
- `packages/daemon/src/lib/agent/agent-session.ts`
- `packages/daemon/src/lib/agent/query-lifecycle-manager.ts`
- `packages/daemon/src/lib/agent/query-runner.ts`
- `packages/daemon/src/lib/agent/query-mode-handler.ts`
- `packages/daemon/src/lib/session/message-persistence.ts`
- `packages/daemon/src/lib/rpc-handlers/session-handlers.ts`
- `packages/daemon/src/lib/space/runtime/agent-message-router.ts`
- `packages/daemon/src/lib/space/runtime/channel-router.ts`
- `packages/daemon/src/lib/space/runtime/task-agent-manager.ts`
- `packages/daemon/src/lib/agent/coordinator-agents.ts`
