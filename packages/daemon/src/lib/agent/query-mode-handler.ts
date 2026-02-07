/**
 * QueryModeHandler - Handles query mode operations (Manual/Auto-queue)
 *
 * Extracted from AgentSession to reduce complexity.
 * Takes AgentSession instance directly - handlers are internal parts of AgentSession.
 *
 * Handles:
 * - handleQueryTrigger - Manual mode: send all saved messages
 * - sendQueuedMessagesOnTurnEnd - Auto-queue mode: send queued messages after turn
 */

import type { Session } from '@neokai/shared';
import { isSDKUserMessage } from '@neokai/shared/sdk/type-guards';
import type { DaemonHub } from '../daemon-hub';
import type { Database } from '../../storage/database';
import type { Logger } from '../logger';
import type { MessageQueue } from './message-queue';

/**
 * Context interface - what QueryModeHandler needs from AgentSession
 * Using interface instead of importing AgentSession to avoid circular deps
 */
export interface QueryModeHandlerContext {
	readonly session: Session;
	readonly db: Database;
	readonly daemonHub: DaemonHub;
	readonly messageQueue: MessageQueue;
	readonly logger: Logger;

	// Method to ensure query is started
	ensureQueryStarted(): Promise<void>;
}

/**
 * Handles query mode operations
 */
export class QueryModeHandler {
	constructor(private ctx: QueryModeHandlerContext) {}

	/**
	 * Handle manual query trigger (Manual mode)
	 *
	 * Retrieves all 'saved' messages from the database and sends them to Claude.
	 */
	async handleQueryTrigger(): Promise<{
		success: boolean;
		messageCount: number;
		error?: string;
	}> {
		const { session, db, daemonHub, messageQueue, logger } = this.ctx;

		try {
			// Get all saved messages
			const savedMessages = db.getMessagesByStatus(session.id, 'saved');

			if (savedMessages.length === 0) {
				return { success: true, messageCount: 0 };
			}

			// Update status to 'queued'
			const dbIds = savedMessages.map((m) => m.dbId);
			db.updateMessageStatus(dbIds, 'queued');

			// Emit status change event
			await daemonHub.emit('messages.statusChanged', {
				sessionId: session.id,
				messageIds: dbIds,
				status: 'queued',
			});

			// Ensure query is started
			await this.ctx.ensureQueryStarted();

			// Enqueue each message
			for (const msg of savedMessages) {
				if (!isSDKUserMessage(msg)) {
					continue;
				}

				const content = msg.message.content;
				if (content) {
					const textContent = this.extractTextContent(content);
					if (textContent) {
						await messageQueue.enqueueWithId(msg.uuid as string, textContent);
					}
				}
			}

			return { success: true, messageCount: savedMessages.length };
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			logger.error('Failed to trigger query:', error);
			return { success: false, messageCount: 0, error: errorMessage };
		}
	}

	/**
	 * Send queued messages when agent turn ends (Auto-queue mode)
	 */
	async sendQueuedMessagesOnTurnEnd(): Promise<void> {
		const { session, db, messageQueue, logger } = this.ctx;

		try {
			// Get all queued messages
			const queuedMessages = db.getMessagesByStatus(session.id, 'queued');

			if (queuedMessages.length === 0) {
				return;
			}

			// Enqueue each message
			for (const msg of queuedMessages) {
				if (!isSDKUserMessage(msg)) {
					continue;
				}

				const content = msg.message.content;
				if (content) {
					const textContent = this.extractTextContent(content);
					if (textContent) {
						await messageQueue.enqueueWithId(msg.uuid as string, textContent);
					}
				}
			}
		} catch (error) {
			logger.error('Failed to send queued messages on turn end:', error);
		}
	}

	/**
	 * Extract text content from message content
	 */
	private extractTextContent(content: string | Array<{ type: string; text?: string }>): string {
		if (typeof content === 'string') {
			return content;
		}

		if (Array.isArray(content)) {
			return content
				.filter((c): c is { type: 'text'; text: string } => c.type === 'text' && !!c.text)
				.map((c) => c.text)
				.join('\n');
		}

		return '';
	}
}
