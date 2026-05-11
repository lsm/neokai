/**
 * ClientEventBridge — declarative mapping from DaemonHub internal events to client-safe events,
 * plus versioned state broadcasts and RPC handler registration.
 *
 * This module contains ALL client-facing delivery paths:
 * - Space events (16 mappings) — forwarding via ClientEventGateway
 * - Session events (session.created, session.deleted, context.updated) — forwarding
 * - Connection/auth events (api.connection, auth.changed) — trigger broadcasts
 * - Config events (commands.updated) — trigger broadcasts
 * - Error events (session.error, session.errorClear) — trigger broadcasts
 * - Versioned state broadcasts (system, settings, session state, SDK messages)
 * - RPC handlers for state snapshots (7 onRequest registrations)
 *
 * StateProjectionService is now a pure projection — it only maintains caches
 * and exposes read methods. This bridge owns all messageHub interactions.
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
import { Logger } from './logger';

type DaemonEventName = keyof DaemonEventMap & string;

interface BridgeMapping {
	event: DaemonEventName;
	clientEvent: string;
	channel: (payload: DaemonEventMap[keyof DaemonEventMap]) => EventChannel;
	transform?: (payload: DaemonEventMap[keyof DaemonEventMap]) => unknown;
}

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
	// Gate data updates → global
	{
		event: 'space.gateData.updated',
		clientEvent: 'space.gateData.updated',
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
	private logger = new Logger('ClientEventBridge');

	constructor(
		private daemonHub: DaemonHub,
		private messageHub: MessageHub,
		private gateway: IClientEventGateway,
		private stateProjection: StateProjectionService & ChannelVersionSource
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

		// Space events
		for (const mapping of SPACE_BRIDGE_MAPPINGS) {
			this.subscribeMapping(mapping);
		}

		// Session events (pure forwarding + broadcast triggers)
		for (const mapping of SESSION_BRIDGE_MAPPINGS) {
			this.subscribeMapping(mapping);
		}
		this.subscribeBroadcast('context.updated', (data) =>
			this.broadcastSessionStateChange(data.sessionId)
		);

		// Connection/auth events (trigger broadcasts)
		this.subscribeBroadcast('api.connection', () => this.broadcastSystemChange());
		this.subscribeBroadcast('auth.changed', () => this.broadcastSystemChange());

		// Config events (trigger broadcast)
		this.subscribeBroadcast('commands.updated', (data) =>
			this.broadcastSessionStateChange(data.sessionId)
		);

		// Error events (trigger broadcast)
		this.subscribeBroadcast('session.error', (data) =>
			this.broadcastSessionStateChange(data.sessionId)
		);
		this.subscribeBroadcast('session.errorClear', (data) =>
			this.broadcastSessionStateChange(data.sessionId)
		);

		// Settings events (trigger broadcast)
		this.subscribeBroadcast('settings.updated', () => this.broadcastSettingsChange());

		// Session updated — trigger session state broadcast
		this.subscribeBroadcast('session.updated', (data) => {
			const { sessionId } = data as unknown as { sessionId: string };
			return this.broadcastSessionUpdateFromCache(sessionId);
		});
	}

	/**
	 * Unsubscribe from all events. After stop(), start() may be called again.
	 */
	stop(): void {
		for (const unsub of this.unsubscribers) {
			unsub();
		}
		this.unsubscribers = [];
	}

	// ========================================
	// RPC Handler Registration
	// ========================================

	private setupRPCHandlers(): void {
		// Global state snapshot
		this.messageHub.onRequest(STATE_CHANNELS.GLOBAL_SNAPSHOT, async () => {
			return await this.stateProjection.getGlobalSnapshot();
		});

		// Session state snapshot
		this.messageHub.onRequest(STATE_CHANNELS.SESSION_SNAPSHOT, async (data) => {
			const { sessionId } = data as { sessionId: string };
			return await this.stateProjection.getSessionSnapshot(sessionId);
		});

		// Unified system state handler
		this.messageHub.onRequest(STATE_CHANNELS.GLOBAL_SYSTEM, async () => {
			return await this.stateProjection.getSystemState();
		});

		// Individual channel requests (for on-demand refresh)
		this.messageHub.onRequest(STATE_CHANNELS.GLOBAL_SESSIONS, async () => {
			return await this.stateProjection.getSessionsState();
		});

		this.messageHub.onRequest(STATE_CHANNELS.GLOBAL_SETTINGS, async () => {
			return await this.stateProjection.getSettingsState();
		});

		// Session-specific channel requests
		this.messageHub.onRequest(STATE_CHANNELS.SESSION, async (data) => {
			const { sessionId } = data as { sessionId: string };
			return await this.stateProjection.getSessionState(sessionId);
		});

		this.messageHub.onRequest(STATE_CHANNELS.SESSION_SDK_MESSAGES, async (data) => {
			const { sessionId, since } = data as {
				sessionId: string;
				since?: number;
			};
			return await this.stateProjection.getSDKMessagesState(sessionId, since);
		});
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

			// If we have cached processing state, try to broadcast a minimal state update
			// Need to read from StateProjectionService's caches — use getSessionState again
			// with a try-catch for fallback is handled internally
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

	private subscribeMapping(mapping: BridgeMapping): void {
		const unsub = this.daemonHub.on(mapping.event, (data: DaemonEventMap[keyof DaemonEventMap]) => {
			const payload = mapping.transform ? mapping.transform(data) : data;
			this.gateway.publish(mapping.clientEvent, payload, mapping.channel(data));
		});
		this.unsubscribers.push(unsub);
	}

	private subscribeBroadcast<K extends DaemonEventName>(
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
}

/**
 * Convenience factory.
 */
export function createClientEventBridge(
	daemonHub: DaemonHub,
	messageHub: MessageHub,
	gateway: IClientEventGateway,
	stateProjection: StateProjectionService & ChannelVersionSource
): ClientEventBridge {
	return new ClientEventBridge(daemonHub, messageHub, gateway, stateProjection);
}
