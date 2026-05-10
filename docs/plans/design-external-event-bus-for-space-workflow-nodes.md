# Design: External Event Bus for Space Workflow Nodes

## Status: Draft

## Problem

The Space Agent spends most of its time relaying "check the new review comments" to the coder node. External events (PR reviews, CI failures, etc.) arrive via webhooks/polling but have no path to workflow **nodes** — they only route to Rooms or to the Space Agent's global session (via `SpaceGitHubService`). We need a system where workflow nodes declare interest in event types, and matching events are delivered directly to their agent sessions.

## Current State

Two parallel event pipelines exist today, neither of which routes to individual workflow nodes:

1. **Room pipeline** (`GitHubService`): Webhook → normalize → filter → security → route → `deliverToRoom()` → DaemonHub `room.message`. Routes to **Rooms**, not Spaces.
2. **Space pipeline** (`SpaceGitHubService`): Webhook → normalize → dedupe → `SpacePrTaskResolver.resolve()` → `injectTaskAgent()`. Routes events to the **Task Agent session** (the orchestrator), which must then manually relay to the coder node.

The Space pipeline proves the primitives exist, but it is not the right extension boundary: GitHub-specific normalization, dedup, PR-to-task resolution, and Task Agent injection are bundled together in `SpaceGitHubService`. The target design extracts source ingestion into extensions and moves dedup and node delivery into reusable core external-event services.

## Design Overview

This design treats GitHub as the first external-event **extension** rather than a special-case Space service. The extension owns source-specific concerns — GitHub auth, webhook verification, polling, raw payload normalization, and source configuration. Core Space infrastructure owns durable external-event lifecycle, subscription matching, retry behavior, and delivery to workflow nodes.

The target flow aligns with the broader internal event/command/query refactor:

```text
GitHubEventExtension
  ├─ enabled globally? enabled for this space?
  ├─ verifies webhook / polls GitHub
  ├─ normalizes GitHub payload → ExternalEvent
  └─ publishes to ExternalEventService

ExternalEventService
  ├─ validates topic/source contract
  ├─ dedupes by (spaceId, source, dedupeKey)
  ├─ persists source event lifecycle
  └─ publishes InternalEventBus fact: externalEvent.published

ExternalEventRouter
  ├─ subscribes to externalEvent.published
  ├─ matches active workflow-node eventInterests
  ├─ records per-subscription delivery lifecycle
  └─ dispatches InternalCommandBus command: agent.message.inject

Agent session
  └─ receives structured external-event message
```

The design should make adding a third-party source boring:

```text
SlackEventExtension / JiraEventExtension / CIEventExtension
  → normalize source payloads into ExternalEvent
  → publish to ExternalEventService
  → reuse the same store, router, retry, and command delivery path
```

No third-party extension should inspect workflow node state or inject messages into agent sessions.

### Extension enablement and configuration

External event sources should be configurable at two levels:

1. **Global extension configuration** — installed/enabled daemon-wide, with shared secrets or app credentials.
2. **Space extension configuration** — enabled/disabled per space, with source-specific routing scope such as watched GitHub repositories, Slack channels, Jira projects, or CI pipelines.

GitHub is the reference implementation:

```text
Global GitHub config
  ├─ extension enabled/disabled
  ├─ GitHub App / token / webhook secret configuration
  └─ allowed capabilities: webhooks, polling, repo watching

Per-space GitHub config
  ├─ extension enabled/disabled for the space
  ├─ watched repositories
  ├─ optional event filters
  └─ optional polling/webhook preferences
```

The extension manager should prevent disabled sources from accepting webhooks, scheduling polling, or publishing events for disabled spaces. Existing source-specific tables such as `space_github_watched_repos` can remain as GitHub extension configuration during migration, but the cross-source event lifecycle belongs to `ExternalEventStore`.

## 1. Namespaced Event Topics

Topic format: `{source}/{owner}/{repo}/{resource}.{action}`

Examples:
```
github/lsm/neokai/pull_request.review_submitted
github/lsm/neokai/pull_request.comment_created
github/lsm/neokai/pull_request.synchronize
github/lsm/neokai/pull_request.closed
# Not emitted in v1 — mapEventType only handles pull_request variants;
# issues.* requires a future GitHub extension expansion: github/lsm/neokai/issues.opened
# Future CI extension (Phase 3): github/lsm/neokai/check_suite.completed
github/lsm/neokai/pull_request.*            ← wildcard: all PR events for this repo
github/lsm/neokai/*.*                       ← wildcard: all events for this repo
github/lsm/neokai/pull_request.review_*     ← prefix wildcard: all review events
```

### Topic construction rules

1. `source` — extension/source identifier (`github`, `slack`, `ci`). Lowercase, no slashes.
2. `owner/repo` — from the event's repository context. Both lowercase for case-insensitive matching.
3. `resource.action` — the fourth path segment is always one dotted pair. For V1 GitHub PR events, `resource` is `pull_request`; review/comment variants are encoded in `action` (`review_submitted`, `comment_created`, `review_comment_created`) so examples like `pull_request.review_submitted` remain canonical. CI resources such as `check_suite` are Phase 3/future extension scope.
4. `action` — the specific action: `opened`, `review_submitted`, `comment_created`, `completed`, etc.
5. All v1 topics use exactly 4 path segments. For resources without a natural `owner/repo` (e.g. a future Slack message), use a source-specific scope pair to preserve the same depth: `{source}/{workspace}/{channel}/{resource}.{action}` (for example, `slack/acme/eng/messages.created`). Adapters that do not have both scope levels should use a reserved placeholder segment such as `_` rather than emitting 3-segment topics.

### Matching rules

Subscriptions use glob-style patterns:
- `*` matches any sequence of characters inside one path segment (no slashes).
  - A whole-segment `*` matches any single segment (e.g., owner or repo).
  - A segment-local wildcard also works inside dotted resource/action segments (e.g., `pull_request.*`, `pull_request.review_*`, `*.*`).
- Literal characters match exactly (case-insensitive).

> **V1 scope note:** The `**` (multi-segment) wildcard is deferred to a follow-up. All v1 use cases are covered by segment-local `*` wildcards at the `owner`, `repo`, or `action` position (e.g., `github/*/*/pull_request.review_submitted`, `github/*/*/pull_request.*`). Adding `**` support requires a depth-bounded recursive trie walk and is not justified by current subscription patterns.

Pattern validation (enforced at workflow create/update time):
- Must be non-empty.
- Must not contain `..` segments.
- Must not contain empty segments (no double slashes).
- Must have exactly 4 segments (`source/scope1/scope2/resource.action`) so it can match real event topics.
- The 4th segment must contain a `resource.action` separator (`.`) with non-empty resource and action sides, allowing segment-local wildcards such as `pull_request.*`, `*.created`, and `*.*`.
- Each segment may contain alphanumeric, dash, underscore, dot, and `*`; `*` must stay within a single segment and cannot cross `/` boundaries.
- Max 10 interests per agent slot.

We implement matching via a **trie-based prefix index** (see §4), not regex.

## 2. Node-Level Event Subscription (`eventInterests`)

### Schema addition to `WorkflowNodeAgent`

```typescript
// packages/shared/src/types/space.ts — add to WorkflowNodeAgent

export interface EventInterest {
  /**
   * Glob pattern matching event topics.
   * Examples: 'github/*/*/pull_request.*', 'github/*/*/pull_request.review_*'
   */
  topic: string;

  /**
   * Scoping mode — determines how the router filters events for this node.
   * - 'task'    — Only events related to THIS TASK (e.g. same PR number, same branch).
   *               The router uses the task's associated PR/branch to filter.
   * - 'repo'    — All events for the space's configured repository.
   * - 'global'  — All events matching the topic pattern, no additional filtering.
   */
  scope: 'task' | 'repo' | 'global';

  /**
   * Optional label for diagnostics. Not used in routing logic.
   * Example: 'PR review comments', 'CI failures'
   */
  label?: string;
}

// Added to WorkflowNodeAgent:
export interface WorkflowNodeAgent {
  // ... existing fields ...

  /**
   * Events this node is interested in receiving. When matched, the event is
   * injected into the agent's session as a structured message.
   * Omit or empty array = no event subscriptions (default).
   */
  eventInterests?: EventInterest[];
}
```

### Example workflow definition

```json
{
  "nodes": [
    {
      "id": "coder",
      "name": "Code",
      "agents": [{
        "agentId": "...",
        "name": "coder",
        "eventInterests": [
          {
            "topic": "github/*/*/pull_request.review_submitted",
            "scope": "repo",
            "label": "PR reviews in watched repos"
          },
          {
            "topic": "github/*/*/pull_request.comment_created",
            "scope": "repo",
            "label": "PR comments in watched repos"
          },
          {
            "topic": "github/*/*/pull_request.review_comment_created",
            "scope": "repo",
            "label": "Inline review comments in watched repos"
          }
        ]
      }]
    },
    {
      "id": "monitor",
      "name": "PR Monitor",
      "agents": [{
        "agentId": "...",
        "name": "pr-monitor",
        "eventInterests": [
          {
            "topic": "github/*/*/pull_request.*",
            "scope": "repo",
            "label": "All PR activity in the repo"
          }
        ]
      }]
    }
  ]
}
```

### Scoping details

**`repo` scope** filters to events from any of the space's watched repositories (`space_github_watched_repos`). The node author doesn't need to know repo names.

**`global` scope** passes through all events in the same space matching the topic pattern. It is never cross-space: the router requires `event.spaceId === subscription.spaceId` before any scope-specific logic runs. Use sparingly (e.g. a space-local "global monitor" node).

### Auto-scoping resolution at runtime

When an event arrives, the router:

1. Verifies `event.spaceId` matches the subscription's `spaceId`, then uses normalized event fields (`repoOwner/repoName`, etc.) for scope checks.
2. For each active node execution with `eventInterests`:
   a. Compiles the interest's `topic` glob against the event's topic.
   b. If matched, checks scope:
      - `repo`: does event's repo match any watched repo in the node's space?
      - `global`: pass.
   c. If scope check passes, the event is queued for delivery to this node's agent session.

## 3. External Event Extension Interface

External sources are modeled as **extensions**. An extension owns the source-specific work:

1. Receive events from its source (webhook, polling, streaming API, etc.).
2. Check global and per-space enablement before accepting or polling events.
3. Verify source-specific authenticity (e.g. GitHub HMAC signatures).
4. Load source-specific configuration (for GitHub: watched repositories and webhook/polling settings).
5. Normalize raw source payloads into `ExternalEvent`.
6. Publish directly to `ExternalEventService`.

Extensions do **not** inspect workflow nodes, resolve Space tasks, or inject into agent sessions. Those are core daemon responsibilities handled by `ExternalEventService`, `ExternalEventRouter`, and `InternalCommandBus`. This keeps GitHub, Slack, Jira, CI, and future integrations pluggable without adding source-specific paths to the workflow runtime.

```typescript
// packages/daemon/src/lib/external-events/types.ts

/**
 * A normalized external event on the bus.
 *
 * `dedupeKey` is the stable source-level identity used by `ExternalEventStore`
 * to recognize the same external event across webhook + polling observations.
 * It must be stable across observations of the same external event from any
 * channel and unique within `(spaceId, source)`.
 */
export interface ExternalEvent {
  /** Unique event ID (UUID) assigned by the extension for this publication. */
  id: string;
  /** Space this event belongs to. Required to prevent cross-space delivery. */
  spaceId: string;
  /** Fully qualified topic: 'github/owner/repo/resource.action' */
  topic: string;
  /** Timestamp when the event occurred at the source (epoch ms). */
  occurredAt: number;
  /** Timestamp when the event was accepted by the extension (epoch ms). */
  ingestedAt: number;
  /** Source extension identifier. */
  source: string;
  /** Optional source-native event id / delivery id for diagnostics. */
  sourceEventId?: string;
  /** Human-readable summary for agent consumption. */
  summary: string;
  /** External URL (e.g. GitHub PR link). */
  externalUrl?: string;
  /**
   * Structured source payload — extension-specific, not constrained.
   * Source-specific metadata like prNumber, repoOwner, repoName, branch
   * live inside this opaque payload. The event pipeline does not interpret
   * these fields; they are passed through to subscribers.
   */
  payload: Record<string, unknown>;
  /**
   * Stable source-level identity used by bus dedup. Must be stable across
   * webhook and polling observations of the same external event.
   */
  dedupeKey: string;
}

export interface ExternalEventExtensionConfig {
  source: string;
  globallyEnabled: boolean;
  capabilities: {
    webhooks?: boolean;
    polling?: boolean;
    rpcConfig?: boolean;
  };
  secretsRef?: string;
  settings?: Record<string, unknown>;
}

export interface SpaceExternalEventSourceConfig {
  spaceId: string;
  source: string;
  enabled: boolean;
  settings: Record<string, unknown>;
}

export interface ExternalEventExtensionContext {
  /** Publish a normalized event into the shared external-event subsystem. */
  publisher: ExternalEventPublisher;
  /** Read global extension config, secrets references, and per-space config. */
  config: ExternalEventExtensionConfigStore;
  /** Notify core services that source configuration changed for a space. */
  onSourceConfigChanged(change: { source: string; spaceId?: string; kind: string }): void;
}

export interface ExternalEventExtensionConfigStore {
  getGlobalConfig(source: string): Promise<ExternalEventExtensionConfig>;
  getSpaceConfig(spaceId: string, source: string): Promise<SpaceExternalEventSourceConfig | null>;
  listEnabledSpaces(source: string): Promise<SpaceExternalEventSourceConfig[]>;
}

/**
 * Interface that event source extensions must implement.
 */
export interface ExternalEventExtension {
  /** Source identifier used in topic namespace: '{source}/...'. */
  readonly sourceId: string;

  /**
   * Start the extension. Called once at daemon startup if the source is globally enabled.
   * The extension calls `context.publisher.publish(event)` whenever it accepts an event.
   */
  start(context: ExternalEventExtensionContext): Promise<void>;

  /** Stop the extension. Called at daemon shutdown or when globally disabled. */
  stop(): Promise<void>;
}

/**
 * Optional interface for extensions that expose HTTP endpoints.
 * The daemon routes matching requests to the extension without knowing source
 * internals such as HMAC verification, event names, or raw payload shape.
 */
export interface HttpExternalEventExtension extends ExternalEventExtension {
  readonly routes: readonly {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    handle(req: Request, context: ExternalEventExtensionContext): Promise<Response>;
  }[];
}

/**
 * Optional interface for extensions that expose daemon RPC methods.
 * GitHub uses this for watch/list/poll operations; future extensions can expose
 * source-specific configuration without adding core RPC handler dependencies.
 */
export interface RpcExternalEventExtension extends ExternalEventExtension {
  registerRpcHandlers(hub: MessageHub, context: ExternalEventExtensionContext): void;
}

/**
 * Callback extensions use to publish events into the shared external-event subsystem.
 */
export interface ExternalEventPublisher {
  publish(event: ExternalEvent): Promise<PublishResult>;
}

export interface PublishResult {
  eventId: string;
  duplicate: boolean;
  state: 'published' | 'duplicate_terminal' | 'retryable_duplicate' | 'ignored';
}

export interface ExternalEventStore {
  store(event: ExternalEvent): { event: ExternalEvent; duplicate: boolean; terminal: boolean };
  /**
   * Idempotently register the delivery row expected for an event/subscription.
   * Must be implemented as INSERT OR IGNORE / ON CONFLICT DO NOTHING (or an
   * equivalent upsert that preserves terminal state) because retryable source
   * duplicates and router retries can prepare the same (eventId, deliveryKey)
   * multiple times before delivery succeeds.
   */
  registerExpectedDelivery(
    eventId: string,
    deliveryKey: string,
    target: { workflowRunId: string; taskId: string; nodeId: string; agentName: string },
  ): void;
  /** Returns true when the delivery row is already terminal and should be skipped. */
  isDeliveryTerminal(eventId: string, deliveryKey: string): boolean;
  /** Looks up the source event id for a registered delivery key. */
  getEventIdForDeliveryKey(deliveryKey: string): string;
  markDeliveryDelivered(eventId: string, deliveryKey: string): void;
  markDeliveryFailed(
    eventId: string,
    deliveryKey: string,
    failure: { terminal: boolean; reason: string },
  ): void;
  markEventDeliveredIfAllDeliveriesDelivered(eventId: string): void;
  markEventFailedIfAnyDeliveryTerminalFailed(eventId: string): void;
  markEventFailedIfAllDeliveriesTerminal(eventId: string): void;
  markEventFailed(eventId: string, failure: { terminal: boolean; reason: string }): void;
  markEventIgnored(eventId: string, reason: 'no_matching_subscriptions' | 'no_scope_eligible_subscriptions'): void;
}
```

```typescript
class ExternalEventService implements ExternalEventPublisher {
  constructor(
    private readonly internalEventBus: InternalEventBus<InternalEventMap>,
    private readonly eventStore: ExternalEventStore,
  ) {}

  async publish(event: ExternalEvent): Promise<PublishResult> {
    // 1. Validate topic and required source fields.
    validateExternalEvent(event);

    // 2. Store and dedupe before emission. Unlike SpaceGitHubService.ingest(),
    // retryable duplicates are not swallowed: if the prior delivery state is
    // non-terminal, the event is re-emitted so delivery can retry.
    const stored = this.eventStore.store(event);
    if (stored.duplicate && stored.terminal) {
      return { eventId: stored.event.id, duplicate: true, state: 'duplicate_terminal' };
    }

    // 3. Publish the normalized event to the internal bus.
    // The event pipeline does NOT resolve tasks — task matching is a
    // workflow-node concern, not an event-pipeline concern.
    await this.internalEventBus.publish('externalEvent.published', {
      channel: Channels.space(event.spaceId),
      payload: { event },
    });

    return {
      eventId: event.id,
      duplicate: stored.duplicate,
      state: stored.duplicate ? 'retryable_duplicate' : 'published',
    };
  }
}
```

### ExternalEventService responsibilities

`ExternalEventService` owns cross-cutting behavior that applies to every extension:

1. **Validation** — all topics must satisfy the four-segment topic contract before publication.
2. **Source-level dedup** — a persistent `ExternalEventStore` tracks `(spaceId, source, dedupeKey)` and delivery state. Terminal duplicates (`delivered`, `failed`, `ignored`) are short-circuited; retryable states (`published`) are re-emitted so delivery can retry.
3. **Publication** — only deduped events are published as the internal fact `externalEvent.published`.

The service does NOT:
- Resolve events to tasks
- Inspect workflow nodes
- Inject messages into agent sessions
- Interpret source-specific payload fields

This replaces the current GitHub-specific `SpaceGitHubService.ingest()` hot path for new event delivery. In particular, the service-level dedup store must not use unconditional `INSERT OR IGNORE` short-circuiting for retryable states; otherwise transient delivery failures become permanent event loss.

### GitHub extension as the reference implementation

```typescript
interface GitHubSpaceConfig {
  enabled: boolean;
  watchedRepos: { owner: string; repo: string; enabled: boolean }[];
  eventFilters?: {
    pullRequests?: boolean;
    reviews?: boolean;
    comments?: boolean;
    checks?: boolean;
  };
  polling?: { enabled: boolean; intervalMs?: number };
  webhooks?: { enabled: boolean };
}

class GitHubEventExtension implements HttpExternalEventExtension, RpcExternalEventExtension {
  readonly sourceId = 'github';
  readonly routes = [
    { method: 'POST', path: '/webhook/github/space', handle: this.handleWebhook.bind(this) },
  ] as const;

  private context?: ExternalEventExtensionContext;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  async start(context: ExternalEventExtensionContext): Promise<void> {
    this.context = context;
    this.stopped = false;
    const global = await context.config.getGlobalConfig(this.sourceId);
    if (!global.globallyEnabled || !global.capabilities.polling) return;

    // Use completion-scheduled polling instead of setInterval so a slow poll cycle
    // cannot overlap the next one and amplify duplicate fetches/rate-limit pressure.
    this.scheduleNextPoll();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
  }

  private scheduleNextPoll(): void {
    if (this.stopped) return;
    this.pollTimer = setTimeout(() => {
      void this.runPollCycle();
    }, GITHUB_POLL_INTERVAL_MS);
  }

  private async runPollCycle(): Promise<void> {
    try {
      await this.pollEnabledSpaces();
    } catch (err) {
      log.warn('GitHubEventExtension: polling failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.scheduleNextPoll();
    }
  }

  registerRpcHandlers(hub: MessageHub, context: ExternalEventExtensionContext): void {
    hub.onRequest('space.github.enable', async (data) => {
      const config = await this.enableForSpace(data);
      context.onSourceConfigChanged({ source: this.sourceId, spaceId: config.spaceId, kind: 'space_enabled' });
      return config;
    });

    hub.onRequest('space.github.disable', async (data) => {
      const config = await this.disableForSpace(data);
      context.onSourceConfigChanged({ source: this.sourceId, spaceId: config.spaceId, kind: 'space_disabled' });
      return config;
    });

    hub.onRequest('space.github.watchRepo', async (data) => {
      const watchedRepo = await this.watchRepo(data);
      context.onSourceConfigChanged({ source: this.sourceId, spaceId: watchedRepo.spaceId, kind: 'watched_repo_changed' });
      return watchedRepo;
    });

    hub.onRequest('space.github.listConfig', async (data) => this.listSpaceConfig(data));
    hub.onRequest('space.github.pollOnce', async (data) => ({ count: await this.pollSpace(data.spaceId) }));
  }

  private async handleWebhook(req: Request, context: ExternalEventExtensionContext): Promise<Response> {
    const global = await context.config.getGlobalConfig(this.sourceId);
    if (!global.globallyEnabled || !global.capabilities.webhooks) {
      return Response.json({ ignored: true, reason: 'github_extension_disabled' }, { status: 202 });
    }

    const raw = await req.text();
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      log.warn('GitHubEventExtension: invalid webhook JSON', {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ ignored: true, reason: 'invalid_json' }, { status: 400 });
    }

    const normalized = normalizeGitHubWebhook(req.headers, payload);
    if (!normalized) return Response.json({ ignored: true });

    const targetSpaces = await this.resolveEnabledSpacesForWebhook(context, req, raw, normalized);
    const results = await Promise.allSettled(
      targetSpaces
        .filter((spaceConfig) => spaceConfig.enabled)
        .map(async (spaceConfig) => {
          try {
            await context.publisher.publish(toExternalEvent(spaceConfig.spaceId, normalized));
            return { spaceId: spaceConfig.spaceId, ok: true };
          } catch (err) {
            log.warn('GitHubEventExtension: failed to publish webhook for space', {
              spaceId: spaceConfig.spaceId,
              error: err instanceof Error ? err.message : String(err),
            });
            return { spaceId: spaceConfig.spaceId, ok: false };
          }
        }),
    );

    const failed = results
      .map((result) => result.status === 'fulfilled' ? result.value : { spaceId: 'unknown', ok: false })
      .filter((result) => !result.ok);

    return Response.json({
      message: 'Webhook received',
      published: results.length - failed.length,
      failed: failed.length,
    }, { status: failed.length > 0 ? 207 : 200 });
  }

  private async pollEnabledSpaces(): Promise<number> {
    if (!this.context) return 0;
    const spaces = await this.context.config.listEnabledSpaces(this.sourceId);
    const results = await Promise.allSettled(
      spaces.map(async (spaceConfig) => {
        try {
          return await this.pollSpace(spaceConfig.spaceId);
        } catch (err) {
          log.warn('GitHubEventExtension: polling failed for space', {
            spaceId: spaceConfig.spaceId,
            error: err instanceof Error ? err.message : String(err),
          });
          return 0;
        }
      }),
    );

    return results.reduce((count, result) => {
      if (result.status === 'fulfilled') return count + result.value;
      return count;
    }, 0);
  }

  async pollSpace(spaceId: string, fetchImpl: typeof fetch = fetch): Promise<number> {
    // Load this space's GitHub config, poll its enabled watched repos, normalize rows,
    // and publish ExternalEvent directly. No SpaceTask lookup and no session injection happen here.
  }
}
```

The normalization helpers currently living in `space-github.ts` move into this extension module:

- `normalizeSpaceGitHubWebhook(...)` → `normalizeGitHubWebhook(...)`
- `normalizePollingRow(...)` → `normalizeGitHubPollingRow(...)`
- `mapEventType(...)` stays with the extension because topic construction is source-specific

The extension may keep source-local tables such as `space_github_watched_repos` and an optional extension event log for diagnostics, but the authoritative cross-source event lifecycle belongs to `ExternalEventStore`. During migration, existing GitHub RPC names can remain as compatibility aliases, but new extension APIs should use a generic shape where possible: global source enablement, per-space source enablement, source-specific settings, and watched-resource configuration.

## 4. ExternalEventRouter Design

### Architecture

The `ExternalEventRouter` subscribes to the internal fact `externalEvent.published` on `InternalEventBus`. When an event arrives, it:

1. Reads the external topic from `event.topic` in the payload.
2. Looks up all active node executions that have `eventInterests` matching that payload topic.
3. For each matching interest, checks scope.
4. Records/updates per-subscription delivery lifecycle.
5. Dispatches `InternalCommandBus.dispatch('agent.message.inject', ...)` for the matching node's agent session.

### Trie-based subscription index

For O(1)-ish lookup, we maintain a **topic trie**:

```
root
  └── github
      └── *                          ← matches any owner
          └── *                      ← matches any repo
              ├── pull_request.*     ← all PR actions
              │   └── [subscriptions: coder(task), ...]
              ├── pull_request.review_submitted
              │   └── [subscriptions: coder(task)]
              ├── pull_request.comment_created
              │   └── [subscriptions: coder(task)]
              └── pull_request.review_comment_created
                  └── [subscriptions: coder(task)]
```

The trie maps topic segments to `Set<Subscription>` at leaf nodes. Each node stores exact children separately from segment-local glob children. A glob segment may be a whole-segment wildcard (`*`) or a dotted segment wildcard (`pull_request.*`, `pull_request.review_*`, `*.*`).

**Build cost**: O(n × k) where n = number of subscriptions, k = topic depth (typically 4-5). Built once when a workflow run starts.

**Lookup cost**: The trie walks the exact branch (O(1)) and any glob-child branches at each level. With k bounded to 4–5 segments and max 10 interests per agent slot, the number of glob branches is small. In the common case this remains effectively O(2^k × m), where m is the total number of matching subscriptions across collected leaves. The real benefit over linear scan is that non-matching subscriptions are never visited — only subscriptions whose pattern segments align with the event's topic are collected.

### Subscription index lifecycle

The index is **per-SpaceRuntime instance** and updated via two distinct operations:

1. **`registerRunInterests`** (called on every `executeTick`): Diff-based trie update. Compares current node execution states against existing subscriptions. Adds subscriptions for newly active nodes and removes stale trie entries. Does NOT touch the dedup map or pending queue — those are preserved across tick refreshes.

2. **`unregisterExecution`** (called when an individual node execution transitions to `cancelled`): Node-level terminal cleanup. Removes that node's subscriptions and fails queued/retrying delivery rows for that node so event terminalization is not blocked until full run teardown.

3. **`clearRunInterests`** (called only on `done`/`cancelled` terminal transitions): Full teardown. Removes all trie subscriptions, dedup entries, and pending queue entries for the run. NOT called on `blocked` transitions because blocked is resumable.

```typescript
interface Subscription {
  workflowRunId: string;
  /** The specific SpaceTask this node execution belongs to. Used for `task` scope. */
  taskId: string;
  nodeId: string;
  agentName: string;
  interest: EventInterest;    // from the workflow definition
  agentSessionId: string | null; // resolved at delivery time
  spaceId: string;
}

interface PendingDelivery {
  event: ExternalEvent;
  deliveryKey: string;
}

interface QueuedDeliveryFailure {
  eventId: string;
  deliveryKey: string;
  reason:
    | 'pending_queue_overflow'
    | 'run_terminal_cleanup'
    | 'run_terminal_retry_cancelled'
    | 'node_execution_cancelled'
    | 'subscription_inactive_retry_skipped';
}

interface EventRetryState {
  event: ExternalEvent;
  /**
   * Last matched subscriptions are retained only for lifecycle cleanup/reschedule
   * when a run terminates while a preparation retry is pending. The retry timer
   * must recompute current matches from the trie before preparing delivery so it
   * never targets subscriptions removed or changed after the retry was scheduled.
   */
  matched: Subscription[];
}

interface WatchedRepoLookup {
  listWatchedRepos(spaceId: string): { owner: string; repo: string; enabled: boolean }[];
}

```

### ExternalEventRouter implementation sketch

```typescript
class ExternalEventRouter {
  // topic trie for fast lookup
  private topicTrie: TopicTrie<Subscription> = new TopicTrie();

  // track which runs have active subscriptions (for lifecycle management)
  private activeRuns: Map<string, Set<Subscription>> = new Map();

  // dedup: JSON tuple (dedupeKey, taskId, nodeId, agentName, workflowRunId) → timestamp
  private delivered: Map<string, number> = new Map();
  // pending delivery queue: JSON tuple (workflowRunId, taskId, nodeId, agentName) → events plus delivery keys
  private pendingQueue: Map<string, PendingDelivery[]> = new Map();
  // TTL for dedup entries — entries older than this are evicted on next access
  private static readonly DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes

  // Track pending deliveries to prevent duplicate queueing while allowing retries
  private pendingDeliveries: Set<string> = new Set();
  // Retry tracking: deliveryKey → retry count / scheduled timer
  private retryCounts: Map<string, number> = new Map();
  private retryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  // Event-level retry tracking for failures before expected delivery rows exist.
  // Retry keys are JSON tuples: [event.id, sorted workflowRunIds, 'prepare'].
  private eventRetryCounts: Map<string, number> = new Map();
  private eventRetryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private eventRetryState: Map<string, EventRetryState> = new Map();
  private static readonly MAX_RETRIES = 3;
  private static readonly RETRY_BACKOFF_MS = 1000; // 1s base, exponential backoff

  // Cache: spaceId → Set of "owner/repo" strings for watched repos.
  // Invalidated when a source extension reports watched-repo configuration
  // changes, including space-level enable/disable transitions that can change
  // which repos are eligible for repo-scoped routing.
  private watchedRepoCache: Map<string, Set<string>> = new Map();

  constructor(
    private readonly config: {
      internalEventBus: InternalEventBus<InternalEventMap>;
      commandBus: InternalCommandBus<InternalCommandMap>;
      nodeExecutionRepo: NodeExecutionRepository;
      taskRepo: SpaceTaskRepository;
      spaceTaskManager: SpaceTaskManager;
      eventStore: ExternalEventStore;
      watchedRepoLookup: WatchedRepoLookup;
    },
  ) {
    // Subscribe to the semantic internal fact. External topic matching happens
    // inside handleEvent via event.topic, not via the internal event name.
    this.config.internalEventBus.subscribe('externalEvent.published', ({ payload, channel }) => {
      const { event } = payload;
      // Defense in depth: payload spaceId and channel spaceId must agree when channel is space-scoped.
      if (channel.kind === 'space' && event.spaceId !== channel.spaceId) return;
      void this.handleEvent(event).catch((err) => {
        log.warn('ExternalEventRouter: failed to route external event', {
          error: err,
          spaceId: event.spaceId,
          topic: event.topic,
          eventId: event.id,
        });
      });
    }, { subscriberName: 'ExternalEventRouter' });
  }

  /** Check if a repo is watched for a given space. Uses cached data. */
  private isWatchedRepo(spaceId: string, owner: string, repo: string): boolean {
    let cached = this.watchedRepoCache.get(spaceId);
    if (!cached) {
      const repos = this.config.watchedRepoLookup.listWatchedRepos(spaceId);
      cached = new Set(
        repos.filter(r => r.enabled).map(r => `${r.owner.toLowerCase()}/${r.repo.toLowerCase()}`)
      );
      this.watchedRepoCache.set(spaceId, cached);
    }
    return cached.has(`${owner.toLowerCase()}/${repo.toLowerCase()}`);
  }

  /**
   * Invalidate the watched-repo cache for a given space (or all spaces).
   * Called from ExternalEventExtensionContext.onSourceConfigChanged when a source extension
   * changes watched-repo configuration or space-level source enablement.
   * Without this, `repo`-scoped matching can use stale enabled/watched repo sets
   * until process restart or a later watch mutation.
   */
  invalidateWatchedRepoCache(spaceId?: string): void {
    if (spaceId) {
      this.watchedRepoCache.delete(spaceId);
    } else {
      this.watchedRepoCache.clear();
    }
  }

  private makeDeliveryKey(event: ExternalEvent, sub: Subscription): string {
    // Use a structured tuple key. Source-level dedupe is unique by
    // (spaceId, source, dedupeKey), so include event.source to prevent two extensions
    // that legitimately emit the same dedupeKey from sharing pending/delivered/retry
    // bookkeeping for the same subscription. All fields are free-form strings and
    // can contain ':', '/', or other delimiter characters, so avoid delimiter joins.
    return JSON.stringify([event.source, event.dedupeKey, sub.taskId, sub.nodeId, sub.agentName, sub.workflowRunId]);
  }

  private makePendingQueueKey(sub: Pick<Subscription, 'workflowRunId' | 'taskId' | 'nodeId' | 'agentName'>): string {
    // Same collision-safe shape as subscription/delivery keys.
    return JSON.stringify([sub.workflowRunId, sub.taskId, sub.nodeId, sub.agentName]);
  }

  private parseDeliveryKey(key: string): {
    source: string;
    dedupeKey: string;
    taskId: string;
    nodeId: string;
    agentName: string;
    workflowRunId: string;
  } {
    const [source, dedupeKey, taskId, nodeId, agentName, workflowRunId] = JSON.parse(key) as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    return { source, dedupeKey, taskId, nodeId, agentName, workflowRunId };
  }

  /** Evict stale dedup entries (called periodically or on demand). */
  private evictStaleDedup(): void {
    const cutoff = Date.now() - ExternalEventRouter.DEDUP_TTL_MS;
    for (const [key, ts] of this.delivered.entries()) {
      if (ts < cutoff) this.delivered.delete(key);
    }
  }

  /**
   * Refresh event interests for a workflow run based on current node execution states.
   * Called on every executeTick to keep the trie in sync with node lifecycle changes.
   *
   * This is a DIFF-BASED update — it only adds/removes trie subscriptions for nodes
   * whose status has changed. It does NOT touch the dedup map or pending queue.
   * Terminal-run cleanup (dedup + pending) is handled exclusively by `clearRunInterests`.
   */
  registerRunInterests(
    spaceId: string,
    workflowRunId: string,
    /** The task whose tick/session activation is being processed. */
    taskId: string,
    workflow: SpaceWorkflow,
    nodeExecutions: NodeExecution[],
  ): void {
    // Build the desired set of subscriptions from current node execution states.
    // Use a structured tuple key encoded with JSON.stringify rather than a
    // delimiter-joined string: task ids, node ids, agent names, topics, and scopes
    // are free-form enough that ':' or other delimiters can appear in valid input.
    const makeSubscriptionKey = (sub: Pick<Subscription, 'taskId' | 'nodeId' | 'agentName' | 'interest'>) =>
      JSON.stringify([sub.taskId, sub.nodeId, sub.agentName, sub.interest.topic, sub.interest.scope]);

    const desiredSubs = new Map<string, Subscription>();

    for (const node of workflow.nodes) {
      for (const agent of node.agents) {
        if (!agent.eventInterests?.length) continue;

        const exec = nodeExecutions.find(
          e => e.workflowNodeId === node.id && e.agentName === agent.name
        );
        if (!exec || !isReceivingStatus(exec.status)) continue;

        for (const interest of agent.eventInterests) {
          // Include taskId, topic, and scope in key — the same run can contain
          // multiple tasks, and the same agent can subscribe to the same topic
          // with different scopes (e.g., both 'task' and 'repo' scope).
          const sub: Subscription = {
            workflowRunId,
            taskId,
            nodeId: node.id,
            agentName: agent.name,
            interest,
            agentSessionId: exec.agentSessionId,
            spaceId,
          };
          desiredSubs.set(makeSubscriptionKey(sub), sub);
        }
      }
    }

    // Diff against current subscriptions for THIS task only. A workflow run can
    // contain multiple tasks, so refreshing task A must not remove task B's
    // subscriptions from the same run.
    const currentRunSubs = this.activeRuns.get(workflowRunId) ?? new Set<Subscription>();
    const currentTaskSubs = [...currentRunSubs].filter(sub => sub.taskId === taskId);
    const currentSubsByKey = new Map<string, Subscription>();
    for (const sub of currentTaskSubs) {
      currentSubsByKey.set(makeSubscriptionKey(sub), sub);
    }
    const desiredKeys = new Set(desiredSubs.keys());

    // Remove this task's subscriptions no longer in the desired set (e.g. node went cancelled).
    for (const [key, sub] of currentSubsByKey) {
      if (!desiredKeys.has(key)) {
        this.topicTrie.remove(
          v => v.workflowRunId === workflowRunId
            && v.taskId === sub.taskId
            && v.nodeId === sub.nodeId
            && v.agentName === sub.agentName
            && v.interest.topic === sub.interest.topic
            && v.interest.scope === sub.interest.scope,
        );
      }
    }

    // Add new subscriptions not currently in the trie. Revalidate here as a
    // safety net for legacy/malformed workflow rows that predate create/update
    // validation.
    for (const [key, sub] of desiredSubs) {
      if (!currentSubsByKey.has(key)) {
        const validation = validateGlobPattern(sub.interest.topic);
        if (!validation.valid) {
          log.warn('ExternalEventRouter: skipping invalid event interest topic', {
            workflowRunId,
            taskId: sub.taskId,
            nodeId: sub.nodeId,
            agentName: sub.agentName,
            topic: sub.interest.topic,
            reason: validation.reason,
          });
          continue;
        }
        this.topicTrie.insert(sub.interest.topic, sub);
      }
    }

    // Replace only this task's active subscriptions while preserving other tasks
    // in the same workflow run.
    const preservedOtherTaskSubs = [...currentRunSubs].filter(sub => sub.taskId !== taskId);
    this.activeRuns.set(workflowRunId, new Set([...preservedOtherTaskSubs, ...desiredSubs.values()]));
  }

  /**
   * Unregister subscriptions for a specific task-owned node execution.
   * Called when a node execution transitions to `cancelled` state.
   * Includes taskId so cancelling one task's node does not remove another
   * task's subscriptions when both tasks share the same workflowRunId/node/agent.
   *
   * Only `cancelled` nodes are removed from the subscription index.
   * All other states (`pending`, `in_progress`, `idle`, `waiting_rebind`,
   * `blocked`) remain subscribed because:
   * - `in_progress`: live session receives events immediately
   * - `idle`: session exists and can be woken via injectMessage (defer mode)
   * - `waiting_rebind`/`blocked`/`pending`: events queued for later delivery
   *
   * See `isReceivingStatus` helper for the complete state classification.
   */
  unregisterExecution(
    workflowRunId: string,
    taskId: string,
    nodeId: string,
    agentName: string,
  ): void {
    const runSubs = this.activeRuns.get(workflowRunId);
    if (!runSubs) return;

    const toRemove = [...runSubs].filter(
      s => s.taskId === taskId && s.nodeId === nodeId && s.agentName === agentName,
    );
    for (const sub of toRemove) {
      runSubs.delete(sub);
      this.topicTrie.remove(
        v => v.workflowRunId === workflowRunId
          && v.taskId === taskId
          && v.agentName === agentName
          && v.nodeId === nodeId,
      );
    }

    // Node cancellation is terminal for this node's already-registered deliveries
    // even if the workflow run continues. Fail queued/retrying rows immediately so
    // they do not block event terminalization until full run teardown.
    this.failPendingStateForExecution(workflowRunId, taskId, nodeId, agentName, 'node_execution_cancelled');
  }

  private failPendingStateForExecution(
    workflowRunId: string,
    taskId: string,
    nodeId: string,
    agentName: string,
    reason: QueuedDeliveryFailure['reason'],
  ): void {
    const queueKey = JSON.stringify([workflowRunId, taskId, nodeId, agentName]);
    const queuedFailures: QueuedDeliveryFailure[] = [];
    const queue = this.pendingQueue.get(queueKey) ?? [];
    for (const pending of queue) {
      queuedFailures.push({ eventId: pending.event.id, deliveryKey: pending.deliveryKey, reason });
    }
    this.pendingQueue.delete(queueKey);
    this.markQueuedDeliveriesFailed(queuedFailures);

    for (const key of this.pendingDeliveries.keys()) {
      const parsed = this.parseDeliveryKey(key);
      if (
        parsed.workflowRunId === workflowRunId
        && parsed.taskId === taskId
        && parsed.nodeId === nodeId
        && parsed.agentName === agentName
      ) {
        this.pendingDeliveries.delete(key);
      }
    }

    for (const key of this.retryCounts.keys()) {
      const parsed = this.parseDeliveryKey(key);
      if (
        parsed.workflowRunId === workflowRunId
        && parsed.taskId === taskId
        && parsed.nodeId === nodeId
        && parsed.agentName === agentName
      ) {
        this.retryCounts.delete(key);
      }
    }

    const retryFailures: QueuedDeliveryFailure[] = [];
    for (const [key, timer] of this.retryTimers.entries()) {
      const parsed = this.parseDeliveryKey(key);
      if (
        parsed.workflowRunId === workflowRunId
        && parsed.taskId === taskId
        && parsed.nodeId === nodeId
        && parsed.agentName === agentName
      ) {
        clearTimeout(timer);
        this.retryTimers.delete(key);
        retryFailures.push({
          eventId: this.config.eventStore.getEventIdForDeliveryKey(key),
          deliveryKey: key,
          reason,
        });
      }
    }
    this.markQueuedDeliveriesFailed(retryFailures);
  }

  /**
   * Clear all subscriptions for a workflow run.
   * Called when the workflow run reaches a truly terminal state (done or cancelled).
   *
   * NOT called for `blocked` runs because blocked is resumable — the run may be
   * reopened (see WorkflowRunReopenedEvent) and its node subscriptions should
   * remain active so queued/arriving events can be delivered upon resume.
   */
  clearRunInterests(workflowRunId: string): void {
    // Always run cleanup, even if activeRuns no longer has this run, so retry
    // timers/pending state cannot survive a terminal transition.
    this.topicTrie.remove(v => v.workflowRunId === workflowRunId);
    this.activeRuns.delete(workflowRunId);

    // Also clean up dedup entries for this run. Keys are JSON tuples, so parse
    // structurally rather than suffix-matching delimiter-joined strings.
    for (const key of this.delivered.keys()) {
      const parsed = this.parseDeliveryKey(key);
      if (parsed.workflowRunId === workflowRunId) {
        this.delivered.delete(key);
      }
    }

    // Clean up in-memory pending queue for this terminal run. Queued deliveries
    // were already registered in ExternalEventStore, so dropping the in-memory
    // queue must also mark each queued delivery terminally failed; otherwise the
    // source event can never reach a terminal all-deliveries state.
    const terminalQueueFailures: QueuedDeliveryFailure[] = [];
    for (const [key, queue] of this.pendingQueue.entries()) {
      const [keyWorkflowRunId] = JSON.parse(key) as [string, string, string, string];
      if (keyWorkflowRunId === workflowRunId) {
        for (const pending of queue) {
          terminalQueueFailures.push({
            eventId: pending.event.id,
            deliveryKey: pending.deliveryKey,
            reason: 'run_terminal_cleanup',
          });
        }
        this.pendingQueue.delete(key);
      }
    }
    this.markQueuedDeliveriesFailed(terminalQueueFailures);

    // Clean up pending deliveries and retry counts for this run.
    // Delivery keys are JSON tuples:
    // [source, dedupeKey, taskId, nodeId, agentName, workflowRunId]. Always parse
    // through parseDeliveryKey so cleanup stays aligned with makeDeliveryKey.
    for (const key of this.pendingDeliveries.keys()) {
      const parsed = this.parseDeliveryKey(key);
      if (parsed.workflowRunId === workflowRunId) {
        this.pendingDeliveries.delete(key);
      }
    }
    for (const key of this.retryCounts.keys()) {
      const parsed = this.parseDeliveryKey(key);
      if (parsed.workflowRunId === workflowRunId) {
        this.retryCounts.delete(key);
      }
    }
    // Cancel per-delivery retry timers for this terminal run. These deliveries
    // were already registered, so cancellation must terminally fail them before
    // deleting retry bookkeeping; otherwise their rows can block event terminalization.
    const retryCancellationFailures: QueuedDeliveryFailure[] = [];
    for (const [key, timer] of this.retryTimers.entries()) {
      const parsed = this.parseDeliveryKey(key);
      if (parsed.workflowRunId === workflowRunId) {
        clearTimeout(timer);
        this.retryTimers.delete(key);
        retryCancellationFailures.push({
          eventId: this.config.eventStore.getEventIdForDeliveryKey(key),
          deliveryKey: key,
          reason: 'run_terminal_retry_cancelled',
        });
      }
    }
    this.markQueuedDeliveriesFailed(retryCancellationFailures);

    // Event-level preparation retries may cover multiple runs. If a retry includes
    // both this terminal run and still-active runs, cancel the old shared timer and
    // reschedule retry state for surviving runs instead of dropping their retry path.
    for (const [key, timer] of this.eventRetryTimers.entries()) {
      const [eventId, keyWorkflowRunIds] = JSON.parse(key) as [string, string[], 'prepare'];
      if (!keyWorkflowRunIds.includes(workflowRunId)) continue;

      const remainingRunIds = keyWorkflowRunIds.filter(runId => runId !== workflowRunId);
      if (remainingRunIds.length === 0) {
        clearTimeout(timer);
        this.eventRetryTimers.delete(key);
        this.eventRetryCounts.delete(key);
        this.eventRetryState.delete(key);
        continue;
      }

      const retryState = this.eventRetryState.get(key);
      const retryCount = this.eventRetryCounts.get(key) ?? 0;
      clearTimeout(timer);
      this.eventRetryTimers.delete(key);
      this.eventRetryCounts.delete(key);
      this.eventRetryState.delete(key);

      if (retryState) {
        const remainingMatched = retryState.matched.filter(sub => sub.workflowRunId !== workflowRunId);
        if (remainingMatched.length > 0) {
          this.scheduleEventRetry(retryState.event, remainingMatched, { retryCountOverride: retryCount });
        }
      }
    }
  }

  private async handleEvent(event: ExternalEvent): Promise<void> {
    // 1. Look up matching subscriptions via trie
    const matched = this.topicTrie.lookup(event.topic);
    await this.handleEventForSubscriptions(event, matched);
  }

  private async handleEventForSubscriptions(event: ExternalEvent, matched: Subscription[]): Promise<boolean> {
    if (matched.length === 0) {
      this.config.eventStore.markEventIgnored(event.id, 'no_matching_subscriptions');
      return true;
    }

    // 2. First compute all scoped deliveries and persist them as expected
    // pending deliveries before attempting injection. This prevents the first
    // successful subscription from marking the source event terminal while other
    // matched subscriptions have not yet been attempted.
    const eligible: Subscription[] = [];
    let preparationFailed = false;
    for (const sub of matched) {
      const deliveryKey = this.makeDeliveryKey(event, sub);
      try {
        if (!this.passesScopeCheck(event, sub)) continue;
        this.config.eventStore.registerExpectedDelivery(event.id, deliveryKey, {
          workflowRunId: sub.workflowRunId,
          taskId: sub.taskId,
          nodeId: sub.nodeId,
          agentName: sub.agentName,
        });
        if (this.config.eventStore.isDeliveryTerminal(event.id, deliveryKey)) continue;
        eligible.push(sub);
      } catch (err) {
        preparationFailed = true;
        log.warn('ExternalEventRouter: failed to prepare external event delivery; scheduling retry', {
          error: err,
          spaceId: event.spaceId,
          topic: event.topic,
          eventId: event.id,
          workflowRunId: sub.workflowRunId,
          taskId: sub.taskId,
          nodeId: sub.nodeId,
          agentName: sub.agentName,
        });
        // Do not clear pendingDeliveries here: preparation does not acquire that
        // guard. The same delivery may already be pending from an earlier queue or
        // retry pass, and dropping the guard would allow duplicate queue/injection.
      }
    }

    if (preparationFailed) {
      this.scheduleEventRetry(event, matched);
    }

    // If any matched subscription failed during scope/registration preparation,
    // do not partially deliver this event in the same pass. Otherwise the prepared
    // subscriptions could all succeed and mark the source event terminal while the
    // failed subscription was never registered. The retry path will re-run matching,
    // scope checks, and expected-delivery registration for the whole event.
    if (preparationFailed) return false;

    // No prepared, non-terminal delivery remains for this event. Mark the source
    // event terminal so retryable source duplicates (webhook + polling, extension
    // retries, etc.) do not re-emit and re-route indefinitely when every matched
    // subscription is out of scope or already terminal.
    if (eligible.length === 0) {
      this.config.eventStore.markEventIgnored(event.id, 'no_scope_eligible_subscriptions');
      return true;
    }

    // 3. Deliver each prepared subscription. Isolate injection failures per
    // subscription after the complete expected-delivery set has been registered.
    for (const sub of eligible) {
      try {
        await this.deliverToSubscription(event, sub);
      } catch (err) {
        log.warn('ExternalEventRouter: failed to deliver external event to subscription', {
          error: err,
          spaceId: event.spaceId,
          topic: event.topic,
          eventId: event.id,
          workflowRunId: sub.workflowRunId,
          taskId: sub.taskId,
          nodeId: sub.nodeId,
          agentName: sub.agentName,
        });
      }
    }

    return true;
  }

  private async deliverToSubscription(event: ExternalEvent, sub: Subscription): Promise<void> {
    // Scope was checked and registered in handleEvent before this method is called.

    // Dedup check — include taskId and nodeId to handle multi-task runs and
    // cases where the same agent name appears in multiple nodes within the same
    // run. Each task/node/agent subscription is deduped independently.
    // Evict before checking so DEDUP_TTL_MS is actually enforced during long runs.
    this.evictStaleDedup();
    const dedupeKey = this.makeDeliveryKey(event, sub);
    if (this.delivered.has(dedupeKey)) return;

    // Check if pending (prevents duplicate queueing while allowing retries on failure)
    if (this.pendingDeliveries.has(dedupeKey)) return;

    // Mark as pending to prevent duplicate queueing. We do NOT mark as delivered
    // until after successful injection. Failed injection/session-resolution paths
    // remove pendingDeliveries and schedule retry rather than relying on a source
    // extension to publish the same event again.
    this.pendingDeliveries.add(dedupeKey);

    try {
      // Resolve session — re-read from nodeExecutionRepo for latest state
      const sessionId = await this.resolveSession(sub);
      if (!sessionId) {
        // Session not active — queue for later delivery. Pending remains until
        // the queue is drained or the entry is evicted.
        this.queueForDelivery(event, sub, dedupeKey);
        return;
      }

      try {
        await this.injectPreparedDelivery(event, sub, dedupeKey, sessionId);
      } catch (err) {
        log.warn(`Failed to deliver event to ${sub.agentName}`, { error: err });

        // Failure: remove pending so it can be retried
        this.pendingDeliveries.delete(dedupeKey);

        // Schedule retry with backoff if we haven't exceeded max retries
        this.scheduleRetry(event, sub, dedupeKey);
      }
    } catch (err) {
      // Session resolution failed (transient DB/repo error) — clear pending
      // and schedule retry so transient failures do not permanently drop delivery.
      log.warn(`Session resolution failed for ${sub.agentName}`, { error: err });
      this.pendingDeliveries.delete(dedupeKey);
      this.scheduleRetry(event, sub, dedupeKey);
    }
  }

  private async injectPreparedDelivery(
    event: ExternalEvent,
    sub: Subscription,
    dedupeKey: string,
    sessionId: string,
  ): Promise<void> {
    // Format and request injection through the command boundary.
    // The command handler owns authorization, validation, telemetry, standardized
    // failure mapping, and the concrete sessionFactory.injectMessage(...) call.
    const message = this.formatEventMessage(event);
    const result = await this.config.commandBus.dispatch('agent.message.inject', {
      sessionId,
      message,
      deliveryMode: 'defer',
      origin: 'system',
      metadata: {
        source: 'externalEvent',
        eventId: event.id,
        deliveryKey: dedupeKey,
        workflowRunId: sub.workflowRunId,
        taskId: sub.taskId,
        nodeId: sub.nodeId,
        agentName: sub.agentName,
      },
    });
    if (!result.ok) {
      throw result.error ?? new Error('agent.message.inject command failed');
    }

    // Success: persist durable delivery state first, then mark the in-memory
    // dedup cache. If persistence throws after successful command dispatch, the
    // retry path must not be short-circuited by an in-memory delivered marker.
    // The source event advances to terminal delivered only when every expected
    // per-subscription delivery succeeded. Terminal failures must keep the source
    // event in a failed outcome rather than being masked by later successes.
    this.config.eventStore.markDeliveryDelivered(event.id, dedupeKey);
    this.config.eventStore.markEventFailedIfAnyDeliveryTerminalFailed(event.id);
    this.config.eventStore.markEventDeliveredIfAllDeliveriesDelivered(event.id);
    this.delivered.set(dedupeKey, Date.now());
    this.pendingDeliveries.delete(dedupeKey);
  }

  private queueForDelivery(event: ExternalEvent, sub: Subscription, deliveryKey: string): void {
    const key = this.makePendingQueueKey(sub);
    const queue = this.pendingQueue.get(key) ?? [];
    queue.push({ event, deliveryKey });
    if (queue.length > 50) {
      const dropped = queue.shift();
      if (dropped) {
        this.pendingDeliveries.delete(dropped.deliveryKey);
        this.markQueuedDeliveryFailed(dropped.event.id, dropped.deliveryKey, 'pending_queue_overflow');
      }
      log.warn('ExternalEventRouter: pending external event queue exceeded limit; dropped oldest event', {
        workflowRunId: sub.workflowRunId,
        taskId: sub.taskId,
        nodeId: sub.nodeId,
        agentName: sub.agentName,
      });
    }
    this.pendingQueue.set(key, queue);
  }

  private markQueuedDeliveryFailed(
    eventId: string,
    deliveryKey: string,
    reason: QueuedDeliveryFailure['reason'],
  ): void {
    this.config.eventStore.markDeliveryFailed(eventId, deliveryKey, { terminal: true, reason });
    this.config.eventStore.markEventFailedIfAllDeliveriesTerminal(eventId);
  }

  private markQueuedDeliveriesFailed(failures: QueuedDeliveryFailure[]): void {
    for (const failure of failures) {
      this.pendingDeliveries.delete(failure.deliveryKey);
      this.markQueuedDeliveryFailed(failure.eventId, failure.deliveryKey, failure.reason);
    }
  }

  /**
   * Drain queued events for a subscription when the node's session is created.
   * Clears pendingDeliveries markers before reinjection so a failed flush can be
   * retried or re-queued instead of being permanently blocked by stale pending keys.
   */
  drainQueueForSession(sub: Subscription): PendingDelivery[] {
    const key = this.makePendingQueueKey(sub);
    const queue = this.pendingQueue.get(key) ?? [];
    this.pendingQueue.delete(key);

    // Clear pendingDeliveries for ALL drained events because queueForDelivery keeps
    // each delivery key marked pending while the node has no session. Use the queued
    // wrapper's stored deliveryKey instead of recomputing from the wrapper object.
    for (const pending of queue) {
      this.pendingDeliveries.delete(pending.deliveryKey);
    }

    return queue;
  }

  /**
   * Called by TaskAgentManager immediately after it creates/binds a node session.
   * Flushes pending-node events through the same injection path as live delivery,
   * preserving delivery state, retry, and terminal event advancement semantics.
   */
  async flushQueuedDeliveriesForSession(sub: Subscription, sessionId: string): Promise<void> {
    const queued = this.drainQueueForSession(sub);
    for (const pending of queued) {
      try {
        await this.injectPreparedDelivery(pending.event, sub, pending.deliveryKey, sessionId);
      } catch (err) {
        log.warn('ExternalEventRouter: failed to flush queued external event delivery', {
          error: err,
          eventId: pending.event.id,
          workflowRunId: sub.workflowRunId,
          taskId: sub.taskId,
          nodeId: sub.nodeId,
          agentName: sub.agentName,
        });
        this.pendingDeliveries.delete(pending.deliveryKey);
        this.scheduleRetry(pending.event, sub, pending.deliveryKey);
      }
    }
  }

  private async passesScopeCheck(event: ExternalEvent, sub: Subscription): Promise<boolean> {
    // All scopes are bounded to the subscription's space. ExternalEventRouter handles a shared
    // daemon-wide stream, so even `global` means "global within this space", not
    // cross-space delivery.
    if (event.spaceId !== sub.spaceId) return false;

    switch (sub.interest.scope) {
      case 'global':
        return true;

      case 'repo': {
        // Check if event's repo matches any watched repo in this space.
        // The event payload contains repoOwner/repoName; extract them for matching.
        const repoOwner = event.payload.repoOwner as string | undefined;
        const repoName = event.payload.repoName as string | undefined;
        if (!repoOwner || !repoName) return false;
        return this.isWatchedRepo(sub.spaceId, repoOwner, repoName);
      }

    }
  }

  private makeEventRetryKey(event: ExternalEvent, matched: Subscription[]): string {
    return JSON.stringify([
      event.id,
      [...new Set(matched.map((sub) => sub.workflowRunId))].sort(),
      'prepare',
    ]);
  }

  /**
   * Schedule an event-level retry for failures before expected delivery rows exist
   * (for example transient watched-repo lookup or delivery-row insert failures).
   * This reruns full matching/preparation instead of allowing partial delivery to
   * mark the source event terminal while an unregistered subscription missed it.
   * handleEventForSubscriptions returns false when preparation failed and another
   * retry was scheduled. If the retry key is unchanged, the count/state is preserved
   * so persistent preparation failures continue toward MAX_RETRIES. If current
   * matching changed the retry key, the old key is cleared before returning because
   * the newly scheduled retry owns the updated state.
   */
  private scheduleEventRetry(
    event: ExternalEvent,
    matched: Subscription[],
    options: { retryCountOverride?: number } = {},
  ): void {
    const retryKey = this.makeEventRetryKey(event, matched);
    const retries = options.retryCountOverride ?? ((this.eventRetryCounts.get(retryKey) ?? 0) + 1);
    if (retries > ExternalEventRouter.MAX_RETRIES) {
      log.warn('ExternalEventRouter: max preparation retries exceeded; marking event failed', {
        eventId: event.id,
        topic: event.topic,
      });
      this.eventRetryCounts.delete(retryKey);
      const existingTimer = this.eventRetryTimers.get(retryKey);
      if (existingTimer) clearTimeout(existingTimer);
      this.eventRetryTimers.delete(retryKey);
      this.eventRetryState.delete(retryKey);
      this.config.eventStore.markEventFailed(event.id, {
        terminal: true,
        reason: 'delivery_preparation_failed',
      });
      return;
    }

    this.eventRetryCounts.set(retryKey, retries);
    this.eventRetryState.set(retryKey, { event, matched });
    const backoff = ExternalEventRouter.RETRY_BACKOFF_MS * Math.pow(2, retries - 1);
    const existingTimer = this.eventRetryTimers.get(retryKey);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      this.eventRetryTimers.delete(retryKey);
      const retryState = this.eventRetryState.get(retryKey) ?? { event, matched };
      // Recompute against the current trie/active subscription set at retry time.
      // The originally matched subscriptions may have been removed or changed by
      // unregisterExecution(), clearRunInterests(), or a tick diff refresh while the
      // timer was waiting. Reusing them would recreate queue/retry state for nodes
      // that are no longer subscribed and could register delivery rows that should
      // not exist.
      const currentMatched = this.topicTrie.lookup(retryState.event.topic);
      void this.handleEventForSubscriptions(retryState.event, currentMatched)
        .then((prepared) => {
          if (!prepared) {
            // handleEventForSubscriptions scheduled the next preparation retry.
            // If matching changed while this timer was waiting, that retry is now
            // stored under a different key. Clear this superseded key so stale
            // counts/state do not leak or later exhaust a reappearing key early.
            const nextRetryKey = this.makeEventRetryKey(retryState.event, currentMatched);
            if (nextRetryKey !== retryKey) {
              this.eventRetryCounts.delete(retryKey);
              this.eventRetryState.delete(retryKey);
            }
            return;
          }

          // A prepared retry pass either registered the complete expected-delivery
          // set for the still-active matched subscriptions or found no matching
          // work left. Clear event-level retry state so a later independent
          // transient error gets a full budget and this map does not leak state.
          this.eventRetryCounts.delete(retryKey);
          this.eventRetryState.delete(retryKey);
        })
        .catch((err) => {
          // Keep count/state on failure so the next scheduled retry continues the
          // same preparation-failure budget instead of starting over.
          log.warn('ExternalEventRouter: event preparation retry failed', { error: err, eventId: event.id });
        });
    }, backoff);
    this.eventRetryTimers.set(retryKey, timer);
  }

  /**
   * Schedule a retry for failed delivery with exponential backoff.
   * Retries are bounded by MAX_RETRIES; after that, the delivery is marked failed.
   */
  private scheduleRetry(event: ExternalEvent, sub: Subscription, deliveryKey: string): void {
    const retries = (this.retryCounts.get(deliveryKey) ?? 0) + 1;
    if (retries > ExternalEventRouter.MAX_RETRIES) {
      log.warn(`Max retries exceeded for event ${deliveryKey}, marking delivery failed`);
      this.retryCounts.delete(deliveryKey);
      const existingTimer = this.retryTimers.get(deliveryKey);
      if (existingTimer) clearTimeout(existingTimer);
      this.retryTimers.delete(deliveryKey);
      this.pendingDeliveries.delete(deliveryKey);

      // Persist terminal failure so source-level dedup stops re-emitting this
      // delivery after restart or future polling of the same upstream event.
      this.config.eventStore.markDeliveryFailed(event.id, deliveryKey, {
        terminal: true,
        reason: 'max_retries_exceeded',
      });
      this.config.eventStore.markEventFailedIfAllDeliveriesTerminal(event.id);
      return;
    }

    this.retryCounts.set(deliveryKey, retries);
    const backoff = ExternalEventRouter.RETRY_BACKOFF_MS * Math.pow(2, retries - 1);

    const existingTimer = this.retryTimers.get(deliveryKey);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      this.retryTimers.delete(deliveryKey);

      // Re-check if delivered while waiting (another delivery might have succeeded)
      if (this.delivered.has(deliveryKey) || this.config.eventStore.isDeliveryTerminal(event.id, deliveryKey)) {
        this.retryCounts.delete(deliveryKey);
        return;
      }

      // Do not retry after the run/subscription has been torn down.
      const runSubs = this.activeRuns.get(sub.workflowRunId);
      const stillActive = runSubs && [...runSubs].some((active) =>
        active.taskId === sub.taskId
          && active.nodeId === sub.nodeId
          && active.agentName === sub.agentName
          && active.interest.topic === sub.interest.topic
          && active.interest.scope === sub.interest.scope,
      );
      if (!stillActive) {
        this.retryCounts.delete(deliveryKey);
        this.pendingDeliveries.delete(deliveryKey);
        this.config.eventStore.markDeliveryFailed(event.id, deliveryKey, {
          terminal: true,
          reason: 'subscription_inactive_retry_skipped',
        });
        this.config.eventStore.markEventFailedIfAllDeliveriesTerminal(event.id);
        return;
      }

      // Use .catch to prevent unhandled promise rejections in retry path.
      this.deliverToSubscription(event, sub)
        .then(() => {
          // deliverToSubscription catches injection failures and may schedule a
          // follow-up retry, so only clear retry state if delivery is now marked.
          if (this.delivered.has(deliveryKey) || this.config.eventStore.isDeliveryTerminal(event.id, deliveryKey)) {
            this.retryCounts.delete(deliveryKey);
            this.pendingDeliveries.delete(deliveryKey);
          }
        })
        .catch((err) => {
          // Don't clear retryCounts on failure — preserve count for retry logic.
          log.warn('ExternalEventRouter: retry delivery failed', {
            error: err,
            retries,
            deliveryKey,
            workflowRunId: sub.workflowRunId,
          });
        });
    }, backoff);

    this.retryTimers.set(deliveryKey, timer);
  }
}
```

## 5. Event Delivery Lifecycle

### State machine per event delivery

```
Event arrives → Match subscriptions → Scope check → Dedup check → Session check
                                                                         │
                                                              ┌──────────┼──────────────┐
                                                              ▼              ▼              ▼
                                                        Session live   Session idle   No session
                                                              │              │              │
                                                              ▼              ▼              ▼
                                                        Inject via      Wake + inject  Queue in
                                                        injectMessage   injectMessage  pending_events
                                                              │              │              │
                                                              ▼              ▼              ▼
                                                        Mark delivered  Mark delivered  Mark queued
                                                                                         delivered
                                                                                         after flush
```

### Deduplication

Dedup happens at two different layers, each with a different key and responsibility:

1. **Source-level bus dedup** — persistent `(spaceId, source, dedupeKey)` in `ExternalEventStore`.
   - Purpose: prevent webhook/polling duplicates from becoming separate bus events.
   - Terminal duplicates (`delivered`, `failed`, `ignored`) are short-circuited.
   - Retryable duplicates (`published`) are re-emitted so transient delivery failures can retry.
   - This replaces `SpaceGitHubService.storeEvent()` as the authoritative dedup path for new external-event delivery.

2. **Per-subscription delivery dedup** — JSON tuple `[event.source, event.dedupeKey, subscription.taskId, subscription.nodeId, subscription.agentName, subscription.workflowRunId]`.
   - Purpose: prevent the same external event from being delivered twice to the same node agent within a run.
   - The tuple includes `event.source` because source-level dedupe is scoped by `(spaceId, source, dedupeKey)`: two extensions can legitimately emit the same `dedupeKey` in one space and must not share pending/delivered/retry bookkeeping.
   - The tuple includes `taskId` to isolate multi-task runs and `nodeId` to handle cases where the same agent name appears in multiple nodes within the same run.
   - The tuple is encoded structurally rather than delimiter-joined because `source`, `dedupeKey`, workflow identifiers, node IDs, and agent names are free-form strings.
   - It is tracked in-memory for fast duplicate suppression and persisted in `space_external_event_deliveries` after successful injection.

The ExternalEventRouter marks per-subscription delivery as `delivered` only after successful injection, updates `ExternalEventStore` with the successful delivery key, and advances the source event to terminal `delivered` only once all expected deliveries are `delivered`. Failed injection/session-resolution paths remove `pendingDeliveries` and schedule retry rather than relying on extensions to re-publish the same event. If a delivery reaches terminal `failed`, the source event must be `failed` rather than later reclassified as `delivered` by another subscription's success. If trie lookup finds no matching subscriptions, or if all matched subscriptions are out of scope/already terminal and no preparation retry is pending, the router marks the source event terminal `ignored` so webhook+polling duplicates do not churn through routing forever.

### Wake-on-idle

When an event matches a subscription whose node execution is `idle` (agent session exists but finished its turn):

1. Dispatch `InternalCommandBus.dispatch('agent.message.inject', { sessionId, message, deliveryMode: 'defer', ... })`.
2. The command handler uses the existing defer mechanism under the hood: if idle → enqueue immediately; if busy → persist as deferred, replay after current turn.
3. No new wake mechanism needed — the existing deferred injection path already solves this, but the router stays behind the command boundary.

### Node cancellation cleanup

When a node execution transitions to `cancelled`, runtime status-transition wiring must call `unregisterExecution(workflowRunId, taskId, nodeId, agentName)` immediately; the next tick's diff refresh is not enough because cancellation has terminal side effects for queued/retrying deliveries. `unregisterExecution(...)` removes that node's subscriptions from `activeRuns` and the topic trie. Because expected delivery rows may already exist for queued or retrying deliveries owned by that node, cancellation must also call `failPendingStateForExecution(...)`:

1. Remove queued pending-node deliveries for the exact `[workflowRunId, taskId, nodeId, agentName]` key and mark them terminally failed with reason `node_execution_cancelled`.
2. Cancel per-delivery retry timers for the same tuple, look up each event id from the delivery store, and mark them terminally failed with reason `node_execution_cancelled`.
3. Clear matching `pendingDeliveries` and retry counts.
4. Call `markEventFailedIfAllDeliveriesTerminal(eventId)` for each failure so long-running runs do not keep source events retryable until full run teardown.

If a retry timer fires after its subscription has already been removed by another path, the inactive-subscription branch must also mark that delivery terminally failed with reason `subscription_inactive_retry_skipped` before returning.

### Terminal run cleanup

When a workflow run transitions to `done` or `cancelled`, `clearRunInterests(workflowRunId)` removes subscriptions, retry timers, and in-memory pending queues. Any queued delivery or backoff retry removed during this terminal cleanup was already registered in `space_external_event_deliveries`, so cleanup must mark it terminally failed before deleting the in-memory state:

1. Collect each queued `{ eventId, deliveryKey }` for the terminal run and fail it with reason `run_terminal_cleanup`.
2. Collect each per-delivery retry timer for the terminal run, look up its source event id from the delivery store, and fail it with reason `run_terminal_retry_cancelled`.
3. For each failure, call `markDeliveryFailed(eventId, deliveryKey, { terminal: true, reason })` and then `markEventFailedIfAllDeliveriesTerminal(eventId)` so the source event can advance once all remaining deliveries are terminal.
4. Only then delete the in-memory queue, pending markers, retry counts, and timers.
5. Event-level preparation retries can span multiple workflow runs. If one run terminates while others remain active, cancel the old shared timer and reschedule a retry for the surviving matched subscriptions with the existing retry count. Cancel without rescheduling only when no matched runs remain.

This keeps run teardown from leaving non-terminal delivery rows for nodes that can no longer be started while preserving retry paths for still-active runs. When an event-level preparation retry timer actually fires, it must re-run `topicTrie.lookup(event.topic)` and prepare only the current active subscriptions rather than reusing the stale list captured when the timer was scheduled. This prevents canceled or diff-removed nodes from being reintroduced by retry.

### Queue for not-yet-started nodes

When a node execution is `pending` (no session yet):

1. The event is queued in an in-memory `Map<string, ExternalEvent[]>` keyed by a JSON tuple `[workflowRunId, taskId, nodeId, agentName]` so free-form identifiers cannot collide by containing delimiter characters.
2. When `TaskAgentManager` creates the node's session, it calls `eventRouter.flushQueuedDeliveriesForSession(sub, sessionId)`.
3. Queued events are injected through the same prepared-delivery path as live events, so successful flush marks the per-subscription delivery delivered and advances the source event only when all expected deliveries are delivered.
4. If flush injection fails, the router clears the stale pending marker and schedules a normal delivery retry so the queued event is not silently lost.
5. Queue is bounded: max 50 events per execution, oldest dropped (with a warning log). Because expected delivery rows are registered before queueing, overflow eviction must call `markDeliveryFailed(..., { terminal: true, reason: 'pending_queue_overflow' })` and then `markEventFailedIfAllDeliveriesTerminal(event.id)`; otherwise the evicted delivery row can block event terminalization forever.

**Known limitation — daemon restart**: The in-memory per-node pending queue is lost on daemon restart. For v1, this is accepted as a known delivery gap:
- The bus-level `ExternalEventStore` preserves the source event and can re-emit retryable states, but the per-node in-memory queue itself is not durable.
- Events queued for `pending` nodes before restart may need explicit replay from the event store once persistent delivery queues are implemented.
- New events (arriving after restart) flow through the bus normally and are not affected.

If persistent queuing is needed in a future iteration, events can be persisted to a `space_event_delivery_queue` SQLite table with the same schema as the in-memory map, and drained on node activation. The table should store the `ExternalEvent.id` plus the subscription key so queued delivery can replay from `ExternalEventStore` without relying on source extensions to re-publish.

### Backpressure

- **Rate limiting**: If a single node receives > 10 events per minute, subsequent events are coalesced into a digest message: "N additional events received in the last minute. Summary: ..."
- **Event TTL**: Events older than 5 minutes are dropped from the queue (they're likely stale for an agent's decision-making).
- **Router/handler overflow**: `ExternalEventService.publish(...)` uses `InternalEventBus.publish('externalEvent.published', ...)`. In v1, use the awaited `publish(...)` path for observability; if later throughput requires fire-and-forget behavior, use explicit `publishAsync(...)` and ensure handler failures are logged with event/subscriber context.

## 6. Topic Trie Implementation

```typescript
/**
 * Simple trie for topic-pattern matching.
 * Supports * (single segment wildcard) at any position.
 */
class TopicTrie<T> {
  private root = new TrieNode<T>();

  /**
   * Insert a value at a glob pattern.
   * Pattern segments may contain segment-local `*` wildcards, e.g.
   * `github/*/*/pull_request.*` or `github/*/*/pull_request.review_*`.
   */
  insert(pattern: string, value: T): void {
    const segments = pattern.split('/');
    let node = this.root;
    for (const segment of segments) {
      const key = segment.toLowerCase();
      const children = key.includes('*') ? node.globChildren : node.exactChildren;
      if (!children.has(key)) {
        children.set(key, new TrieNode());
      }
      node = children.get(key)!;
    }
    if (!node.values) node.values = [];
    node.values.push(value);
  }

  /**
   * Lookup all values whose patterns match the given topic.
   * Returns all values from exact matches AND wildcard matches at each level.
   * Walks at most 2^k paths where k = topic segment count (bounded, small).
   * Only collects subscriptions from matching leaves — non-matching patterns
   * are never visited.
   */
  lookup(topic: string): T[] {
    const segments = topic.split('/');
    const results: T[] = [];

    const walk = (node: TrieNode<T>, depth: number) => {
      if (depth === segments.length) {
        // Terminal node — collect values
        if (node.values) results.push(...node.values);
        return;
      }

      const segment = segments[depth].toLowerCase();

      // Exact branch: O(1)
      const exact = node.exactChildren.get(segment);
      if (exact) walk(exact, depth + 1);

      // Glob branches: only patterns that contain segment-local '*'
      for (const [patternSegment, child] of node.globChildren.entries()) {
        if (segmentMatches(patternSegment, segment)) {
          walk(child, depth + 1);
        }
      }
    };

    walk(this.root, 0);
    return results;
  }

  /**
   * Remove all values matching a predicate and prune empty child branches.
   */
  remove(predicate: (value: T) => boolean): void {
    const clean = (node: TrieNode<T>): boolean => {
      if (node.values) {
        node.values = node.values.filter(v => !predicate(v));
        if (node.values.length === 0) node.values = undefined;
      }

      for (const [segment, child] of node.exactChildren.entries()) {
        if (clean(child)) {
          node.exactChildren.delete(segment);
        }
      }
      for (const [segment, child] of node.globChildren.entries()) {
        if (clean(child)) {
          node.globChildren.delete(segment);
        }
      }

      return !node.values && node.exactChildren.size === 0 && node.globChildren.size === 0;
    };

    clean(this.root);
  }
}

function segmentMatches(pattern: string, segment: string): boolean {
  if (pattern === segment) return true;
  if (!pattern.includes('*')) return false;

  // Segment-local glob: '*' matches any characters except '/'. Because callers
  // split on '/', the segment input never contains '/'. Escape other regex chars.
  const regex = new RegExp(
    '^' + pattern.split('*').map(escapeRegex).join('[^/]*') + '$',
    'i',
  );
  return regex.test(segment);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

class TrieNode<T> {
  exactChildren: Map<string, TrieNode<T>> = new Map();
  globChildren: Map<string, TrieNode<T>> = new Map();
  values?: T[];
}
```

### Helper: `isReceivingStatus`

Determines whether a node execution should remain in the subscription index.
This is intentionally different from `TERMINAL_NODE_EXECUTION_STATUSES` in
`node-execution-manager.ts`, which includes `idle`. For the event bus, `idle`
nodes MUST stay subscribed because:

1. The agent session still exists and can be woken via `injectMessage`.
2. The `deliveryMode: 'defer'` mechanism handles idle sessions natively.
3. Removing idle nodes from the subscription index would prevent wake-on-idle
   delivery — the core use case for the event bus.

```typescript
import type { NodeExecutionStatus } from '@neokai/shared';

/**
 * States where the node should be excluded from the subscription index.
 * Only `cancelled` is excluded — the node has been permanently stopped.
 *
 * States that remain subscribed:
 * - `pending`       — no session yet, events queued for first turn
 * - `in_progress`   — live session, events injected immediately
 * - `idle`          — session exists but finished a turn; events wake it
 * - `waiting_rebind` — session paused for tool recovery; events queued
 * - `blocked`       — session exists but waiting for human; events queued
 */
const NON_RECEIVING_STATES: ReadonlySet<NodeExecutionStatus> = new Set([
  'cancelled',
]);

function isReceivingStatus(status: NodeExecutionStatus): boolean {
  return !NON_RECEIVING_STATES.has(status);
}
```

**Complexity**:
- Insert: O(k) where k = segment count (~4-5)
- Lookup: Effectively O(2^k × m) in the common case — walks exact + matching glob branches at each level, collects m total matching subscriptions from leaves. Since k is bounded (4–5) and per-agent interest count is capped, glob branching stays small.
- Memory: O(n × k) where n = number of subscriptions

## 7. Wiring the GitHub Extension

### Target architecture

The GitHub integration is extracted into a first-class event extension. It no longer depends on `SpaceGitHubService.ingest()`, `space.githubEvent.routed`, or Task Agent notification delivery.

```text
GitHub webhook / polling
    → GitHubEventExtension
        → check global + per-space enablement
        → verify signature / fetch API pages
        → normalize raw GitHub payload
        → construct topic + dedupeKey
        → ExternalEventService.publish(ExternalEvent)
            → ExternalEventStore.store() + retry-aware dedup
            → InternalEventBus.publish('externalEvent.published', ...)
                → ExternalEventRouter
                    → InternalCommandBus.dispatch('agent.message.inject', ...)
```

There is no intermediate `space.githubEvent.routed` payload contract. The extension publishes the full normalized event directly to `ExternalEventService`, and core external-event services own delivery state.

### Changes to existing code

**Extract source-specific GitHub code from `SpaceGitHubService`:**

- Move webhook normalization (`normalizeSpaceGitHubWebhook`) into `github-event-extension.ts` / `github-normalizer.ts`.
- Move polling normalization (`normalizePollingRow`) into `github-event-extension.ts` / `github-normalizer.ts`.
- Move watched-repo configuration access into `GitHubEventExtensionRepository` or keep the existing `space_github_watched_repos` table behind that repository.
- Move `space.github.watchRepo`, `space.github.listWatchedRepos`, and `space.github.pollOnce` registration behind `RpcExternalEventExtension.registerRpcHandlers(...)` as compatibility RPCs.
- Add generic extension configuration APIs for global enablement, per-space enablement, and source settings; GitHub-specific RPCs can delegate to those APIs where practical.
- Register `/webhook/github/space` through the extension route registry rather than hard-coding a direct call to `spaceGitHubService.handleWebhook(req)` in `app.ts`.

**Do not extend `appendTaskActivity`:** the old plan proposed adding normalized fields to `space.githubEvent.routed`. That is no longer needed because the GitHub extension publishes `ExternalEvent` directly and no longer treats `SpaceGitHubService` as an upstream source.

**Deprecate direct Task Agent injection:** the old `scheduleTaskNotification()` / `flushTaskNotification()` path remains only as a compatibility shim during migration. New node-level delivery goes through `ExternalEventRouter` and the `agent.message.inject` command. Once workflows rely on `eventInterests`, the Task Agent relay can be removed.

### GitHub extension topic construction

The GitHub extension normalizes to GitHub event kinds (`issue_comment`, `pull_request_review`, `pull_request_review_comment`, `pull_request`) and maps them to bus topics:

| GitHub normalized kind | `mapEventType(kind, action)` returns |
|---|---|
| `issue_comment` | `pull_request.comment_${action}` (PR comments only; created, edited, deleted) |
| `pull_request_review` | `pull_request.review_${action}` (submitted, edited, dismissed) |
| `pull_request_review_comment` | `pull_request.review_comment_${action}` (created, edited, deleted) |
| `pull_request` | `pull_request.${action}` (opened, synchronize, closed, etc.) |

These return values are the complete fourth path segment (`resource.action`). For V1 PR events the resource side is always `pull_request`; `comment_*`, `review_*`, and `review_comment_*` are action names, not nested resource segments. The extension must not emit doubled resource names such as `pull_request.review.review_submitted`.

```typescript
function mapEventType(kind: string, action: string): string | null {
  switch (kind) {
    case 'issue_comment': return `pull_request.comment_${action}`;
    case 'pull_request_review': return `pull_request.review_${action}`;
    case 'pull_request_review_comment': return `pull_request.review_comment_${action}`;
    case 'pull_request': return `pull_request.${action}`;
    default: return null; // Non-PR GitHub topics are future extension scope.
  }
}
```

### ExternalEvent construction

```typescript
function toExternalEvent(spaceId: string, event: NormalizedGitHubEvent): ExternalEvent {
  const repoOwner = event.repoOwner.toLowerCase();
  const repoName = event.repoName.toLowerCase();
  const resourceAction = mapEventType(event.eventType, event.action);
  if (!resourceAction) throw new Error(`Unsupported GitHub event type: ${event.eventType}`);

  return {
    id: crypto.randomUUID(),
    spaceId,
    topic: `github/${repoOwner}/${repoName}/${resourceAction}`,
    occurredAt: event.occurredAt,
    ingestedAt: Date.now(),
    source: 'github',
    sourceEventId: event.deliveryId,
    summary: event.summary,
    externalUrl: event.externalUrl,
    payload: {
      eventType: event.eventType,
      action: event.action,
      source: event.source,
      prUrl: event.prUrl,
      prNumber: event.prNumber,
      repoOwner,
      repoName,
      branch: event.branch,
      deliveryId: event.deliveryId,
      externalId: event.externalId,
      actor: event.actor,
      body: event.body,
      rawPayload: event.rawPayload,
    },
    dedupeKey: event.dedupeKey,
  };
}
```

## 8. Migration Path

### DB schema changes

V1 needs core event lifecycle tables, extension configuration storage, and workflow type additions:

1. **Core bus event store** (`space_external_events`): persistent source-level event lifecycle for retry-aware dedup.

   ```sql
   CREATE TABLE space_external_events (
     id TEXT PRIMARY KEY,
     space_id TEXT NOT NULL,
     source TEXT NOT NULL,
     topic TEXT NOT NULL,
     dedupe_key TEXT NOT NULL,
     occurred_at INTEGER NOT NULL,
     ingested_at INTEGER NOT NULL,
     payload_json TEXT NOT NULL,
     state TEXT NOT NULL DEFAULT 'published',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     UNIQUE(space_id, source, dedupe_key)
   );
   ```

   `state` values are `published`, `delivered`, `failed`, and `ignored`. Duplicate handling depends on state: terminal states (`delivered`, `failed`, `ignored`) short-circuit; retryable states can re-emit. `delivered` is written only after every expected per-subscription delivery is `delivered`; terminal delivery failures must instead move or keep the source event in `failed` so later successful deliveries cannot mask partial failure. `failed` is written after any delivery reaches terminal failure, or after retry budgets are exhausted for all retryable deliveries, and `ignored` is written when routing finds no matching subscriptions or no eligible non-terminal delivery after scope checks.

   > **Note:** `routed_task_id` is intentionally NOT stored in the event table. Task resolution is the responsibility of the task/workflow system, not the event pipeline. The event store only tracks dedup and delivery lifecycle.

2. **Core bus delivery store** (`space_external_event_deliveries`): persistent per-subscription delivery lifecycle used by ExternalEventRouter to advance source events to terminal delivered only when every expected delivery succeeds.

   ```sql
   CREATE TABLE space_external_event_deliveries (
     event_id TEXT NOT NULL,
     delivery_key TEXT NOT NULL,
     workflow_run_id TEXT NOT NULL,
     task_id TEXT NOT NULL,
     node_id TEXT NOT NULL,
     agent_name TEXT NOT NULL,
     state TEXT NOT NULL DEFAULT 'pending',
     delivered_at INTEGER,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY(event_id, delivery_key)
   );
   ```

   `ExternalEventRouter` calls `registerExpectedDelivery(...)` for every scope-matched subscription before attempting any injection. This registration must be idempotent for the `(event_id, delivery_key)` primary key: use `INSERT OR IGNORE`, `ON CONFLICT DO NOTHING`, or an equivalent upsert that never downgrades an existing terminal row. Retryable source duplicates and router retries can prepare the same delivery more than once, so duplicate expected-delivery rows are normal and must not become preparation failures. After idempotent registration, the router skips already-terminal delivery rows and only attempts pending/retryable rows. It then records `delivered` after successful command-bus injection and calls `markEventDeliveredIfAllDeliveriesDelivered(event.id)` so source-level dedup can stop re-emitting fully delivered events after restart or in-memory TTL eviction. That transition must check for all expected delivery rows being `delivered`, not merely terminal; if any delivery row is terminal `failed`, `markEventFailedIfAnyDeliveryTerminalFailed(event.id)` keeps the source event failed and prevents a later successful subscription from incorrectly reclassifying the source event as delivered. When retry budget is exhausted, pending-node queue overflow evicts an expected delivery, node cancellation removes queued/retrying deliveries, a retry fires for an inactive subscription, terminal run cleanup drops queued deliveries, or terminal run cleanup cancels per-delivery retry timers, the router records terminal delivery failure and calls `markEventFailedIfAllDeliveriesTerminal(event.id)` so duplicate source observations do not restart an exhausted or impossible delivery.

3. **Extension configuration**: store global and per-space source configuration so sources can be enabled/disabled and configured independently.

   ```sql
   CREATE TABLE external_event_source_configs (
     source TEXT PRIMARY KEY,
     enabled INTEGER NOT NULL DEFAULT 0,
     capabilities_json TEXT NOT NULL,
     settings_json TEXT NOT NULL,
     secrets_ref TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );

   CREATE TABLE space_external_event_source_configs (
     space_id TEXT NOT NULL,
     source TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 0,
     settings_json TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY(space_id, source)
   );
   ```

4. **Extension-owned GitHub configuration**: reuse or migrate the existing `space_github_watched_repos` table behind `GitHubEventExtensionRepository`. This table remains source-specific and should not be queried by `ExternalEventRouter` except through cache invalidation hooks for repo-scoped matching. Over time, GitHub watched repositories can move into `space_external_event_source_configs.settings_json` if that becomes simpler.

5. **No node-execution schema change**: event interests are stored as part of the workflow definition JSON in `space_workflows.nodes[].agents[].eventInterests`.

### Type changes

1. Add `EventInterest` interface to `packages/shared/src/types/space.ts`.
2. Add `eventInterests?: EventInterest[]` to `WorkflowNodeAgent`.
3. Add `ExternalEvent`, `ExternalEventExtension`, `HttpExternalEventExtension`, `RpcExternalEventExtension`, `ExternalEventPublisher`, and `ExternalEventStore` types under `packages/daemon/src/lib/external-events/`.
4. Add validation in the workflow create/update path (Zod schema or manual validation):
   - `topic` must pass `validateGlobPattern()` (non-empty, exactly 4 segments, no `..` segments, no double slashes, valid characters including segment-local `*`).
   - `scope` must be one of `'task' | 'repo' | 'global'`.
   - Max 10 interests per agent slot (prevent abuse).
   - `validateGlobPattern()` is the single source of truth — called at workflow create/update and again at trie insertion time as a safety net.

### New files

```
packages/daemon/src/lib/external-events/
  ├── types.ts                    # ExternalEvent, extension, publisher interfaces
  ├── external-event-service.ts   # ExternalEventService publishes externalEvent.published
  ├── external-event-store.ts     # Persistent retry-aware source-level dedup
  ├── external-event-router.ts    # Subscribes to InternalEventBus, matches, dispatches commands
  ├── extension-manager.ts        # Global/per-space enablement + route/RPC registration
  ├── extension-config-store.ts   # Global + per-space source config
  ├── topic-trie.ts               # TopicTrie<T> implementation
  ├── topic-validator.ts          # validateGlobPattern() helper
  └── index.ts                    # Public exports

packages/daemon/src/lib/external-events/github/
  ├── github-event-extension.ts   # GitHub webhook/polling → ExternalEventService
  ├── github-normalizer.ts        # GitHub webhook/polling normalization helpers
  ├── github-repository.ts        # watched repo config + extension diagnostics
  └── index.ts
```

### Topic pattern validation

```typescript
// topic-validator.ts

/**
 * Validate a glob pattern for event subscriptions.
 * Rejects patterns that could corrupt the trie or match unintended topics.
 * Called at workflow create/update time and again at trie insertion time.
 *
 * Requires exactly 4 segments because all v1 event topics have the format
 * `{source}/{scope1}/{scope2}/{resource.action}`. For GitHub, scope1/scope2
 * are owner/repo; for future non-repo extensions, they are source-specific scope
 * segments such as workspace/channel.
 * Patterns like `github/*` (too shallow) or `github/*/*/pull_request/review_*`
 * (too deep) would pass validation but never match any event, creating silent
 * misconfigurations.
 */
export function validateGlobPattern(pattern: string): { valid: boolean; reason?: string } {
  if (!pattern || pattern.trim().length === 0) {
    return { valid: false, reason: 'Topic pattern must not be empty' };
  }

  const segments = pattern.split('/');

  if (segments.length !== 4) {
    return {
      valid: false,
      reason: `Topic pattern must have exactly 4 segments (source/scope1/scope2/resource.action); got ${segments.length}. Example: 'github/*/*/pull_request.review_submitted'`,
    };
  }

  for (const segment of segments) {
    if (segment === '') {
      return { valid: false, reason: 'Topic pattern must not contain empty segments (double slashes)' };
    }
    if (segment === '..') {
      return { valid: false, reason: 'Topic pattern must not contain ".." segments' };
    }
    if (segment === '**') {
      return { valid: false, reason: 'Multi-segment "**" wildcard is not supported in v1' };
    }
    if (!/^[a-zA-Z0-9_.*-]+$/.test(segment)) {
      return {
        valid: false,
        reason: `Segment "${segment}" contains invalid characters. Use alphanumeric, dash, underscore, dot, or segment-local "*" wildcard.`,
      };

    }
  }

  const resourceAction = segments[3];
  const dotIndex = resourceAction.indexOf('.');
  if (dotIndex <= 0 || dotIndex === resourceAction.length - 1) {
    return {
      valid: false,
      reason: `Topic pattern fourth segment must be resource.action; got "${resourceAction}". Example: 'pull_request.review_submitted'`,
    };
  }

  // Enforce exactly one dot in the 4th segment (resource.action pair).
  // Patterns like `pull_request.review.submitted` (two dots) are invalid
  // because V1 topics use exactly one dot to separate resource from action.
  const dotCount = (resourceAction.match(/\./g) || []).length;
  if (dotCount !== 1) {
    return {
      valid: false,
      reason: `Topic pattern fourth segment must contain exactly one dot (resource.action), got ${dotCount} dots in "${resourceAction}". Example: 'pull_request.review_submitted'`,
    };
  }

  return { valid: true };
}
```

### Wiring into SpaceRuntime and daemon startup

```typescript
// In SpaceRuntimeConfig, add:
interface SpaceRuntimeConfig {
  // ... existing fields ...
  eventRouter?: ExternalEventRouter;
}

// In SpaceRuntime.executeTick(), after node executions are resolved:
// This does a DIFF-BASED update of trie subscriptions. Safe to call on every tick.
if (this.eventRouter) {
  this.eventRouter.registerRunInterests(
    spaceId,
    workflowRunId,
    taskId, // current task whose tick/session activation is being processed
    workflow,
    activeNodeExecutions,
  );
}

// In the node execution status transition handler:
// Called when an individual node execution becomes cancelled, even if the
// workflow run itself remains active or blocked/resumable.
if (newNodeStatus === 'cancelled') {
  this.eventRouter.unregisterExecution(
    workflowRunId,
    taskId,
    workflowNodeId,
    agentName,
  );
}

// In the workflow run status transition handler:
// Called ONLY on truly terminal transitions (done, cancelled) — NOT on blocked.
if (newStatus === 'done' || newStatus === 'cancelled') {
  this.eventRouter.clearRunInterests(workflowRunId);
}

// In daemon startup:
const externalEventStore = new ExternalEventStore(db);
const externalEventService = new ExternalEventService(
  internalEventBus,
  externalEventStore,
);
const externalEventRouter = new ExternalEventRouter({
  internalEventBus,
  commandBus: internalCommandBus,
  nodeExecutionRepo,
  taskRepo,
  spaceTaskManager,
  eventStore: externalEventStore,
  watchedRepoLookup,
});

const extensionContext: ExternalEventExtensionContext = {
  publisher: externalEventService,
  config: externalEventExtensionConfigStore,
  onSourceConfigChanged(change) {
    if (change.source === 'github' && [
      'watched_repo_changed',
      'space_enabled',
      'space_disabled',
    ].includes(change.kind)) {
      externalEventRouter.invalidateWatchedRepoCache(change.spaceId);
    }
  },
};

const extensions: ExternalEventExtension[] = [
  new GitHubEventExtension(new GitHubEventExtensionRepository(db)),
];

for (const extension of extensions) {
  const globalConfig = await extensionContext.config.getGlobalConfig(extension.sourceId);
  if (!globalConfig.globallyEnabled) continue;
  if ('routes' in extension) routeRegistry.register(extension.routes, extensionContext);
  if ('registerRpcHandlers' in extension) extension.registerRpcHandlers(messageHub, extensionContext);
  await extension.start(extensionContext);
}
```

Repo-scoped matching cache invalidation is explicit: watched-resource changes and per-space source enable/disable transitions call `ExternalEventExtensionContext.onSourceConfigChanged(...)`, and daemon startup wires those GitHub change kinds to `externalEventRouter.invalidateWatchedRepoCache(spaceId)`. This keeps source configuration owned by the extension while ensuring `repo`-scoped subscriptions observe newly watched, unwatched, disabled, or re-enabled repos without process restart.

### Phased rollout

**Phase 1 (target MVP):**
- Add `EventInterest` type to `WorkflowNodeAgent`.
- Implement `ExternalEventService`, `ExternalEventStore`, `TopicTrie`, and `ExternalEventRouter`.
- Implement `ExternalEventExtension` interfaces and a minimal extension manager/config store.
- Extract `GitHubEventExtension` as the primary GitHub event source (webhook + polling + normalization).
- Add global GitHub enablement and per-space GitHub enablement/watched-repo configuration.
- Route GitHub PR events through `ExternalEventService` → `InternalEventBus` → `ExternalEventRouter` → `InternalCommandBus` with `task` scope.
- Keep `SpaceGitHubService` only as a compatibility path while parity is verified.
- No UI changes needed for node subscriptions — event interests are authored in workflow JSON. Basic config can be exposed through existing/admin RPCs first.

**Phase 2 (compatibility removal):**
- Remove direct Task Agent notification delivery from `SpaceGitHubService` (`scheduleTaskNotification` / `flushTaskNotification`).
- Migrate remaining `space.github.*` RPC handling into `GitHubEventExtension` or generic external-source config APIs.
- Remove dependence on `space.githubEvent.routed` for external event delivery.
- Add persistent per-node delivery queue if restart-safe pending-node delivery is required.

**Phase 3 (future extensibility):**
- Slack extension: subscribe to Slack Events API, normalize to `ExternalEvent`, publish.
- Jira extension: subscribe to issue/project webhooks, normalize to `ExternalEvent`, publish.
- CI extension: subscribe to GitHub Check Suite or other CI events, normalize, publish.
- Custom extension API: allow Space operators to register custom extensions via global/per-space config.
- UI for global and per-space extension enablement/configuration.

## 9. Relationship to Existing Systems

| Existing system | Relationship |
|---|---|
| **InternalEventBus** | Carries the internal fact `externalEvent.published`. It does not persist external events; durability remains in `ExternalEventStore`. |
| **InternalCommandBus** | Owns the `agent.message.inject` command used by `ExternalEventRouter` to request delivery into an agent session. |
| **MessageHub** | Remains client/RPC transport infrastructure for extension configuration RPCs and client delivery; it is not the external-event domain bus. |
| **GitHubService** (Room pipeline) | Unchanged for Room compatibility. It is not the source for Space workflow-node events. |
| **SpaceGitHubService** (legacy Space pipeline) | Deprecated compatibility path. Its source-specific normalization/polling logic is extracted into `GitHubEventExtension`; delivery moves to `ExternalEventService`/`ExternalEventRouter`. The new path must not depend on `space.githubEvent.routed`. |
| **GitHubEventExtension** | Source extension that owns GitHub webhook verification, polling, normalization, global/per-space enablement, watched-repo configuration, and direct publication to `ExternalEventService`. It does not query Space tasks or inject sessions. |
| **ExternalEventStore** | Core persistence and retry-aware source-level dedup across extensions. Replaces GitHub-specific unconditional duplicate short-circuiting for new delivery. |
| **SessionNotificationSink** | Compatibility notification path for existing Space Agent notifications. External event delivery should move to `InternalCommandBus.dispatch('agent.message.inject', ...)`. |
| **AgentMessageRouter** | Not used for event delivery. Events are system-injected context, not agent-originated messages. |
| **ChannelRouter** | Not involved. Event delivery is not a workflow channel transition. It is delivery into an existing/queued agent session, not a graph activation trigger. |

## 10. Key Design Decisions

### Why InternalEventBus instead of a source-specific hub?

The broader messaging refactor introduces `InternalEventBus` as the daemon-side semantic event layer. External source events should use that layer instead of introducing another generic bus or making GitHub own delivery semantics.

Using `InternalEventBus` means:

- `externalEvent.published` is a normal internal fact, not a raw external topic.
- External slash/glob topics stay in `ExternalEvent.topic` and are matched by `ExternalEventRouter`.
- Publish semantics and handler failure observability come from the shared internal event layer.
- Client delivery, state projection, audit, metrics, and agent notification can subscribe independently.
- The external-event subsystem owns durability through `ExternalEventStore`; the internal bus itself does not become a persistence/replay layer.

This keeps GitHub as an extension and keeps routing/delivery behavior in reusable core services.

### Why deliver through `agent.message.inject` instead of AgentMessageRouter?

AgentMessageRouter is designed for agent-to-agent communication with channel topology authorization. External events are system-injected context, not agent-originated messages. Routing them through AgentMessageRouter would:
- Require topology changes because events do not come from a declared workflow node.
- Conflate system events with peer agent messages in the message history.
- Add unnecessary channel authorization overhead.

The target design uses `InternalCommandBus.dispatch('agent.message.inject', ...)` so delivery remains explicit, testable, and observable without giving external extensions direct access to session injection. The command handler can still use the existing `sessionFactory.injectMessage(..., { deliveryMode: 'defer' })` mechanism under the hood.

### Why trie-based matching instead of regex?

1. **Performance**: Trie lookup walks O(2^k) paths and collects matching subscriptions from each leaf; non-matching subscriptions are never visited. Regex matching is O(n) per event where n = number of subscriptions.
2. **Composability**: Trie supports incremental add/remove (subscriptions change as nodes activate/deactivate). Regex requires rebuilding the full pattern.
3. **Debuggability**: Trie structure can be inspected and visualized. Regex patterns are opaque.

### Why not extend SpaceGitHubService directly?

`SpaceGitHubService` currently mixes four responsibilities in one class: GitHub source ingestion, source-level dedup, PR-to-task resolution, and Task Agent session injection. Extending it would preserve the same coupling and keep the event bus downstream of an already-routed delivery pipeline.

The target architecture splits those responsibilities:
- `GitHubEventExtension` owns only GitHub-specific webhook/polling/normalization/configuration.
- `ExternalEventStore` owns cross-source event lifecycle and retry-aware dedup.
- `ExternalEventRouter` owns node subscription matching and command-based delivery.

This makes GitHub one extension among many instead of a special core daemon path. Future extensions (Slack, Jira, CI, etc.) publish the same `ExternalEvent` shape and reuse the same dedup and delivery machinery.

### Why `deliveryMode: 'defer'` for event injection?

The existing defer mechanism already handles:
- Idle sessions: message enqueued immediately, processed on next turn.
- Busy sessions: message persisted as deferred, replayed after current turn.
- No dropped messages, no interrupted turns.

This is exactly the behavior we want for external events.

### Why remove task resolution from the event pipeline?

The original design embedded `ExternalEventTaskResolver` inside `ExternalEventService`, which:
1. Coupled the event pipeline to the task system, violating the extension boundary.
2. Required source-specific metadata (prNumber, repoOwner, repoName) to be first-class fields on `ExternalEvent` rather than opaque payload data.
3. Created a hardcoded pipeline where events were always resolved to tasks before publication, even when no task-scoped subscriptions existed.

The simplified design:
1. Keeps `ExternalEvent` as a pure normalization layer with opaque payload.
2. Removes `routed_task_id` from the event store schema.
3. Keeps the event pipeline fully task-agnostic — task association is a workflow-node concern, not an event-pipeline concern.
4. Allows the task system to evolve its matching logic independently of the event pipeline.

## 11. Testing Strategy

### Unit tests

1. **TopicTrie**: Insert patterns, verify lookup returns correct values for exact and wildcard matches.
2. **ExternalEventRouter**: Given subscriptions and events, verify scope filtering, topic validation before trie insertion, dedup, and delivery.
3. **ExternalEventStore**: Verify terminal duplicates are short-circuited, retryable duplicates are re-emitted, expected deliveries are registered before injection, successful per-subscription delivery advances the source event to terminal `delivered` only after all expected deliveries are `delivered`, any terminal per-subscription failure prevents/reverts a delivered outcome and marks the source event `failed`, and retry exhaustion advances to terminal `failed`.
4. **ExternalEventService**: Verify validation, dedup, and publication without task resolution.
5. **GitHubEventExtension**: Given webhook and polling payloads, verify enablement checks, signature handling, topic construction, dedupe keys, and `ExternalEvent` construction without querying Space tasks.
6. **Scope resolution**: Test `repo` and `global` scope filtering.

### Integration tests

1. **End-to-end webhook flow**: POST a GitHub webhook payload to the extension route with a `review_submitted` action for PR #42 on repo `lsm/neokai`. Verify the extension publishes `github/lsm/neokai/pull_request.review_submitted`, and the coder node's `task`-scoped subscription receives an injected message.

2. **Dedup across two events with same dedupeKey**: Publish the same GitHub PR review through webhook and polling (identical `dedupeKey`). Verify source-level bus dedup does not create two independent events, and per-subscription delivery dedup calls `injectMessage` exactly once for each interested node. Also verify retryable duplicate states re-emit after a simulated injection failure.

3. **Wake-on-idle delivery**: Set a node execution's session to `idle` state (agent finished its turn). Emit a matching event. Verify `injectMessage` is called with `deliveryMode: 'defer'` and the session processes the message on its next turn (via the existing defer replay mechanism).

4. **Pending node queuing**: Emit an event for a node whose execution is `pending` (no session yet). Verify the event is stored in the in-memory pending queue. Then simulate `TaskAgentManager` creating the session. Verify the queued event is flushed and injected into the new session as part of the first turn.
