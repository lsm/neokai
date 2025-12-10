/**
 * Session RPC Handlers
 */

import type { MessageHub, MessageImage, Session } from '@liuboer/shared';
import type { SessionManager } from '../session-manager';
import type { CreateSessionRequest, UpdateSessionRequest } from '@liuboer/shared';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ModelInfo } from '@liuboer/shared/sdk';

/**
 * Cache for supported models to avoid repeated SDK queries
 */
let modelsCacheData: {
	models: ModelInfo[];
	timestamp: number;
} | null = null;

const MODELS_CACHE_DURATION = 60 * 60 * 1000; // 1 hour

/**
 * Get supported models from Claude Agent SDK
 * Uses a temporary query object and caches results for 1 hour
 */
async function getSupportedModels(forceRefresh = false): Promise<ModelInfo[]> {
	const now = Date.now();

	// Return cached data if valid
	if (!forceRefresh && modelsCacheData && now - modelsCacheData.timestamp < MODELS_CACHE_DURATION) {
		return modelsCacheData.models;
	}

	// Create a temporary query to fetch models
	// We use a simple prompt since we just need the query object
	const tmpQuery = query({
		prompt: 'list models',
		options: {
			cwd: process.cwd(),
			maxTurns: 1,
		},
	});

	try {
		// Get supported models from SDK
		const models = await tmpQuery.supportedModels();

		// Update cache
		modelsCacheData = {
			models,
			timestamp: now,
		};

		// Interrupt the query since we don't need it to run
		await tmpQuery.interrupt();

		return models;
	} catch (error) {
		// Clean up query on error
		try {
			await tmpQuery.interrupt();
		} catch {
			// Ignore interrupt errors
		}
		throw error;
	}
}

/**
 * Clear the models cache
 */
function clearModelsCache(): void {
	modelsCacheData = null;
}

export function setupSessionHandlers(messageHub: MessageHub, sessionManager: SessionManager): void {
	messageHub.handle('session.create', async (data) => {
		const req = data as CreateSessionRequest;
		const sessionId = await sessionManager.createSession({
			workspacePath: req.workspacePath,
			initialTools: req.initialTools,
			config: req.config,
		});

		// Return the full session object so client can optimistically update
		const agentSession = sessionManager.getSession(sessionId);
		const session = agentSession?.getSessionData();

		return { sessionId, session };
	});

	messageHub.handle('session.list', async () => {
		const sessions = sessionManager.listSessions();
		return { sessions };
	});

	messageHub.handle('session.get', async (data) => {
		const { sessionId: targetSessionId } = data as { sessionId: string };
		const agentSession = await sessionManager.getSessionAsync(targetSessionId);

		if (!agentSession) {
			throw new Error('Session not found');
		}

		const session = agentSession.getSessionData();
		const messages = agentSession.getMessages();

		return {
			session,
			messages,
			activeTools: [],
			context: {
				files: [],
				workingDirectory: session.workspacePath,
			},
		};
	});

	messageHub.handle('session.update', async (data, _ctx) => {
		const { sessionId: targetSessionId, ...updates } = data as UpdateSessionRequest & {
			sessionId: string;
		};

		// Convert UpdateSessionRequest to Partial<Session>
		// config in UpdateSessionRequest is Partial<SessionConfig>, which is handled by
		// database.updateSession merging with existing config
		await sessionManager.updateSession(targetSessionId, updates as Partial<Session>);

		// Broadcast update event to all clients
		await messageHub.publish('session.updated', updates, {
			sessionId: targetSessionId,
		});

		return { success: true };
	});

	messageHub.handle('session.delete', async (data, _ctx) => {
		const { sessionId: targetSessionId } = data as { sessionId: string };
		await sessionManager.deleteSession(targetSessionId);

		// Broadcast deletion event to all clients
		await messageHub.publish(
			'session.deleted',
			{},
			{
				sessionId: targetSessionId,
			}
		);

		return { success: true };
	});

	// Handle message sending to a session
	messageHub.handle('message.send', async (data) => {
		const {
			sessionId: targetSessionId,
			content,
			images,
		} = data as {
			sessionId: string;
			content: string;
			images?: MessageImage[];
		};

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		return await agentSession.handleMessageSend({ content, images });
	});

	// Handle session interruption
	messageHub.handle('client.interrupt', async (data) => {
		const { sessionId: targetSessionId } = data as { sessionId: string };

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		await agentSession.handleInterrupt();
		return { success: true };
	});

	// Handle getting current model information
	messageHub.handle('session.model.get', async (data) => {
		const { sessionId: targetSessionId } = data as { sessionId: string };

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		const modelInfo = agentSession.getCurrentModel();
		return {
			currentModel: modelInfo.id,
			modelInfo: modelInfo.info,
		};
	});

	// Handle model switching
	messageHub.handle('session.model.switch', async (data) => {
		const { sessionId: targetSessionId, model } = data as {
			sessionId: string;
			model: string;
		};

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		const result = await agentSession.handleModelSwitch(model);

		// If successful, broadcast the model switch event
		if (result.success) {
			await messageHub.publish(
				'session.updated',
				{ model: result.model },
				{ sessionId: targetSessionId }
			);
		}

		return result;
	});

	// Handle listing available models using Claude Agent SDK
	messageHub.handle('models.list', async (data) => {
		const { useCache = true, forceRefresh = false } = data as {
			useCache?: boolean;
			forceRefresh?: boolean;
		};

		try {
			// Get models from SDK (with caching)
			const shouldRefresh = !useCache || forceRefresh;
			const models = await getSupportedModels(shouldRefresh);

			// Convert SDK ModelInfo format to match expected API response
			// SDK returns: { value, displayName, description }
			// We return it as-is, which is cleaner than the old API format
			return {
				models: models.map((m) => ({
					id: m.value,
					display_name: m.displayName,
					description: m.description,
					type: 'model' as const,
				})),
				cached: !shouldRefresh,
			};
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error('[RPC] Failed to list models:', errorMessage);
			throw new Error(`Failed to list models: ${errorMessage}`);
		}
	});

	// Handle clearing the model cache
	messageHub.handle('models.clearCache', async () => {
		clearModelsCache();
		return { success: true };
	});

	// FIX: Handle getting current agent processing state
	// Called by clients after subscribing to agent.state to get initial snapshot
	messageHub.handle('agent.getState', async (data) => {
		const { sessionId: targetSessionId } = data as { sessionId: string };

		const agentSession = await sessionManager.getSessionAsync(targetSessionId);
		if (!agentSession) {
			throw new Error('Session not found');
		}

		const state = agentSession.getProcessingState();

		// Return current state (don't publish - this is just a query, not a state change)
		return { state };
	});
}
