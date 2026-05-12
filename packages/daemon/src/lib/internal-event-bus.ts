/**
 * InternalEventBus — Semantic daemon messaging primitive (v1)
 *
 * First-class facade for typed internal events with explicit await-vs-fire-and-forget
 * semantics.  New daemon/domain code publishes and subscribes through this facade
 * instead of importing DaemonHub directly.
 *
 * Semantics
 * ---------
 * • `publish(...)`  – awaits every local internal handler and returns/throws
 *   structured handler failures.  Use when the caller must know whether all
 *   subscribers succeeded.
 * • `publishAsync(...)` – explicit fire-and-forget.  Returns immediately;
 *   handler failures are silently swallowed.
 *
 * Design constraints (v1)
 * -----------------------
 * • Wraps existing lower-level infrastructure where practical — the registry is
 *   kept in-process and does not migrate existing callers.
 * • No persistence / no replay.
 * • Subscriber names are required for diagnostics.
 *
 * Future direction
 * ----------------
 * See docs/plans/internal-event-command-query-architecture.md for the full
 * internal-event / command / query architecture plan.
 */

import type { GlobalSettings } from '@neokai/shared';
import type { ExternalEventPublishedPayload } from './external-events/external-event-service';

export interface HandlerFailure {
	/** Subscriber name that registered the failing handler. */
	subscriberName: string;

	/** Event name being handled when the failure occurred. */
	event: string;

	/** The raw Error (or Error-like) thrown by the handler. */
	error: Error;
}

export interface PublishResult {
	/** Number of handlers that completed successfully. */
	delivered: number;

	/** Structured failures from handlers that threw or rejected. */
	failures: HandlerFailure[];
}

/**
 * Thrown by `publish(...)` when one or more handlers fail.
 * The `result` field contains the full breakdown so callers can decide
 * whether to abort, partially retry, or continue.
 */
export class InternalEventBusPublishError extends Error {
	constructor(
		public readonly event: string,
		public readonly result: PublishResult
	) {
		super(
			`Publish of '${event}' failed with ${result.failures.length} handler failure(s) ` +
				`(${result.delivered} succeeded)`
		);
		this.name = 'InternalEventBusPublishError';
	}
}

/**
 * Generic constraint for event-map entries.
 * All events must be plain objects so we can safely read `namespaceId` for
 * scoped routing.
 */
export interface InternalEventPayload {
	/** Namespace routing key.  Use `'global'` for app-wide events. */
	namespaceId: string;

	[key: string]: unknown;
}

/**
 * Subscription options.
 */
export interface SubscribeOptions {
	/**
	 * Human-readable subscriber identifier used in diagnostics and
	 * `HandlerFailure.subscriberName`.  Required.
	 */
	subscriberName: string;

	/**
	 * When provided, the handler only receives events whose payload carries
	 * the matching `namespaceId`.  Omit for a global subscription.
	 */
	namespaceId?: string;
}

export type InternalEventHandler<TPayload> = (data: TPayload) => void | Promise<void>;

interface RegisteredHandler {
	subscriberName: string;
	handler: (data: unknown) => void | Promise<void>;
}

const GLOBAL_NAMESPACE_KEY = '__global__';

/**
 * InternalEventBus
 *
 * @template TEventMap — map of dot-separated event names to payload shapes.
 */
export class InternalEventBus<TEventMap extends object = Record<string, InternalEventPayload>> {
	// event → namespaceId → handlers
	private handlers = new Map<string, Map<string, Set<RegisteredHandler>>>();

	/**
	 * Subscribe to an event.
	 *
	 * @param event     — typed event name
	 * @param handler   — callback invoked when the event is published
	 * @param options   — must include `subscriberName`; optional `namespaceId` filter
	 * @returns unsubscribe function
	 */
	subscribe<K extends keyof TEventMap & string>(
		event: K,
		handler: InternalEventHandler<TEventMap[K] & InternalEventPayload>,
		options: SubscribeOptions
	): () => void {
		const eventKey = event;
		const namespaceKey = options.namespaceId ?? GLOBAL_NAMESPACE_KEY;

		if (options.namespaceId === GLOBAL_NAMESPACE_KEY) {
			throw new Error(
				`'${GLOBAL_NAMESPACE_KEY}' is a reserved namespace key and cannot be used as an explicit namespaceId`
			);
		}

		if (!options.subscriberName || options.subscriberName.trim().length === 0) {
			throw new Error('InternalEventBus.subscribe requires a non-empty subscriberName');
		}

		let namespaceMap = this.handlers.get(eventKey);
		if (!namespaceMap) {
			namespaceMap = new Map();
			this.handlers.set(eventKey, namespaceMap);
		}

		let handlerSet = namespaceMap.get(namespaceKey);
		if (!handlerSet) {
			handlerSet = new Set();
			namespaceMap.set(namespaceKey, handlerSet);
		}

		const registered: RegisteredHandler = {
			subscriberName: options.subscriberName,
			handler: handler as (data: unknown) => void | Promise<void>,
		};

		handlerSet.add(registered);

		return () => {
			const map = this.handlers.get(eventKey);
			if (!map) return;
			const set = map.get(namespaceKey);
			if (!set) return;
			set.delete(registered);
			if (set.size === 0) map.delete(namespaceKey);
			if (map.size === 0) this.handlers.delete(eventKey);
		};
	}

	/**
	 * Publish an event and **await** every local internal handler.
	 *
	 * All matching handlers are executed concurrently.  If any handler throws,
	 * the error is captured in a structured `HandlerFailure`, every other
	 * handler still runs, and the method finally throws
	 * `InternalEventBusPublishError` containing the full `PublishResult`.
	 *
	 * When **all** handlers succeed the returned `PublishResult` contains
	 * `failures: []` and is never thrown.
	 */
	async publish<K extends keyof TEventMap & string>(
		event: K,
		data: TEventMap[K] & InternalEventPayload
	): Promise<PublishResult> {
		const eventKey = event;
		const namespaceMap = this.handlers.get(eventKey);

		if (!namespaceMap || namespaceMap.size === 0) {
			return { delivered: 0, failures: [] };
		}

		const namespaceId = data.namespaceId;
		const failures: HandlerFailure[] = [];
		let delivered = 0;

		const targets: RegisteredHandler[] = [];

		// Namespace-scoped handlers
		const scoped = namespaceMap.get(namespaceId);
		if (scoped) {
			for (const h of scoped) targets.push(h);
		}

		// Global handlers — only add when namespaceId is not the global sentinel
		// to prevent double-delivery of the same handler set.
		if (namespaceId !== GLOBAL_NAMESPACE_KEY) {
			const global = namespaceMap.get(GLOBAL_NAMESPACE_KEY);
			if (global) {
				for (const h of global) targets.push(h);
			}
		}

		if (targets.length === 0) {
			return { delivered: 0, failures: [] };
		}

		// Run every handler concurrently; collect failures individually.
		await Promise.all(
			targets.map(async (registered) => {
				try {
					await registered.handler(data);
					delivered++;
				} catch (raw) {
					const error = raw instanceof Error ? raw : new Error(String(raw));
					failures.push({
						subscriberName: registered.subscriberName,
						event: eventKey,
						error,
					});
				}
			})
		);

		const result: PublishResult = { delivered, failures };

		if (failures.length > 0) {
			throw new InternalEventBusPublishError(eventKey, result);
		}

		return result;
	}

	/**
	 * Fire-and-forget publish.
	 *
	 * Schedules handlers asynchronously but returns immediately.
	 * Handler failures are silently swallowed; they are never thrown
	 * and the caller cannot await them.
	 */
	publishAsync<K extends keyof TEventMap & string>(
		event: K,
		data: TEventMap[K] & InternalEventPayload
	): void {
		// Defer to the next microtask so that synchronous handlers do not
		// run on the caller's stack and `publishAsync` truly returns
		// immediately.
		queueMicrotask(() => {
			this.publish(event, data).catch(() => {
				// Swallow — publishAsync is explicit fire-and-forget.
			});
		});
	}

	/**
	 * Remove every handler for the given event (all namespaces).
	 */
	off<K extends keyof TEventMap & string>(event: K): void {
		this.handlers.delete(event);
	}

	/**
	 * Remove all handlers for every event.
	 */
	clear(): void {
		this.handlers.clear();
	}

	/**
	 * Return the total number of registered handlers for an event
	 * across all namespace scopes.
	 */
	getHandlerCount<K extends keyof TEventMap & string>(event: K): number {
		const namespaceMap = this.handlers.get(event);
		if (!namespaceMap) return 0;
		let total = 0;
		for (const set of namespaceMap.values()) {
			total += set.size;
		}
		return total;
	}

	/**
	 * Return the number of registered handlers for a specific namespace scope.
	 */
	getHandlerCountForNamespace<K extends keyof TEventMap & string>(
		event: K,
		namespaceId: string
	): number {
		const namespaceMap = this.handlers.get(event);
		if (!namespaceMap) return 0;
		return namespaceMap.get(namespaceId)?.size ?? 0;
	}
}

/**
 * Convenience factory that produces an InternalEventBus typed with the
 * caller's event map.
 *
 * This is the entry point most daemon code should use:
 *
 *   import { createInternalEventBus } from '@neokai/daemon/lib/internal-event-bus';
 *   const bus = createInternalEventBus<MyEventMap>();
 */
export function createInternalEventBus<
	TEventMap extends object = Record<string, InternalEventPayload>,
>(): InternalEventBus<TEventMap> {
	return new InternalEventBus<TEventMap>();
}

// ---------------------------------------------------------------------------
// Event contracts — canonical payloads for events migrated to InternalEventBus.
// Expand this map as new events are migrated off DaemonHub; keep each domain's
// events in a separate interface and intersect them here.
//
// Naming convention: dot-separated, lower camelCase per segment, fact/state-
// change wording. See docs/plans/internal-event-command-query-architecture.md.
// ---------------------------------------------------------------------------

/**
 * Payload for `settings.updated` — emitted when global settings are updated
 * via `settings.global.update`, `settings.global.save`, or after a successful
 * `.mcp.json` import refresh. Subscribers (e.g. StateProjectionService) re-broadcast
 * the latest settings to clients on the global settings channel.
 *
 * Always carries `namespaceId: 'global'` — settings are application-wide.
 */
export interface SettingsUpdatedEvent {
	namespaceId: string;
	settings: GlobalSettings;
}

/**
 * Settings domain events.
 */
export interface SettingsEvents {
	'settings.updated': SettingsUpdatedEvent;
}

/**
 * External event domain events.
 */
export interface ExternalEventEvents {
	'externalEvent.published': ExternalEventPublishedPayload;
}

/**
 * Session domain events — migrated from DaemonHub to InternalEventBus in M5.
 * These events drive StateProjectionService cache updates.
 */
export interface SessionEvents {
	'session.created': { namespaceId: string; session: import('@neokai/shared').Session };
	'session.updated': {
		namespaceId: string;
		source?: string;
		session?: Partial<import('@neokai/shared').Session>;
		processingState?: import('@neokai/shared').AgentProcessingState;
	};
	'session.deleted': { namespaceId: string };
	'commands.updated': { namespaceId: string; commands: string[] };
	'session.error': { namespaceId: string; error: string; details?: unknown };
	'session.errorClear': { namespaceId: string };
}

/**
 * API connection events — migrated from DaemonHub to InternalEventBus in M5.
 */
export interface ApiConnectionEvents {
	'api.connection': { namespaceId: string } & import('@neokai/shared').ApiConnectionState;
}

// ---------------------------------------------------------------------------
// Space runtime events — migrated from NotificationSink to InternalEventBus in M6.
// Naming: dot-separated, lower camelCase per segment, fact/state-change wording.
// ---------------------------------------------------------------------------

/** A task has transitioned to `blocked` and requires judgment. */
export interface SpaceTaskBlockedEvent {
	namespaceId: string;
	spaceId: string;
	taskId: string;
	reason: string;
	timestamp: string;
}

/**
 * A task has been unblocked and is resuming.
 *
 * Reserved: defined in the event map for forward compatibility, but not yet
 * emitted by any publisher. Will be wired when the runtime adds an unblock path.
 */
export interface SpaceTaskUnblockedEvent {
	namespaceId: string;
	spaceId: string;
	taskId: string;
	reason: string;
	timestamp: string;
}

/**
 * A task has reached a terminal state (completed, failed, or cancelled).
 *
 * Reserved: defined in the event map for forward compatibility, but not yet
 * emitted by any publisher. The runtime currently emits `workflowRun.completed`
 * for terminal runs rather than per-task completion events.
 */
export interface SpaceTaskCompletedEvent {
	namespaceId: string;
	spaceId: string;
	taskId: string;
	status: 'done' | 'cancelled' | 'blocked';
	timestamp: string;
}

/**
 * A task has failed with an unrecoverable error.
 *
 * Reserved: defined in the event map for forward compatibility, but not yet
 * emitted by any publisher. Task failures are currently surfaced via
 * `space.task.blocked` with the failure reason.
 */
export interface SpaceTaskFailedEvent {
	namespaceId: string;
	spaceId: string;
	taskId: string;
	reason: string;
	timestamp: string;
}

/** A Task Agent session crashed unexpectedly. */
export interface SpaceAgentCrashedEvent {
	namespaceId: string;
	spaceId: string;
	taskId: string;
	timestamp: string;
}

/**
 * A crashed agent has been recovered (e.g. after retry).
 *
 * Reserved: defined in the event map for forward compatibility, but not yet
 * emitted by any publisher. Recovery is currently silent; agents are retried
 * without emitting a dedicated recovery event.
 */
export interface SpaceAgentRecoveredEvent {
	namespaceId: string;
	spaceId: string;
	taskId: string;
	timestamp: string;
}

/** A stuck agent was auto-completed by the runtime after timeout. */
export interface SpaceAgentAutoCompletedEvent {
	namespaceId: string;
	spaceId: string;
	taskId: string;
	elapsedMs: number;
	timestamp: string;
}

/** A node agent went idle without a terminal SDK message or reported status. */
export interface SpaceAgentIdleNonTerminalEvent {
	namespaceId: string;
	spaceId: string;
	taskId: string;
	runId: string;
	executionId: string;
	nodeId: string;
	agentName: string;
	reason: string;
	timestamp: string;
}

/** A workflow run has reached a terminal state. */
export interface SpaceWorkflowRunCompletedEvent {
	namespaceId: string;
	spaceId: string;
	runId: string;
	status: 'done' | 'cancelled' | 'blocked';
	summary?: string;
	timestamp: string;
}

/** A workflow run has failed with an unrecoverable error. */
export interface SpaceWorkflowRunFailedEvent {
	namespaceId: string;
	spaceId: string;
	runId: string;
	reason: string;
	timestamp: string;
}

/** A workflow run has transitioned to `blocked`. */
export interface SpaceWorkflowRunBlockedEvent {
	namespaceId: string;
	spaceId: string;
	runId: string;
	reason: string;
	timestamp: string;
}

/** A previously-terminal workflow run has been reopened back to `in_progress`. */
export interface SpaceWorkflowRunReopenedEvent {
	namespaceId: string;
	spaceId: string;
	runId: string;
	fromStatus: 'done' | 'cancelled';
	reason: string;
	by: string;
	timestamp: string;
}

/** A blocked execution is being automatically retried by the runtime. */
export interface SpaceWorkflowRunRetryEvent {
	namespaceId: string;
	spaceId: string;
	taskId: string;
	runId: string;
	originalReason: string;
	attemptNumber: number;
	maxAttempts: number;
	timestamp: string;
}

/** A blocked workflow run has exhausted automatic retries and needs attention. */
export interface SpaceWorkflowRunNeedsAttentionEvent {
	namespaceId: string;
	spaceId: string;
	runId: string;
	taskId: string;
	reason: string;
	retriesExhausted: number;
	timestamp: string;
}

/** A task has paused at a completion action that requires approval. */
export interface SpaceTaskAwaitingApprovalEvent {
	namespaceId: string;
	spaceId: string;
	taskId: string;
	actionId: string;
	actionName: string;
	actionDescription?: string;
	actionType: 'script' | 'instruction' | 'mcp_call';
	requiredLevel: number;
	spaceLevel: number;
	autonomyLevel: number;
	timestamp: string;
}

/** A task has been running longer than the configured timeout threshold. */
export interface SpaceTaskTimeoutEvent {
	namespaceId: string;
	spaceId: string;
	taskId: string;
	elapsedMs: number;
	timestamp: string;
}

/**
 * Space domain events — migrated from NotificationSink to InternalEventBus in M6.
 */
export interface SpaceEvents {
	'space.task.blocked': SpaceTaskBlockedEvent;
	'space.task.unblocked': SpaceTaskUnblockedEvent;
	'space.task.completed': SpaceTaskCompletedEvent;
	'space.task.failed': SpaceTaskFailedEvent;
	'space.agent.crashed': SpaceAgentCrashedEvent;
	'space.agent.recovered': SpaceAgentRecoveredEvent;
	'space.agent.autoCompleted': SpaceAgentAutoCompletedEvent;
	'space.agent.idleNonTerminal': SpaceAgentIdleNonTerminalEvent;
	'space.workflowRun.completed': SpaceWorkflowRunCompletedEvent;
	'space.workflowRun.failed': SpaceWorkflowRunFailedEvent;
	'space.workflowRun.blocked': SpaceWorkflowRunBlockedEvent;
	'space.workflowRun.reopened': SpaceWorkflowRunReopenedEvent;
	'space.workflowRun.retry': SpaceWorkflowRunRetryEvent;
	'space.workflowRun.needsAttention': SpaceWorkflowRunNeedsAttentionEvent;
	'space.task.awaitingApproval': SpaceTaskAwaitingApprovalEvent;
	'space.task.timeout': SpaceTaskTimeoutEvent;
}

/**
 * Client-visible Space events — migrated from DaemonHub to InternalEventBus in M2.
 *
 * These are broadcast events consumed by ClientEventBridge and the web UI. They
 * intentionally keep the historical event names so existing client subscriptions
 * remain unchanged. Runtime/domain-only events (for example `space.task.blocked`)
 * stay in `SpaceEvents` above.
 */
export interface SpaceClientEvents {
	'space.task.created': {
		namespaceId: string;
		sessionId: string;
		spaceId: string;
		taskId: string;
		task: import('@neokai/shared').SpaceTask;
	};
	'space.task.updated': {
		namespaceId: string;
		sessionId: string;
		spaceId: string;
		taskId: string;
		task: import('@neokai/shared').SpaceTask;
		archiveSource?: 'user' | 'system_reconcile';
	};
	'space.workflowRun.created': {
		namespaceId: string;
		sessionId: string;
		spaceId: string;
		runId: string;
		run: import('@neokai/shared').SpaceWorkflowRun;
	};
	'space.workflowRun.updated': {
		namespaceId: string;
		sessionId: string;
		spaceId: string;
		runId: string;
		run?: Partial<import('@neokai/shared').SpaceWorkflowRun>;
	};
	'space.gateData.updated': {
		namespaceId: string;
		sessionId: string;
		spaceId: string;
		runId: string;
		gateId: string;
		data: Record<string, unknown>;
	};
	'space.created': {
		namespaceId: string;
		sessionId: string;
		spaceId: string;
		space: import('@neokai/shared').Space;
	};
	'space.updated': {
		namespaceId: string;
		sessionId: string;
		spaceId: string;
		space?: Partial<import('@neokai/shared').Space>;
	};
	'space.archived': {
		namespaceId: string;
		sessionId: string;
		spaceId: string;
		space: import('@neokai/shared').Space;
	};
	'space.deleted': { namespaceId: string; sessionId: string; spaceId: string };
	'space.githubEvent.routed': {
		namespaceId: string;
		sessionId: string;
		taskId: string;
		event: {
			repo: string;
			prNumber: number;
			eventType: string;
			summary: string;
			externalUrl: string;
		};
	};
	'space.artifactCache.updated': {
		namespaceId: string;
		sessionId: string;
		spaceId: string;
		runId: string;
		taskId: string;
		cacheKey: string;
		status: 'ok' | 'syncing' | 'error';
	};
	'space.pendingMessage.queued': {
		namespaceId: string;
		sessionId: string;
		spaceId: string;
		workflowRunId: string;
		taskId: string | null;
		targetAgentName: string;
		targetKind: 'node_agent' | 'space_agent';
		messageId: string;
		attempts: number;
		maxAttempts: number;
		expiresAt: number;
		deduped: boolean;
	};
	'space.pendingMessage.delivered': {
		namespaceId: string;
		sessionId: string;
		spaceId: string;
		workflowRunId: string;
		targetAgentName: string;
		targetKind: string;
		messageId: string;
		deliveredSessionId: string;
	};
	'space.schedule.updated': {
		namespaceId: string;
		sessionId: string;
		spaceId: string;
		scheduleId: string;
		schedule: import('@neokai/shared').TaskSchedule;
	};
	'space.workflowRun.cyclesReset': {
		namespaceId: string;
		sessionId: string;
		runId: string;
		reason: 'human_touch';
		taskId?: string;
		rowsReset: number;
	};
}

/**
 * Canonical daemon internal event map.
 *
 * Each domain should own its slice; this type is the intersection of all
 * domain event maps so the bus can be typed with the full surface.
 *
 * NOTE: This map intentionally starts small. New events are added here as
 * publishers/subscribers migrate off DaemonHub. Events that have not yet been
 * migrated continue to flow through DaemonHub (`createDaemonHub`) and the
 * compatibility `DaemonEventMap`.
 */
/**
 * Context / session-scoped events — migrated from DaemonHub in M2.
 * These carry sessionId as a field but also need namespaceId for bus routing.
 */
export interface ContextEvents {
	'context.updated': {
		namespaceId: string;
		sessionId: string;
		contextInfo: import('@neokai/shared').ContextInfo;
	};
}

/**
 * Agent domain events — migrated from DaemonHub in M2.
 */
export interface AgentEvents {
	'sdk.message': {
		namespaceId: string;
		sessionId: string;
		message: unknown;
		deliveryMode?: string;
	};
	'question.asked': {
		namespaceId: string;
		sessionId: string;
		[key: string]: unknown;
	};
	'question.answered': {
		namespaceId: string;
		sessionId: string;
		answer: unknown;
	};
	'question.injected_as_tool_result': {
		namespaceId: string;
		sessionId: string;
		[key: string]: unknown;
	};
	'question.orphaned': {
		namespaceId: string;
		sessionId: string;
		[key: string]: unknown;
	};
	'model.changed': {
		namespaceId: string;
		sessionId: string;
		model: string;
		provider: string;
	};
	'model.switched': {
		namespaceId: string;
		sessionId: string;
		model: string;
		provider?: string;
		success?: boolean;
		error?: string;
	};
	'messages.statusChanged': {
		namespaceId: string;
		sessionId: string;
		messageIds: string[];
		status: string;
	};
	'message.sent': { namespaceId: string; sessionId: string };
	'message.persisted': {
		namespaceId: string;
		sessionId: string;
		messageId: string;
		messageContent: unknown;
		userMessageText?: string;
		needsWorkspaceInit?: boolean;
		hasDraftToClear?: boolean;
		skipQueryStart?: boolean;
	};
	'session.reset': {
		namespaceId: string;
		sessionId: string;
		session: import('@neokai/shared').Session;
		restartQuery: boolean;
	};
	'rewind.started': {
		namespaceId: string;
		sessionId: string;
		mode: string;
		[key: string]: unknown;
	};
	'rewind.completed': {
		namespaceId: string;
		sessionId: string;
		result: unknown;
		mode: string;
	};
	'rewind.failed': { namespaceId: string; sessionId: string; error: string };
	'rewind.executed': {
		namespaceId: string;
		sessionId: string;
		result: unknown;
		mode: string;
	};
	'sdk.captured': { namespaceId: string; sessionId: string; sdkSessionId: string };
	'sdk.restart': { namespaceId: string; sessionId: string };
	'slashCommands.fetched': {
		namespaceId: string;
		sessionId: string;
		commands: string[];
	};
	'agent.interrupted': { namespaceId: string; sessionId: string };
	'agent.reset': {
		namespaceId: string;
		sessionId: string;
		session?: import('@neokai/shared').Session;
		restartQuery?: boolean;
		success?: boolean;
		error?: string;
	};
	'agent.restart': {
		namespaceId: string;
		sessionId: string;
		session?: import('@neokai/shared').Session;
		restartQuery?: boolean;
		success?: boolean;
		error?: string;
	};
	'agent.interruptRequest': { namespaceId: string; sessionId: string };
	'query.trigger': { namespaceId: string; sessionId: string };
}

/**
 * Config/registry domain events — migrated from DaemonHub in M2.
 */
export interface RegistryEvents {
	'skills.changed': { namespaceId: string; sessionId: string };
	'mcp.registry.changed': { namespaceId: string; sessionId: string };
}

export interface DaemonInternalEventMap
	extends SettingsEvents,
		ExternalEventEvents,
		SessionEvents,
		ApiConnectionEvents,
		SpaceEvents,
		ContextEvents,
		AgentEvents,
		RegistryEvents,
		SpaceClientEvents {}

/**
 * Convenience factory typed with the canonical daemon internal event map.
 * Prefer this over the bare `createInternalEventBus` factory inside daemon
 * application/domain code so all migrated events share one typed surface.
 */
export function createDaemonInternalEventBus(): InternalEventBus<DaemonInternalEventMap> {
	return new InternalEventBus<DaemonInternalEventMap>();
}
