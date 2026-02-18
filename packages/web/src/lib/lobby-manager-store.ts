/**
 * LobbyManagerStore - Lobby Manager chat state management
 *
 * Manages chat with the Lobby Manager AI assistant.
 * Uses RPC over WebSocket for communication.
 *
 * Signals (reactive state):
 * - messages: Chat message history
 * - loading: Loading state for initial fetch
 * - error: Error state
 */

import { signal } from '@preact/signals';
import { Logger } from '@neokai/shared';
import { connectionManager } from './connection-manager';

const logger = new Logger('kai:web:lobbymanagerstore');

/**
 * Lobby Manager chat message
 */
export interface LobbyManagerMessage {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	timestamp: number;
}

class LobbyManagerStore {
	// ========================================
	// Core Signals
	// ========================================

	/** Chat messages */
	readonly messages = signal<LobbyManagerMessage[]>([]);

	/** Loading state */
	readonly loading = signal<boolean>(false);

	/** Error state */
	readonly error = signal<string | null>(null);

	/** Initialized flag */
	private initialized = false;

	// ========================================
	// Initialization
	// ========================================

	/**
	 * Initialize the store and load chat history
	 */
	async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}

		this.loading.value = true;
		this.error.value = null;

		try {
			await this.loadHistory();
			this.initialized = true;
		} catch (err) {
			logger.error('Failed to initialize lobby manager store:', err);
			this.error.value = err instanceof Error ? err.message : 'Failed to load chat history';
		} finally {
			this.loading.value = false;
		}
	}

	// ========================================
	// Chat Methods
	// ========================================

	/**
	 * Load chat history from server
	 */
	async loadHistory(): Promise<void> {
		try {
			const hub = connectionManager.getHubIfConnected();
			if (!hub) {
				logger.warn('Cannot load history: not connected');
				return;
			}

			const response = await hub.request<{ messages: LobbyManagerMessage[] }>(
				'lobby.chat.history',
				{}
			);
			this.messages.value = response.messages ?? [];
		} catch (err) {
			logger.error('Failed to load lobby manager history:', err);
			// Don't throw - just keep empty messages
			this.messages.value = [];
		}
	}

	/**
	 * Send a message to the Lobby Manager
	 */
	async sendMessage(content: string): Promise<void> {
		const hub = connectionManager.getHubIfConnected();
		if (!hub) {
			throw new Error('Not connected');
		}

		// Optimistically add user message
		const userMessage: LobbyManagerMessage = {
			id: `temp-${Date.now()}`,
			role: 'user',
			content,
			timestamp: Date.now(),
		};
		this.messages.value = [...this.messages.value, userMessage];

		try {
			// Send to server - server will broadcast the response
			await hub.request('lobby.chat.send', { content });
		} catch (err) {
			// Remove optimistic message on error
			this.messages.value = this.messages.value.filter((m) => m.id !== userMessage.id);
			logger.error('Failed to send lobby manager message:', err);
			throw err;
		}
	}

	/**
	 * Add an assistant message (called from WebSocket event handler)
	 */
	addAssistantMessage(message: LobbyManagerMessage): void {
		this.messages.value = [...this.messages.value, message];
	}

	/**
	 * Clear chat history
	 */
	clear(): void {
		this.messages.value = [];
		this.error.value = null;
	}
}

/** Singleton lobby manager store instance */
export const lobbyManagerStore = new LobbyManagerStore();
