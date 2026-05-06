# Plan: Internal Event, Command, and Query Architecture

## Status

Draft proposal for progressive migration.

## Problem

Neokai currently has several overlapping messaging/event mechanisms:

- legacy `EventBus` in `packages/shared/src/event-bus.ts`;
- `TypedHub` and `MessageHub` infrastructure;
- daemon-wide `DaemonHub` built as `TypedHub<DaemonEventMap>`;
- manual daemon-to-client event forwarding in `StateManager`;
- `NotificationSink` for Space runtime notifications;
- direct service-to-session delivery paths such as `SpaceGitHubService.injectTaskAgent(...)`;
- storage-local eventing via `ReactiveDatabase`.

This makes the event-driven architecture hard to reason about. Developers need to know which bus/hub/sink to use, whether a message is internal or client-visible, whether a handler is awaited, and whether `sessionId` is an actual session or a channel string such as `room:${roomId}` or `space:${spaceId}`.

The target model should be semantic and boring:

- **Event**: a fact that already happened.
- **Command**: a request for the system to do something.
- **Query**: a request to read state.

## Target Naming

Use one consistent internal trio:

- `InternalEventBus`
- `InternalCommandBus`
- `InternalQueryBus`

The names are intentionally internal because they describe trusted daemon-side application messaging. Client delivery and external source ingestion are separate layers.

Supporting services:

- `Channels` / `ChannelRegistry` — canonical channel construction and parsing.
- `ClientEventGateway` — sends client-safe events over WebSocket or a future client transport.
- `ClientEventBridge` — declaratively maps selected internal events to client events/channels.
- `StateProjectionService` — listens to events and maintains daemon read models/caches.
- `ExternalEventService` — normalizes, dedupes, persists, and publishes external source events.
- `ExternalEventRouter` — routes external events to workflow node subscriptions and agent sessions.

## Design Principles

1. **Events are facts**. Event names should be past tense or state-change facts, for example `space.task.blocked`, `session.created`, `externalEvent.published`.
2. **Commands request actions**. Command names should be imperative/action-oriented, for example `agent.message.inject`, `space.workflow.resume`, `github.repo.watch`.
3. **Queries read state**. Query names should return data and avoid side effects, for example `space.workflowRun.get`, `room.tasks.list`.
4. **No silent failures**. Handler errors must be logged, returned, or surfaced through a failure result/event.
5. **Publish semantics are explicit**. Fire-and-forget and wait-for-handlers behavior must be separate APIs or clearly documented.
6. **Channels are first-class**. Do not overload `sessionId` as a generic channel field in new APIs.
7. **Internal events are not automatically client events**. Client visibility is explicit through `ClientEventBridge`.
8. **State projection is not event forwarding**. State caches and client broadcasting are separate responsibilities.
9. **External event delivery is durable and idempotent**. Source dedupe and per-subscription delivery lifecycle belong to the external event subsystem, not source-specific services.
10. **Current infrastructure can remain under the hood during migration**. The clean APIs should wrap existing `DaemonHub`/`MessageHub` first, then progressively replace legacy concepts.

## Target Architecture

```text
Internal producers
  ├─ publish facts ───────────────▶ InternalEventBus
  ├─ dispatch requested actions ──▶ InternalCommandBus
  └─ execute reads ───────────────▶ InternalQueryBus

InternalEventBus
  ├─ StateProjectionService       updates read models/caches
  ├─ ClientEventBridge            maps selected events to ClientEventGateway
  ├─ AgentNotificationService     turns domain events into agent-facing messages
  ├─ Audit/metrics subscribers    record observability data
  └─ ExternalEventRouter          routes external events to workflow node agents

ClientEventGateway
  └─ WebSocket/MessageHub clients
```

## Core APIs

### Channels

New code should construct channels through helpers rather than inline strings.

```ts
export type EventChannel =
  | { kind: 'global' }
  | { kind: 'session'; sessionId: string }
  | { kind: 'room'; roomId: string }
  | { kind: 'space'; spaceId: string }
  | { kind: 'workflowRun'; spaceId: string; workflowRunId: string }
  | { kind: 'task'; spaceId: string; taskId: string };

export const Channels = {
  global: (): EventChannel => ({ kind: 'global' }),
  session: (sessionId: string): EventChannel => ({ kind: 'session', sessionId }),
  room: (roomId: string): EventChannel => ({ kind: 'room', roomId }),
  space: (spaceId: string): EventChannel => ({ kind: 'space', spaceId }),
  workflowRun: (spaceId: string, workflowRunId: string): EventChannel => ({
    kind: 'workflowRun',
    spaceId,
    workflowRunId,
  }),
  task: (spaceId: string, taskId: string): EventChannel => ({ kind: 'task', spaceId, taskId }),
};
```

During migration, channels can serialize to the existing route strings:

```text
global
session:${sessionId} or the legacy bare session id
room:${roomId}
space:${spaceId}
workflowRun:${spaceId}:${workflowRunId}
task:${spaceId}:${taskId}
```

### InternalEventBus

```ts
interface InternalEventEnvelope<TPayload> {
  id: string;
  name: string;
  channel: EventChannel;
  occurredAt: number;
  correlationId?: string;
  causationId?: string;
  actor?: EventActor;
  payload: TPayload;
}

interface InternalEventBus<TEventMap> {
  publish<K extends keyof TEventMap>(
    name: K,
    event: { channel: EventChannel; payload: TEventMap[K]; correlationId?: string; causationId?: string },
  ): Promise<EventPublishAccepted>;

  publishAndWait<K extends keyof TEventMap>(
    name: K,
    event: { channel: EventChannel; payload: TEventMap[K]; correlationId?: string; causationId?: string },
  ): Promise<EventPublishResult>;

  subscribe<K extends keyof TEventMap>(
    name: K,
    handler: (event: InternalEventEnvelope<TEventMap[K]>) => void | Promise<void>,
    options?: { subscriberName?: string },
  ): UnsubscribeFn;
}
```

`publish(...)` means accepted/enqueued. `publishAndWait(...)` means all local internal handlers have completed or reported failure. Neither mode may swallow handler failures silently.

### InternalCommandBus

```ts
interface InternalCommandBus<TCommandMap> {
  dispatch<K extends keyof TCommandMap>(name: K, command: TCommandMap[K]): Promise<CommandResult>;
  register<K extends keyof TCommandMap>(
    name: K,
    handler: (command: TCommandMap[K]) => Promise<CommandResult>,
  ): UnsubscribeFn;
}
```

Commands should normally have one owner/handler. Duplicate command handlers should be rejected unless explicitly configured as middleware.

### InternalQueryBus

```ts
interface InternalQueryBus<TQueryMap> {
  execute<K extends keyof TQueryMap>(name: K, query: TQueryMap[K]['input']): Promise<TQueryMap[K]['output']>;
  register<K extends keyof TQueryMap>(
    name: K,
    handler: (query: TQueryMap[K]['input']) => Promise<TQueryMap[K]['output']>,
  ): UnsubscribeFn;
}
```

Queries should be side-effect free and should not publish events as part of normal execution.

## Event Naming Convention

Use dot-separated names with lower camel case inside each segment.

Recommended patterns:

```text
session.created
session.updated
room.task.updated
space.task.blocked
space.workflowRun.completed
externalEvent.published
externalEvent.deliveryFailed
github.repoWatched
```

Rules for new names:

- use dots, not colons;
- use camelCase, not snake_case;
- group by domain first;
- use fact/state-change wording for events;
- do not use raw external topics as internal event names.

## Domain Event Maps

Avoid one giant event map file. Compose the internal map from domain-owned maps.

```ts
export interface SessionEvents { /* session.* */ }
export interface RoomEvents { /* room.* */ }
export interface SpaceEvents { /* space.* */ }
export interface ExternalEvents { /* externalEvent.* */ }
export interface GitHubEvents { /* github.* */ }
export interface StorageEvents { /* storage.* */ }

export type InternalEventMap = SessionEvents
  & RoomEvents
  & SpaceEvents
  & ExternalEvents
  & GitHubEvents
  & StorageEvents;
```

This gives each subsystem a clear owner and makes additions reviewable.

## Client Event Boundary

Internal events are trusted daemon facts. Client events are UI/API contracts. They must remain separated.

```ts
const CLIENT_EVENT_BRIDGE = defineClientEventBridge<InternalEventMap, ClientEventMap>({
  'space.workflowRun.updated': {
    clientEvent: 'space.workflowRun.updated',
    channel: (event) => Channels.space(event.payload.spaceId),
    transform: (event) => ({
      spaceId: event.payload.spaceId,
      workflowRunId: event.payload.workflowRunId,
      status: event.payload.status,
    }),
  },

  'room.task.updated': {
    clientEvent: 'room.task.updated',
    channel: (event) => Channels.room(event.payload.roomId),
    transform: (event) => event.payload,
  },
});
```

The bridge should be the only default way for internal events to become client-visible. This keeps authorization, payload filtering, and channel selection auditable.

## External Event Subsystem Alignment

The Space external event design should be renamed and aligned with this architecture:

```text
GitHubEventAdapter
  → ExternalEventService.publish(...)
  → ExternalEventStore dedupe/enrich/persist
  → InternalEventBus.publish('externalEvent.published', ...)
  → ExternalEventRouter
  → InternalCommandBus.dispatch('agent.message.inject', ...)
  → agent session
```

Do not introduce another generic `EventBus`. The domain service should be `ExternalEventService`, and node delivery should be `ExternalEventRouter`.

## Progressive Migration Milestones

### Milestone 1 — Remove legacy `EventBus` confusion

Goal: make it impossible for new production code to choose the dead event primitive.

Tasks:

1. Verify production imports of `packages/shared/src/event-bus.ts` remain zero.
2. Remove it from any public/shared barrel exports if present.
3. Mark the class and tests as deprecated or delete them if package compatibility permits.
4. Add a short replacement note pointing to `InternalEventBus`/current `DaemonHub` wrapper.
5. Rename variables typed as `DaemonHub` from `eventBus` to `daemonHub` where practical.

Exit criteria:

- no production code references legacy `EventBus`;
- docs explain that legacy `EventBus` is not the path forward;
- common daemon services no longer call a `DaemonHub` instance `eventBus`.

### Milestone 2 — Introduce compatibility façades

Goal: add clean API names without changing runtime behavior.

Tasks:

1. Add `InternalEventBus` as a wrapper around current `DaemonHub`.
2. Add initial `InternalCommandBus` and `InternalQueryBus` implementations.
3. Add `Channels` helpers that serialize to existing channel strings.
4. Add a small architecture doc comment in each module explaining event/command/query semantics.
5. Add tests for registration, dispatch, query execution, unsubscribe, and duplicate command/query handler handling.

Exit criteria:

- new code can depend on `InternalEventBus`, `InternalCommandBus`, and `InternalQueryBus`;
- existing behavior remains backed by current hub infrastructure;
- channels are constructed through helpers in new code.

### Milestone 3 — Fix event delivery semantics and observability

Goal: make the internal event layer safe for critical workflows.

Tasks:

1. Fix or wrap `TypedHub` local dispatch so async handlers can be awaited.
2. Add explicit APIs for accepted/enqueued publish vs publish-and-wait.
3. Stop silently swallowing handler errors; log event name, channel, subscriber name, and error.
4. Return structured publish results with handler counts and failures for wait mode.
5. Add tests for async handler completion, error reporting, unsubscribe cleanup, and session/channel filtering.

Exit criteria:

- event handler failures are observable;
- tests prove awaited mode waits for async handlers;
- fire-and-forget semantics are explicit rather than accidental.

### Milestone 4 — Extract client forwarding from `StateManager`

Goal: separate state projection from client event delivery.

Tasks:

1. Create `ClientEventGateway` around the existing WebSocket/MessageHub client path.
2. Create `ClientEventBridge` with declarative internal-event-to-client-event mappings.
3. Move the repetitive `StateManager` forwarding handlers into bridge config.
4. Keep payloads/channels behavior-compatible at first.
5. Add authorization/filtering hooks even if initial implementation delegates to existing checks.
6. Fix `channelVersions` cleanup while touching StateManager/channel lifecycle.

Exit criteria:

- `StateManager` no longer owns repetitive daemon-to-client forwarding;
- all client-visible internal events are listed in one bridge registry;
- channel construction uses `Channels` helpers;
- state cache cleanup includes channel version cleanup.

### Milestone 5 — Split state projections from runtime side effects

Goal: turn `StateManager` into a read-model/projection service rather than an event side-effect hub.

Tasks:

1. Rename or split `StateManager` responsibilities into `StateProjectionService` plus bridge/gateway services.
2. Route state-cache updates through `InternalEventBus` subscriptions.
3. Ensure side effects such as agent notification, audit logging, and client delivery are separate subscribers.
4. Add projection-focused tests for session, room, space, and workflow state.

Exit criteria:

- state projection code is not responsible for client broadcasting;
- side-effect subscribers are separately named/tested;
- read-model queries can be served through `InternalQueryBus`.

### Milestone 6 — Normalize Space runtime notifications

Goal: remove the parallel `NotificationSink` hierarchy as the primary integration pattern.

Tasks:

1. Define Space runtime domain events, for example `space.task.blocked`, `space.agent.crashed`, `space.workflowRun.completed`.
2. Publish these events through `InternalEventBus`.
3. Implement `SpaceAgentNotificationService` as a subscriber that turns selected Space events into agent-facing messages.
4. Implement client bridge mappings for client-visible Space events.
5. Keep `NotificationSink` as a compatibility adapter during migration.

Exit criteria:

- new Space runtime state transitions publish domain events;
- agent notifications and UI updates are subscribers, not parallel direct pipes;
- compatibility sink can be removed after callers migrate.

### Milestone 7 — Align GitHub and external event ingestion

Goal: prepare for multi-source external events without copying GitHub-specific pipelines.

Tasks:

1. Split shared GitHub ingress concerns from room/space routing: webhook verification, polling, raw normalization.
2. Rename the proposed external event design from generic `EventBus` to `ExternalEventService`.
3. Add `ExternalEventStore` for source dedupe and delivery lifecycle.
4. Add `ExternalEventTaskResolver` for task enrichment.
5. Publish `externalEvent.published` through `InternalEventBus`.
6. Route delivery through `ExternalEventRouter` and `InternalCommandBus` command `agent.message.inject`.
7. Keep current `SpaceGitHubService` direct injection path as a migration compatibility path until the new route proves stable.

Exit criteria:

- GitHub is one adapter/source for the external event subsystem;
- external event delivery is observable, retryable, and persistent;
- no new generic bus/hub abstraction is introduced.

### Milestone 8 — Retire legacy names and compatibility paths

Goal: remove the old conceptual clutter once migrations are complete.

Tasks:

1. Remove legacy `EventBus` source/tests if still present.
2. Remove or hide direct `DaemonHub` usage behind `InternalEventBus` where feasible.
3. Remove `NotificationSink` compatibility adapters.
4. Remove direct SpaceGitHub task-agent injection once `ExternalEventRouter` is primary.
5. Consolidate architecture docs around event/command/query semantics.

Exit criteria:

- production code uses `InternalEventBus`, `InternalCommandBus`, and `InternalQueryBus` as the semantic entry points;
- client delivery is through `ClientEventGateway`/`ClientEventBridge`;
- external source delivery is through `ExternalEventService`/`ExternalEventRouter`.

## Risk Management

- **Avoid big-bang transport rewrites.** Start with wrappers around current infrastructure.
- **Keep client and internal boundaries explicit.** Do not automatically expose all internal events to clients.
- **Use compatibility adapters.** Let old paths and new paths coexist while tests and telemetry build confidence.
- **Preserve behavior in bridge extraction.** First move should be structural, not semantic.
- **Instrument failures early.** Event-driven systems are hard to debug if handler failures vanish.

## Open Questions

1. Should `publish(...)` default to fire-and-forget or should only an explicitly named `publishAsync(...)` do that?
2. Should internal event envelopes be persisted for selected durable event classes, or should persistence remain domain-specific?
3. Should `InternalCommandBus` support middleware, or only one handler per command?
4. How aggressively should existing daemon event names be migrated to the new naming convention versus grandfathered?
5. What is the minimum compatibility period for `NotificationSink` and `SpaceGitHubService` direct delivery?

## Summary

The target architecture is not another hub. It is a semantic messaging layer:

```text
InternalEventBus   facts that happened
InternalCommandBus requests to do work
InternalQueryBus   requests to read state
```

Built around explicit channels, explicit client bridging, observable handler behavior, and progressive migration from the current `DaemonHub`/`MessageHub`/`StateManager`/`NotificationSink` mix.
