/**
 * ClientEventBridge — declarative mapping from DaemonHub internal events to client-safe events,
 * plus versioned state broadcasts and RPC handler registration.
 *
 * This module contains ALL client-facing delivery paths:
 * - Space events (21 mappings) — forwarding via ClientEventGateway
 * - Session events (session.created, session.deleted, context.updated) — forwarding
 * - Connection/auth events (api.connection, auth.changed) — trigger broadcasts
 * - Config events (commands.updated) — trigger broadcasts
 * - Error events (session.error, session.errorClear) — trigger broadcasts
 * - Versioned state broadcasts (system, settings, session state, SDK messages)
 * - RPC handlers for state snapshots (7 onRequest registrations)
 *
 * Event source split:
 * - InternalEventBus: migrated space events (see INTERNAL_SPACE_BRIDGE_EVENTS),
 *   settings.updated, session.updated
 * - DaemonHub: unmigrated space events (spaceAgent.*, spaceWorkflow.*),
 *   session.created/deleted, context.updated, api.connection,
 *   auth.changed, commands.updated, session.error/errorClear
 *
 * The bridge subscribes to InternalEventBus for settings.updated and session.updated
 * because those events are published there (settings handlers use publishAsync,
 * session.updated needs projection caches to be written first). DaemonHub events
 * are forwarded to InternalEventBus in app.ts via fire-and-forget, so subscribing
 * on InternalEventBus guarantees cache consistency for broadcasts.
 *
 * Design notes
 * ------------
 * - The bridge reads state from StateProjectionService for broadcasts and RPC responses.
 * - channelVersions are managed by StateProjectionService (via ChannelVersionSource)
 *   and accessed through the same interface.
 * - Each bridge mapping is a plain object so the registry is auditable in one place.
 * - The bridge is constructed in DaemonApp and wired before handlers start emitting events.
 */

import type {
	MessageHub,
	IClientEventGateway,
	EventChannel,
	SDKMessagesUpdate,
} from '@neokai/shared';
import { Channels, STATE_CHANNELS } from '@neokai/shared';
import type { DaemonHub, DaemonEventMap } from './daemon-hub';
import type { StateProjectionService, ChannelVersionSource } from './state-projection-service';
import type { DaemonInternalEventMap, InternalEventBus } from './internal-event-bus';
import { Logger } from './logger';

type DaemonEventName = keyof DaemonEventMap & string;
type InternalEventName = keyof DaemonInternalEventMap & string;
type BridgeEventMap = DaemonEventMap & DaemonInternalEventMap;

interface BridgeMapping {
	event: keyof BridgeEventMap & string;
	clientEvent: string;
	channel: (payload: BridgeEventMap[keyof BridgeEventMap]) => EventChannel;
	transform?: (payload: BridgeEventMap[keyof BridgeEventMap]) => unknown;
}

// ---------------------------------------------------------------------------
// Migrated Space events — subscribed on InternalEventBus
// ---------------------------------------------------------------------------

const INTERNAL_SPACE_BRIDGE_EVENTS = new Set<string>([
	'space.created',
	'space.updated',
	'space.archived',
	'space.deleted',
	'space.task.created',
	'space.task.updated',
	'space.schedule.updated',
	'space.workflowRun.created',
	'space.workflowRun.updated',
	'space.gateData.updated',
	'space.githubEvent.routed',
	'space.artifactCache.updated',
	'space.pendingMessage.queued',
	'space.pendingMessage.delivered',
	'space.workflowRun.cyclesReset',
]);

// ---------------------------------------------------------------------------
// Space bridge mappings
// ---------------------------------------------------------------------------

const SPACE_BRIDGE_MAPPINGS: BridgeMapping[] = [
	// Broad space events → global
	{
		event: 'space.created',
		clientEvent: 'space.created',
		channel: () => Channels.global(),
	},
	{
		event: 'space.updated',
		clientEvent: 'space.updated',
		channel: () => Channels.global(),
	},
	{
		event: 'space.archived',
		clientEvent: 'space.archived',
		channel: () => Channels.global(),
	},
	{
		event: 'space.deleted',
		clientEvent: 'space.deleted',
		channel: () => Channels.global(),
	},
	// Space task events → global
	{
		event: 'space.task.created',
		clientEvent: 'space.task.created',
		channel: () => Channels.global(),
	},
	{
		event: 'space.task.updated',
		clientEvent: 'space.task.updated',
		channel: () => Channels.global(),
	},
	// Space schedule events → global
	{
		event: 'space.schedule.updated',
		clientEvent: 'space.schedule.updated',
		channel: () => Channels.global(),
	},
	// Space workflow run events → global
	{
		event: 'space.workflowRun.created',
		clientEvent: 'space.workflowRun.created',
		channel: () => Channels.global(),
	},
	{
		event: 'space.workflowRun.updated',
		clientEvent: 'space.workflowRun.updated',
		channel: () => Channels.global(),
	},
	// Gate data and misc client-visible space events → global
	{
		event: 'space.gateData.updated',
		clientEvent: 'space.gateData.updated',
		channel: () => Channels.global(),
	},
	{
		event: 'space.githubEvent.routed',
		clientEvent: 'space.githubEvent.routed',
		channel: () => Channels.global(),
	},
	{
		event: 'space.artifactCache.updated',
		clientEvent: 'space.artifactCache.updated',
		channel: () => Channels.global(),
	},
	{
		event: 'space.pendingMessage.queued',
		clientEvent: 'space.pendingMessage.queued',
		channel: () => Channels.global(),
	},
	{
		event: 'space.pendingMessage.delivered',
		clientEvent: 'space.pendingMessage.delivered',
		channel: () => Channels.global(),
	},
	{
		event: 'space.workflowRun.cyclesReset',
		clientEvent: 'space.workflowRun.cyclesReset',
		channel: () => Channels.global(),
	},
	// Space agent events → space-scoped
	{
		event: 'spaceAgent.created',
		clientEvent: 'spaceAgent.created',
		channel: (p) => Channels.space((p as DaemonEventMap['spaceAgent.created']).spaceId),
	},
	{
		event: 'spaceAgent.updated',
		clientEvent: 'spaceAgent.updated',
		channel: (p) => Channels.space((p as DaemonEventMap['spaceAgent.updated']).spaceId),
	},
	{
		event: 'spaceAgent.deleted',
		clientEvent: 'spaceAgent.deleted',
		channel: (p) => Channels.space((p as DaemonEventMap['spaceAgent.deleted']).spaceId),
	},
	// Space workflow definition events → global
	{
		event: 'spaceWorkflow.created',
		clientEvent: 'spaceWorkflow.created',
		channel: () => Channels.global(),
	},
	{
		event: 'spaceWorkflow.updated',
		clientEvent: 'spaceWorkflow.updated',
		channel: () => Channels.global(),
	},
	{
		event: 'spaceWorkflow.deleted',
		clientEvent: 'spaceWorkflow.deleted',
		channel: () => Channels.global(),
	},
];

// ---------------------------------------------------------------------------
// Session bridge mappings (pure gateway forwarding)
// ---------------------------------------------------------------------------

const SESSION_BRIDGE_MAPPINGS: BridgeMapping[] = [
	{
		event: 'session.created',
		clientEvent: 'session.created',
		channel: () => Channels.global(),
		transform: (payload) => {
			const p = payload as DaemonEventMap['session.created'];
			return { sessionId: p.session.id };
		},
	},
	{
		event: 'session.deleted',
		clientEvent: 'session.deleted',
		channel: () => Channels.global(),
		transform: (payload) => {
			const p = payload as DaemonEventMap['session.deleted'];
			return { sessionId: p.sessionId };
		},
	},
	{
		event: 'context.updated',
		clientEvent: 'context.updated',
		channel: (payload) => {
			const p = payload as DaemonEventMap['context.updated'];
			return Channels.session(p.sessionId);
		},
		transform: (payload) => {
			const p = payload as DaemonEventMap['context.updated'];
			return p.contextInfo;
		},
	},
];

/**
 * ClientEventBridge wires DaemonHub event subscriptions to ClientEventGateway
 * deliveries and manages versioned state broadcasts + RPC handlers.
 */
export class ClientEventBridge {
	private unsubscribers: (() => void)[] = [];
	private rpcUnsubscribers: (() => void)[] = [];
	private logger = new Logger('ClientEventBridge');

	constructor(
		private daemonHub: DaemonHub,
		private messageHub: MessageHub,
		private gateway: IClientEventGateway,
		private stateProjection: StateProjectionService & ChannelVersionSource,
		private internalEventBus: InternalEventBus<DaemonInternalEventMap>
	) {}

	/**
	 * Subscribe to all registered events, register RPC handlers, and start forwarding.
	 * Idempotent: calling start() on an already-started bridge is a no-op.
	 */
	start(): void {
		if (this.unsubscribers.length > 0) {
			return;
		}

		// Register RPC handlers for state snapshots
		this.setupRPCHandlers();

		// Space events — migrated events use InternalEventBus, unmigrated stay on DaemonHub
		for (const mapping of SPACE_BRIDGE_MAPPINGS) {
			const source =
				this.internalEventBus && INTERNAL_SPACE_BRIDGE_EVENTS.has(mapping.event)
					? 'internal'
					: 'daemon';
			this.subscribeMapping(mapping, source);
		}

		// Session events (DaemonHub — pure forwarding + broadcast triggers)
		for (const mapping of SESSION_BRIDGE_MAPPINGS) {
			this.subscribeMapping(mapping);
		}
		this.subscribeDaemonBroadcast('context.updated', (data) =>
			this.broadcastSessionStateChange(data.sessionId)
		);

		// Connection/auth events (DaemonHub — trigger broadcasts)
		this.subscribeDaemonBroadcast('api.connection', () => this.broadcastSystemChange());
		this.subscribeDaemonBroadcast('auth.changed', () => this.broadcastSystemChange());

		// Config events (DaemonHub — trigger broadcast)
		this.subscribeDaemonBroadcast('commands.updated', (data) =>
			this.broadcastSessionStateChange(data.sessionId)
		);

		// Error events (DaemonHub — trigger broadcast)
		this.subscribeDaemonBroadcast('session.error', (data) =>
			this.broadcastSessionStateChange(data.sessionId)
		);
		this.subscribeDaemonBroadcast('session.errorClear', (data) =>
			this.broadcastSessionStateChange(data.sessionId)
		);

		// Settings events — subscribe on InternalEventBus because settings handlers
		// publish via internalEventBus.publishAsync(), not daemonHub.emit().
		this.subscribeEventBusBroadcast('settings.updated', () => this.broadcastSettingsChange());

		// Session updated — subscribe on InternalEventBus to guarantee projection
		// caches are updated before the broadcast reads them. DaemonHub →
		// InternalEventBus forwarding in app.ts settles the cache write before
		// this subscriber fires.
		this.subscribeEventBusBroadcast('session.updated', (data) => {
			const { namespaceId } = data as unknown as { namespaceId: string };
			return this.broadcastSessionUpdateFromCache(namespaceId);
		});
	}

	/**
	 * Unsubscribe from all events and RPC handlers. After stop(), start() may be
	 * called again.
	 */
	stop(): void {
		for (const unsub of this.unsubscribers) {
			unsub();
		}
		this.unsubscribers = [];

		for (const unsub of this.rpcUnsubscribers) {
			unsub();
		}
		this.rpcUnsubscribers = [];
	}

	// ========================================
	// RPC Handler Registration
	// ========================================

	private setupRPCHandlers(): void {
		// Global state snapshot
		const unsub1 = this.messageHub.onRequest(STATE_CHANNELS.GLOBAL_SNAPSHOT, async () => {
			return await this.stateProjection.getGlobalSnapshot();
		});
		this.rpcUnsubscribers.push(unsub1);

		// Session state snapshot
		const unsub2 = this.messageHub.onRequest(STATE_CHANNELS.SESSION_SNAPSHOT, async (data) => {
			const { sessionId } = data as { sessionId: string };
			return await this.stateProjection.getSessionSnapshot(sessionId);
		});
		this.rpcUnsubscribers.push(unsub2);

		// Unified system state handler
		const unsub3 = this.messageHub.onRequest(STATE_CHANNELS.GLOBAL_SYSTEM, async () => {
			return await this.stateProjection.getSystemState();
		});
		this.rpcUnsubscribers.push(unsub3);

		// Individual channel requests (for on-demand refresh)
		const unsub4 = this.messageHub.onRequest(STATE_CHANNELS.GLOBAL_SESSIONS, async () => {
			return await this.stateProjection.getSessionsState();
		});
		this.rpcUnsubscribers.push(unsub4);

		const unsub5 = this.messageHub.onRequest(STATE_CHANNELS.GLOBAL_SETTINGS, async () => {
			return await this.stateProjection.getSettingsState();
		});
		this.rpcUnsubscribers.push(unsub5);

		// Session-specific channel requests
		const unsub6 = this.messageHub.onRequest(STATE_CHANNELS.SESSION, async (data) => {
			const { sessionId } = data as { sessionId: string };
			return await this.stateProjection.getSessionState(sessionId);
		});
		this.rpcUnsubscribers.push(unsub6);

		const unsub7 = this.messageHub.onRequest(STATE_CHANNELS.SESSION_SDK_MESSAGES, async (data) => {
			const { sessionId, since } = data as {
				sessionId: string;
				since?: number;
			};
			return await this.stateProjection.getSDKMessagesState(sessionId, since);
		});
		this.rpcUnsubscribers.push(unsub7);
	}

	// ========================================
	// State Change Broadcasters
	// ========================================

	/**
	 * Broadcast session update from cached state (event-sourced)
	 */
	private async broadcastSessionUpdateFromCache(sessionId: string): Promise<void> {
		try {
			await this.broadcastSessionStateChange(sessionId);
		} catch (error) {
			this.logger.warn(`Failed to broadcast session update for ${sessionId}:`, error);
		}
	}

	/**
	 * Broadcast unified system state change (auth + config + health)
	 */
	async broadcastSystemChange(): Promise<void> {
		const version = this.stateProjection.incrementVersion(STATE_CHANNELS.GLOBAL_SYSTEM);
		const state = { ...(await this.stateProjection.getSystemState()), version };

		this.messageHub.event(STATE_CHANNELS.GLOBAL_SYSTEM, state, {
			channel: 'global',
		});
	}

	/**
	 * Broadcast global settings change
	 */
	async broadcastSettingsChange(): Promise<void> {
		const version = this.stateProjection.incrementVersion(STATE_CHANNELS.GLOBAL_SETTINGS);
		const state = { ...(await this.stateProjection.getSettingsState()), version };

		this.messageHub.event(STATE_CHANNELS.GLOBAL_SETTINGS, state, {
			channel: 'global',
		});
	}

	/**
	 * Broadcast unified session state change (metadata + agent + commands + context)
	 */
	async broadcastSessionStateChange(sessionId: string): Promise<void> {
		// Guard: an empty sessionId indicates an upstream event emitted without a
		// valid session (e.g. a provider error surfacing before session binding).
		if (!sessionId) {
			return;
		}

		const version = this.stateProjection.incrementVersion(`${STATE_CHANNELS.SESSION}:${sessionId}`);

		try {
			const state = { ...(await this.stateProjection.getSessionState(sessionId)), version };

			this.messageHub.event(STATE_CHANNELS.SESSION, state, {
				channel: `session:${sessionId}`,
			});
		} catch (error) {
			// Session may have been deleted or database may be closed during cleanup
			this.logger.warn(
				`[ClientEventBridge] Failed to broadcast session state for ${sessionId}:`,
				error instanceof Error ? error.message : error
			);

			// Fallback: if we have cached processing state, broadcast a minimal
			// state update. This ensures UI state (like stop/send button) stays in
			// sync even if full state fetch fails (e.g., teardown races).
			const fallback = this.stateProjection.getCachedSessionState(sessionId);
			if (fallback) {
				try {
					this.messageHub.event(
						STATE_CHANNELS.SESSION,
						{ ...fallback, version },
						{
							channel: `session:${sessionId}`,
						}
					);
				} catch (fallbackError) {
					this.logger.error(
						`[ClientEventBridge] Fallback broadcast also failed for ${sessionId}:`,
						fallbackError instanceof Error ? fallbackError.message : fallbackError
					);
				}
			}
		}
	}

	/**
	 * Broadcast SDK messages change
	 */
	async broadcastSDKMessagesChange(sessionId: string): Promise<void> {
		const version = this.stateProjection.incrementVersion(
			`${STATE_CHANNELS.SESSION_SDK_MESSAGES}:${sessionId}`
		);
		const state = { ...(await this.stateProjection.getSDKMessagesState(sessionId)), version };

		this.messageHub.event(STATE_CHANNELS.SESSION_SDK_MESSAGES, state, {
			channel: `session:${sessionId}`,
		});
	}

	/**
	 * Broadcast SDK messages delta (single new message)
	 */
	async broadcastSDKMessagesDelta(sessionId: string, update: SDKMessagesUpdate): Promise<void> {
		const version = this.stateProjection.incrementVersion(
			`${STATE_CHANNELS.SESSION_SDK_MESSAGES}.delta:${sessionId}`
		);
		this.messageHub.event(
			`${STATE_CHANNELS.SESSION_SDK_MESSAGES}.delta`,
			{ ...update, version },
			{ channel: `session:${sessionId}` }
		);
	}

	// ========================================
	// Private helpers
	// ========================================

	private subscribeMapping(
		mapping: BridgeMapping,
		source: 'daemon' | 'internal' = 'daemon'
	): void {
		const handler = (data: BridgeEventMap[keyof BridgeEventMap]) => {
			const payload = mapping.transform ? mapping.transform(data) : data;
			this.gateway.publish(mapping.clientEvent, payload, mapping.channel(data));
		};

		if (source === 'internal') {
			const unsub = this.internalEventBus.subscribe(
				mapping.event as InternalEventName,
				handler as (data: DaemonInternalEventMap[InternalEventName]) => void,
				{ subscriberName: 'ClientEventBridge' }
			);
			this.unsubscribers.push(unsub);
			return;
		}

		const unsub = this.daemonHub.on(
			mapping.event as DaemonEventName,
			handler as (data: DaemonEventMap[DaemonEventName]) => void
		);
		this.unsubscribers.push(unsub);
	}

	private subscribeDaemonBroadcast<K extends DaemonEventName>(
		event: K,
		broadcast: (data: DaemonEventMap[K]) => Promise<void> | undefined
	): void {
		const unsub = this.daemonHub.on(event, (data: DaemonEventMap[K]) => {
			const promise = broadcast(data);
			if (promise) {
				return promise.catch((err) => {
					this.logger.warn(`Broadcast failed for ${event}:`, err);
				});
			}
		});
		this.unsubscribers.push(unsub);
	}

	/**
	 * Subscribe to an InternalEventBus event and trigger a broadcast.
	 * Used for events that are published to InternalEventBus (not DaemonHub),
	 * such as settings.updated and session.updated (after cache projection).
	 */
	private subscribeEventBusBroadcast<K extends string & keyof DaemonInternalEventMap>(
		event: K,
		broadcast: (data: DaemonInternalEventMap[K]) => Promise<void> | undefined
	): void {
		const unsub = this.internalEventBus.subscribe(
			event,
			(data: DaemonInternalEventMap[K]) => {
				const promise = broadcast(data);
				if (promise) {
					return promise.catch((err) => {
						this.logger.warn(`EventBus broadcast failed for ${event}:`, err);
					});
				}
			},
			{ subscriberName: `ClientEventBridge.${event}` }
		);
		this.unsubscribers.push(unsub);
	}
}

/**
 * Convenience factory.
 */
export function createClientEventBridge(
	daemonHub: DaemonHub,
	messageHub: MessageHub,
	gateway: IClientEventGateway,
	stateProjection: StateProjectionService & ChannelVersionSource,
	internalEventBus: InternalEventBus<DaemonInternalEventMap>
): ClientEventBridge {
	return new ClientEventBridge(daemonHub, messageHub, gateway, stateProjection, internalEventBus);
}
