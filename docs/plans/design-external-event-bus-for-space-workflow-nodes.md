# Design: External Event Bus for Space Workflow Nodes

## Status: Draft

## Problem

The Space Agent spends most of its time relaying "check the new review comments" to the coder node. External events (PR reviews, CI failures, etc.) arrive via webhooks/polling but have no path to workflow **nodes** — they only route to Rooms or to the Space Agent's global session (via `SpaceGitHubService`). We need a system where workflow nodes declare interest in event types, and matching events are delivered directly to their agent sessions.

## Current State

Two parallel event pipelines exist today, neither of which routes to individual workflow nodes:

1. **Room pipeline** (`GitHubService`): Webhook → normalize → filter → security → route → `deliverToRoom()` → DaemonHub `room.message`. Routes to **Rooms**, not Spaces.
2. **Space pipeline** (`SpaceGitHubService`): Webhook → normalize → dedupe → `SpacePrTaskResolver.resolve()` → `injectTaskAgent()`. Routes events to the **Task Agent session** (the orchestrator), which must then manually relay to the coder node.

The Space pipeline proves the primitives exist, but it is not the right extension boundary: GitHub-specific normalization, dedup, PR-to-task resolution, and Task Agent injection are bundled together in `SpaceGitHubService`. The target design extracts source ingestion into adapters and moves dedup, task enrichment, and node delivery into the core event bus.

## Design Overview

```
External Event Sources (GitHub webhook, polling, future: Slack, CI)
       │
       ▼
┌─────────────────────┐
│  EventAdapter       │  Verify → normalize → publish to EventBus
│  (extension/source) │
└────────┬────────────┘
         │ publish(event) → hub.emit('space.externalEvent.published', { sessionId: 'global', event })
         ▼
┌─────────────────────┐
│  EventBus           │  Persistent dedup + task enrichment, backed by TypedHub.
│  (singleton)        │  Fixed TypedHub-safe method; external topic is payload data.
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  EventRouter        │  Subscribes to bus. Matches events to active
│  (per-runtime)      │  node interests and injects directly into sessions.
└─────────────────────┘
```

## 1. Namespaced Event Topics

Topic format: `{source}/{owner}/{repo}/{resource}.{action}`

Examples:
```
github/lsm/neokai/pull_request.review_submitted
github/lsm/neokai/pull_request.comment_created
github/lsm/neokai/pull_request.synchronize
github/lsm/neokai/pull_request.closed
# Not emitted in v1 — mapEventType only handles pull_request variants;
# issues.* requires a future adapter extension: github/lsm/neokai/issues.opened
# Future CI adapter (Phase 3): github/lsm/neokai/check_suite.completed
github/lsm/neokai/pull_request.*            ← wildcard: all PR events for this repo
github/lsm/neokai/*.*                       ← wildcard: all events for this repo
github/lsm/neokai/pull_request.review_*     ← prefix wildcard: all review events
```

### Topic construction rules

1. `source` — adapter identifier (`github`, `slack`, `ci`). Lowercase, no slashes.
2. `owner/repo` — from the event's repository context. Both lowercase for case-insensitive matching.
3. `resource.action` — the fourth path segment is always one dotted pair. For V1 GitHub PR events, `resource` is `pull_request`; review/comment variants are encoded in `action` (`review_submitted`, `comment_created`, `review_comment_created`) so examples like `pull_request.review_submitted` remain canonical. CI resources such as `check_suite` are Phase 3/future adapter scope.
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
            "scope": "task",
            "label": "PR reviews on my task's PR"
          },
          {
            "topic": "github/*/*/pull_request.comment_created",
            "scope": "task",
            "label": "PR comments on my task's PR"
          },
          {
            "topic": "github/*/*/pull_request.review_comment_created",
            "scope": "task",
            "label": "Inline review comments"
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

**`task` scope** is the critical innovation. Task association is resolved before delivery by the core `EventTaskResolver`:

1. The task's `SpaceTask` record has `workflowRunId` and (via workflow artifacts or gate data) an associated PR number, PR URL, or branch name.
2. `EventTaskResolver` enriches matching events with `routedTaskId` using source-normalized metadata such as GitHub PR URL/number/branch.
3. For a `task`-scoped subscription, the router checks whether `event.routedTaskId === sub.taskId`.
4. The node author never specifies a PR number — it's implicit from the task context.

**`repo` scope** filters to events from any of the space's watched repositories (`space_github_watched_repos`). The node author doesn't need to know repo names.

**`global` scope** passes through all events in the same space matching the topic pattern. It is never cross-space: the router requires `event.spaceId === subscription.spaceId` before any scope-specific logic runs. Use sparingly (e.g. a space-local "global monitor" node).

### Auto-scoping resolution at runtime

When an event arrives, the router:

1. Verifies `event.spaceId` matches the subscription's `spaceId`, then uses normalized event fields (`repoOwner/repoName`, `routedTaskId`, etc.) for scope checks.
2. For each active node execution with `eventInterests`:
   a. Compiles the interest's `topic` glob against the event's topic.
   b. If matched, checks scope:
      - `task`: checks the `EventTaskResolver` enrichment (`event.routedTaskId`) against this subscription's task.
      - `repo`: does event's repo match any watched repo in the node's space?
      - `global`: pass.
   c. If scope check passes, the event is queued for delivery to this node's agent session.

## 3. EventIngestion Adapter Interface

External sources are modeled as **extensions**. An adapter owns the source-specific work:

1. Receive events from its source (webhook, polling, streaming API, etc.).
2. Verify source-specific authenticity (e.g. GitHub HMAC signatures).
3. Normalize raw source payloads into `ExternalEvent`.
4. Publish directly to the EventBus.

Adapters do **not** resolve Space tasks, inspect workflow nodes, or inject into agent sessions. Those are core daemon responsibilities handled by bus-level services and the `EventRouter`. This keeps GitHub, Slack, CI, and future integrations pluggable without adding source-specific paths to the workflow runtime.

```typescript
// packages/daemon/src/lib/space/runtime/event-bus/types.ts

/**
 * A normalized external event on the bus.
 */
export interface ExternalEvent {
  /** Unique event ID (UUID) assigned by the adapter for this bus publication. */
  id: string;
  /** Space this event belongs to. Required to prevent cross-space delivery. */
  spaceId: string;
  /** Fully qualified topic: 'github/owner/repo/resource.action' */
  topic: string;
  /** Timestamp when the event occurred at the source (epoch ms). */
  occurredAt: number;
  /** Timestamp when the event was accepted by the adapter (epoch ms). */
  ingestedAt: number;
  /** Source adapter identifier. */
  source: string;
  /** Optional source-native event id/delivery id for diagnostics. */
  sourceEventId?: string;
  /** Optional PR number used by core task resolution. */
  prNumber?: number;
  /** Repository owner (lowercase) for repo-scoped matching. */
  repoOwner?: string;
  /** Repository name (lowercase) for repo-scoped matching. */
  repoName?: string;
  /** Branch name, if available. */
  branch?: string;
  /** Human-readable summary for agent consumption. */
  summary: string;
  /** External URL (e.g. GitHub PR link). */
  externalUrl?: string;
  /** Structured source payload — adapter-specific, not constrained. */
  payload: Record<string, unknown>;
  /**
   * Stable source-level identity used by bus dedup. Must be stable across
   * webhook and polling observations of the same external event.
   */
  dedupeKey: string;
  /**
   * Core enrichment filled by EventTaskResolver after publication.
   * Adapters should leave this unset unless the source itself has a trusted
   * first-party task id.
   */
  routedTaskId?: string;
}

/**
 * Interface that event source extensions must implement.
 */
export interface EventAdapter {
  /** Adapter identifier (used in topic namespace: '{source}/...'). */
  readonly sourceId: string;

  /**
   * Start the adapter. Called once at daemon startup.
   * The adapter calls `publisher.publish(event)` whenever it accepts an event.
   */
  start(publisher: EventPublisher): Promise<void>;

  /** Stop the adapter. Called at daemon shutdown. */
  stop(): Promise<void>;
}

/**
 * Optional interface for adapters that expose HTTP endpoints.
 * The daemon routes matching requests to the adapter without knowing source
 * internals such as HMAC verification, event names, or raw payload shape.
 */
export interface HttpEventAdapter extends EventAdapter {
  readonly routes: readonly {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    handle(req: Request, publisher: EventPublisher): Promise<Response>;
  }[];
}

/**
 * Optional interface for adapters that expose daemon RPC methods.
 * GitHub uses this for watch/list/poll operations; future adapters can expose
 * source-specific configuration without adding core RPC handler dependencies.
 */
export interface EventAdapterContext {
  /** Notify core services that source configuration changed for a space. */
  onSourceConfigChanged(change: { source: string; spaceId?: string; kind: 'watched_repo_changed' }): void;
}

export interface RpcEventAdapter extends EventAdapter {
  registerRpcHandlers(hub: MessageHub, publisher: EventPublisher, context: EventAdapterContext): void;
}

/**
 * Callback adapters use to publish events onto the bus.
 */
export interface EventPublisher {
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
  markDeliveryDelivered(eventId: string, deliveryKey: string): void;
  markDeliveryFailed(
    eventId: string,
    deliveryKey: string,
    failure: { terminal: boolean; reason: string },
  ): void;
  markEventDeliveredIfAllDeliveriesTerminal(eventId: string): void;
  markEventFailedIfAllDeliveriesTerminal(eventId: string): void;
  markEventFailed(eventId: string, failure: { terminal: boolean; reason: string }): void;
}

export interface EventTaskResolver {
  /** Enrich a normalized event with routedTaskId when a trusted task association exists. */
  enrich(event: ExternalEvent): Promise<ExternalEvent>;
}

/**
 * TypedHub/MessageHub method used by EventBus.
 *
 * IMPORTANT: raw external topics (e.g. `github/lsm/neokai/pull_request.opened`)
 * are NOT used as TypedHub method names because MessageHub validates methods
 * with `[a-zA-Z0-9._-]`, requires a dot, and rejects `/` and `*`.
 * The external topic stays in `ExternalEvent.topic` and is matched by EventRouter.
 */
export const EXTERNAL_EVENT_PUBLISHED_METHOD = 'space.externalEvent.published';

export interface EventBusHubEventMap {
  'space.externalEvent.published': {
    /** Fixed channel required by BaseEventData/TypedHub routing. */
    sessionId: 'global';
    spaceId: string;
    event: ExternalEvent;
  };
}
```

The `sessionId: 'global'` field is required because EventBus is backed by TypedHub/DaemonHub, whose payloads satisfy `BaseEventData` for channel routing. External event delivery is still space-scoped by `spaceId`; the fixed session channel is only the transport channel for bus subscribers.

```typescript
class EventBus implements EventPublisher {
  constructor(
    private readonly hub: DaemonHub,
    private readonly eventStore: ExternalEventStore,
    private readonly taskResolver: EventTaskResolver,
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

    // 3. Core enrichment. For GitHub PR events this resolves PR -> SpaceTask.
    // Adapters do not query workflow/task/gate tables directly.
    const enriched = await this.taskResolver.enrich(stored.event);

    await this.hub.emit(EXTERNAL_EVENT_PUBLISHED_METHOD, {
      sessionId: 'global',
      spaceId: enriched.spaceId,
      event: enriched,
    });

    return {
      eventId: enriched.id,
      duplicate: stored.duplicate,
      state: stored.duplicate ? 'retryable_duplicate' : 'published',
    };
  }
}
```

### Bus-level middleware/services

The EventBus owns cross-cutting behavior that applies to every adapter:

1. **Validation** — all topics must satisfy the four-segment topic contract before publication.
2. **Source-level dedup** — a persistent `ExternalEventStore` tracks `(spaceId, source, dedupeKey)` and delivery state. Terminal duplicates (`delivered`, `failed`, `ignored`, `ambiguous`) are short-circuited; retryable states (`published`, `routed`, `delivery_failed`) are re-emitted so delivery can retry.
3. **Task enrichment** — `EventTaskResolver` enriches events with `routedTaskId` for task-scoped matching. For GitHub PR events, it uses PR URL/number/branch fields that were normalized by the adapter. For future Slack/CI events, source-specific resolver plugins can be registered without changing adapters.
4. **Publication** — only enriched, deduped events are emitted on `space.externalEvent.published`.

This replaces the current GitHub-specific `SpaceGitHubService.ingest()` hot path for new event delivery. In particular, the bus-level dedup store must not use unconditional `INSERT OR IGNORE` short-circuiting for retryable states; otherwise transient delivery failures become permanent event loss.

### GitHub adapter as an extension

The GitHub adapter is a primary source adapter, not a downstream listener on `SpaceGitHubService`:

```typescript
class GitHubEventAdapter implements HttpEventAdapter, RpcEventAdapter {
  readonly sourceId = 'github';
  readonly routes = [
    { method: 'POST', path: '/webhook/github/space', handle: this.handleWebhook.bind(this) },
  ] as const;

  constructor(
    private readonly repo: GitHubEventAdapterRepository,
    private readonly githubToken?: string,
  ) {}

  async start(publisher: EventPublisher): Promise<void> {
    this.publisher = publisher;
    this.pollTimer = setInterval(() => {
      void this.pollOnce().catch((err) => {
        log.warn('GitHubEventAdapter: polling failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, GITHUB_POLL_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  registerRpcHandlers(hub: MessageHub, publisher: EventPublisher, context: EventAdapterContext): void {
    hub.onRequest('space.github.watchRepo', async (data) => {
      const watchedRepo = await this.watchRepo(data);
      context.onSourceConfigChanged({
        source: this.sourceId,
        spaceId: watchedRepo.spaceId,
        kind: 'watched_repo_changed',
      });
      return watchedRepo;
    });
    hub.onRequest('space.github.listWatchedRepos', async (data) => this.listWatchedRepos(data));
    hub.onRequest('space.github.pollOnce', async () => ({ count: await this.pollOnce() }));
  }

  private async handleWebhook(req: Request, publisher: EventPublisher): Promise<Response> {
    const raw = await req.text();
    const verifiedRepos = this.verifySignatureAgainstWatchedRepos(req, raw);
    const normalized = normalizeGitHubWebhook(req.headers, JSON.parse(raw));
    if (!normalized) return Response.json({ ignored: true });

    for (const watched of verifiedRepos) {
      await publisher.publish(toExternalEvent(watched.spaceId, normalized));
    }

    return Response.json({ message: 'Webhook received' });
  }

  async pollOnce(fetchImpl: typeof fetch = fetch): Promise<number> {
    // Poll GitHub endpoints, normalize rows, and publish ExternalEvent directly.
    // No SpaceTask lookup and no session injection happen here.
  }
}
```

The normalization helpers currently living in `space-github.ts` move into this adapter module:

- `normalizeSpaceGitHubWebhook(...)` → `normalizeGitHubWebhook(...)`
- `normalizePollingRow(...)` → `normalizeGitHubPollingRow(...)`
- `mapEventType(...)` stays with the adapter because topic construction is source-specific

The adapter may keep source-local tables such as `space_github_watched_repos` and an optional adapter event log for diagnostics, but the authoritative cross-source event lifecycle belongs to the EventBus store.

## 4. EventRouter Design

### Architecture

The `EventRouter` subscribes to the fixed TypedHub-safe EventBus method (`space.externalEvent.published`). When an event arrives, it:

1. Reads the external topic from `event.topic` in the payload.
2. Looks up all active node executions that have `eventInterests` matching that payload topic.
3. For each matching interest, checks scope.
4. Delivers the event to the matching node's agent session.

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

1. **`registerRunInterests`** (called on every `executeTick`): Diff-based trie update. Compares current node execution states against existing subscriptions. Adds subscriptions for newly active nodes, removes subscriptions for `cancelled` nodes. Does NOT touch the dedup map or pending queue — those are preserved across tick refreshes.

2. **`clearRunInterests`** (called only on `done`/`cancelled` terminal transitions): Full teardown. Removes all trie subscriptions, dedup entries, and pending queue entries for the run. NOT called on `blocked` transitions because blocked is resumable.

3. A workflow definition is updated (interests may have changed — next `registerRunInterests` call picks up changes via the diff).

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

interface WatchedRepoLookup {
  listWatchedRepos(spaceId: string): { owner: string; repo: string; enabled: boolean }[];
}
```

### EventRouter implementation sketch

```typescript
class EventRouter {
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
  // Event-level retry tracking for failures before expected delivery rows exist
  private eventRetryCounts: Map<string, number> = new Map();
  private eventRetryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private static readonly MAX_RETRIES = 3;
  private static readonly RETRY_BACKOFF_MS = 1000; // 1s base, exponential backoff

  // Cache: spaceId → Set of "owner/repo" strings for watched repos.
  // Invalidated when a source adapter reports watched-repo configuration changes.
  private watchedRepoCache: Map<string, Set<string>> = new Map();

  constructor(
    private readonly eventBus: EventBus,
    private readonly nodeExecutionRepo: NodeExecutionRepository,
    private readonly taskRepo: SpaceTaskRepository,
    private readonly spaceTaskManager: SpaceTaskManager,
    private readonly sessionFactory: SessionFactory,
    private readonly eventStore: ExternalEventStore,
    private readonly watchedRepoLookup: WatchedRepoLookup,
  ) {
    // Subscribe to the fixed TypedHub-safe method. External topic matching happens
    // inside handleEvent via event.topic, not via the hub method name.
    this.eventBus.subscribe(EXTERNAL_EVENT_PUBLISHED_METHOD, ({ spaceId, event }) => {
      // Defense in depth: payload spaceId and event.spaceId must agree.
      if (event.spaceId !== spaceId) return;
      void this.handleEvent(event).catch((err) => {
        log.warn('EventRouter: failed to route external event', {
          error: err,
          spaceId,
          topic: event.topic,
          eventId: event.id,
        });
      });
    });
  }

  /** Check if a repo is watched for a given space. Uses cached data. */
  private isWatchedRepo(spaceId: string, owner: string, repo: string): boolean {
    let cached = this.watchedRepoCache.get(spaceId);
    if (!cached) {
      const repos = this.watchedRepoLookup.listWatchedRepos(spaceId);
      cached = new Set(
        repos.filter(r => r.enabled).map(r => `${r.owner.toLowerCase()}/${r.repo.toLowerCase()}`)
      );
      this.watchedRepoCache.set(spaceId, cached);
    }
    return cached.has(`${owner.toLowerCase()}/${repo.toLowerCase()}`);
  }

  /**
   * Invalidate the watched-repo cache for a given space (or all spaces).
   * Called from EventAdapterContext.onSourceConfigChanged when a source adapter
   * changes watched-repo configuration (for example `space.github.watchRepo`).
   * Without this, `repo`-scoped matching grows stale until process restart.
   */
  invalidateWatchedRepoCache(spaceId?: string): void {
    if (spaceId) {
      this.watchedRepoCache.delete(spaceId);
    } else {
      this.watchedRepoCache.clear();
    }
  }

  private makeDeliveryKey(event: ExternalEvent, sub: Subscription): string {
    // Use a structured tuple key: event.dedupeKey and workflow/node/agent ids are
    // free-form strings and can contain ':', '/', or other delimiter characters.
    return JSON.stringify([event.dedupeKey, sub.taskId, sub.nodeId, sub.agentName, sub.workflowRunId]);
  }

  private makePendingQueueKey(sub: Pick<Subscription, 'workflowRunId' | 'taskId' | 'nodeId' | 'agentName'>): string {
    // Same collision-safe shape as subscription/delivery keys.
    return JSON.stringify([sub.workflowRunId, sub.taskId, sub.nodeId, sub.agentName]);
  }

  /** Evict stale dedup entries (called periodically or on demand). */
  private evictStaleDedup(): void {
    const cutoff = Date.now() - EventRouter.DEDUP_TTL_MS;
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
          log.warn('EventRouter: skipping invalid event interest topic', {
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
      const [, , , , keyWorkflowRunId] = JSON.parse(key) as [string, string, string, string, string];
      if (keyWorkflowRunId === workflowRunId) {
        this.delivered.delete(key);
      }
    }

    // Clean up in-memory pending queue for this run. Keys are JSON tuples, so parse
    // structurally rather than prefix-matching delimiter-joined strings.
    for (const key of this.pendingQueue.keys()) {
      const [keyWorkflowRunId] = JSON.parse(key) as [string, string, string, string];
      if (keyWorkflowRunId === workflowRunId) {
        this.pendingQueue.delete(key);
      }
    }

    // Clean up pending deliveries and retry counts for this run.
    // Delivery keys are JSON tuples: [dedupeKey, taskId, nodeId, agentName, workflowRunId]
    for (const key of this.pendingDeliveries.keys()) {
      const [, , , , keyWorkflowRunId] = JSON.parse(key) as [string, string, string, string, string];
      if (keyWorkflowRunId === workflowRunId) {
        this.pendingDeliveries.delete(key);
      }
    }
    for (const key of this.retryCounts.keys()) {
      const [, , , , keyWorkflowRunId] = JSON.parse(key) as [string, string, string, string, string];
      if (keyWorkflowRunId === workflowRunId) {
        this.retryCounts.delete(key);
      }
    }
    for (const [key, timer] of this.retryTimers.entries()) {
      const [, , , , keyWorkflowRunId] = JSON.parse(key) as [string, string, string, string, string];
      if (keyWorkflowRunId === workflowRunId) {
        clearTimeout(timer);
        this.retryTimers.delete(key);
      }
    }

    // Event-level preparation retries may cover multiple subscriptions in the run.
    for (const [key, timer] of this.eventRetryTimers.entries()) {
      if (key.includes(`:${workflowRunId}:`)) {
        clearTimeout(timer);
        this.eventRetryTimers.delete(key);
        this.eventRetryCounts.delete(key);
      }
    }
  }

  private async handleEvent(event: ExternalEvent): Promise<void> {
    // 1. Look up matching subscriptions via trie
    const matched = this.topicTrie.lookup(event.topic);

    if (matched.length === 0) return;

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
        this.eventStore.registerExpectedDelivery(event.id, deliveryKey, {
          workflowRunId: sub.workflowRunId,
          taskId: sub.taskId,
          nodeId: sub.nodeId,
          agentName: sub.agentName,
        });
        if (this.eventStore.isDeliveryTerminal(event.id, deliveryKey)) continue;
        eligible.push(sub);
      } catch (err) {
        preparationFailed = true;
        log.warn('EventRouter: failed to prepare external event delivery; scheduling retry', {
          error: err,
          spaceId: event.spaceId,
          topic: event.topic,
          eventId: event.id,
          workflowRunId: sub.workflowRunId,
          taskId: sub.taskId,
          nodeId: sub.nodeId,
          agentName: sub.agentName,
        });
        this.pendingDeliveries.delete(deliveryKey);
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
    if (preparationFailed) return;

    // 3. Deliver each prepared subscription. Isolate injection failures per
    // subscription after the complete expected-delivery set has been registered.
    for (const sub of eligible) {
      try {
        await this.deliverToSubscription(event, sub);
      } catch (err) {
        log.warn('EventRouter: failed to deliver external event to subscription', {
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
    // clear pending and schedule router-level retry rather than relying on a source
    // adapter to publish the same event again.
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
    // Format and inject.
    // NOTE: There is a TOCTOU race — the session could complete between our
    // resolveSession call and injectMessage. This is safe: injectMessage on a
    // completed/absent session returns a caught error (logged as a warning).
    const message = this.formatEventMessage(event);
    await this.sessionFactory.injectMessage(sessionId, message, {
      deliveryMode: 'defer',
    });

    // Success: mark as delivered both in-memory and persistently, then advance
    // the source event to terminal delivered only when all expected per-subscription
    // deliveries are terminal. This keeps source-level dedup from re-emitting
    // already-delivered events after restart/TTL expiry.
    this.delivered.set(dedupeKey, Date.now());
    this.eventStore.markDeliveryDelivered(event.id, dedupeKey);
    this.eventStore.markEventDeliveredIfAllDeliveriesTerminal(event.id);
    this.pendingDeliveries.delete(dedupeKey);
  }

  private queueForDelivery(event: ExternalEvent, sub: Subscription, deliveryKey: string): void {
    const key = this.makePendingQueueKey(sub);
    const queue = this.pendingQueue.get(key) ?? [];
    queue.push({ event, deliveryKey });
    if (queue.length > 50) {
      const dropped = queue.shift();
      if (dropped) this.pendingDeliveries.delete(dropped.deliveryKey);
      log.warn('EventRouter: pending external event queue exceeded limit; dropped oldest event', {
        workflowRunId: sub.workflowRunId,
        taskId: sub.taskId,
        nodeId: sub.nodeId,
        agentName: sub.agentName,
      });
    }
    this.pendingQueue.set(key, queue);
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
        log.warn('EventRouter: failed to flush queued external event delivery', {
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

  private passesScopeCheck(event: ExternalEvent, sub: Subscription): boolean {
    // All scopes are bounded to the subscription's space. EventBus is a shared
    // daemon-wide stream, so even `global` means "global within this space", not
    // cross-space delivery.
    if (event.spaceId !== sub.spaceId) return false;

    switch (sub.interest.scope) {
      case 'global':
        return true;

      case 'repo': {
        // Check if event's repo matches any watched repo in this space.
        // Uses an adapter-provided watched-repo lookup filtered by
        // (spaceId, owner, repo, enabled=true). The router caches this per-space
        // to avoid DB hits on every event.
        if (!event.repoOwner || !event.repoName) return false;
        return this.isWatchedRepo(sub.spaceId, event.repoOwner, event.repoName);
      }

      case 'task': {
        // EventTaskResolver enriches matching events before publication. The
        // router uses that trusted enrichment directly and never performs broad
        // PR/task scans during delivery. This prevents cross-task leakage in
        // multi-task runs and keeps task/gate/workflow schema access out of
        // source adapters and delivery hot paths. If routedTaskId is absent, the
        // event has no associated task, so the scope check returns false.
        return event.routedTaskId === sub.taskId;
      }
    }
  }

  /**
   * Schedule an event-level retry for failures before expected delivery rows exist
   * (for example transient watched-repo lookup or delivery-row insert failures).
   * This reruns full matching/preparation instead of allowing partial delivery to
   * mark the source event terminal while an unregistered subscription missed it.
   */
  private scheduleEventRetry(event: ExternalEvent, matched: Subscription[]): void {
    const retryKey = `${event.id}:${matched.map((sub) => sub.workflowRunId).sort().join(',')}:prepare`;
    const retries = (this.eventRetryCounts.get(retryKey) ?? 0) + 1;
    if (retries > EventRouter.MAX_RETRIES) {
      log.warn('EventRouter: max preparation retries exceeded; marking event failed', {
        eventId: event.id,
        topic: event.topic,
      });
      this.eventRetryCounts.delete(retryKey);
      const existingTimer = this.eventRetryTimers.get(retryKey);
      if (existingTimer) clearTimeout(existingTimer);
      this.eventRetryTimers.delete(retryKey);
      this.eventStore.markEventFailed(event.id, {
        terminal: true,
        reason: 'delivery_preparation_failed',
      });
      return;
    }

    this.eventRetryCounts.set(retryKey, retries);
    const backoff = EventRouter.RETRY_BACKOFF_MS * Math.pow(2, retries - 1);
    const existingTimer = this.eventRetryTimers.get(retryKey);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      this.eventRetryTimers.delete(retryKey);
      void this.handleEvent(event).catch((err) => {
        log.warn('EventRouter: event preparation retry failed', { error: err, eventId: event.id });
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
    if (retries > EventRouter.MAX_RETRIES) {
      log.warn(`Max retries exceeded for event ${deliveryKey}, marking delivery failed`);
      this.retryCounts.delete(deliveryKey);
      const existingTimer = this.retryTimers.get(deliveryKey);
      if (existingTimer) clearTimeout(existingTimer);
      this.retryTimers.delete(deliveryKey);
      this.pendingDeliveries.delete(deliveryKey);

      // Persist terminal failure so source-level dedup stops re-emitting this
      // delivery after restart or future polling of the same upstream event.
      this.eventStore.markDeliveryFailed(event.id, deliveryKey, {
        terminal: true,
        reason: 'max_retries_exceeded',
      });
      this.eventStore.markEventFailedIfAllDeliveriesTerminal(event.id);
      return;
    }

    this.retryCounts.set(deliveryKey, retries);
    const backoff = EventRouter.RETRY_BACKOFF_MS * Math.pow(2, retries - 1);

    const existingTimer = this.retryTimers.get(deliveryKey);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(() => {
      this.retryTimers.delete(deliveryKey);

      // Re-check if delivered while waiting (another delivery might have succeeded)
      if (this.delivered.has(deliveryKey) || this.eventStore.isDeliveryTerminal(event.id, deliveryKey)) {
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
        return;
      }

      // Use .catch to prevent unhandled promise rejections in retry path.
      this.deliverToSubscription(event, sub)
        .then(() => {
          // deliverToSubscription catches injection failures and may schedule a
          // follow-up retry, so only clear retry state if delivery is now marked.
          if (this.delivered.has(deliveryKey) || this.eventStore.isDeliveryTerminal(event.id, deliveryKey)) {
            this.retryCounts.delete(deliveryKey);
            this.pendingDeliveries.delete(deliveryKey);
          }
        })
        .catch((err) => {
          // Don't clear retryCounts on failure — preserve count for retry logic.
          log.warn('EventRouter: retry delivery failed', {
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
                                                          ┌──────────────┼──────────────┐
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
   - Terminal duplicates (`delivered`, `ignored`, `ambiguous`) are short-circuited.
   - Retryable duplicates (`published`, `routed`, `delivery_failed`) are re-emitted so transient delivery failures can retry.
   - This replaces `SpaceGitHubService.storeEvent()` as the authoritative dedup path for new external-event delivery.

2. **Per-subscription delivery dedup** — JSON tuple `[event.dedupeKey, subscription.taskId, subscription.nodeId, subscription.agentName, subscription.workflowRunId]`.
   - Purpose: prevent the same external event from being delivered twice to the same node agent within a run.
   - The tuple includes `taskId` to isolate multi-task runs and `nodeId` to handle cases where the same agent name appears in multiple nodes within the same run.
   - The tuple is encoded structurally rather than delimiter-joined because `dedupeKey`, workflow identifiers, node IDs, and agent names are free-form strings.
   - It is tracked in-memory for fast duplicate suppression and persisted in `space_external_event_deliveries` after successful injection.

The EventRouter marks per-subscription delivery as `delivered` only after successful injection, updates `ExternalEventStore` with the successful delivery key, and advances the source event to terminal `delivered` only once all expected deliveries are terminal. Failed injection/session-resolution paths remove `pendingDeliveries` and schedule retry rather than relying on adapters to re-publish the same event.

### Wake-on-idle

When an event matches a subscription whose node execution is `idle` (agent session exists but finished its turn):

1. Call `sessionFactory.injectMessage(sessionId, message, { deliveryMode: 'defer' })`.
2. The existing defer mechanism handles waking: if idle → enqueue immediately; if busy → persist as deferred, replay after current turn.
3. No new wake mechanism needed — the existing `SessionNotificationSink` pattern already solves this.

### Queue for not-yet-started nodes

When a node execution is `pending` (no session yet):

1. The event is queued in an in-memory `Map<string, ExternalEvent[]>` keyed by a JSON tuple `[workflowRunId, taskId, nodeId, agentName]` so free-form identifiers cannot collide by containing delimiter characters.
2. When `TaskAgentManager` creates the node's session, it calls `eventRouter.flushQueuedDeliveriesForSession(sub, sessionId)`.
3. Queued events are injected through the same prepared-delivery path as live events, so successful flush marks the per-subscription delivery delivered and advances the source event only when all expected deliveries are terminal.
4. If flush injection fails, the router clears the stale pending marker and schedules a normal delivery retry so the queued event is not silently lost.
5. Queue is bounded: max 50 events per execution, oldest dropped (with a warning log).

**Known limitation — daemon restart**: The in-memory per-node pending queue is lost on daemon restart. For v1, this is accepted as a known delivery gap:
- The bus-level `ExternalEventStore` preserves the source event and can re-emit retryable states, but the per-node in-memory queue itself is not durable.
- Events queued for `pending` nodes before restart may need explicit replay from the event store once persistent delivery queues are implemented.
- New events (arriving after restart) flow through the bus normally and are not affected.

If persistent queuing is needed in a future iteration, events can be persisted to a `space_event_delivery_queue` SQLite table with the same schema as the in-memory map, and drained on node activation. The table should store the `ExternalEvent.id` plus the subscription key so queued delivery can replay from `ExternalEventStore` without relying on source adapters to re-publish.

### Backpressure

- **Rate limiting**: If a single node receives > 10 events per minute, subsequent events are coalesced into a digest message: "N additional events received in the last minute. Summary: ..."
- **Event TTL**: Events older than 5 minutes are dropped from the queue (they're likely stale for an agent's decision-making).
- **Bus overflow**: The `EventBus` uses TypedHub's async-everywhere design with the fixed method `space.externalEvent.published` — slow consumers don't block publishers. Handlers run via `queueMicrotask`; external slash/glob topics remain payload data and are never used as MessageHub method names.

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

## 7. Wiring the GitHub Adapter

### Target architecture

The GitHub integration is extracted into a first-class event adapter. It no longer depends on `SpaceGitHubService.ingest()`, `space.githubEvent.routed`, or Task Agent notification delivery.

```
GitHub webhook / polling
    → GitHubEventAdapter
        → verify signature / fetch API pages
        → normalize raw GitHub payload
        → construct topic + dedupeKey
        → EventBus.publish(ExternalEvent)
            → ExternalEventStore.store() + retry-aware dedup
            → EventTaskResolver.enrich()   // PR → SpaceTask when possible
            → DaemonHub.emit('space.externalEvent.published', { event })
                → EventRouter.deliverToSubscription()
                    → sessionFactory.injectMessage(..., { deliveryMode: 'defer' })
```

There is no intermediate `space.githubEvent.routed` payload contract. The adapter publishes the full normalized event directly to the bus, and the bus owns task enrichment and delivery state.

### Changes to existing code

**Extract source-specific GitHub code from `SpaceGitHubService`:**

- Move webhook normalization (`normalizeSpaceGitHubWebhook`) into `github-adapter.ts`.
- Move polling normalization (`normalizePollingRow`) into `github-adapter.ts`.
- Move watched-repo configuration access into `GitHubEventAdapterRepository` or keep the existing `space_github_watched_repos` table behind that repository.
- Move `space.github.watchRepo`, `space.github.listWatchedRepos`, and `space.github.pollOnce` registration behind `RpcEventAdapter.registerRpcHandlers(...)`.
- Register `/webhook/github/space` through the adapter route registry rather than hard-coding a direct call to `spaceGitHubService.handleWebhook(req)` in `app.ts`.

**Do not extend `appendTaskActivity`:** the old plan proposed adding normalized fields to `space.githubEvent.routed`. That is no longer needed because the GitHub adapter publishes `ExternalEvent` directly and no longer treats `SpaceGitHubService` as an upstream source.

**Deprecate direct Task Agent injection:** the old `scheduleTaskNotification()` / `flushTaskNotification()` path remains only as a compatibility shim during migration. New node-level delivery goes through `EventRouter`. Once workflows rely on `eventInterests`, the Task Agent relay can be removed.

### GitHub adapter topic construction

The GitHub adapter normalizes to GitHub event kinds (`issue_comment`, `pull_request_review`, `pull_request_review_comment`, `pull_request`) and maps them to bus topics:

| GitHub normalized kind | `mapEventType(kind, action)` returns |
|---|---|
| `issue_comment` | `pull_request.comment_${action}` (PR comments only; created, edited, deleted) |
| `pull_request_review` | `pull_request.review_${action}` (submitted, edited, dismissed) |
| `pull_request_review_comment` | `pull_request.review_comment_${action}` (created, edited, deleted) |
| `pull_request` | `pull_request.${action}` (opened, synchronize, closed, etc.) |

These return values are the complete fourth path segment (`resource.action`). For V1 PR events the resource side is always `pull_request`; `comment_*`, `review_*`, and `review_comment_*` are action names, not nested resource segments. The adapter must not emit doubled resource names such as `pull_request.review.review_submitted`.

```typescript
function mapEventType(kind: string, action: string): string | null {
  switch (kind) {
    case 'issue_comment': return `pull_request.comment_${action}`;
    case 'pull_request_review': return `pull_request.review_${action}`;
    case 'pull_request_review_comment': return `pull_request.review_comment_${action}`;
    case 'pull_request': return `pull_request.${action}`;
    default: return null; // Non-PR GitHub topics are future adapter scope.
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
    prNumber: event.prNumber,
    repoOwner,
    repoName,
    summary: event.summary,
    externalUrl: event.externalUrl,
    payload: {
      eventType: event.eventType,
      action: event.action,
      source: event.source,
      prUrl: event.prUrl,
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

### Task-scoped resolution

For `task` scope, the adapter does not resolve a task. Instead, `EventTaskResolver` enriches PR events after bus dedup and before publication:

1. If the event already has a trusted `routedTaskId`, use it directly.
2. For GitHub PR events, resolve using normalized `prUrl`, `repoOwner/repoName`, `prNumber`, and optional `branch`.
3. Store the result in `event.routedTaskId` and `event.payload.taskResolution` for diagnostics.
4. EventRouter `task` scope checks `event.routedTaskId === sub.taskId` and does not re-run broad task scans during delivery.

This removes duplicate PR→task resolution from the adapter and EventRouter hot paths while preserving the existing auto-scoping behavior.

## 8. Migration Path

### DB schema changes

V1 needs one core event-store table plus workflow type additions:

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
     routed_task_id TEXT,
     state TEXT NOT NULL DEFAULT 'published',
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     UNIQUE(space_id, source, dedupe_key)
   );
   ```

   `state` values are `published`, `routed`, `delivered`, `delivery_failed`, `failed`, `ignored`, and `ambiguous`. Duplicate handling depends on state: terminal states (`delivered`, `failed`, `ignored`, `ambiguous`) short-circuit; retryable states can re-emit. `delivered` is written only after expected per-subscription deliveries are terminal, and `failed` is written only after retry budgets are exhausted for all retryable deliveries.

2. **Core bus delivery store** (`space_external_event_deliveries`): persistent per-subscription delivery lifecycle used by EventRouter to advance source events to terminal delivered.

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

   `EventRouter` calls `registerExpectedDelivery(...)` for every scope-matched subscription before attempting any injection. This registration must be idempotent for the `(event_id, delivery_key)` primary key: use `INSERT OR IGNORE`, `ON CONFLICT DO NOTHING`, or an equivalent upsert that never downgrades an existing terminal row. Retryable source duplicates and router retries can prepare the same delivery more than once, so duplicate expected-delivery rows are normal and must not become preparation failures. After idempotent registration, the router skips already-terminal delivery rows and only attempts pending/retryable rows. It then records `delivered` after successful `injectMessage` and calls `markEventDeliveredIfAllDeliveriesTerminal(event.id)` so source-level dedup can stop re-emitting already-delivered events after restart or in-memory TTL eviction. When retry budget is exhausted it records terminal delivery failure and calls `markEventFailedIfAllDeliveriesTerminal(event.id)` so duplicate source observations do not restart an exhausted retry loop.

3. **Adapter-owned GitHub configuration**: reuse or migrate the existing `space_github_watched_repos` table behind `GitHubEventAdapterRepository`. This table remains source-specific and should not be queried by EventRouter except through cache invalidation hooks for repo-scoped matching.

4. **No node-execution schema change**: event interests are stored as part of the workflow definition JSON in `space_workflows.nodes[].agents[].eventInterests`.

### Type changes

1. Add `EventInterest` interface to `packages/shared/src/types/space.ts`.
2. Add `eventInterests?: EventInterest[]` to `WorkflowNodeAgent`.
3. Add `ExternalEvent`, `EventAdapter`, `HttpEventAdapter`, `RpcEventAdapter`, `EventPublisher`, `ExternalEventStore`, and `EventTaskResolver` types under `packages/daemon/src/lib/space/runtime/event-bus/`.
4. Add validation in the workflow create/update path (Zod schema or manual validation):
   - `topic` must pass `validateGlobPattern()` (non-empty, exactly 4 segments, no `..` segments, no double slashes, valid characters including segment-local `*`).
   - `scope` must be one of `'task' | 'repo' | 'global'`.
   - Max 10 interests per agent slot (prevent abuse).
   - `validateGlobPattern()` is the single source of truth — called at workflow create/update and again at trie insertion time as a safety net.

### New files

```
packages/daemon/src/lib/space/runtime/event-bus/
  ├── types.ts                 # ExternalEvent, EventAdapter, EventPublisher interfaces
  ├── event-bus.ts             # EventBus singleton (wraps TypedHub)
  ├── event-store.ts           # Persistent retry-aware source-level dedup
  ├── event-task-resolver.ts   # Core event -> SpaceTask enrichment
  ├── topic-trie.ts            # TopicTrie<T> implementation
  ├── topic-validator.ts       # validateGlobPattern() helper
  ├── event-router.ts          # EventRouter — subscribes to bus, matches, delivers
  └── index.ts                 # Public exports

packages/daemon/src/lib/space/runtime/event-adapters/github/
  ├── github-adapter.ts        # GitHubEventAdapter — webhook/polling -> EventBus
  ├── github-normalizer.ts     # GitHub webhook/polling normalization helpers
  ├── github-repository.ts     # watched repo config + adapter diagnostics
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
 * `{source}/{scope1}/{scope2}/{resource}.{action}`. For GitHub, scope1/scope2
 * are owner/repo; for future non-repo adapters, they are source-specific scope
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
  eventRouter?: EventRouter;
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

// In the workflow run status transition handler:
// Called ONLY on truly terminal transitions (done, cancelled) — NOT on blocked.
if (newStatus === 'done' || newStatus === 'cancelled') {
  this.eventRouter.clearRunInterests(workflowRunId);
}

// In daemon startup:
const externalEventStore = new ExternalEventStore(db);
const eventTaskResolver = new EventTaskResolver(db);
const eventBus = new EventBus(daemonHub, externalEventStore, eventTaskResolver);
const eventRouter = new EventRouter(eventBus, ...dependencies);

const adapterContext: EventAdapterContext = {
  onSourceConfigChanged(change) {
    if (change.kind === 'watched_repo_changed') {
      eventRouter.invalidateWatchedRepoCache(change.spaceId);
    }
  },
};

const adapters: EventAdapter[] = [
  new GitHubEventAdapter(new GitHubEventAdapterRepository(db), process.env.GITHUB_TOKEN),
];

for (const adapter of adapters) {
  if ('routes' in adapter) routeRegistry.register(adapter.routes, eventBus);
  if ('registerRpcHandlers' in adapter) adapter.registerRpcHandlers(messageHub, eventBus, adapterContext);
  await adapter.start(eventBus);
}
```

Repo-scoped matching cache invalidation is explicit: `watchRepo` changes call `EventAdapterContext.onSourceConfigChanged(...)`, and daemon startup wires that callback to `eventRouter.invalidateWatchedRepoCache(spaceId)`. This keeps source configuration owned by the adapter while ensuring `repo`-scoped subscriptions observe newly watched or unwatched repos without process restart.

### Phased rollout

**Phase 1 (target MVP):**
- Add `EventInterest` type to `WorkflowNodeAgent`.
- Implement `EventBus`, `ExternalEventStore`, `EventTaskResolver`, `TopicTrie`, and `EventRouter`.
- Extract `GitHubEventAdapter` as the primary GitHub event source (webhook + polling + normalization).
- Route GitHub PR events directly through EventBus to node sessions with `task` scope.
- Keep `SpaceGitHubService` only as a compatibility path while parity is verified.
- No UI changes needed — event interests are authored in workflow JSON.

**Phase 2 (compatibility removal):**
- Remove direct Task Agent notification delivery from `SpaceGitHubService` (`scheduleTaskNotification` / `flushTaskNotification`).
- Migrate remaining `space.github.*` RPC handling into `GitHubEventAdapter`.
- Remove dependence on `space.githubEvent.routed` for external event delivery.
- Add persistent per-node delivery queue if restart-safe pending-node delivery is required.

**Phase 3 (future extensibility):**
- Slack adapter: subscribe to Slack Events API, normalize to `ExternalEvent`, publish.
- CI adapter: subscribe to GitHub Check Suite or other CI events, normalize, publish.
- Custom adapter API: allow Space operators to register custom adapters via config.

## 9. Relationship to Existing Systems

| Existing system | Relationship |
|---|---|
| **DaemonHub / TypedHub** | `EventBus` is a TypedHub participant on the shared `InProcessTransportBus`. It publishes all external events through the fixed valid method `space.externalEvent.published`; slash-delimited external topics stay in `ExternalEvent.topic` and are matched by the router trie. |
| **GitHubService** (Room pipeline) | Unchanged for Room compatibility. It is not the source for Space workflow-node events. |
| **SpaceGitHubService** (legacy Space pipeline) | Deprecated compatibility path. Its source-specific normalization/polling logic is extracted into `GitHubEventAdapter`; task resolution and delivery move to EventBus/EventRouter. The bus must not depend on `space.githubEvent.routed`. |
| **GitHubEventAdapter** | Source extension that owns GitHub webhook verification, polling, normalization, watched-repo configuration, and direct publication to EventBus. It does not query Space tasks or inject sessions. |
| **ExternalEventStore** | Core bus persistence and retry-aware source-level dedup across adapters. Replaces GitHub-specific unconditional duplicate short-circuiting for new delivery. |
| **EventTaskResolver** | Core enrichment service that maps events to Space tasks where possible (e.g. GitHub PR → task). Keeps task/gate/workflow schema access out of adapters. |
| **SessionNotificationSink** | The event bus uses the same `sessionFactory.injectMessage()` with `deliveryMode: 'defer'` pattern. |
| **AgentMessageRouter** | Not used for event delivery. Events are injected directly via `sessionFactory.injectMessage()`, not via the agent-to-agent messaging channel. Events are not agent-originated messages — they're system-injected context. |
| **ChannelRouter** | Not involved. Event delivery is not a workflow channel transition. It's an injection into an existing session, not an activation trigger. |

## 10. Key Design Decisions

### Why TypedHub and not a standalone EventEmitter?

TypedHub provides:
- Async-everywhere design (cluster-ready).
- Session-scoped subscriptions (O(1) lookup).
- Already wired into the daemon's lifecycle.
- No new dependency.

Using TypedHub as the backing transport means the EventBus inherits all of these properties for free. The bus does **not** use external topic strings as TypedHub method names: raw topics contain `/` and glob `*`, which violate MessageHub method validation. Instead, EventBus publishes every external event under the fixed valid method `space.externalEvent.published` and places the external topic in `ExternalEvent.topic` for trie matching.

### Why not route through AgentMessageRouter?

AgentMessageRouter is designed for agent-to-agent communication with channel topology authorization. External events are system-injected context, not agent messages. Routing them through AgentMessageRouter would:
- Require topology changes (events don't come from a declared node).
- Conflate system events with agent-to-agent messages in the message history.
- Add unnecessary authorization overhead.

Direct injection via `sessionFactory.injectMessage()` is simpler and semantically correct.

### Why trie-based matching instead of regex?

1. **Performance**: Trie lookup walks O(2^k) paths and collects matching subscriptions from each leaf; non-matching subscriptions are never visited. Regex matching is O(n) per event where n = number of subscriptions.
2. **Composability**: Trie supports incremental add/remove (subscriptions change as nodes activate/deactivate). Regex requires rebuilding the full pattern.
3. **Debuggability**: Trie structure can be inspected and visualized. Regex patterns are opaque.

### Why not extend SpaceGitHubService directly?

`SpaceGitHubService` currently mixes four responsibilities in one class: GitHub source ingestion, source-level dedup, PR-to-task resolution, and Task Agent session injection. Extending it would preserve the same coupling and keep the event bus downstream of an already-routed delivery pipeline.

The target architecture splits those responsibilities:
- `GitHubEventAdapter` owns only GitHub-specific webhook/polling/normalization.
- `ExternalEventStore` owns cross-source event lifecycle and retry-aware dedup.
- `EventTaskResolver` owns Space task enrichment.
- `EventRouter` owns node subscription matching and session delivery.

This makes GitHub one adapter among many instead of a special core daemon path. Future adapters (Slack, CI, etc.) publish the same `ExternalEvent` shape and reuse the same dedup, task enrichment, and delivery machinery.

### Why `deliveryMode: 'defer'` for event injection?

The existing defer mechanism already handles:
- Idle sessions: message enqueued immediately, processed on next turn.
- Busy sessions: message persisted as deferred, replayed after current turn.
- No dropped messages, no interrupted turns.

This is exactly the behavior we want for external events.

## 11. Testing Strategy

### Unit tests

1. **TopicTrie**: Insert patterns, verify lookup returns correct values for exact and wildcard matches.
2. **EventRouter**: Given subscriptions and events, verify scope filtering, topic validation before trie insertion, dedup, and delivery.
3. **ExternalEventStore**: Verify terminal duplicates are short-circuited, retryable duplicates are re-emitted, expected deliveries are registered before injection, successful per-subscription delivery advances the source event to terminal `delivered` only after all expected deliveries are terminal, and retry exhaustion advances to terminal `failed`.
4. **EventTaskResolver**: Given GitHub PR metadata, verify correct task enrichment and ambiguous/unknown states.
5. **GitHubEventAdapter**: Given webhook and polling payloads, verify signature handling, topic construction, dedupe keys, and `ExternalEvent` construction without querying Space tasks.
6. **Scope resolution**: Test `task` scope with enriched `routedTaskId` and various task/PR associations.

### Integration tests

1. **End-to-end webhook flow**: POST a GitHub webhook payload to the adapter route with a `review_submitted` action for PR #42 on repo `lsm/neokai`. Verify the adapter publishes `github/lsm/neokai/pull_request.review_submitted`, `EventTaskResolver` enriches it with the matching task, and the coder node's `task`-scoped subscription receives an injected message.

2. **Dedup across two events with same dedupeKey**: Publish the same GitHub PR review through webhook and polling (identical `dedupeKey`). Verify source-level bus dedup does not create two independent events, and per-subscription delivery dedup calls `injectMessage` exactly once for each interested node. Also verify retryable duplicate states re-emit after a simulated injection failure.

3. **Wake-on-idle delivery**: Set a node execution's session to `idle` state (agent finished its turn). Emit a matching event. Verify `injectMessage` is called with `deliveryMode: 'defer'` and the session processes the message on its next turn (via the existing defer replay mechanism).

4. **Pending node queuing**: Emit an event for a node whose execution is `pending` (no session yet). Verify the event is stored in the in-memory pending queue. Then simulate `TaskAgentManager` creating the session. Verify the queued event is flushed and injected into the new session as part of the first turn.
