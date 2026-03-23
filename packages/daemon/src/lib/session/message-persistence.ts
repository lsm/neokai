/**
 * Message Persistence Module
 *
 * Handles user message persistence to database and UI broadcasting:
 * - Expand built-in commands
 * - Build message content (text + images)
 * - Create SDK user message format
 * - Save to database
 * - Publish to UI via state channels
 * - Emit events for downstream processing
 */

import type { MessageContent, MessageDeliveryMode, MessageHub, MessageImage } from '@neokai/shared';
import type { SDKUserMessage } from '@neokai/shared/sdk';
import type { UUID } from 'crypto';
import type { Database } from '../../storage/database';
import type { DaemonHub } from '../daemon-hub';
import { expandBuiltInCommand } from '../built-in-commands';
import { Logger } from '../logger';
import type { SessionCache } from './session-cache';

export interface MessagePersistenceData {
	sessionId: string;
	messageId: string;
	content: string;
	images?: MessageImage[];
	deliveryMode?: MessageDeliveryMode;
}

export class MessagePersistence {
	private logger: Logger;

	constructor(
		private sessionCache: SessionCache,
		private db: Database,
		private messageHub: MessageHub,
		private eventBus: DaemonHub
	) {
		this.logger = new Logger('MessagePersistence');
	}

	/**
	 * Handle message persistence
	 *
	 * ARCHITECTURE: EventBus-centric - SessionManager owns message persistence logic
	 *
	 * Responsibilities:
	 * 1. Validate image sizes
	 * 2. Expand built-in commands
	 * 3. Build message content (text + images)
	 * 4. Create SDK user message
	 * 5. Save to database
	 * 6. Publish to UI via state channel
	 * 7. Emit 'message.persisted' event for downstream processing
	 */
	async persist(data: MessagePersistenceData): Promise<void> {
		const { sessionId, messageId, content, images, deliveryMode = 'immediate' } = data;

		const agentSession = await this.sessionCache.getAsync(sessionId);
		if (!agentSession) {
			const error = `[MessagePersistence] Session ${sessionId} not found for message persistence`;
			this.logger.error(error);
			// FIX: Throw instead of returning early so error is propagated
			// This prevents messages from being silently lost when session fails to load
			throw new Error(error);
		}

		const session = agentSession.getSessionData();

		try {
			// 1. Validate image sizes (API limit is 5MB for base64-encoded data)
			if (images && images.length > 0) {
				const MAX_BASE64_SIZE = 5 * 1024 * 1024; // 5MB
				for (const image of images) {
					const base64SizeBytes = image.data.length;
					if (base64SizeBytes > MAX_BASE64_SIZE) {
						const sizeMB = (base64SizeBytes / (1024 * 1024)).toFixed(2);
						const maxMB = (MAX_BASE64_SIZE / (1024 * 1024)).toFixed(2);
						throw new Error(
							`Image base64 size (${sizeMB} MB) exceeds API limit (${maxMB} MB). Please resize the image before uploading.`
						);
					}
				}
			}

			// 2. Expand built-in commands (e.g., /merge-session → full prompt)
			const expandedContent = expandBuiltInCommand(content);
			const finalContent = expandedContent || content;

			// 3. Build message content (text + images)
			const messageContent = buildMessageContent(finalContent, images);

			// 4. Create SDK user message
			const sdkUserMessage: SDKUserMessage = {
				type: 'user' as const,
				uuid: messageId as UUID,
				session_id: sessionId,
				parent_tool_use_id: null,
				message: {
					role: 'user' as const,
					content:
						typeof messageContent === 'string'
							? [{ type: 'text' as const, text: messageContent }]
							: messageContent,
				},
			};

			// 5. Save to database with delivery-aware status
			const processingState = agentSession.getProcessingState();
			const isAgentBusy =
				processingState.status === 'processing' || processingState.status === 'queued';
			const isManualMode = session.config.queryMode === 'manual';

			const effectiveDeliveryMode: MessageDeliveryMode =
				deliveryMode === 'defer' && isAgentBusy ? 'defer' : 'immediate';
			const sendStatus: 'deferred' | 'enqueued' | 'consumed' = isManualMode
				? 'deferred'
				: effectiveDeliveryMode === 'defer'
					? 'deferred'
					: isAgentBusy
						? 'enqueued'
						: 'consumed';
			const shouldDispatchToQuery = !isManualMode && effectiveDeliveryMode === 'immediate';

			const dbMessageId = this.db.saveUserMessage(sessionId, sdkUserMessage, sendStatus);

			// 6. Publish to UI immediately only when not currently in-flight.
			// Busy-turn insertions are shown in the input overlay and rendered in chat once consumed.
			if (isManualMode || !isAgentBusy) {
				try {
					this.messageHub.event(
						'state.sdkMessages.delta',
						{ added: [sdkUserMessage], timestamp: Date.now() },
						{ channel: `session:${sessionId}` }
					);
				} catch (_err) {
					/* v8 ignore next 2 */
					this.logger.error('[MessagePersistence] Error publishing message to UI:', _err);
				}
			}

			// Broadcast status update for queue-aware UI
			await this.eventBus.emit('messages.statusChanged', {
				sessionId,
				messageIds: [dbMessageId],
				status: sendStatus,
			});

			// 7. Emit 'message.persisted' event for downstream processing
			// AgentSession will start query and enqueue message
			// SessionManager will handle title generation and draft clearing
			if (shouldDispatchToQuery) {
				await this.eventBus.emit('message.persisted', {
					sessionId,
					messageId,
					messageContent,
					userMessageText: content, // Original content (before expansion)
					needsWorkspaceInit: !session.metadata.titleGenerated,
					hasDraftToClear: session.metadata?.inputDraft === content.trim(),
					sendStatus,
					deliveryMode: effectiveDeliveryMode,
				});
			}
		} catch (error) {
			this.logger.error('[MessagePersistence] Error persisting message:', error);
			throw error;
		}
	}
}

/**
 * Build message content from text and optional images
 * Static utility function for building SDK message content
 */
function buildMessageContent(content: string, images?: MessageImage[]): string | MessageContent[] {
	if (!images || images.length === 0) {
		return content;
	}

	// Multi-modal message: array of content blocks
	// Images first, then text (SDK format)
	return [
		...images.map((img) => ({
			type: 'image' as const,
			source: {
				type: 'base64' as const,
				media_type: img.media_type,
				data: img.data,
			},
		})),
		{ type: 'text' as const, text: content },
	];
}
