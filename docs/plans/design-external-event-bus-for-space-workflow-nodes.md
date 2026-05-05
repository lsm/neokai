# Design: External Event Bus for Space Workflow Nodes

## Status: Draft

## Problem

The Space Agent spends most of its time relaying "check the new review comments" to the coder node. External events (PR reviews, CI failures, etc.) arrive via webhooks/polling but have no path to workflow **nodes** — they only route to Rooms or to the Space Agent's global session (via `SpaceGitHubService`). We need a system where workflow nodes declare interest in event types, and matching events are delivered directly to their agent sessions.

## Current State

Two parallel event pipelines exist today, neither of which routes to individual workflow nodes:

1. **Room pipeline** (`GitHubService`): Webhook → normalize → filter → security → route → `deliverToRoom()` → DaemonHub `room.message`. Routes to **Rooms**, not Spaces.
2. **Space pipeline** (`SpaceGitHubService`): Webhook → normalize → dedupe → `SpacePrTaskResolver.resolve()` → `injectTaskAgent()`. Routes events to the **Task Agent session** (the orchestrator), which must then manually relay to the coder node.

The Space pipeline already does the hard part — it normalizes events, resolves them to a task by PR number, and injects them into the Task Agent session. But it stops one hop short: the coder node still depends on the Task Agent to forward relevant events.

## Design Overview

```
External Event Sources (GitHub webhook, polling, future: Slack, CI)
       │
       ▼
┌─────────────────────┐
│  EventIngestion     │  Normalize → validate → publish to EventBus
│  (adapter per source│
└────────┬────────────┘
         │ publish(event) → hub.emit('space.externalEvent.published', { event })
         ▼
┌─────────────────────┐
│  EventBus           │  In-memory, backed by TypedHub. External topic is payload data.
│  (singleton)        │  Fixed TypedHub-safe method; router trie matches event.topic.
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  EventRouter        │  Subscribes to all topics. Matches events to
│  (per-runtime)      │  active node interests. Delivers via AgentMessageRouter
│                     │  or injects directly into sessions.
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
github/lsm/neokai/issues.opened
# Future CI adapter (Phase 3): github/lsm/neokai/check_suite.completed
github/lsm/neokai/pull_request.*            ← wildcard: all PR events for this repo
github/lsm/neokai/*.*                       ← wildcard: all events for this repo
github/lsm/neokai/pull_request.review_*     ← prefix wildcard: all review events
```

### Topic construction rules

1. `source` — adapter identifier (`github`, `slack`, `ci`). Lowercase, no slashes.
2. `owner/repo` — from the event's repository context. Both lowercase for case-insensitive matching.
3. `resource` — the event resource type. V1 GitHub adapter emits PR-related resources (`pull_request`, `pull_request.comment`, `pull_request.review`, `pull_request.review_comment`). CI resources such as `check_suite` are Phase 3/future adapter scope.
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

**`task` scope** is the critical innovation. The router resolves the task's context at match time:

1. The task's `SpaceTask` record has `workflowRunId` and (via `space_workflow_run_artifacts` where `key = 'pr_url'` matches the event's `prUrl`, or gate data with `branch_name`) an associated PR number and branch name.
2. The router queries the same `SpacePrTaskResolver` that `SpaceGitHubService` already uses to match PR numbers to tasks.
3. For a `task`-scoped subscription, the router checks: does this event's PR number / branch match the node execution's parent task?
4. The node author never specifies a PR number — it's implicit from the task context.

**`repo` scope** filters to events from any of the space's watched repositories (`space_github_watched_repos`). The node author doesn't need to know repo names.

**`global` scope** passes through all events in the same space matching the topic pattern. It is never cross-space: the router requires `event.spaceId === subscription.spaceId` before any scope-specific logic runs. Use sparingly (e.g. a space-local "global monitor" node).

### Auto-scoping resolution at runtime

When an event arrives, the router:

1. Verifies `event.spaceId` matches the subscription's `spaceId`, then extracts `prNumber` and `repoOwner/repoName` from the event payload.
2. For each active node execution with `eventInterests`:
   a. Compiles the interest's `topic` glob against the event's topic.
   b. If matched, checks scope:
      - `task`: resolves `SpaceTask` → `SpacePrTaskResolver` → does event's PR match this task?
      - `repo`: does event's repo match any watched repo in the node's space?
      - `global`: pass.
   c. If scope check passes, the event is queued for delivery to this node's agent session.

## 3. EventIngestion Adapter Interface

```typescript
// packages/daemon/src/lib/space/runtime/event-bus/types.ts

/**
 * A normalized external event on the bus.
 */
export interface ExternalEvent {
  /** Unique event ID (UUID) */
  id: string;
  /** Space this event was routed for. Required to prevent cross-space delivery. */
  spaceId: string;
  /** Fully qualified topic: 'github/owner/repo/resource.action' */
  topic: string;
  /** Timestamp when the event occurred (epoch ms) */
  occurredAt: number;
  /** Timestamp when the event was ingested (epoch ms) */
  ingestedAt: number;
  /** Source adapter identifier */
  source: string;
  /**
   * For scope resolution. Not all events have a PR number;
   * absence means 'task'-scoped subscriptions won't match.
   */
  prNumber?: number;
  /** Repository owner (lowercase) */
  repoOwner?: string;
  /** Repository name (lowercase) */
  repoName?: string;
  /** Branch name, if available */
  branch?: string;
  /** Human-readable summary for agent consumption */
  summary: string;
  /** External URL (e.g. GitHub PR link) */
  externalUrl?: string;
  /** Structured payload — adapter-specific, not constrained */
  payload: Record<string, unknown>;
  /**
   * Deduplication key. The bus tracks delivered events by (eventId, nodeId)
   * to prevent double delivery.
   */
  dedupeKey: string;
}

/**
 * Interface that event source adapters must implement.
 */
export interface EventAdapter {
  /** Adapter identifier (used in topic namespace: '{source}/...') */
  readonly sourceId: string;

  /**
   * Start the adapter. Called once at daemon startup.
   * The adapter calls `publisher.publish(event)` whenever it has an event.
   */
  start(publisher: EventPublisher): Promise<void>;

  /** Stop the adapter. Called at daemon shutdown. */
  stop(): Promise<void>;
}

/**
 * Callback adapters use to publish events onto the bus.
 */
export interface EventPublisher {
  publish(event: ExternalEvent): Promise<void>;
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
  'space.externalEvent.published': { spaceId: string; event: ExternalEvent };
}
```

### GitHub adapter

The GitHub adapter wraps the existing `SpaceGitHubService.ingest()` pipeline. Rather than duplicating normalization logic, the adapter hooks into the point where `SpaceGitHubService` has already normalized and resolved the event:

```typescript
class GitHubEventAdapter implements EventAdapter {
  readonly sourceId = 'github';

  constructor(
    private readonly spaceGitHubService: SpaceGitHubService,
    private readonly watchedRepoLookup: (owner: string, repo: string) => { spaceId: string }[]
  ) {}

  async start(publisher: EventPublisher): Promise<void> {
    // Hook into SpaceGitHubService by intercepting the post-normalization path.
    // SpaceGitHubService already:
    //   1. Normalizes the webhook/polling event
    //   2. Deduplicates via dedupeKey
    //   3. Resolves PR → taskId via SpacePrTaskResolver
    //   4. Emits DaemonHub 'space.githubEvent.routed'
    //
    // The adapter subscribes to 'space.githubEvent.routed' on DaemonHub
    // and converts the event to an ExternalEvent for the bus.
    //
    // This means:
    //   - No change to existing webhook/polling normalization
    //   - Events continue flowing to Task Agent as before
    //   - Additionally, events appear on the EventBus for node delivery
  }
}
```

The adapter subscribes to the existing `space.githubEvent.routed` DaemonHub event (already emitted by `SpaceGitHubService.appendTaskActivity`). It converts the event to `ExternalEvent` format and publishes to the bus.

**Note — normalized field gap:** The current `space.githubEvent.routed` payload emitted by `appendTaskActivity` only includes `{ repo, prNumber, eventType, summary, externalUrl }`. It does NOT include the stable dedupe identifiers or the full normalized GitHub fields needed for topic construction and fallback task resolution.

**Fix:** Extend the `appendTaskActivity` payload in `SpaceGitHubService` to include the normalized fields consumed by the adapter:

```typescript
// In space-github.ts, appendTaskActivity():
this.daemonHub?.emit('space.githubEvent.routed', {
    sessionId: 'global',
    spaceId,
    taskId,
    event: {
        repo: `${event.repoOwner}/${event.repoName}`,
        prNumber: event.prNumber,
        eventType: event.eventType,
        action: event.action,
        source: event.source,
        summary: event.summary,
        prUrl: event.prUrl,
        externalUrl: event.externalUrl,
        externalId: event.externalId,
        actor: event.actor,
        body: event.body,
        occurredAt: event.occurredAt,
        rawPayload: event.rawPayload,
        dedupeKey: event.dedupeKey,
        deliveryId: event.deliveryId,
    },
});
```

This is a payload-contract extension to `appendTaskActivity` using fields already available on the `NormalizedSpaceGitHubEvent` at the call site plus the enclosing `spaceId`. `dedupeKey` and `deliveryId` are required for stable upstream event identity; `prUrl` and the other normalized fields keep the `SpacePrTaskResolver` fallback functional if `taskId` is absent; `spaceId` prevents cross-space delivery on the shared daemon event stream.

**Why this approach:**
- Minimal change to the existing `SpaceGitHubService` — additional normalized fields in an existing DaemonHub emission, with no changes to ingestion/dedup/routing behavior.
- The existing PR-to-task resolution (`SpacePrTaskResolver`) continues to work.
- The existing Task Agent injection continues to work (we don't replace it, we supplement it).
- The adapter is purely additive: it converts an already-normalized event into bus format.
- `rawPayload` is included so adapter consumers (and future adapters) have access to the full original event data without re-fetching from GitHub.

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
```

### EventRouter implementation sketch

```typescript
class EventRouter {
  // topic trie for fast lookup
  private topicTrie: TopicTrie<Subscription[]> = new TopicTrie();

  // track which runs have active subscriptions (for lifecycle management)
  private activeRuns: Map<string, Set<Subscription>> = new Map();

  // dedup: (dedupeKey, agentSessionId) → timestamp
  private delivered: Map<string, number> = new Map();
  // TTL for dedup entries — entries older than this are evicted on next access
  private static readonly DEDUP_TTL_MS = 10 * 60 * 1000; // 10 minutes

  // Cache: spaceId → Set of "owner/repo" strings for watched repos
  // Invalidated via invalidateWatchedRepoCache() when repos are added/removed
  // through the `space.github.watchRepo` RPC path.
  private watchedRepoCache: Map<string, Set<string>> = new Map();

  constructor(
    private readonly eventBus: EventBus,
    private readonly nodeExecutionRepo: NodeExecutionRepository,
    private readonly taskRepo: SpaceTaskRepository,
    private readonly spaceTaskManager: SpaceTaskManager,
    private readonly sessionFactory: SessionFactory,
    private readonly prResolver: SpacePrTaskResolver,
    private readonly spaceGitHubRepo: SpaceGitHubRepository,
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
      const repos = this.spaceGitHubRepo.listWatchedRepos(spaceId);
      cached = new Set(
        repos.filter(r => r.enabled).map(r => `${r.owner.toLowerCase()}/${r.repo.toLowerCase()}`)
      );
      this.watchedRepoCache.set(spaceId, cached);
    }
    return cached.has(`${owner.toLowerCase()}/${repo.toLowerCase()}`);
  }

  /**
   * Invalidate the watched-repo cache for a given space (or all spaces).
   * Called when watched repos change via the `space.github.watchRepo` RPC path
   * (enabling/disabling repos). Without this, `repo`-scoped matching grows stale
   * until process restart.
   */
  invalidateWatchedRepoCache(spaceId?: string): void {
    if (spaceId) {
      this.watchedRepoCache.delete(spaceId);
    } else {
      this.watchedRepoCache.clear();
    }
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
    const desiredSubs = new Map<string, Subscription>();  // key: `${taskId}:${nodeId}:${agentName}:${topic}:${scope}`

    for (const node of workflow.nodes) {
      for (const agent of node.agents) {
        if (!agent.eventInterests?.length) continue;

        const exec = nodeExecutions.find(
          e => e.workflowNodeId === node.id && e.agentName === agent.name
        );
        if (!exec || !isReceivingStatus(exec.status)) continue;

        const subKey = `${taskId}:${node.id}:${agent.name}`;
        for (const interest of agent.eventInterests) {
          // Include taskId, topic, and scope in key — the same run can contain
          // multiple tasks, and the same agent can subscribe to the same topic
          // with different scopes (e.g., both 'task' and 'repo' scope).
          const fullKey = `${subKey}:${interest.topic}:${interest.scope}`;
          desiredSubs.set(fullKey, {
            workflowRunId,
            taskId,
            nodeId: node.id,
            agentName: agent.name,
            interest,
            agentSessionId: exec.agentSessionId,
            spaceId,
          });
        }
      }
    }

    // Diff against current subscriptions for THIS task only. A workflow run can
    // contain multiple tasks, so refreshing task A must not remove task B's
    // subscriptions from the same run.
    const currentRunSubs = this.activeRuns.get(workflowRunId) ?? new Set<Subscription>();
    const currentTaskSubs = [...currentRunSubs].filter(sub => sub.taskId === taskId);
    const currentKeys = new Set<string>();
    for (const sub of currentTaskSubs) {
      currentKeys.add(`${sub.taskId}:${sub.nodeId}:${sub.agentName}:${sub.interest.topic}:${sub.interest.scope}`);
    }
    const desiredKeys = new Set(desiredSubs.keys());

    // Remove this task's subscriptions no longer in the desired set (e.g. node went cancelled).
    for (const key of currentKeys) {
      if (!desiredKeys.has(key)) {
        const [subTaskId, nodeId, agentName, ...rest] = key.split(':');
        const scope = rest.pop()!;
        const topic = rest.join(':');
        this.topicTrie.remove(
          v => v.workflowRunId === workflowRunId
            && v.taskId === subTaskId
            && v.nodeId === nodeId
            && v.agentName === agentName
            && v.interest.topic === topic
            && v.interest.scope === scope,
        );
      }
    }

    // Add new subscriptions not currently in the trie.
    for (const [key, sub] of desiredSubs) {
      if (!currentKeys.has(key)) {
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
    const runSubs = this.activeRuns.get(workflowRunId);
    if (!runSubs) return;

    this.topicTrie.remove(v => v.workflowRunId === workflowRunId);
    this.activeRuns.delete(workflowRunId);

    // Also clean up dedup entries for this run.
    // Delivery keys are: `${event.dedupeKey}:${sub.taskId}:${sub.nodeId}:${sub.agentName}:${workflowRunId}`
    // The run ID is the final segment — match with suffix `:${workflowRunId}`.
    const suffix = `:${workflowRunId}`;
    for (const key of this.delivered.keys()) {
      if (key.endsWith(suffix)) {
        this.delivered.delete(key);
      }
    }

    // Clean up in-memory pending queue for this run.
    // Keys are `${workflowRunId}:${taskId}:${nodeId}:${agentName}` — use the
    // delimiter to avoid false prefix matches (e.g., run "abc1" matching "abc10:*").
    const runPrefix = `${workflowRunId}:`;
    for (const [key, events] of this.pendingQueue.entries()) {
      if (key.startsWith(runPrefix)) {
        this.pendingQueue.delete(key);
      }
    }
  }

  private async handleEvent(event: ExternalEvent): Promise<void> {
    // 1. Look up matching subscriptions via trie
    const matched = this.topicTrie.lookup(event.topic);

    if (matched.length === 0) return;

    // 2. For each matched subscription, check scope and deliver.
    // Isolate failures per subscription so one bad repo/task lookup or injection
    // does not prevent other interested nodes from receiving the same event.
    for (const sub of matched) {
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
    // Scope check
    if (!this.passesScopeCheck(event, sub)) return;

    // Dedup check — include taskId and nodeId to handle multi-task runs and
    // cases where the same agent name appears in multiple nodes within the same
    // run. Each task/node/agent subscription is deduped independently.
    // Evict before checking so DEDUP_TTL_MS is actually enforced during long runs.
    this.evictStaleDedup();
    const dedupeKey = `${event.dedupeKey}:${sub.taskId}:${sub.nodeId}:${sub.agentName}:${sub.workflowRunId}`;
    if (this.delivered.has(dedupeKey)) return;

    // Mark dedup BEFORE session resolution / queueing. This prevents the same
    // event from being queued multiple times for inactive sessions — if the
    // event arrives again before the queued delivery is flushed, the dedup
    // check above will catch it. The tradeoff is that if injection fails (e.g.
    // session crashes during delivery), the event will not be retried; this is
    // acceptable because the upstream SpaceGitHubService re-polls on restart
    // and will generate a fresh event.
    this.delivered.set(dedupeKey, Date.now());

    // Resolve session — re-read from nodeExecutionRepo for latest state
    const sessionId = await this.resolveSession(sub);
    if (!sessionId) {
      // Session not active — queue for later delivery
      this.queueForDelivery(event, sub);
      return;
    }

    // Format and inject.
    // NOTE: There is a TOCTOU race — the session could complete between our
    // resolveSession call and injectMessage. This is safe: injectMessage on a
    // completed/absent session returns a caught error (logged as a warning),
    // and the dedup map prevents re-delivery if the same event arrives again
    // after the session restarts. No data loss or corruption occurs.
    const message = this.formatEventMessage(event);
    try {
      await this.sessionFactory.injectMessage(sessionId, message, {
        deliveryMode: 'defer',
      });
    } catch (err) {
      log.warn(`Failed to deliver event to ${sub.agentName}`, { error: err });
      // Session may have completed between resolution and injection.
      // The event is already dedup-marked so it won't be re-delivered for
      // this run. A fresh event will arrive via the next poll cycle if the
      // underlying external event is still relevant.
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
        // Uses SpaceGitHubRepository.getEnabledRepos(owner, repo) which queries
        // the `space_github_watched_repos` table filtered by (spaceId, owner, repo, enabled=1).
        // The router caches this per-space to avoid DB hits on every event.
        if (!event.repoOwner || !event.repoName) return false;
        return this.isWatchedRepo(sub.spaceId, event.repoOwner, event.repoName);
      }

      case 'task': {
        // The DaemonHub 'space.githubEvent.routed' event already carries the
        // resolved taskId from SpacePrTaskResolver. We use that directly instead
        // of re-running the resolver, which could match a historical task outside
        // this run (SpacePrTaskResolver searches ALL tasks in the space).
        //
        // We constrain matching to the subscription's OWN task, not merely any
        // task in the same workflow run. This prevents cross-task leakage in
        // multi-task runs (e.g., two PR tasks sharing a workflowRunId).
        if (!event.prNumber) return false;

        // Optimization: the adapter includes the routed taskId in ExternalEvent.payload.
        // Use it for a direct equality check against this subscription's task.
        const routedTaskId = event.payload?.taskId as string | undefined;
        if (routedTaskId) {
          return routedTaskId === sub.taskId;
        }

        // Fallback (should rarely happen): if the adapter didn't include taskId,
        // resolve with the full normalized GitHub shape. SpacePrTaskResolver's
        // primary queries use prUrl, so passing only owner/repo/prNumber would
        // make this fallback ineffective for older routed payloads.
        if (event.source !== 'github') return false;
        const resolved = this.prResolver.resolve(sub.spaceId, {
          deliveryId: event.payload?.deliveryId as string | undefined,
          dedupeKey: event.dedupeKey,
          source: 'webhook',
          eventType: event.payload?.eventType as string,
          action: event.payload?.action as string,
          repoOwner: event.repoOwner ?? '',
          repoName: event.repoName ?? '',
          prNumber: event.prNumber,
          prUrl: (event.payload?.prUrl as string | undefined) ?? event.externalUrl,
          actor: event.payload?.actor as string | undefined,
          body: event.payload?.body as string | undefined,
          summary: event.summary,
          externalUrl: event.externalUrl,
          externalId: event.payload?.externalId as string | undefined,
          occurredAt: (event.payload?.occurredAt as string | undefined) ?? new Date(event.occurredAt).toISOString(),
          rawPayload: event.payload?.rawPayload,
        } as NormalizedSpaceGitHubEvent);
        return resolved.taskId === sub.taskId;
      }
    }
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
                                                    Mark delivered  Mark delivered  Await session
                                                                                     start
```

### Deduplication

- **Key**: `(event.dedupeKey, subscription.taskId, subscription.nodeId, subscription.agentName, subscription.workflowRunId)` — includes `taskId` to isolate multi-task runs and `nodeId` to handle cases where the same agent name appears in multiple nodes within the same run.
- **Storage**: In-memory `Map<string, number>` (timestamp). Evicted when the workflow run completes.
- **Guarantee**: Same external event is never delivered twice to the same node agent within a run.
- The upstream `SpaceGitHubService` already deduplicates by `(spaceId, dedupeKey)` — this is an additional per-node dedup.

### Wake-on-idle

When an event matches a subscription whose node execution is `idle` (agent session exists but finished its turn):

1. Call `sessionFactory.injectMessage(sessionId, message, { deliveryMode: 'defer' })`.
2. The existing defer mechanism handles waking: if idle → enqueue immediately; if busy → persist as deferred, replay after current turn.
3. No new wake mechanism needed — the existing `SessionNotificationSink` pattern already solves this.

### Queue for not-yet-started nodes

When a node execution is `pending` (no session yet):

1. The event is queued in an in-memory `Map<string, ExternalEvent[]>` keyed by `${workflowRunId}:${taskId}:${nodeId}:${agentName}`.
2. When `TaskAgentManager` creates the node's session, it checks for queued events.
3. Queued events are injected as initial context in the session's first turn.
4. Queue is bounded: max 50 events per execution, oldest dropped (with a warning log).

**Known limitation — daemon restart**: The in-memory pending queue is lost on daemon restart. For v1, this is acceptable because:
- Events between daemon restarts are also lost (the webhook/polling pipeline itself doesn't guarantee delivery during downtime).
- The existing `SpaceGitHubService` polling service re-polls on startup, so events that arrived during downtime are re-normalized and re-routed.
- For nodes that are still `pending` after restart, the next poll cycle will generate fresh events that flow through the bus.

If persistent queuing is needed in a future iteration, events can be persisted to a `space_event_delivery_queue` SQLite table with the same schema as the in-memory map, and drained on node activation.

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
   * Remove all values matching a predicate.
   */
  remove(predicate: (value: T) => boolean): void {
    const clean = (node: TrieNode<T>) => {
      if (node.values) {
        node.values = node.values.filter(v => !predicate(v));
      }
      for (const child of node.exactChildren.values()) {
        clean(child);
      }
      for (const child of node.globChildren.values()) {
        clean(child);
      }
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

### Changes to existing code

**Routed payload contract extension.** The `appendTaskActivity` method in `space-github.ts` must include the normalized fields consumed by the adapter in the `space.githubEvent.routed` DaemonHub payload, including `action`, `source`, `prUrl`, `externalId`, `actor`, `body`, `occurredAt`, `rawPayload`, `dedupeKey`, and `deliveryId`. The adapter requires `dedupeKey` as the stable upstream event identity for per-subscription deduplication, `deliveryId` preserves the unique GitHub delivery identifier used to build that identity, and `prUrl` keeps the `SpacePrTaskResolver` fallback functional. This is the only change to existing code. All other existing behavior (webhook handling, polling, normalization, Task Agent injection) remains unchanged.

```
SpaceGitHubService.handleWebhook()
    → normalizeSpaceGitHubWebhook()
    → ingest(spaceId, normalized)
        → storeEvent() + dedupe
        → SpacePrTaskResolver.resolve()
        → appendTaskActivity()
            → DaemonHub.emit('space.githubEvent.routed', { taskId, event })
        → scheduleTaskNotification()
            → injectTaskAgent(taskId, message)
```

The GitHub adapter subscribes to `space.githubEvent.routed` and converts it:

```typescript
// No changes to SpaceGitHubService.
// The adapter is a new subscriber:

class GitHubEventAdapter implements EventAdapter {
  async start(publisher: EventPublisher): Promise<void> {
    this.daemonHub.on('space.githubEvent.routed', async (data) => {
      const { event, spaceId, taskId } = data;
      const [repoOwner, repoName] = event.repo.split('/');

      // Construct topic from event.
      // mapEventType returns the full resource.action string and preserves the
      // original GitHub action so users can filter created/edited/deleted/etc.
      const topic = `github/${repoOwner}/${repoName}/${mapEventType(event.eventType, event.action)}`;

      // Publish to bus. Preserve the upstream occurrence time for ordering,
      // queue TTL, and latency diagnostics; only ingestedAt is "now".
      const externalEvent: ExternalEvent = {
        id: crypto.randomUUID(),
        spaceId,
        topic,
        occurredAt: new Date(event.occurredAt).getTime(),
        ingestedAt: Date.now(),
        source: 'github',
        prNumber: event.prNumber,
        repoOwner,
        repoName,
        summary: event.summary,
        externalUrl: event.externalUrl,
        payload: {
          // Full normalized event for adapter consumers and resolver fallback
          eventType: event.eventType,
          action: event.action,
          source: event.source,
          taskId,
          prUrl: event.prUrl,
          deliveryId: event.deliveryId,
          externalId: event.externalId,
          actor: event.actor,
          body: event.body,
          occurredAt: event.occurredAt,
          rawPayload: event.rawPayload,   // Include original webhook/polling payload
        },
        dedupeKey: event.dedupeKey,  // Use upstream identity (includes deliveryId); avoids collapsing distinct events that share repo/pr/action/url
      };

      await publisher.publish(externalEvent);
    });
  }
}
```

### Event type mapping

The `SpaceGitHubService` already normalizes to `SpaceGitHubEventKind` (`issue_comment`, `pull_request_review`, `pull_request_review_comment`, `pull_request`). We map these to bus topics:

| SpaceGitHubEventKind | `mapEventType(kind, action)` returns |
|---|---|
| `issue_comment` | `pull_request.comment_${action}` (PR comments only; created, edited, deleted) |
| `pull_request_review` | `pull_request.review_${action}` (submitted, edited, dismissed) |
| `pull_request_review_comment` | `pull_request.review_comment_${action}` (created, edited, deleted) |
| `pull_request` | `pull_request.${action}` (opened, synchronize, closed, etc.) |

```typescript
function mapEventType(kind: string, action: string): string {
  switch (kind) {
    case 'issue_comment': return `pull_request.comment_${action}`;
    case 'pull_request_review': return `pull_request.review_${action}`;
    case 'pull_request_review_comment': return `pull_request.review_comment_${action}`;
    case 'pull_request': return `pull_request.${action}`;
    default: return `${kind}.${action}`;
  }
}
```

### Task-scoped resolution optimization

For `task` scope, we already have the `taskId` from `space.githubEvent.routed`. The router can short-circuit:

1. Look up subscriptions whose `sub.taskId` equals the routed event `taskId` and whose `eventInterests` match the topic.
2. Only deliver to those task-owned subscriptions — nodes attached to other tasks in the same workflow run do not pass `task` scope.

This optimization turns the common case (one coder node interested in review comments) into a direct map lookup: `taskId → subscriptions → filter by interest topic match`.

## 8. Migration Path

### DB schema changes

No new tables required for V1. Event interests are stored as part of the workflow definition JSON in `space_workflows.nodes[].agents[].eventInterests`. The existing JSON serialization of workflow nodes already supports arbitrary fields. Task-scoped delivery uses the current `SpaceTask.id` passed into `registerRunInterests(...)` by the runtime and the routed `taskId` already emitted by `space.githubEvent.routed`; no node-execution schema change is required.

### Type changes

1. Add `EventInterest` interface to `packages/shared/src/types/space.ts`.
2. Add `eventInterests?: EventInterest[]` to `WorkflowNodeAgent`.
3. Add validation in the workflow create/update path (Zod schema or manual validation):
   - `topic` must pass `validateGlobPattern()` (non-empty, exactly 4 segments, no `..` segments, no double slashes, valid characters including segment-local `*`).
   - `scope` must be one of `'task' | 'repo' | 'global'`.
   - Max 10 interests per agent slot (prevent abuse).
   - `validateGlobPattern()` is the single source of truth — called at workflow create/update and again at trie insertion time as a safety net.

### New files

```
packages/daemon/src/lib/space/runtime/event-bus/
  ├── types.ts              # ExternalEvent, EventAdapter, EventPublisher interfaces
  ├── event-bus.ts           # EventBus singleton (wraps TypedHub)
  ├── topic-trie.ts          # TopicTrie<T> implementation
  ├── topic-validator.ts     # validateGlobPattern() helper
  ├── event-router.ts        # EventRouter — subscribes to bus, matches, delivers
  ├── github-adapter.ts      # GitHubEventAdapter — bridges SpaceGitHubService → EventBus
  └── index.ts               # Public exports
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

  return { valid: true };
}
```

### Wiring into SpaceRuntime

```typescript
// In SpaceRuntimeConfig, add:
interface SpaceRuntimeConfig {
  // ... existing fields ...
  eventBus?: EventBus;  // Optional — created internally if not provided
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

// In the `space.github.watchRepo` RPC handler (packages/daemon/src/lib/rpc-handlers/index.ts):
// After persisting the watch/unwatch change, invalidate the watched-repo cache
// so that repo-scoped matching reflects the new state immediately.
await this.eventRouter.invalidateWatchedRepoCache(spaceId);

// In daemon startup (e.g. in SpaceRuntimeService or init function):
const eventBus = new EventBus(daemonHub);
const eventRouter = new EventRouter(eventBus, ...dependencies);
const githubAdapter = new GitHubEventAdapter(daemonHub);

await githubAdapter.start(eventBus);
```

### Phased rollout

**Phase 1 (MVP — this PR):**
- Add `EventInterest` type to `WorkflowNodeAgent`.
- Implement `EventBus`, `TopicTrie`, `EventRouter`, `GitHubEventAdapter`.
- Wire GitHub adapter to existing `space.githubEvent.routed` events.
- Deliver events to coder nodes with `task` scope.
- No UI changes needed — event interests are authored in workflow JSON.

**Phase 2 (follow-up):**
- Add `eventInterests` editor to the workflow visual editor UI.
- Add event delivery status to the task activity panel.
- Add digest/coalescing for high-frequency events.
- Add metrics: events matched, events delivered, delivery latency.

**Phase 3 (future extensibility):**
- Slack adapter: subscribe to Slack Events API, normalize to `ExternalEvent`, publish.
- CI adapter: subscribe to GitHub Check Suite events, normalize, publish.
- Custom adapter API: allow Space operators to register custom adapters via config.

## 9. Relationship to Existing Systems

| Existing system | Relationship |
|---|---|
| **DaemonHub / TypedHub** | `EventBus` is a TypedHub participant on the shared `InProcessTransportBus`. It publishes all external events through the fixed valid method `space.externalEvent.published`; slash-delimited external topics stay in `ExternalEvent.topic` and are matched by the router trie. |
| **GitHubService** (Room pipeline) | Unchanged. Continues routing to Rooms. The event bus is additive. |
| **SpaceGitHubService** (Space pipeline) | Unchanged. Continues injecting into Task Agent. The GitHub adapter subscribes to `space.githubEvent.routed` as an additional consumer. |
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

1. **Performance**: Trie lookup is O(k) per event regardless of subscription count. Regex matching is O(n) per event where n = number of subscriptions.
2. **Composability**: Trie supports incremental add/remove (subscriptions change as nodes activate/deactivate). Regex requires rebuilding the full pattern.
3. **Debuggability**: Trie structure can be inspected and visualized. Regex patterns are opaque.

### Why not extend SpaceGitHubService directly?

The adapter pattern separates concerns:
- `SpaceGitHubService` owns GitHub-specific normalization, dedup, and PR resolution.
- The event bus is source-agnostic (GitHub, Slack, CI, etc.).
- The adapter bridges the two without coupling.
- Future adapters (Slack, CI) don't touch `SpaceGitHubService`.

### Why `deliveryMode: 'defer'` for event injection?

The existing defer mechanism already handles:
- Idle sessions: message enqueued immediately, processed on next turn.
- Busy sessions: message persisted as deferred, replayed after current turn.
- No dropped messages, no interrupted turns.

This is exactly the behavior we want for external events.

## 11. Testing Strategy

### Unit tests

1. **TopicTrie**: Insert patterns, verify lookup returns correct values for exact and wildcard matches.
2. **EventRouter**: Given subscriptions and events, verify scope filtering, dedup, and delivery.
3. **GitHubEventAdapter**: Given a `space.githubEvent.routed` event, verify correct `ExternalEvent` construction.
4. **Scope resolution**: Test `task` scope with various task/PR associations.

### Integration tests

1. **End-to-end webhook flow**: Emit a `space.githubEvent.routed` event with a review_submitted action for PR #42 on repo `lsm/neokai`. The coder node in a workflow has `task`-scoped interest in `github/*/*/pull_request.review_submitted`. Verify the event reaches the coder node's session as an injected message.

2. **Dedup across two events with same dedupeKey**: Emit two `space.githubEvent.routed` events for the same PR review (identical `dedupeKey`). Verify `injectMessage` is called exactly once for the coder node — the second event is silently dropped by the dedup check. Also verify that if two *different* nodes subscribe to the same event (e.g., coder + ci-monitor), each node receives exactly one injection independently.

3. **Wake-on-idle delivery**: Set a node execution's session to `idle` state (agent finished its turn). Emit a matching event. Verify `injectMessage` is called with `deliveryMode: 'defer'` and the session processes the message on its next turn (via the existing defer replay mechanism).

4. **Pending node queuing**: Emit an event for a node whose execution is `pending` (no session yet). Verify the event is stored in the in-memory pending queue. Then simulate `TaskAgentManager` creating the session. Verify the queued event is flushed and injected into the new session as part of the first turn.
