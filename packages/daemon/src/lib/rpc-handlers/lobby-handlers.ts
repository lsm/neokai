/**
 * Lobby RPC Handlers
 *
 * RPC handlers for lobby manager chat operations:
 * - lobby.chat.send - Send message to lobby manager AI
 * - lobby.chat.history - Get chat history
 * - lobby.stats - Get lobby statistics
 * - lobby.adapters - Get registered adapters
 */

import type { MessageHub } from '@neokai/shared';
import type { MessageImage } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { LobbyAgentService } from '../lobby/lobby-agent-service';

/**
 * Lobby message type
 */
export interface LobbyMessage {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	images?: MessageImage[];
	timestamp: string;
}

/**
 * In-memory storage for lobby messages
 * TODO: Consider persisting to database in the future
 */
const lobbyMessages: LobbyMessage[] = [];

/**
 * Generate a unique message ID
 */
function generateMessageId(): string {
	return `lobby-msg-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Setup lobby chat RPC handlers
 */
export function setupLobbyHandlers(
	messageHub: MessageHub,
	daemonHub: DaemonHub,
	lobbyAgentService?: LobbyAgentService
): void {
	// lobby.stats - Get lobby statistics
	messageHub.onRequest('lobby.stats', async () => {
		if (!lobbyAgentService) {
			return { stats: null, error: 'Lobby agent not available' };
		}
		return { stats: lobbyAgentService.getStats() };
	});

	// lobby.adapters - Get registered adapters
	messageHub.onRequest('lobby.adapters', async () => {
		if (!lobbyAgentService) {
			return { adapters: [], error: 'Lobby agent not available' };
		}
		return { adapters: lobbyAgentService.getAdapters() };
	});

	// lobby.chat.send - Send message to lobby manager AI
	messageHub.onRequest('lobby.chat.send', async (data) => {
		const params = data as {
			content: string;
			images?: MessageImage[];
		};

		if (!params.content) {
			throw new Error('Message content is required');
		}

		// Create user message
		const userMessage: LobbyMessage = {
			id: generateMessageId(),
			role: 'user',
			content: params.content,
			images: params.images,
			timestamp: new Date().toISOString(),
		};

		// Store user message
		lobbyMessages.push(userMessage);

		// If lobby agent is available, it will process and emit responses
		// Otherwise, fall back to echo behavior
		if (!lobbyAgentService) {
			// Create placeholder assistant response
			const assistantMessage: LobbyMessage = {
				id: generateMessageId(),
				role: 'assistant',
				content: `Echo: ${params.content}`,
				timestamp: new Date().toISOString(),
			};

			// Store assistant message
			lobbyMessages.push(assistantMessage);

			// Emit lobby.message event for clients to receive real-time updates
			daemonHub
				.emit('lobby.message', {
					sessionId: 'lobby',
					message: assistantMessage,
				})
				.catch(() => {
					// Event emission error - non-critical, continue
				});

			return { message: assistantMessage };
		}

		// Delegate to lobby agent for processing
		// The agent will respond via events
		return { success: true };
	});

	// lobby.chat.history - Get chat history
	messageHub.onRequest('lobby.chat.history', async (data) => {
		const params = data as { limit?: number };
		const limit = params.limit ?? 100;

		// Return the most recent messages up to the limit
		const messages = lobbyMessages.slice(-limit);

		return { messages };
	});
}
