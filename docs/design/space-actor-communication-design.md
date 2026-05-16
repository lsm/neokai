# Space Actor Communication Design

Status: Proposed
Date: 2026-05-16
Task: #401 — Design universal Space actor communication model

## Summary

Use a small actor-addressed messaging substrate for the Space features we already have:

- Space chat / Coordinator
- ad-hoc Space sessions
- task-agent compatibility
- workflow node agent messaging
- pending worker delivery
- role escalation such as task-manager

The substrate should be generic enough to support long-term agents, inter-Space communication, and
inter-domain communication later, but v1 should not introduce a full Slack clone or task/workflow
chat threads.

## Core decision

Build one generic **Messaging** service/package boundary, then adapt Space to it.

Recommended boundary:

- `packages/messaging` or equivalent daemon-internal package first if package split is too early.
- Owns protocol types, address parsing, resolver contracts, message/delivery shapes, and audit event
  shapes.
- Does not own Space-specific storage, workflow activation, gates, or UI policy.
- Space runtime implements domain adapters: actor resolver, permission checks, delivery executor, and
  activation hooks.

This avoids baking generic actor messaging into `packages/daemon/src/lib/space/*` and keeps future
inter-Space / inter-domain routing from requiring a ground-up rewrite.

## What v1 must cover

Current behavior must keep working:

| Current feature | v1 generic mapping |
| --- | --- |
| Space Agent / default space chat agent | `coordinator` actor with `@coordinator` handle |
| Human Space chat / ad-hoc session | `session` actor with `@session:<id>` address |
| New persistent role agents | `agent` actor with handle and optional roles |
| Workflow node agent / coder / reviewer | `worker` actor, scoped by `workflowRunId` + `nodeId` |
| `node-agent send_message` | wrapper around generic `send_message` |
| `send_message_to_task` | compatibility wrapper around generic `send_message` |
| `pending_agent_messages` | delivery rows / queue with same retry, TTL, terminal state |
| task/workflow message UI | projection of messages/events; not LLM chat thread |

## Non-goals for v1

Do not build these now:

- Full channel system beyond existing Space/session/task surfaces.
- Public `conversation:<id>` target syntax.
- Task threads or workflow threads as LLM-visible chat surfaces.
- Cross-Space delivery implementation.
- Cross-domain delivery implementation.
- General federation, external identity proof, or trust negotiation.

Design data shapes so those can be added later through adapters.

## Minimal concepts

### Actor

Actor = addressable identity.

```ts
type ActorKind = 'human' | 'coordinator' | 'session' | 'agent' | 'worker' | 'system';

type ActorRef = {
	actorId: string;
	kind: ActorKind;
	spaceId: string;
	handle?: string; // @coordinator, @task-manager
	roles?: string[]; // coordinator, task-manager, reviewer
	status: 'active' | 'inactive' | 'archived' | 'deleted';
};
```

Notes:

- `archived`: no new routing; stays visible in history.
- `deleted`: soft-delete for privacy/admin removal; no routing/lookup/autocomplete; history keeps actor
  ID with redacted display metadata.
- Worker aliases like `@coder` and `@review` are contextual only. Do not register them as global Space
  handles. Globally addressable workers use `@worker:<run>/<node>`.

### Address syntax

Keep v1 syntax small:

| Syntax | Meaning | Example |
| --- | --- | --- |
| `@handle` | Actor handle in current Space | `@coordinator`, `@task-manager` |
| `@role:<role>` | Role binding in current Space | `@role:task-manager` |
| `@session:<id>` | Space session actor | `@session:abc123` |
| `@worker:<node>` | Worker in current workflow context | `@worker:Review` |
| `@worker:<run>/<node>` | Worker in explicit workflow run | `@worker:f1089/Review` |
| `#<name>` | Optional channel/topic handle if enabled | `#deployments` |

Do not expose these as target syntax in v1:

- `session:<id>` — ambiguous with `@session:<id>`.
- `conversation:<id>` — too low-level for agents/users.
- `task:<id>` / `workflow:<id>` — context only, not deliverable targets.

If a caller must continue an existing conversation, use fields, not target syntax:

```ts
send_message({
	target: '@session:abc123',
	conversationId: 'conv_789',
	body: 'Following up here',
});
```

### Context

Task/workflow/session IDs are context and audit metadata, not chat targets.

```ts
type MessageContext = {
	spaceId: string;
	taskId?: string;
	workflowRunId?: string;
	nodeId?: string;
	sessionId?: string;
	originMessageId?: string;
	originConversationId?: string;
};
```

Use context for:

- authorization
- worker alias resolution
- pending delivery lookup
- audit
- UI badges / task timeline projection
- reply routing

### Message

```ts
type MessageKind =
	| 'chat'
	| 'question'
	| 'answer'
	| 'blocked'
	| 'handoff'
	| 'approval_request'
	| 'approval_result'
	| 'system_event';

type MessageAttachment = {
	id?: string;
	type: 'image' | 'file' | 'url';
	mimeType?: string;
	name?: string;
	url?: string;
	storageKey?: string;
};

type MessageRecord = {
	messageId: string;
	spaceId: string;
	senderActorId: string;
	targets: string[]; // raw target strings after wrapper translation
	body: string;
	kind: MessageKind;
	context: MessageContext;
	conversationId?: string;
	replyToMessageId?: string;
	attachments?: MessageAttachment[];
	data?: Record<string, unknown>; // structured gate/vote/approval payload
	idempotencyKey?: string;
	createdAt: number;
};
```

`data` is required for compatibility with current `node-agent send_message({ data })`: gated channel
payloads are merged into gate state today and must keep working after cutover. `attachments` preserves
current human task messaging images/files instead of forcing a side channel. `idempotencyKey` is
persisted on the message and checked per `(spaceId, senderActorId, idempotencyKey)` before insert so
retry/restart dedupe and pending-message duplicate suppression survive migration.

### Delivery

One message can create many deliveries.

```ts
type DeliveryState = 'queued' | 'delivered' | 'failed' | 'expired' | 'skipped';

type DeliveryRecord = {
	deliveryId: string;
	messageId: string;
	targetActorId: string;
	state: DeliveryState;
	attemptCount: number;
	maxAttempts: number;
	expiresAt?: number;
	lastError?: string;
	deliveredSessionId?: string;
	deliveredAt?: number;
};
```

`pending_agent_messages` migration:

- legacy `pending` → `queued`
- legacy `delivered` → `delivered`
- legacy `failed` → `failed`
- legacy `expired` → `expired`
- preserve attempts, max attempts, TTL, last error, delivered session ID

## Resolution rules

Keep resolver deterministic:

1. Parse target string.
2. Apply current Space/domain context.
3. Resolve exact `@handle` among routable actors: `active` delivers immediately; `inactive` can create
   queued delivery if activation/retry policy exists; `archived`/`deleted` do not route.
4. Resolve `@role:<role>` using role binding.
5. Resolve `@session:<id>` to session actor if session is user-facing/ad-hoc.
6. Resolve `@worker:<node>` using `workflowRunId` from context.
7. Resolve `@worker:<run>/<node>` if sender can access that run.
8. Resolve optional `#<name>` channel/topic if enabled.
9. If caller omitted `target`, use context fallback (`@coordinator`, `@role:task-manager`, legacy
   task-agent coordinator, or triage channel).
10. If caller provided an explicit target and it does not resolve, return an error. Do not silently
    fallback; typos and stale handles must not leak content to another actor.
11. If fallback target cannot resolve, create failed delivery and return explicit error.

Important seeding rule:

- Session actors only come from ad-hoc human/member sessions.
- Exclude `space_chat`, `space_task_agent`, and workflow sub-sessions.
- Coordinator and Legacy Task Agent use dedicated migration paths.

## API shape

### `send_message`

```ts
type SendMessageInput = {
	/** Optional only for context-fallback paths; explicit callers should pass a target. */
	target?: string | string[];
	body: string;
	kind?: MessageKind;
	context?: Partial<MessageContext>;
	conversationId?: string;
	replyToMessageId?: string;
	attachments?: MessageAttachment[];
	data?: Record<string, unknown>;
	idempotencyKey?: string;
};

type SendMessageResult = {
	messageId: string;
	deliveries: DeliveryRecord[];
	fallbackUsed?: string;
};
```

### Other v1 tools

Minimal set:

- `send_message`
- `resolve_address`
- `list_actors`
- `read_messages` / `read_conversation` if UI/agent needs history
- Defer `mark_handled` until delivery records grow read/handled timestamps; v1 keeps delivery state to queue/delivery outcomes.

Do not add a full conversation management API until product needs it.

## Compatibility wrappers

### `node-agent-tools.send_message`

Maps current workflow messaging into `send_message`:

```ts
const translatedTarget = translateLegacyNodeTarget(target, { workflowRunId, nodeId });

send_message({
	target: translatedTarget,
	body: message,
	kind: messageKind ?? 'chat',
	data,
	context: { spaceId, taskId, workflowRunId, nodeId },
});
```

Preserve:

- channel topology permissions
- gated channel payload merge from `data`
- queued delivery for inactive target sessions
- activation hooks
- broadcast / node-name / agent-name resolution where supported today

Legacy node targets must be translated before calling generic `send_message`:

| Legacy target | Generic target |
| --- | --- |
| `'*'` | expand to topology-permitted `@worker:<run>/<node>` targets before send |
| bare agent name | matching `@worker:<run>/<agentName>` or configured worker alias |
| bare node name | `@worker:<run>/<nodeName>` |
| already generic `@...` / `#...` | pass through |

### `space-agent-tools.send_message_to_task`

Preserve current behavior:

- If caller only passes task ID/number, deliver to legacy task-agent/task coordinator actor.
- If caller passes node ID, explicit actor, or role target, deliver there.
- Mark wrapper deprecated after generic tool adoption.

### Human task message RPC

Routes to explicit worker/role/session when mentioned; otherwise preserves current task-agent/default
behavior until replacement path is ready.

## Package / implementation shape

Recommended split:

```text
packages/messaging/                 # or daemon-internal equivalent first
  src/types.ts                       # ActorRef, MessageRecord, DeliveryRecord
  src/address.ts                     # parse/format target strings
  src/contracts.ts                   # resolver/router/storage interfaces

packages/daemon/src/lib/space/
  messaging-adapter.ts               # Space actor resolver + policy + delivery executor
  tools/*                            # MCP wrappers call generic service
  runtime/*                          # workflow activation/gates remain here
```

Do not move SQLite schema or runtime activation into generic package. Generic package should define
contracts and pure helpers; daemon owns persistence/execution.

## Future extension points

### Inter-Space

Do not implement now. Future adapter can wrap the same message shape in a remote envelope:

```ts
type RemoteEnvelope = {
	originSpaceId: string;
	targetSpaceId: string;
	originActorId: string;
	target: string;
	message: MessageRecord;
	trustLevel: 'local' | 'same_org' | 'external';
	correlationId: string;
};
```

Future syntax can be added without changing core records:

- `space:<spaceId>::@handle`
- `space:<spaceId>::@role:<role>`
- `space:<spaceId>::#channel`

Until adapter exists, reject these explicitly. Never fallback to local handles.

### Inter-domain

Same model, different adapter. Examples:

- GitHub issue/PR comment actor
- Slack user/channel
- support ticket thread
- external automation bot

Future syntax:

- `domain:github::@release-bot`
- `domain:github::conversation:pr-1920`

Domain adapter owns identity proof, permission, rate limits, and external audit mapping.

### Task timeline and workflow execution log

Task/workflow are not chat targets. Future UI may add projections:

- **Task timeline**: human-readable task feed of decisions, questions, answers, artifacts, and status.
- **Workflow execution log**: runtime feed of node handoffs, gate writes, queued delivery, retries, CI,
  artifacts, and system events.

These surfaces reference messages/events. They do not own reply routing and are not injected wholesale
into LLM context.

## Migration plan

1. Add generic messaging types/address parser/contracts.
2. Seed minimal actor registry:
   - Human actors from Space membership/users.
   - Coordinator from current Space Agent / `space_chat` default session.
   - Session actors from ad-hoc human/member sessions only.
   - Agent actors for long-term agents when they exist.
   - Worker actors from active and declared workflow node executions, including inactive workers
     referenced by pending rows.
   - System actors for runtime subsystems.
3. Implement Space adapter resolver and delivery writer.
4. Map `pending_agent_messages` into delivery rows/facade.
5. Wrap `node-agent send_message` and preserve gate `data` behavior.
6. Wrap `send_message_to_task` and preserve task-only default task-agent delivery.
7. Update Space MCP attachment by explicit actor/session role:
   - `space_chat` / Coordinator gets generic messaging + management.
   - ad-hoc Space sessions get generic messaging.
   - workflow workers get generic messaging through node wrapper.
   - `space_task_agent` keeps compatibility tools only during migration.
8. Retire legacy task-agent helper only after direct worker/role delivery is live.

## Follow-up implementation tasks

1. **Add generic messaging contracts and address parser**
   - Minimal types, parser, resolver/router/storage interfaces.

2. **Add Space actor registry adapter**
   - Depends on task 1.
   - Seed Coordinator, Human, Session, Worker, System actors using current data.

3. **Implement Space resolver and delivery facade**
   - Depends on tasks 1 and 2.
   - Preserve current workflow routing and pending delivery semantics.

4. **Wrap existing MCP/RPC tools**
   - Depends on task 3.
   - `node-agent send_message`, `send_message_to_task`, human task message RPC.

5. **Add long-term agent inbox / DM activation**
   - Depends on task 4.
   - Enables agent ↔ agent and session ↔ agent messaging.

6. **Refactor Space MCP attachment by actor/session role**
   - Depends on task 4.
   - Replace broad `context.spaceId` sweeps and skip guards with explicit policy.

7. **Add UI projections**
   - Depends on tasks 3 and 4.
   - Actor labels, target resolution badges, delivery state, task timeline projection.

Dependency graph:

```mermaid
flowchart TD
	T1[1 contracts + parser] --> T2[2 Space actor registry]
	T1 --> T3[3 resolver + delivery]
	T2 --> T3
	T3 --> T4[4 wrappers]
	T4 --> T5[5 long-term inbox]
	T4 --> T6[6 MCP attachment policy]
	T3 --> T7[7 UI projections]
	T4 --> T7
```

## Updates to draft tasks

### #398 — Untangle Space MCP ownership by session role

Keep, but scope it after generic messaging wrapper work. Replace current skip mechanisms with explicit
actor/session-role policy:

- `session.type === 'space_chat'`
- `session.type === 'space_task_agent'`
- workflow sub-session ID checks using `:task:` + `:exec:`

Do not treat `:agent:` as a guard; it is session ID construction.

### #399 — Fix Space ad-hoc session MCP reattach after daemon restart

If urgent, keep tactical fix now. Long-term fix becomes role-based attachment using actor/session
policy.

### #400 — Remove built-in task-agent LLM helper from Space workflows

Do not remove first. Update dependency:

- generic messaging wrappers exist
- direct worker/role delivery works
- pending delivery migration preserves queued rows
- task-only `send_message_to_task` compatibility still routes to legacy task-agent/task coordinator

Then retire `space_task_agent` helper.
