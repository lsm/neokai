/**
 * ClientEventBridge — declarative mapping from DaemonHub internal events to client-safe events.
 *
 * Today, StateManager contains ~30 repetitive daemon-to-client forwarding handlers
 * that do nothing but call `messageHub.event(method, data, { channel })`.  This
 * module extracts those into a single bridge that:
 *
 *   1. Subscribes to selected DaemonHub events.
 *   2. Forwards the payload verbatim (or via a lightweight transform) through
 *      ClientEventGateway using typed Channels.
 *
 * Scope (first slice)
 * -------------------
 * This PR migrates the **space event bridge** slice from StateManager.
 * These are pure forwarding paths with no state caching, no version
 * increments, and no side effects — the safest first extraction.
 *
 * Remaining in StateManager (for follow-up PRs)
 * ---------------------------------------------
 * - session.created / session.deleted / context.updated (already gateway-ised)
 * - api.connection, auth.changed, commands.updated, session.error, session.errorClear
 * - broadcastSystemChange, broadcastSettingsChange, broadcastSessionStateChange,
 *   broadcastSDKMessagesChange, broadcastSDKMessagesDelta
 *
 * Design notes
 * ------------
 * - The bridge intentionally does NOT own channelVersions; that stays in
 *   StateManager until StateProjectionService is introduced.
 * - Each bridge mapping is a plain object so the registry is auditable in one
 *   place.
 * - The bridge is constructed in DaemonApp and wired before handlers start
 *   emitting events.
 */

import type { IClientEventGateway, EventChannel } from '@neokai/shared';
import { Channels } from '@neokai/shared';
import type { DaemonHub, DaemonEventMap } from './daemon-hub';

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

/**
 * ClientEventBridge wires DaemonHub event subscriptions to ClientEventGateway
 * deliveries.  Each mapping in the registry becomes one `daemonHub.on(...)`
 * subscriber that forwards through the gateway.
 */
export class ClientEventBridge {
	private unsubscribers: (() => void)[] = [];

	constructor(
		private daemonHub: DaemonHub,
		private gateway: IClientEventGateway
	) {}

	/**
	 * Subscribe to all registered events and start forwarding.
	 * Idempotent: calling start() on an already-started bridge is a no-op.
	 */
	start(): void {
		if (this.unsubscribers.length > 0) {
			return;
		}

		for (const mapping of SPACE_BRIDGE_MAPPINGS) {
			this.subscribeMapping(mapping);
		}
	}

	/**
	 * Unsubscribe from all events.  After stop(), start() may be called again.
	 */
	stop(): void {
		for (const unsub of this.unsubscribers) {
			unsub();
		}
		this.unsubscribers = [];
	}

	private subscribeMapping(mapping: BridgeMapping): void {
		const unsub = this.daemonHub.on(mapping.event, (data: DaemonEventMap[keyof DaemonEventMap]) => {
			const payload = mapping.transform ? mapping.transform(data) : data;
			this.gateway.publish(mapping.clientEvent, payload, mapping.channel(data));
		});
		this.unsubscribers.push(unsub);
	}
}

/**
 * Convenience factory.
 */
export function createClientEventBridge(
	daemonHub: DaemonHub,
	gateway: IClientEventGateway
): ClientEventBridge {
	return new ClientEventBridge(daemonHub, gateway);
}
