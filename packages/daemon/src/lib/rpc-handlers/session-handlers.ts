/**
 * Session RPC Handlers
 */

import type { MessageHub, MessageImage, Session } from '@liuboer/shared';
import type { SessionManager } from '../session-manager';
import type { CreateSessionRequest, UpdateSessionRequest } from '@liuboer/shared';
import { clearModelsCache } from '../model-service';

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

		return {
			session,
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

		// Get current model ID
		const currentModelId = agentSession.getCurrentModel().id;

		// Fetch full model info from SDK asynchronously
		const { getModelInfo } = await import('../model-service');
		const modelInfo = await getModelInfo(currentModelId);

		return {
			currentModel: currentModelId,
			modelInfo,
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

	// Handle listing available models - uses hardcoded model list
	messageHub.handle('models.list', async (data) => {
		try {
			// Import model service for dynamic models (with static fallback)
			const { getAvailableModels } = await import('../model-service');

			// Check if forceRefresh is requested
			const forceRefresh = (data as { forceRefresh?: boolean })?.forceRefresh ?? false;

			// Get models from cache (uses 'global' cache key)
			// This will return dynamic models if they were loaded, otherwise static fallback
			const availableModels = getAvailableModels('global');

			// Return models in the expected format
			return {
				models: availableModels.map((m) => ({
					id: m.id,
					display_name: m.name,
					description: m.description,
					type: 'model' as const,
				})),
				// If forceRefresh is true, indicate that this is a fresh fetch
				cached: !forceRefresh,
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
