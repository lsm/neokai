/**
 * SDKMessageHandler - Process incoming SDK messages
 *
 * Handles:
 * - Message persistence to DB
 * - Broadcasting to clients via MessageHub
 * - Metadata updates (tokens, costs, tool calls)
 * - Compaction event detection and emission
 * - Title generation trigger
 * - Automatic phase detection for state tracking
 */

import type { Session, EventBus, MessageHub } from '@liuboer/shared';
import type { SDKMessage, SDKUserMessage } from '@liuboer/shared/sdk';
import {
	isSDKResultSuccess,
	isSDKAssistantMessage,
	isToolUseBlock,
	isSDKStatusMessage,
	isSDKCompactBoundary,
	isSDKSystemMessage,
} from '@liuboer/shared/sdk/type-guards';
import { Database } from '../storage/database';
import { Logger } from './logger';
import { ProcessingStateManager } from './processing-state-manager';
import { ContextTracker } from './context-tracker';
import { ContextFetcher } from './context-fetcher';

export class SDKMessageHandler {
	private sdkMessageDeltaVersion: number = 0;
	private logger: Logger;
	private contextFetcher: ContextFetcher;

	// Track whether we just processed a context response to prevent infinite loop
	// When true, we skip queuing /context for the next result message
	private lastMessageWasContextResponse: boolean = false;

	// Track UUIDs of internal /context commands to skip their result messages
	private internalContextCommandIds: Set<string> = new Set();

	// Callback to queue messages (will be set by AgentSession)
	// Returns the message UUID so we can track internal commands
	private queueMessage?: (content: string, internal: boolean) => Promise<string>;

	constructor(
		private session: Session,
		private db: Database,
		private messageHub: MessageHub,
		private eventBus: EventBus,
		private stateManager: ProcessingStateManager,
		private contextTracker: ContextTracker
	) {
		this.logger = new Logger(`SDKMessageHandler ${session.id}`);
		this.contextFetcher = new ContextFetcher(session.id);
	}

	/**
	 * Set the message queue callback
	 * Called by AgentSession to enable automatic context fetching
	 */
	setQueueMessageCallback(callback: (content: string, internal: boolean) => Promise<string>): void {
		this.queueMessage = callback;
	}

	/**
	 * Main entry point - handle incoming SDK message
	 */
	async handleMessage(message: SDKMessage): Promise<void> {
		// Automatically update phase based on message type
		await this.stateManager.detectPhaseFromMessage(message);

		// Context tracking: Extract usage from stream events
		if (message.type === 'stream_event') {
			const streamEventMessage = message as { event: unknown };
			await this.contextTracker.processStreamEvent(streamEventMessage.event);
		}

		// Check if this is a /context response BEFORE saving/emitting
		// /context responses should be processed for context tracking but NOT saved to DB or shown in UI
		const isContextResponse = this.contextFetcher.isContextResponse(message);
		if (isContextResponse) {
			await this.handleContextResponse(message);
			// Set flag to skip:
			// 1. Queuing another /context for the next result
			// 2. Saving the result message that follows this context response
			this.lastMessageWasContextResponse = true;

			// Clean up the tracked ID if this is the response
			const userMsg = message as { uuid?: string };
			if (userMsg.uuid && this.internalContextCommandIds.has(userMsg.uuid)) {
				this.internalContextCommandIds.delete(userMsg.uuid);
			}

			// IMPORTANT: Return early to skip saving and emitting this message
			// It's already been processed for context tracking
			return;
		}

		// Check if this is a result message immediately following a /context response
		// Skip saving/broadcasting these result messages
		if (message.type === 'result' && this.lastMessageWasContextResponse) {
			this.logger.log('Skipping result message for internal /context command');
			// Reset the flag - we've now handled both the context response AND its result
			this.lastMessageWasContextResponse = false;
			// Return early - don't save or broadcast this result
			return;
		}

		// Mark all user messages from SDK as synthetic
		// Real user messages are saved in the message generator, not here
		// SDK only emits user messages for synthetic purposes (compaction, subagent context, etc.)
		if (message.type === 'user') {
			(message as SDKUserMessage & { isSynthetic: boolean }).isSynthetic = true;
		}

		// Save to DB FIRST before broadcasting to clients
		// This ensures we only broadcast messages that are successfully persisted
		const savedSuccessfully = this.db.saveSDKMessage(this.session.id, message);

		if (!savedSuccessfully) {
			// Log warning but continue - message is already in SDK's memory
			this.logger.warn(`Failed to save message to DB (type: ${message.type})`);
			// Don't broadcast to clients if DB save failed
			return;
		}

		// Only broadcast if successfully saved to DB
		await this.messageHub.publish('sdk.message', message, { sessionId: this.session.id });

		// Broadcast SDK message delta
		await this.messageHub.publish(
			'state.sdkMessages.delta',
			{
				added: [message],
				timestamp: Date.now(),
				version: ++this.sdkMessageDeltaVersion,
			},
			{ sessionId: this.session.id }
		);

		// Handle specific message types
		if (isSDKSystemMessage(message)) {
			await this.handleSystemMessage(message);
		}

		if (isSDKResultSuccess(message)) {
			await this.handleResultMessage(message);
		}

		if (isSDKAssistantMessage(message)) {
			await this.handleAssistantMessage(message);
		}

		if (isSDKStatusMessage(message)) {
			await this.handleStatusMessage(message);
		}

		if (isSDKCompactBoundary(message)) {
			await this.handleCompactBoundary(message);
		}
	}

	/**
	 * Handle system message (capture SDK session ID)
	 */
	private async handleSystemMessage(message: SDKMessage): Promise<void> {
		if (!isSDKSystemMessage(message)) return;

		// Capture SDK's internal session ID if we don't have it yet
		// This enables session resumption after daemon restart
		if (!this.session.sdkSessionId && message.session_id) {
			this.logger.log(`Captured SDK session ID: ${message.session_id}`);

			// Update in-memory session
			this.session.sdkSessionId = message.session_id;

			// Persist to database
			this.db.updateSession(this.session.id, {
				sdkSessionId: message.session_id,
			});

			// Emit session:updated event so StateManager broadcasts the change
			// Include data for decoupled state management
			await this.eventBus.emit('session:updated', {
				sessionId: this.session.id,
				source: 'sdk-session',
				session: { sdkSessionId: message.session_id },
			});
		}
	}

	/**
	 * Handle result message (end of turn)
	 */
	private async handleResultMessage(message: SDKMessage): Promise<void> {
		// Type guard to ensure this is a successful result
		if (!isSDKResultSuccess(message)) return;

		// Update session metadata with token usage and costs
		const usage = message.usage;
		const totalTokens = usage.input_tokens + usage.output_tokens;
		const cost = message.total_cost_usd || 0;

		this.session.lastActiveAt = new Date().toISOString();
		this.session.metadata = {
			...this.session.metadata,
			messageCount: (this.session.metadata?.messageCount || 0) + 1,
			totalTokens: (this.session.metadata?.totalTokens || 0) + totalTokens,
			inputTokens: (this.session.metadata?.inputTokens || 0) + usage.input_tokens,
			outputTokens: (this.session.metadata?.outputTokens || 0) + usage.output_tokens,
			totalCost: (this.session.metadata?.totalCost || 0) + cost,
			toolCallCount: this.session.metadata?.toolCallCount || 0,
		};

		this.db.updateSession(this.session.id, {
			lastActiveAt: this.session.lastActiveAt,
			metadata: this.session.metadata,
		});

		// Emit session:updated event so StateManager broadcasts the change
		// Include data for decoupled state management
		await this.eventBus.emit('session:updated', {
			sessionId: this.session.id,
			source: 'metadata',
			session: {
				lastActiveAt: this.session.lastActiveAt,
				metadata: this.session.metadata,
			},
		});

		// Update context tracker with final accurate usage
		// SKIP for /context command's result - /context doesn't call the API, so it has 0 tokens
		// We already have the correct context from parsing the /context response
		if (!this.lastMessageWasContextResponse) {
			await this.contextTracker.handleResultUsage(
				{
					input_tokens: usage.input_tokens,
					output_tokens: usage.output_tokens,
					cache_read_input_tokens: usage.cache_read_input_tokens,
					cache_creation_input_tokens: usage.cache_creation_input_tokens,
				},
				message.modelUsage
			);
		}

		// Queue /context command to get detailed breakdown (unless we just got one)
		// CRITICAL: Check flag to prevent infinite loop!
		// /context produces its own result message, so we must skip queuing another
		// Note: flag is reset when we process the result message (see early return above)
		if (!this.lastMessageWasContextResponse && this.queueMessage) {
			try {
				// Queue as internal message (won't be saved to DB or broadcast as user message)
				const messageId = await this.queueMessage('/context', true);
				// Track this ID so we can skip the result message
				this.internalContextCommandIds.add(messageId);
				this.logger.log(`Queued /context for detailed breakdown (ID: ${messageId})`);
			} catch (error) {
				// Non-critical - just log the error
				this.logger.warn('Failed to queue /context:', error);
			}
		}

		// Set state back to idle
		// Note: Title generation now handled by TitleGenerationQueue (decoupled via EventBus)
		await this.stateManager.setIdle();
	}

	/**
	 * Handle assistant message (track tool calls)
	 */
	private async handleAssistantMessage(message: SDKMessage): Promise<void> {
		if (!isSDKAssistantMessage(message)) return;

		const toolCalls = message.message.content.filter(isToolUseBlock);
		if (toolCalls.length > 0) {
			this.session.metadata = {
				...this.session.metadata,
				toolCallCount: (this.session.metadata?.toolCallCount || 0) + toolCalls.length,
			};
			this.db.updateSession(this.session.id, {
				metadata: this.session.metadata,
			});

			// Emit session:updated event so StateManager broadcasts the change
			// Include data for decoupled state management
			await this.eventBus.emit('session:updated', {
				sessionId: this.session.id,
				source: 'metadata',
				session: { metadata: this.session.metadata },
			});
		}
	}

	/**
	 * Handle status message (detect compaction start)
	 */
	private async handleStatusMessage(message: SDKMessage): Promise<void> {
		if (!isSDKStatusMessage(message)) return;

		const statusMsg = message as { status: string | null };
		if (statusMsg.status === 'compacting') {
			this.logger.log('Context compaction started (auto)');
			await this.eventBus.emit('context:compacting', {
				sessionId: this.session.id,
				trigger: 'auto' as const,
			});
		}
	}

	/**
	 * Handle compact boundary message (compaction completed)
	 */
	private async handleCompactBoundary(message: SDKMessage): Promise<void> {
		if (!isSDKCompactBoundary(message)) return;

		const compactMsg = message as {
			compact_metadata: {
				trigger: 'manual' | 'auto';
				pre_tokens: number;
			};
		};

		this.logger.log(
			`Context compaction completed (${compactMsg.compact_metadata.trigger}), ` +
				`pre-tokens: ${compactMsg.compact_metadata.pre_tokens}`
		);

		await this.eventBus.emit('context:compacted', {
			sessionId: this.session.id,
			trigger: compactMsg.compact_metadata.trigger,
			preTokens: compactMsg.compact_metadata.pre_tokens,
		});
	}

	/**
	 * Handle /context response
	 * Parse the detailed breakdown and merge with stream-based context tracking
	 */
	private async handleContextResponse(message: SDKMessage): Promise<void> {
		this.logger.log('Processing /context response...');

		const parsedContext = this.contextFetcher.parseContextResponse(message);
		if (!parsedContext) {
			this.logger.warn('Failed to parse /context response');
			return;
		}

		// Merge with stream-based context
		const streamContext = this.contextTracker.getContextInfo();
		const mergedContext = this.contextFetcher.mergeWithStreamContext(parsedContext, streamContext);

		// Update ContextTracker with merged data
		// This makes it the source of truth for context info
		// The tracker will persist to session metadata and emit the context:updated event
		this.contextTracker.updateWithDetailedBreakdown(mergedContext);

		// Emit context update event via EventBus
		// StateManager will broadcast this via state.session channel
		await this.eventBus.emit('context:updated', {
			sessionId: this.session.id,
			contextInfo: mergedContext,
		});
	}
}
