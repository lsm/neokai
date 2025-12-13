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
} from '@liuboer/shared/sdk/type-guards';
import { Database } from '../storage/database';
import { Logger } from './logger';
import { ProcessingStateManager } from './processing-state-manager';
import { ContextTracker } from './context-tracker';
import { generateTitle } from './title-generator';

export class SDKMessageHandler {
	private sdkMessageDeltaVersion: number = 0;
	private logger: Logger;

	constructor(
		private session: Session,
		private db: Database,
		private messageHub: MessageHub,
		private eventBus: EventBus,
		private stateManager: ProcessingStateManager,
		private contextTracker: ContextTracker
	) {
		this.logger = new Logger(`SDKMessageHandler ${session.id}`);
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
	 * Handle result message (end of turn)
	 */
	private async handleResultMessage(message: SDKMessage): Promise<void> {
		// Type guard to ensure this is a successful result
		if (!isSDKResultSuccess(message)) return;
		// Set state back to idle
		await this.stateManager.setIdle();

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

		// Update context tracker with final accurate usage
		await this.contextTracker.handleResultUsage(
			{
				input_tokens: usage.input_tokens,
				output_tokens: usage.output_tokens,
				cache_read_input_tokens: usage.cache_read_input_tokens,
				cache_creation_input_tokens: usage.cache_creation_input_tokens,
			},
			message.modelUsage
		);

		// Auto-generate title after first response
		await this.triggerTitleGeneration();
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
	 * Trigger title generation (after first response)
	 */
	private async triggerTitleGeneration(): Promise<void> {
		// Skip if title already generated
		if (this.session.metadata.titleGenerated) {
			return;
		}

		this.logger.log('Auto-generating session title...');

		// Get messages to find first user and assistant messages
		const messages = this.db.getSDKMessages(this.session.id, 10);
		const firstUserMsg = messages.find((m) => m.type === 'user');
		const firstAssistantMsg = messages.find((m) => isSDKAssistantMessage(m));

		if (firstUserMsg && firstAssistantMsg) {
			try {
				const generatedTitle = await generateTitle(
					firstUserMsg,
					firstAssistantMsg,
					this.session.workspacePath
				);
				if (generatedTitle) {
					// Update session title and flag in memory and database
					this.session.title = generatedTitle;
					this.session.metadata.titleGenerated = true;

					this.db.updateSession(this.session.id, {
						title: generatedTitle,
						metadata: this.session.metadata,
					});

					// Emit session:updated event so StateManager broadcasts the change
					await this.eventBus.emit('session:updated', {
						sessionId: this.session.id,
						updates: { title: generatedTitle },
					});

					this.logger.log(`Session title updated to: "${generatedTitle}"`);
				}
			} catch (error) {
				// Don't throw - title generation is non-critical
				this.logger.warn('Failed to generate session title:', error);
			}
		}
	}
}
