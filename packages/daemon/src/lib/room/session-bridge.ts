/**
 * SessionBridge - Bridges Worker and Manager sessions
 *
 * Responsibilities:
 * - Monitor Worker and Manager session state changes
 * - Detect terminal states (idle, waiting_for_input, interrupted)
 * - Collect Worker's assistant messages and forward to Manager
 * - Collect Manager's response and forward to Worker
 * - Create synthetic user messages to bridge the sessions
 *
 * Architecture:
 * - Uses STATE_CHANNELS.SESSION for state subscription
 * - Uses daemonHub.emit for internal events
 * - Uses messageHub.request('message.send', ...) for sending messages to sessions
 * - Uses SDKMessageRepository.getSDKMessages() with `since` parameter to collect messages
 */

import type { MessageHub } from '@neokai/shared';
import {
	STATE_CHANNELS,
	Logger,
	type SessionState,
	type AgentProcessingState,
	type SessionError,
} from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { SessionPairManager } from './session-pair-manager';
import type { SessionManager } from '../session-manager';
import type { SDKMessageRepository } from '../../storage/repositories/sdk-message-repository';

/**
 * Internal state for an active bridge
 */
interface BridgeState {
	pairId: string;
	roomId: string;
	workerSessionId: string;
	managerSessionId: string;
	workerUnsub: () => void;
	managerUnsub: () => void;
	lastWorkerMessageTimestamp: number;
	lastManagerMessageTimestamp: number;
}

/**
 * SessionBridge - Bridges Worker and Manager sessions for dual-session architecture
 *
 * Usage:
 * ```typescript
 * const bridge = new SessionBridge(messageHub, daemonHub, sessionPairManager, sessionManager, sdkMessageRepo);
 * await bridge.startBridge('pair-id-123');
 * // Bridge monitors both sessions and forwards messages
 * await bridge.stopBridge('pair-id-123');
 * ```
 */
export class SessionBridge {
	private activeBridges: Map<string, BridgeState> = new Map();
	private logger: Logger;

	constructor(
		private messageHub: MessageHub,
		private daemonHub: DaemonHub,
		private sessionPairManager: SessionPairManager,
		private sessionManager: SessionManager,
		private sdkMessageRepo: SDKMessageRepository
	) {
		this.logger = new Logger('session-bridge');
	}

	/**
	 * Start monitoring a session pair
	 *
	 * Subscribes to state changes for both Worker and Manager sessions.
	 * When either reaches a terminal state, triggers message forwarding.
	 */
	async startBridge(pairId: string): Promise<void> {
		// Don't double-bridge
		if (this.activeBridges.has(pairId)) {
			this.logger.debug(`Bridge already active for pair: ${pairId}`);
			return;
		}

		// Get pair info
		const pair = this.sessionPairManager.getPair(pairId);
		if (!pair) {
			throw new Error(`Session pair not found: ${pairId}`);
		}

		const { roomId, workerSessionId, managerSessionId } = pair;

		// Join session channels for both sessions
		await this.messageHub.joinChannel(`session:${workerSessionId}`);
		await this.messageHub.joinChannel(`session:${managerSessionId}`);

		// Subscribe to Worker session state changes
		const workerUnsub = this.messageHub.onEvent<SessionState>(STATE_CHANNELS.SESSION, (state) => {
			if (state.sessionInfo?.id === workerSessionId) {
				this.handleWorkerStateChange(pairId, state).catch((error) => {
					this.logger.error(`Error handling Worker state change for ${pairId}:`, error);
				});
			}
		});

		// Subscribe to Manager session state changes
		const managerUnsub = this.messageHub.onEvent<SessionState>(STATE_CHANNELS.SESSION, (state) => {
			if (state.sessionInfo?.id === managerSessionId) {
				this.handleManagerStateChange(pairId, state).catch((error) => {
					this.logger.error(`Error handling Manager state change for ${pairId}:`, error);
				});
			}
		});

		// Track the bridge
		this.activeBridges.set(pairId, {
			pairId,
			roomId,
			workerSessionId,
			managerSessionId,
			workerUnsub,
			managerUnsub,
			lastWorkerMessageTimestamp: Date.now(),
			lastManagerMessageTimestamp: Date.now(),
		});

		this.logger.debug(`Started bridge for pair: ${pairId}`);

		// Fetch and handle initial states
		try {
			const workerState = await this.messageHub.request<SessionState>('state.session', {
				sessionId: workerSessionId,
			});
			await this.handleWorkerStateChange(pairId, workerState);
		} catch (error) {
			this.logger.warn(`Could not fetch initial Worker state for ${pairId}:`, error);
		}

		try {
			const managerState = await this.messageHub.request<SessionState>('state.session', {
				sessionId: managerSessionId,
			});
			await this.handleManagerStateChange(pairId, managerState);
		} catch (error) {
			this.logger.warn(`Could not fetch initial Manager state for ${pairId}:`, error);
		}
	}

	/**
	 * Stop monitoring a session pair
	 */
	async stopBridge(pairId: string): Promise<void> {
		const bridge = this.activeBridges.get(pairId);
		if (!bridge) {
			this.logger.debug(`No active bridge for pair: ${pairId}`);
			return;
		}

		// Unsubscribe from state channels
		bridge.workerUnsub();
		bridge.managerUnsub();

		// Leave session channels
		await this.messageHub.leaveChannel(`session:${bridge.workerSessionId}`);
		await this.messageHub.leaveChannel(`session:${bridge.managerSessionId}`);

		// Remove from active bridges
		this.activeBridges.delete(pairId);
		this.logger.debug(`Stopped bridge for pair: ${pairId}`);
	}

	/**
	 * Stop all active bridges
	 */
	async stopAllBridges(): Promise<void> {
		const pairIds = Array.from(this.activeBridges.keys());

		await Promise.all(
			pairIds.map(async (pairId) => {
				const bridge = this.activeBridges.get(pairId);
				if (bridge) {
					bridge.workerUnsub();
					bridge.managerUnsub();
					await this.messageHub.leaveChannel(`session:${bridge.workerSessionId}`);
					await this.messageHub.leaveChannel(`session:${bridge.managerSessionId}`);
				}
			})
		);

		this.activeBridges.clear();
		this.logger.debug(`Stopped all bridges (${pairIds.length})`);
	}

	/**
	 * Get list of active bridge pair IDs
	 */
	getActiveBridges(): string[] {
		return Array.from(this.activeBridges.keys());
	}

	/**
	 * Check if a bridge is active for a pair
	 */
	isBridgeActive(pairId: string): boolean {
		return this.activeBridges.has(pairId);
	}

	/**
	 * Handle Worker session state changes
	 *
	 * When Worker reaches a terminal state, collect assistant messages
	 * and forward to Manager.
	 */
	private async handleWorkerStateChange(pairId: string, state: SessionState): Promise<void> {
		const bridge = this.activeBridges.get(pairId);
		if (!bridge) return;

		// Check for error state first (crash detection)
		if (state.error) {
			await this.handleWorkerCrash(bridge.workerSessionId, state.error);
			return;
		}

		const { agentState } = state;

		// Check if Worker reached a terminal state
		if (this.isTerminalState(agentState)) {
			this.logger.debug(`Worker reached terminal state: ${agentState.status} for pair: ${pairId}`);

			// Emit internal event for bridge coordination
			await this.daemonHub.emit('bridge.workerTerminal', {
				sessionId: bridge.workerSessionId,
				pairId,
				agentState,
			});

			// Collect and forward Worker's assistant messages to Manager
			await this.forwardWorkerToManager(pairId);
		}
	}

	/**
	 * Handle Manager session state changes
	 *
	 * When Manager reaches a terminal state, collect response
	 * and forward to Worker.
	 */
	private async handleManagerStateChange(pairId: string, state: SessionState): Promise<void> {
		const bridge = this.activeBridges.get(pairId);
		if (!bridge) return;

		const { agentState } = state;

		// Check if Manager reached a terminal state
		if (this.isTerminalState(agentState)) {
			this.logger.debug(`Manager reached terminal state: ${agentState.status} for pair: ${pairId}`);

			// Emit internal event for bridge coordination
			await this.daemonHub.emit('bridge.managerTerminal', {
				sessionId: bridge.managerSessionId,
				pairId,
				agentState,
			});

			// Collect and forward Manager's response to Worker
			await this.forwardManagerToWorker(pairId);
		}
	}

	/**
	 * Forward Worker's assistant messages to Manager
	 *
	 * Collects assistant messages from Worker session since last check
	 * and creates a synthetic user message in Manager session.
	 */
	private async forwardWorkerToManager(pairId: string): Promise<void> {
		const bridge = this.activeBridges.get(pairId);
		if (!bridge) return;

		const { workerSessionId, managerSessionId, lastWorkerMessageTimestamp } = bridge;

		// Get Worker's assistant messages since last check
		const messages = this.sdkMessageRepo.getSDKMessages(
			workerSessionId,
			100, // limit
			undefined, // before
			lastWorkerMessageTimestamp // since
		);

		// Filter for assistant messages only
		const assistantMessages = messages.filter((msg) => msg.type === 'assistant');

		if (assistantMessages.length === 0) {
			this.logger.debug(`No new assistant messages from Worker for pair: ${pairId}`);
			return;
		}

		// Format messages as content for Manager
		const content = this.formatAssistantMessagesForForwarding(assistantMessages);

		// Send as user message to Manager (synthetic bridging message)
		await this.messageHub.request('message.send', {
			sessionId: managerSessionId,
			content: `[Worker Update]\n\n${content}`,
		});

		// Update last message timestamp
		bridge.lastWorkerMessageTimestamp = Date.now();

		this.logger.debug(
			`Forwarded ${assistantMessages.length} messages from Worker to Manager for pair: ${pairId}`
		);

		// Emit internal event
		await this.daemonHub.emit('bridge.messagesForwarded', {
			sessionId: workerSessionId,
			pairId,
			direction: 'worker-to-manager',
			count: assistantMessages.length,
		});
	}

	/**
	 * Forward Manager's response to Worker
	 *
	 * Collects assistant messages from Manager session since last check
	 * and creates a synthetic user message in Worker session.
	 */
	private async forwardManagerToWorker(pairId: string): Promise<void> {
		const bridge = this.activeBridges.get(pairId);
		if (!bridge) return;

		const { workerSessionId, managerSessionId, lastManagerMessageTimestamp } = bridge;

		// Get Manager's assistant messages since last check
		const messages = this.sdkMessageRepo.getSDKMessages(
			managerSessionId,
			100, // limit
			undefined, // before
			lastManagerMessageTimestamp // since
		);

		// Filter for assistant messages only
		const assistantMessages = messages.filter((msg) => msg.type === 'assistant');

		if (assistantMessages.length === 0) {
			this.logger.debug(`No new assistant messages from Manager for pair: ${pairId}`);
			return;
		}

		// Format messages as content for Worker
		const content = this.formatAssistantMessagesForForwarding(assistantMessages);

		// Send as user message to Worker (synthetic bridging message)
		await this.messageHub.request('message.send', {
			sessionId: workerSessionId,
			content: `[Manager Response]\n\n${content}`,
		});

		// Update last message timestamp
		bridge.lastManagerMessageTimestamp = Date.now();

		this.logger.debug(
			`Forwarded ${assistantMessages.length} messages from Manager to Worker for pair: ${pairId}`
		);

		// Emit internal event
		await this.daemonHub.emit('bridge.messagesForwarded', {
			sessionId: managerSessionId,
			pairId,
			direction: 'manager-to-worker',
			count: assistantMessages.length,
		});
	}

	/**
	 * Format assistant messages for forwarding
	 *
	 * Extracts text content from assistant messages for human-readable forwarding.
	 */
	private formatAssistantMessagesForForwarding(messages: unknown[]): string {
		const lines: string[] = [];

		for (const msg of messages) {
			const assistantMsg = msg as {
				message?: { content?: string | Array<{ type: string; text?: string }> };
			};

			if (assistantMsg.message?.content) {
				if (typeof assistantMsg.message.content === 'string') {
					lines.push(assistantMsg.message.content);
				} else if (Array.isArray(assistantMsg.message.content)) {
					for (const block of assistantMsg.message.content) {
						if (block.type === 'text' && block.text) {
							lines.push(block.text);
						}
					}
				}
			}
		}

		return lines.join('\n\n');
	}

	/**
	 * Check if agent state is terminal (ready for bridging)
	 *
	 * Terminal states indicate the agent has finished processing:
	 * - idle: Agent finished processing
	 * - waiting_for_input: Agent needs user response
	 * - interrupted: Agent was stopped
	 */
	isTerminalState(agentState: AgentProcessingState): boolean {
		return (
			agentState.status === 'idle' ||
			agentState.status === 'waiting_for_input' ||
			agentState.status === 'interrupted'
		);
	}

	/**
	 * Get bridge info for a pair
	 *
	 * Returns bridge state information for debugging/monitoring.
	 */
	getBridgeInfo(pairId: string): {
		pairId: string;
		roomId: string;
		workerSessionId: string;
		managerSessionId: string;
		lastWorkerMessageTimestamp: number;
		lastManagerMessageTimestamp: number;
	} | null {
		const bridge = this.activeBridges.get(pairId);
		if (!bridge) return null;

		return {
			pairId: bridge.pairId,
			roomId: bridge.roomId,
			workerSessionId: bridge.workerSessionId,
			managerSessionId: bridge.managerSessionId,
			lastWorkerMessageTimestamp: bridge.lastWorkerMessageTimestamp,
			lastManagerMessageTimestamp: bridge.lastManagerMessageTimestamp,
		};
	}

	/**
	 * Handle Worker session crash
	 *
	 * Detects crashes and attempts recovery with retry limits.
	 */
	private async handleWorkerCrash(workerSessionId: string, _error?: SessionError): Promise<void> {
		const bridge = this.activeBridges.get(
			Array.from(this.activeBridges.values()).find((b) => b.workerSessionId === workerSessionId)
				?.pairId ?? ''
		);
		if (!bridge) return;

		const pair = this.sessionPairManager.getPair(bridge.pairId);
		if (!pair) return;

		// Get recovery context from session metadata
		const agentSession = this.sessionManager.getSession(workerSessionId);
		const recoveryContext = agentSession?.session?.metadata?.recoveryContext as
			| { retryCount?: number }
			| undefined;

		const retryCount = recoveryContext?.retryCount ?? 0;

		if (retryCount < 3) {
			// Log recovery attempt
			this.logger.info(
				`Worker ${workerSessionId.slice(0, 8)} crashed, attempting recovery (attempt ${retryCount + 1})`
			);

			// Notify manager about crash and recovery
			await this.sendSyntheticMessage(
				bridge.managerSessionId,
				`Worker session encountered an error and is being restarted. Retry ${retryCount + 1}/3.`
			);

			// Update pair status temporarily
			this.sessionPairManager.updatePairStatus(bridge.pairId, 'idle');

			// Note: Actual session recreation would be done by SessionPairManager
			// For now we just update the status and notify
		} else {
			// Max retries exceeded - escalate
			this.logger.error(
				`Worker ${workerSessionId.slice(0, 8)} crashed and could not be recovered after ${retryCount} attempts`
			);

			await this.sendSyntheticMessage(
				bridge.managerSessionId,
				`Worker session crashed and could not be recovered after ${retryCount} attempts. Manual intervention required.`
			);

			this.sessionPairManager.updatePairStatus(bridge.pairId, 'crashed');

			// Stop bridging
			this.stopBridge(bridge.pairId);
		}
	}

	/**
	 * Send a synthetic system message to a session
	 *
	 * Used for crash notifications and other system-level communications.
	 */
	private async sendSyntheticMessage(sessionId: string, content: string): Promise<void> {
		try {
			await this.messageHub.request('message.send', {
				sessionId,
				content: `[System] ${content}`,
			});
		} catch (error) {
			this.logger.error(`Failed to send synthetic message to session ${sessionId}:`, error);
		}
	}
}
