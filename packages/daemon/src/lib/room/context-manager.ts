/**
 * ContextManager - Manages conversation context with compaction support
 *
 * Handles:
 * - Adding messages to the context
 * - Retrieving recent messages for SDK calls
 * - Token counting and compaction
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { NeoContextRepository } from '../../storage/repositories/context-repository';
import type { NeoContextMessage, NeoContext, ContextMessageRole } from '@neokai/shared';

/**
 * Estimate token count for a message
 * Simple heuristic: ~4 characters per token for English text
 */
function estimateTokens(content: string): number {
	return Math.ceil(content.length / 4);
}

/**
 * Maximum context tokens before compaction is triggered
 */
const MAX_CONTEXT_TOKENS = 150000;

/**
 * Number of recent messages to keep during compaction
 */
const COMPACTION_KEEP_RECENT = 20;

export class ContextManager {
	private contextRepo: NeoContextRepository;
	private contextId: string | null = null;

	constructor(
		private db: BunDatabase,
		private roomId: string
	) {
		this.contextRepo = new NeoContextRepository(db);
	}

	/**
	 * Get or create the context for this room
	 */
	private async getOrCreateContext(): Promise<string> {
		if (this.contextId) {
			return this.contextId;
		}

		let context = this.contextRepo.getContextForRoom(this.roomId);
		if (!context) {
			context = this.contextRepo.createContext(this.roomId);
		}

		this.contextId = context.id;
		return context.id;
	}

	/**
	 * Add message to context
	 */
	async addMessage(
		role: ContextMessageRole,
		content: string,
		metadata?: { sessionId?: string; taskId?: string }
	): Promise<NeoContextMessage> {
		const contextId = await this.getOrCreateContext();
		const tokenCount = estimateTokens(content);

		const message = this.contextRepo.addMessage(
			contextId,
			role,
			content,
			tokenCount,
			metadata?.sessionId,
			metadata?.taskId
		);

		return message;
	}

	/**
	 * Get recent messages for SDK call
	 */
	async getRecentMessages(limit?: number): Promise<NeoContextMessage[]> {
		const contextId = await this.getOrCreateContext();
		const messages = this.contextRepo.getMessages(contextId);

		if (limit && messages.length > limit) {
			return messages.slice(-limit);
		}

		return messages;
	}

	/**
	 * Get total token count
	 */
	async getTokenCount(): Promise<number> {
		const contextId = await this.getOrCreateContext();
		const context = this.contextRepo.getContext(contextId);

		return context?.totalTokens ?? 0;
	}

	/**
	 * Get the context object
	 */
	async getContext(): Promise<NeoContext | null> {
		const contextId = await this.getOrCreateContext();
		return this.contextRepo.getContext(contextId);
	}

	/**
	 * Update context status
	 */
	async updateStatus(status: NeoContext['status']): Promise<void> {
		const contextId = await this.getOrCreateContext();
		this.contextRepo.updateContext(contextId, { status });
	}

	/**
	 * Update current task/session
	 */
	async setCurrentContext(params: {
		currentTaskId?: string | null;
		currentSessionId?: string | null;
	}): Promise<void> {
		const contextId = await this.getOrCreateContext();
		this.contextRepo.updateContext(contextId, params);
	}

	/**
	 * Compact context if too large (keep system + recent)
	 * Returns true if compaction was performed
	 */
	async compactIfNecessary(): Promise<boolean> {
		const contextId = await this.getOrCreateContext();
		const context = this.contextRepo.getContext(contextId);

		if (!context || context.totalTokens < MAX_CONTEXT_TOKENS) {
			return false;
		}

		// Get all messages
		const messages = this.contextRepo.getMessages(contextId);

		// Keep system messages and recent messages
		const systemMessages = messages.filter((m) => m.role === 'system');
		const nonSystemMessages = messages.filter((m) => m.role !== 'system');
		const recentNonSystem = nonSystemMessages.slice(-COMPACTION_KEEP_RECENT);

		// Find the cutoff timestamp (oldest message we're keeping)
		const keptMessages = [...systemMessages, ...recentNonSystem];
		const keptIds = new Set(keptMessages.map((m) => m.id));

		// Delete messages not in the keep list
		const deletedCount = messages.filter((m) => !keptIds.has(m.id)).length;

		if (deletedCount > 0) {
			// Recalculate token count
			const newTokenCount = keptMessages.reduce((sum, m) => sum + m.tokenCount, 0);

			// Delete old messages from database
			// Note: This is a simplified approach - in production, we'd want a more efficient method
			for (const message of messages) {
				if (!keptIds.has(message.id)) {
					this.db.prepare('DELETE FROM neo_context_messages WHERE id = ?').run(message.id);
				}
			}

			// Update context with new token count and compaction timestamp
			this.contextRepo.updateContext(contextId, {
				totalTokens: newTokenCount,
				lastCompactedAt: Date.now(),
			});

			return true;
		}

		return false;
	}

	/**
	 * Clear all messages from context
	 */
	async clearContext(): Promise<void> {
		const contextId = await this.getOrCreateContext();
		this.db.prepare('DELETE FROM neo_context_messages WHERE context_id = ?').run(contextId);
		this.contextRepo.updateContext(contextId, { totalTokens: 0 });
	}
}
