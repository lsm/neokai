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
 * All events must be plain objects so we can safely read `sessionId` for
 * scoped routing.
 */
export interface InternalEventPayload {
	/** Session-scoped routing key.  Use `'global'` for app-wide events. */
	sessionId: string;

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
	 * the matching `sessionId`.  Omit for a global subscription.
	 */
	sessionId?: string;
}

export type InternalEventHandler<TPayload> = (data: TPayload) => void | Promise<void>;

interface RegisteredHandler {
	subscriberName: string;
	handler: (data: unknown) => void | Promise<void>;
}

const GLOBAL_SESSION_KEY = '__global__';

/**
 * InternalEventBus
 *
 * @template TEventMap — map of dot-separated event names to payload shapes.
 */
export class InternalEventBus<TEventMap extends object = Record<string, InternalEventPayload>> {
	// event → sessionId → handlers
	private handlers = new Map<string, Map<string, Set<RegisteredHandler>>>();

	/**
	 * Subscribe to an event.
	 *
	 * @param event     — typed event name
	 * @param handler   — callback invoked when the event is published
	 * @param options   — must include `subscriberName`; optional `sessionId` filter
	 * @returns unsubscribe function
	 */
	subscribe<K extends keyof TEventMap & string>(
		event: K,
		handler: InternalEventHandler<TEventMap[K] & InternalEventPayload>,
		options: SubscribeOptions
	): () => void {
		const eventKey = event;
		const sessionKey = options.sessionId ?? GLOBAL_SESSION_KEY;

		if (options.sessionId === GLOBAL_SESSION_KEY) {
			throw new Error(
				`'${GLOBAL_SESSION_KEY}' is a reserved session key and cannot be used as an explicit sessionId`
			);
		}

		if (!options.subscriberName || options.subscriberName.trim().length === 0) {
			throw new Error('InternalEventBus.subscribe requires a non-empty subscriberName');
		}

		let sessionMap = this.handlers.get(eventKey);
		if (!sessionMap) {
			sessionMap = new Map();
			this.handlers.set(eventKey, sessionMap);
		}

		let handlerSet = sessionMap.get(sessionKey);
		if (!handlerSet) {
			handlerSet = new Set();
			sessionMap.set(sessionKey, handlerSet);
		}

		const registered: RegisteredHandler = {
			subscriberName: options.subscriberName,
			handler: handler as (data: unknown) => void | Promise<void>,
		};

		handlerSet.add(registered);

		return () => {
			const map = this.handlers.get(eventKey);
			if (!map) return;
			const set = map.get(sessionKey);
			if (!set) return;
			set.delete(registered);
			if (set.size === 0) map.delete(sessionKey);
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
		const sessionMap = this.handlers.get(eventKey);

		if (!sessionMap || sessionMap.size === 0) {
			return { delivered: 0, failures: [] };
		}

		const sessionId = data.sessionId;
		const failures: HandlerFailure[] = [];
		let delivered = 0;

		const targets: RegisteredHandler[] = [];

		// Session-scoped handlers
		const scoped = sessionMap.get(sessionId);
		if (scoped) {
			for (const h of scoped) targets.push(h);
		}

		// Global handlers — only add when sessionId is not the global sentinel
		// to prevent double-delivery of the same handler set.
		if (sessionId !== GLOBAL_SESSION_KEY) {
			const global = sessionMap.get(GLOBAL_SESSION_KEY);
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
	 * Remove every handler for the given event (all sessions).
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
	 * across all session scopes.
	 */
	getHandlerCount<K extends keyof TEventMap & string>(event: K): number {
		const sessionMap = this.handlers.get(event);
		if (!sessionMap) return 0;
		let total = 0;
		for (const set of sessionMap.values()) {
			total += set.size;
		}
		return total;
	}

	/**
	 * Return the number of registered handlers for a specific session scope.
	 */
	getHandlerCountForSession<K extends keyof TEventMap & string>(
		event: K,
		sessionId: string
	): number {
		const sessionMap = this.handlers.get(event);
		if (!sessionMap) return 0;
		return sessionMap.get(sessionId)?.size ?? 0;
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
