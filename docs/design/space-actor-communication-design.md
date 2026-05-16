# Space Actor Communication Design

Status: Proposed
Date: 2026-05-16
Task: #401 — Design universal Space actor communication model

## Summary

Space communication should use one actor-addressed substrate for humans, the Coordinator,
Space Sessions, Long-term Agents, Workflow Workers, and System actors. The model is intentionally
Slack/Teams-like: stable actor IDs, readable handles, address resolution, conversations, threads,
delivery state, membership, permissions, and audit logs are first-class data instead of tool-specific
routing hacks.

This design replaces hardcoded paths such as `send_message_to_task`, workflow-only
`node-agent send_message`, task-agent queues, and broad `space-agent-tools` attachment rules with a
single Space Messaging layer. Existing MCP tools become compatibility wrappers over that layer while
UI and agents migrate to generic tools.

## Goals

- One universal actor-to-actor communication model inside a Space.
- Support DMs, group DMs, channels/topic threads, task threads, workflow threads, and session
  threads.
- Stable internal actor IDs plus human-readable handles such as `@coordinator`, `@task-manager`,
  `#deployments`.
- Role-based addressing where a role can resolve to one actor now, many actors later, or a fallback.
- Space Session/ad-hoc chat can message Long-term Agents.
- Long-term Agents can message each other.
- Workflow Workers can escalate questions or blocked states to role agents such as `@task-manager`
  or `@coordinator`.
- Preserve auditability, permissions, autonomy boundaries, loop prevention, delivery state, retry
  state, and read/handled state.

## Existing concept mapping

| Current concept | New name | Notes |
| --- | --- | --- |
| Space Agent / default space chat agent | Coordinator | Long-term Agent with reserved role `coordinator` and handle `@coordinator`. |
| Human user in Space UI | Human Actor | Actor type `human`, can own sessions and approve restricted actions. |
| Space chat / ad-hoc Space session | Space Session | Actor type `space_session`, handle optional, session thread participant. |
| New persistent role agents | Long-term Agent | Actor type `long_term_agent`, e.g. `@task-manager`, `@marketing-director`. |
| Workflow node agent / coder / reviewer | Workflow Worker | Actor type `workflow_worker`, scoped to workflow run/node. |
| Runtime, scheduler, gate scripts | System Actor | Actor type `system`, emits events and delivery records. |
| `space-agent-tools` | Space Messaging tools + Space management tools | Messaging part becomes generic substrate tools. |
| `node-agent send_message` | Wrapper for `send_message` | Adds workflow actor identity and topology checks. |
| `send_message_to_task` | Wrapper targeting task thread or task participants | Deprecated after task thread UI migrates. |
| `pending_agent_messages` | Delivery queue | Evolves into per-recipient delivery rows. |
| `space_task_agent` helper | Legacy Task Agent | Superseded by Coordinator/Task Manager + task threads. |

Relevant current implementation anchors:

- `packages/daemon/src/lib/space/tools/space-agent-tools.ts` exposes `send_message_to_task` and owns
  broad Space tool wiring.
- `packages/daemon/src/lib/space/tools/node-agent-tools.ts` exposes workflow `send_message`.
- `packages/daemon/src/lib/space/runtime/agent-message-router.ts` resolves and delivers workflow
  worker messages.
- `packages/daemon/src/storage/repositories/pending-agent-message-repository.ts` stores queued
  workflow messages with retry/TTL state.
- `packages/daemon/src/lib/rpc-handlers/space-task-message-handlers.ts` routes human task messages
  to node agents and pending queues.
- `packages/daemon/src/lib/space/runtime/space-runtime-service.ts` attaches `space-agent-tools` to
  Space member sessions and special-cases `space_chat`, `space_task_agent`, and workflow sub-session
  IDs.
- `packages/daemon/src/lib/space/runtime/task-agent-manager.ts` creates task-agent and node-agent
  MCP servers and flushes pending messages.

## Actor taxonomy

Actors are Space-scoped addressable identities. Sessions are runtime incarnations of actors, not the
identity itself.

```ts
type SpaceActorType =
	| 'human'
	| 'coordinator'
	| 'space_session'
	| 'long_term_agent'
	| 'workflow_worker'
	| 'system';

type SpaceActorStatus = 'active' | 'idle' | 'disabled' | 'archived' | 'deleted';
```

`archived` means the actor no longer participates in routing but remains visible in conversation,
delivery, and audit history. `deleted` is a stronger soft-delete marker for privacy/admin removal:
routing, handle lookup, autocomplete, and new membership all ignore it, while historical messages and
delivery rows keep the actor ID with redacted display metadata rather than being physically removed.

### Human Actor

- Represents a user account/member in a Space.
- Stable actor ID: `actor_human_<spaceId>_<userId>`.
- Handles: `@alice`, display name, optional aliases.
- Can send user-authored messages, approve restricted actions, configure membership, and receive
  notifications.

### Coordinator

- Reserved Long-term Agent for each Space.
- Stable actor ID: `actor_agent_<spaceId>_coordinator`.
- Handle: `@coordinator`.
- Default fallback for unresolved role escalations unless configured otherwise.
- Replaces current default Space Agent naming in new UI/API language.

### Space Session / ad-hoc chat

- Ephemeral or persistent session actor representing a human-facing Space chat or ad-hoc session.
- Stable actor ID derives from session ID: `actor_session_<spaceId>_<sessionId>`.
- Optional handle: `@session-<shortId>` for internal references; UI displays session title.
- Can send messages to Long-term Agents and task/workflow threads if session policy allows.
- Receives replies in the originating session thread by default.

### Long-term Agent

- Persistent Space role agent, e.g. `@task-manager`, `@marketing-director`, `@sales-manager`,
  `@infra-director`.
- Stable actor ID: `actor_agent_<spaceId>_<agentId>`.
- Has handle, display name, role bindings, inbox, memory, tools, autonomy level, and acting policy.
- Can message Humans, Coordinator, other Long-term Agents, Space Sessions, Workflow Workers, and
  channels subject to policy.

### Workflow Worker

- Runtime actor for workflow node execution: Coding, Review, deploy checker, gate evaluator, etc.
- Stable actor ID within a run/node/session:
  `actor_worker_<spaceId>_<taskId>_<workflowRunId>_<nodeId>_<agentName>`.
- Handles are scoped, e.g. `@coder`, `@review`, `@workflow/f1089/coder`.
- Can send direct messages, escalate to roles, post to workflow/task threads, and receive feedback.
- Actor may become inactive when run ends; audit records remain.

### System Actor

- Non-human runtime source for scheduler, gates, CI poller, GitHub webhook, task lifecycle, or
  delivery daemon events.
- Stable actor IDs per subsystem, e.g. `actor_system_<spaceId>_workflow-runtime`.
- Can emit events and notifications; cannot perform user-like tool actions unless explicitly
  delegated by policy.

## Address syntax and resolution rules

Address resolution is a pure service with audit logging. It converts user/tool input into actor,
conversation, or thread targets before delivery.

### Syntax

| Syntax | Target kind | Example | Notes |
| --- | --- | --- | --- |
| `@handle` | Actor handle | `@coordinator`, `@task-manager` | Unique within Space among active actor handles. |
| `@role:<role>` | Role binding | `@role:task-manager` | Can resolve to one or many actors. |
| `@session:<id>` | Space Session actor | `@session:abc123` | Allows ad-hoc session addressing. |
| `@worker:<node>` | Workflow Worker in current run | `@worker:Review` | Contextual; requires task/workflow context. |
| `@worker:<run>/<node>` | Workflow Worker by run | `@worker:f1089/Review` | Stable across tools and UI. |
| `#channel` | Channel conversation | `#deployments` | Posts to channel. |
| `task:<number>` | Task thread | `task:401` | Posts into task conversation. |
| `workflow:<runId>` | Workflow thread | `workflow:f1089...` | Posts to workflow run thread. |
| `session:<id>` | Session thread | `session:abc123` | Posts to session conversation. |
| `conversation:<id>` | Existing conversation | `conversation:conv_...` | Explicit continuation. |

### Resolution order

1. Parse explicit target syntax.
2. Resolve conversation/thread IDs before actor handles if prefix exists.
3. Resolve exact active actor handle in Space.
4. Resolve role binding in Space.
5. Resolve contextual worker aliases from sender context (`@review`, `@coder`, `Review`).
6. Resolve channel handle.
7. If no match, use configured fallback for sender context.
8. If fallback unavailable, create undeliverable delivery rows and notify sender.

### Handles

- Handle registry is Space-scoped and case-insensitive.
- Handles use lowercase kebab-case: `@task-manager`, `@infra-director`, `#deployments`.
- Reserved handles: `@coordinator`, `@system`, `@human`, `@me`, `@here`, `@channel`.
- Archived actors keep historical handle claims for audit but can release handle for reuse only after
  migration creates aliases.

### Roles

Role bindings decouple intent from concrete agents.

```ts
type SpaceRoleBinding = {
	role: string; // task-manager, infra, sales, coordinator
	strategy: 'single' | 'broadcast' | 'round_robin' | 'least_busy' | 'fallback_only';
	actorIds: string[];
	fallbackAddress?: string; // usually @coordinator or #triage
	requiresHumanApproval?: boolean;
};
```

Examples:

- `@task-manager` resolves to one Long-term Agent today.
- Later, `@task-manager` can resolve to multiple agents with broadcast or load balancing.
- If no task manager exists, fallback routes to `@coordinator` and records
  `resolution.fallbackUsed=true`.
- Workflow Worker blocked-state escalation defaults to `@role:task-manager`, fallback
  `@coordinator`, fallback channel `#workflow-triage` if the Coordinator is unavailable.

## Conversation types

Conversations are durable containers. Threads are ordered message trees within conversations. A
conversation can have one root thread and many topic/subthreads.

```ts
type SpaceConversationType =
	| 'direct_message'
	| 'group_dm'
	| 'channel'
	| 'task_thread'
	| 'workflow_thread'
	| 'session_thread';
```

### Direct Message

- One sender, one target actor.
- Stable pair key: sorted participant actor IDs plus Space ID, unless `ephemeral=true`.
- Used for Long-term Agent ↔ Long-term Agent and Space Session ↔ Long-term Agent private messages.

### Group DM

- Small fixed participant set.
- Used for ad-hoc coordination among humans and agents.
- Membership change can either mutate same conversation or fork, depending on audit policy.

### Channel

- Named Space-wide topic conversation, e.g. `#deployments`, `#sales`, `#workflow-triage`.
- Membership/subscriptions determine visibility and notifications.
- Supports mentions, channel-wide notifications, and topic threads.

### Task thread

- Conversation bound to a Space task ID.
- Participants include task owner, Coordinator, assigned Long-term Agents, active Workflow Workers,
  and subscribed humans.
- Replaces hidden task-agent chat semantics.
- Human messages to a task post here; routing rules decide whether to notify active workers or role
  agents.

### Workflow thread

- Conversation bound to workflow run ID.
- Participants include workers, Coordinator, system runtime, and subscribed Long-term Agents.
- Worker-to-worker messages remain visible here unless sent as private DM.
- Gate events, artifacts, review handoffs, and blocked states can appear here.

### Session thread

- Conversation bound to a Space Session/ad-hoc chat session ID.
- Default place for replies to messages originating from that session.
- Lets Long-term Agents answer back into human-visible ad-hoc session without targeting raw SDK
  session internals.

## Message schema

Messages are immutable content records. Edits/deletes are events linked to the original message.
Delivery, read, and handled state live in separate tables.

```ts
type SpaceMessage = {
	id: string;
	spaceId: string;
	conversationId: string;
	threadId: string;
	parentMessageId?: string;

	senderActorId: string;
	senderSessionId?: string;
	senderRunId?: string;
	senderTaskId?: string;

	body: string;
	format: 'text' | 'markdown' | 'json' | 'system_event';
	messageKind:
		| 'chat'
		| 'question'
		| 'answer'
		| 'blocked'
		| 'handoff'
		| 'approval_request'
		| 'approval_result'
		| 'system_event';

	explicitTargets: SpaceAddress[];
	resolvedTargets: ResolvedTarget[];
	mentions: SpaceMention[];
	attachments: SpaceAttachment[];
	artifacts: SpaceArtifactRef[];

	correlationId?: string;
	idempotencyKey?: string;
	replyToMessageId?: string;
	replyRouting?: ReplyRouting;

	createdAt: number;
	createdByActorId: string;
	visibility: 'conversation' | 'participants' | 'private' | 'audit_only';
	metadata?: Record<string, unknown>;
};
```

### Mentions

```ts
type SpaceMention = {
	range?: { start: number; end: number };
	address: string;
	resolvedKind: 'actor' | 'role' | 'channel' | 'conversation' | 'unknown';
	resolvedActorIds?: string[];
	resolvedConversationId?: string;
	fallbackUsed?: boolean;
};
```

### Attachments and artifacts

```ts
type SpaceAttachment = {
	id: string;
	type: 'file' | 'image' | 'url' | 'code' | 'diff' | 'github_pr' | 'github_comment';
	name?: string;
	url?: string;
	mimeType?: string;
	storageKey?: string;
	metadata?: Record<string, unknown>;
};

type SpaceArtifactRef = {
	artifactId: string;
	workflowRunId?: string;
	taskId?: string;
	nodeId?: string;
	type?: string;
	key?: string;
};
```

### Reply routing

```ts
type ReplyRouting = {
	mode: 'same_thread' | 'sender_dm' | 'origin_session_thread' | 'task_thread' | 'workflow_thread';
	originMessageId?: string;
	originConversationId?: string;
	originThreadId?: string;
	originActorId?: string;
	originSessionId?: string;
};
```

Default rules:

- Reply to a message in a thread stays in same thread.
- Reply to a DM stays in the DM.
- Reply to a Space Session-originated escalation defaults to `origin_session_thread` unless sender
  chooses another visible conversation.
- Workflow Worker replies to a task-thread human message stay in task thread so audit remains
  human-visible.

## Delivery schema

Each message creates one or more delivery rows. Delivery rows model target lifecycle, retries, and
read/handled state per recipient actor or conversation subscription.

```ts
type SpaceMessageDelivery = {
	id: string;
	messageId: string;
	spaceId: string;
	targetKind: 'actor' | 'conversation' | 'role' | 'channel_subscription';
	targetAddress?: string;
	resolvedActorId?: string;
	resolvedConversationId?: string;
	resolutionStrategy?: string;
	fallbackUsed?: boolean;

	status:
		| 'pending'
		| 'queued'
		| 'activating'
		| 'delivered'
		| 'read'
		| 'handled'
		| 'skipped'
		| 'failed'
		| 'expired'
		| 'cancelled';

	attemptCount: number;
	maxAttempts: number;
	nextAttemptAt?: number;
	lastAttemptAt?: number;
	deliveredAt?: number;
	readAt?: number;
	handledAt?: number;
	handledByActorId?: string;
	expiresAt?: number;

	errorCode?: string;
	errorMessage?: string;
	lastDeliverySessionId?: string;
	createdAt: number;
	updatedAt: number;
};
```

Delivery status semantics:

- `pending`: accepted, not yet processed by router.
- `queued`: waiting for inactive actor/session or scheduled retry.
- `activating`: runtime is starting target actor/session.
- `delivered`: message injected into target inbox/session or visible in subscribed conversation.
- `read`: human or agent read cursor passed message.
- `handled`: recipient acknowledged or acted on message.
- `skipped`: policy/routing intentionally suppressed delivery, e.g. sender not notified by own
  channel post.
- `failed`: retryable or terminal failure with error metadata.
- `expired`: TTL exceeded.
- `cancelled`: upstream task/run/conversation cancelled.

Existing `pending_agent_messages` maps to rows with `status in ('queued', 'failed', 'expired')`,
`attemptCount`, `maxAttempts`, and `expiresAt`.

## Membership and subscription model

Membership answers who can see a conversation. Subscription answers who gets notified or activated.

```ts
type ConversationMembership = {
	conversationId: string;
	actorId: string;
	role: 'owner' | 'admin' | 'member' | 'guest' | 'observer';
	state: 'active' | 'muted' | 'left' | 'removed';
	joinedAt: number;
	lastReadMessageId?: string;
};

type ConversationSubscription = {
	conversationId: string;
	actorId: string;
	notificationLevel: 'all' | 'mentions' | 'direct' | 'none';
	autoActivate: boolean;
	eventFilters?: string[]; // task.blocked, workflow.review_ready, artifact.created
	createdAt: number;
};
```

### Channel membership

- Public Space channel: visible to all Space members; posting can be restricted by policy.
- Private channel: explicit members only.
- System channel: runtime-managed; may be read-only for humans/agents.
- Agents can be members with `notificationLevel='mentions'` by default to avoid noisy activation.

### Agent inboxes

Each actor has a virtual inbox, not a separate conversation type:

- DM deliveries.
- Mentions in channels/task/workflow/session threads.
- Subscribed event deliveries.
- Approval requests and blocked states.

Agent runtime consumes inbox rows by priority and policy. Inboxes use delivery rows plus actor cursors.

### Task/workflow event subscriptions

Long-term Agents can subscribe to structured events:

- Task Manager: `task.created`, `task.blocked`, `task.review_requested`, `task.overdue`.
- Infra Director: `workflow.deploy_failed`, `ci.failed`, `environment.blocked`.
- Coordinator: all high-priority task/workflow escalations by default.
- Humans: direct mentions, approval requests, watched tasks/channels.

## Routing semantics

### One-to-one

- Sender targets one actor handle or actor ID.
- Router creates or finds DM conversation if no conversation supplied.
- One delivery row is created for target actor.
- If target inactive and auto-activation allowed, status transitions `queued -> activating -> delivered`.

### One-to-many

- Sender targets channel, group DM, role broadcast, or multiple explicit targets.
- Router expands to actor recipients and conversation membership.
- Idempotency key prevents duplicate delivery when same actor appears through multiple target paths.
- Message stores original address plus resolved targets for audit.

### Role resolution

- Role strategy decides expansion.
- `single`: exactly one primary actor; fallback if missing.
- `broadcast`: all bound actors receive deliveries.
- `round_robin`: one actor selected, recorded in resolution metadata.
- `least_busy`: actor selected by queue depth or active task count.
- `fallback_only`: role is virtual; always routes to configured fallback.

### Missing target fallback

Fallback order:

1. Target-specific fallback from role binding or channel config.
2. Sender-context fallback, e.g. Workflow Worker blocked escalation → `@task-manager` →
   `@coordinator` → `#workflow-triage`.
3. Space default fallback `@coordinator`.
4. System undeliverable notice to sender and audit log.

Fallback use must be visible in message metadata and UI badges.

### Reply routing and thread continuity

- Every message carries `conversationId` and `threadId`; replies default to both.
- Cross-conversation handoff stores `replyRouting.origin*` metadata.
- Space Session → Long-term Agent message creates a DM or task/channel post but records origin
  session thread; agent response can return to session thread.
- Workflow Worker → Long-term Agent escalation from a workflow thread records workflow run and node;
  response returns to workflow thread unless actor chooses DM/task thread.

### Ad-hoc Space Session to Long-term Agent

Flow:

1. User chats in a Space Session and mentions `@task-manager` or calls `send_message` with target.
2. Session actor posts a message in its session thread with explicit target.
3. Resolver maps `@task-manager` to Long-term Agent actor ID or fallback.
4. Router creates delivery to agent inbox and optional DM conversation link.
5. Agent runtime reads message, with origin session context and allowed reply route.
6. Agent reply posts to session thread by default so the user sees it in the ad-hoc chat.

### Long-term Agent to Long-term Agent

Flow:

1. Agent calls `send_message({ target: '@infra-director', body })`.
2. Policy checks sender autonomy, recipient access, loop limits, and tool permissions.
3. Router creates/fetches DM conversation for both agents.
4. Delivery row activates target agent if allowed; otherwise queues.
5. Recipient handles and can reply in same DM thread.

### Workflow Worker escalation to role agent

Flow:

1. Worker reaches blocked state and calls `send_message({ target: '@task-manager', kind: 'blocked' })`.
2. Resolver expands role; if missing, fallback to `@coordinator`; if unavailable, fallback to
   `#workflow-triage`.
3. Message posts to workflow thread or task thread depending on context.
4. Delivery row notifies resolved Long-term Agent/Coordinator inbox.
5. Agent response returns to workflow thread and target worker, preserving audit trail.
6. If response includes action beyond worker autonomy, approval gate remains enforced.

## Permissions and autonomy

Permissions are evaluated before delivery, before activation, and before actions triggered by
messages.

### Permission checks

- Space membership: sender belongs to Space or is trusted System actor.
- Conversation membership/visibility: sender can post in target conversation.
- Addressability: sender can DM target actor type.
- Role policy: sender can invoke role binding.
- Activation policy: sender/message kind can activate sleeping agent.
- Autonomy policy: recipient can act on message without human approval.
- Tool policy: recipient tools available for requested action.
- Workflow topology policy: workers can message only permitted peers unless escalating to allowed
  roles/channels.

### Suggested defaults

| Sender | Can message | Default limits |
| --- | --- | --- |
| Human | Any Space actor/channel/task/session visible to them | Restricted only by Space permissions. |
| Coordinator | Long-term Agents, Humans, Space Sessions, Workflow Workers, channels | Must honor configured autonomy for external side effects. |
| Space Session | Coordinator, role agents, channels, task/session threads | Cannot directly control workflow workers unless task context grants it. |
| Long-term Agent | Coordinator, other Long-term Agents, subscribed channels/tasks/workflows | External side effects gated by autonomy level. |
| Workflow Worker | Workflow peers, Coordinator, allowed roles, task/workflow thread | Cross-Space and unrelated task DMs denied. |
| System | System channels, task/workflow events, configured recipients | Cannot impersonate human/agent. |

### Human approval boundaries

Messages can request actions but cannot bypass gates:

- Low-autonomy agents may draft plans/replies but need human approval for changes.
- Workflow Workers remain bound by workflow gates such as PR-ready, review approval, merge policy.
- Role agents may advise or triage blocked workers; they cannot grant permission beyond their own
  configured authority.
- Approval requests are message kind `approval_request` with explicit action metadata and delivery to
  Human/Coordinator according to policy.

### Audit log needs

Audit entries should capture:

- Sender actor/session/user and effective identity.
- Raw target address, resolved target, role strategy, fallback use.
- Permission decisions and policy version.
- Message content hash, attachment/artifact refs, visibility.
- Delivery attempts, activation attempts, failures, retries.
- Read/handled acknowledgements for agents and humans.
- Actions taken as result of message, linked by correlation ID.

## Loop prevention

Agent-to-agent communication must default safe. The substrate should prevent runaway ping-pong,
broadcast storms, and self-trigger loops.

### Limits

- Per-conversation agent turn limit, e.g. 12 agent-authored replies in 10 minutes without human or
  System event interruption.
- Per-actor outbound rate limit per Space and per target.
- Per-role broadcast fanout limit.
- Max reply depth for automatic agent responses.
- Max retry attempts and TTL for queued delivery.
- Cooldown for repeated identical messages using content hash + target + thread.

### Cycle detection

Track recent chain metadata:

```ts
type MessageLoopTrace = {
	rootMessageId: string;
	conversationId: string;
	actorPath: string[];
	rolePath: string[];
	messageHashPath: string[];
	startedAt: number;
};
```

Detect:

- A → B → A ping-pong above threshold.
- Role fallback cycle, e.g. `@task-manager` fallback `@coordinator`, Coordinator policy forwards back
  to `@task-manager`.
- Channel mention loops where agent responds with same channel mention repeatedly.
- Delivery retry loop caused by activation failure.

### Escalation

When loop guard trips:

1. Stop auto-activation for affected thread.
2. Mark delivery `failed` or `skipped` with `errorCode='loop_guard'`.
3. Post System summary to thread.
4. Notify `@coordinator` or Human depending on severity.
5. Require manual reply or explicit resume to continue.

## MCP/API shape

Expose one generic Space Messaging API to agents, UI, and runtime services. MCP tools are thin
wrappers over the same service.

### Core tools

#### `send_message`

```ts
type SendMessageInput = {
	target: string | string[];
	body: string;
	conversationId?: string;
	threadId?: string;
	messageKind?: SpaceMessage['messageKind'];
	attachments?: SpaceAttachment[];
	artifacts?: SpaceArtifactRef[];
	idempotencyKey?: string;
	replyToMessageId?: string;
	visibility?: SpaceMessage['visibility'];
};
```

Returns:

```ts
type SendMessageResult = {
	messageId: string;
	conversationId: string;
	threadId: string;
	resolvedTargets: ResolvedTarget[];
	deliveries: { deliveryId: string; targetActorId?: string; status: string }[];
	fallbacksUsed: string[];
};
```

#### `list_actors`

Filters actors by type, handle, role, status, capability, task, workflow run, or channel.

#### `resolve_address`

Returns parsed address, candidate actors/conversations, fallback decision, and permission result
without sending a message. Used by UI autocomplete and agent planning.

#### `list_conversations`

Lists visible conversations for caller with type filters, unread counts, and membership state.

#### `read_conversation`

Reads messages by conversation/thread with cursor pagination. Can optionally mark read for caller.

#### `ack_message` / `mark_handled`

Marks delivery as read/handled with optional note/action reference.

#### `subscribe_conversation` / `update_notification_level`

Manages membership/subscription when policy allows.

### RPC endpoints

UI-facing RPC mirrors MCP:

- `space.messaging.sendMessage`
- `space.messaging.resolveAddress`
- `space.messaging.listActors`
- `space.messaging.listConversations`
- `space.messaging.readConversation`
- `space.messaging.markRead`
- `space.messaging.markHandled`
- `space.messaging.updateSubscription`

### Legacy wrapper strategy

Keep existing tools while migrating callers:

- `space-agent-tools.send_message_to_task` → calls `send_message` targeting `task:<taskNumber>` or
  explicit worker/role address. Mark deprecated in tool description.
- `node-agent-tools.send_message` → calls `send_message` with sender actor type `workflow_worker`,
  sender workflow context, and topology/autonomy policy. Preserve current gated channel behavior by
  converting workflow topology to permissions plus role/channel destinations.
- `task-agent-tools.send_message` → if Task Agent remains during migration, maps to task thread or
  Coordinator DM. If task-agent helper is removed, wrapper returns migration guidance or routes from
  `system`/`coordinator` according to compatibility mode.
- `PendingAgentMessageRepository` → becomes compatibility facade over `space_message_deliveries`.
- `SpaceRuntimeService.attachSpaceToolsToMemberSession` → uses actor/session role resolver to attach
  generic messaging MCP plus only role-appropriate management/query tools.

Tool descriptions should stop teaching agents special one-off names once generic tools exist.

## Migration plan

### Phase 0: Design gate

- Land this design artifact.
- Update or supersede draft tasks #398, #399, and #400 as below.

### Phase 1: Data model foundation

Add tables/repositories for:

- `space_actors`
- `space_actor_handles`
- `space_role_bindings`
- `space_conversations`
- `space_conversation_memberships`
- `space_conversation_subscriptions`
- `space_messages`
- `space_message_deliveries`
- `space_message_audit_events`

Seed actors from existing data:

- Human actors from Space membership/users.
- Coordinator from current Space Agent / `space_chat` default session.
- Space Session actors from sessions with `context.spaceId` and non-workflow role.
- Workflow Worker actors from active workflow node sessions.
- System actors for runtime subsystems.

### Phase 2: Resolver and router service

Create `SpaceMessagingService` with:

- Actor registry.
- Address parser/resolver.
- Permission/autonomy checker.
- Conversation/thread resolver.
- Delivery writer and queue.
- Loop guard.
- Audit writer.

Adapt existing `AgentMessageRouter` behavior into this service or make it a workflow-specific
adapter. Preserve current activation and queue semantics.

### Phase 3: Generic MCP/RPC tools

Add generic MCP server/tool set:

- `send_message`
- `list_actors`
- `resolve_address`
- `list_conversations`
- `read_conversation`
- `mark_handled`

Add UI RPC endpoints for same primitives.

### Phase 4: Compatibility wrappers

Refactor wrappers:

- `space-agent-tools.send_message_to_task` delegates to Space Messaging.
- `node-agent-tools.send_message` delegates to Space Messaging.
- Human task message RPC posts task-thread messages and delivery rows instead of directly targeting
  hidden task-agent/node paths.
- Pending message queues map to delivery rows.

No user-visible behavior should regress during this phase.

### Phase 5: Role-based MCP attachment

Replace broad `context.spaceId` MCP attachment sweeps with an explicit session role → MCP policy:

| Session role | Messaging tools | Other tools |
| --- | --- | --- |
| Coordinator / Space chat | Generic messaging + Space management | db-query, registry tools if configured |
| Space Session / ad-hoc | Generic messaging | db-query if policy allows |
| Long-term Agent | Generic messaging | role tools, memory tools, allowed MCPs |
| Workflow Worker | Generic messaging via node wrapper | node workflow tools, safe registry/fetch tools |
| Legacy Task Agent | Compatibility tools only during migration | task-agent tools if retained |
| System | Internal service API, not SDK MCP by default | none |

Role-based attachment must also make MCP server names and tool names collision-safe. Current
`mergeRuntimeMcpServers` semantics overwrite on key collision, so generic messaging tool names must
not collide with role-specific management tools or compatibility wrappers.

This phase directly addresses current scattered `SpaceRuntimeService`, `TaskAgentManager`, rehydrate,
reset, and `QueryOptionsBuilder` ownership paths.

### Phase 6: Long-term Agent runtime

Implement persistent agents:

- Coordinator as reserved Long-term Agent.
- CRUD for role agents and handles.
- Agent inbox processing loop with activation policy.
- Role bindings and fallback config.
- UI surfaces for agent list, DM, channel membership, and subscriptions.

### Phase 7: Task-agent removal/retirement

Remove or retire default `space_task_agent` LLM helper after task threads and Coordinator/Task Manager
routing replace its orchestration role. Keep DB compatibility for existing `taskAgentSessionId` rows.

## Proposed follow-up implementation tasks

Dependency graph:

```mermaid
flowchart TD
	A[Design gate: space-actor-communication-design]
	B[Create Space actor + conversation schema]
	C[Implement address resolver + role bindings]
	D[Implement message/delivery router + queue]
	E[Add generic messaging MCP/RPC tools]
	F[Wrap existing space-agent/node-agent/task-agent messaging]
	G[Refactor MCP attachment by session role]
	H[Add Space Session -> Long-term Agent routing]
	I[Add Long-term Agent inbox + DM runtime]
	J[Add Workflow Worker role escalation]
	K[Retire default task-agent helper]
	L[Build UI for actors, handles, conversations]

	A --> B
	B --> C
	C --> D
	D --> E
	E --> F
	E --> H
	E --> I
	F --> G
	F --> J
	G --> K
	H --> L
	I --> L
	J --> L
	K --> L
```

### New tasks to create

1. **Add Space actor and conversation persistence**
   - Depends on this design.
   - Add schema/repositories/types and seed Coordinator/Human/Session/System actors.

2. **Implement Space address resolver and role bindings**
   - Depends on actor persistence.
   - Supports handles, roles, sessions, workers, channels, task/workflow/session threads, fallback.

3. **Implement Space message router and delivery queue**
   - Depends on resolver.
   - Replaces pending queue internals with delivery rows, retry/TTL, activation hooks, audit events,
     loop guard.

4. **Expose generic Space Messaging MCP/RPC tools**
   - Depends on router.
   - Adds `send_message`, `list_actors`, `resolve_address`, `list_conversations`,
     `read_conversation`, `mark_handled`.

5. **Migrate legacy messaging tools to Space Messaging wrappers**
   - Depends on generic tools.
   - Refactors `send_message_to_task`, node-agent `send_message`, task-agent `send_message`, and
     human task RPC to delegate to the new service.

6. **Implement Long-term Agent inbox and DM runtime**
   - Depends on generic tools.
   - Enables Long-term Agent ↔ Long-term Agent messaging and activation.

7. **Implement Space Session to Long-term Agent messaging**
   - Depends on generic tools.
   - Ensures ad-hoc sessions can send to role agents and receive replies in session threads.

8. **Implement Workflow Worker role escalation**
   - Depends on legacy wrappers and resolver.
   - Supports blocked/question escalation to `@task-manager`, fallback `@coordinator`, and workflow
     thread continuity.

9. **Add actor/channel/conversation UI**
   - Depends on generic RPC and core runtime.
   - Adds handles, channels, DMs, task/workflow/session thread views, notification settings.

### Existing draft task updates

#### #398 — Untangle Space MCP ownership by session role

Update rather than run as originally scoped. New scope should depend on generic messaging tools and
become **Refactor Space MCP attachment by actor/session role**.

Changes:

- Use explicit actor/session role resolver from this design.
- Attach generic Space Messaging MCP to Coordinator, Space Sessions, Long-term Agents, and Workflow
  Workers through role-appropriate wrappers.
- Keep db-query/registry/fetch tools separate from messaging tools.
- Replace all current skip mechanisms with actor/session-role policy: `session.type === 'space_chat'`,
  `session.type === 'space_task_agent'`, and workflow sub-session ID checks using `:task:` plus
  `:exec:`. Do not treat `:agent:` as a guard; it is part of workflow session ID construction.

Dependency: after tasks 1–5 above.

#### #399 — Fix Space ad-hoc session MCP reattach after daemon restart

Supersede as a standalone fix if generic role-based attachment is prioritized. If restart bug must be
fixed before the messaging migration, keep a short tactical task.

Recommended update:

- Short-term: ensure Space Session/ad-hoc sessions reattach current tools before first post-restart
  query.
- Long-term: replace with Phase 5 role-based attachment policy and regression tests that verify
  generic messaging tools are present.

Dependency: short-term can run now; long-term depends on #398 updated scope.

#### #400 — Remove built-in task-agent LLM helper from Space workflows

Update to depend on task threads and generic messaging wrappers. Removing the helper before the
substrate exists risks losing human task messages and worker escalation paths.

Recommended new scope:

- After task-thread messaging and workflow escalation work, retire default `space_task_agent` LLM
  helper.
- Preserve runtime services, workflow worker tools, pending delivery compatibility, and existing DB
  rows.
- Route human task messages to task threads, Coordinator, Task Manager, or explicit workers through
  Space Messaging.

Dependency: after tasks 1–5 and 8 above.

## Non-goals

- Implementing full Slack UI in the first backend migration.
- Cross-Space federation.
- External user invites and organization-wide directory.
- Replacing provider/session execution engine.
- Allowing messages to bypass workflow gates or human approval requirements.

## Acceptance criteria mapping

- Avoid hardcoded agent-to-agent assumptions: actors, roles, resolver, conversations, deliveries, and
  wrappers replace one-off paths.
- Existing concepts mapped: see Existing concept mapping and Actor taxonomy.
- Space ad-hoc sessions send messages to Long-term Agents: see routing flow and session thread model.
- Long-term Agents send/receive messages from each other: see DM flow and inbox model.
- Workflow Workers escalate to role agents: see blocked escalation flow and fallback rules.
- Dependency graph included: see follow-up implementation tasks.
