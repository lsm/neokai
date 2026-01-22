/**
 * QueryModeHandler - Handles query mode operations (Manual/Auto-queue)
 *
 * Extracted from AgentSession to reduce complexity.
 * Handles:
 * - handleQueryTrigger - Manual mode: send all saved messages
 * - sendQueuedMessagesOnTurnEnd - Auto-queue mode: send queued messages after turn
 */

import type { Session } from '@liuboer/shared';
import { isSDKUserMessage } from '@liuboer/shared/sdk/type-guards';
import type { DaemonHub } from '../daemon-hub';
import { Database } from '../../storage/database';
import { Logger } from '../logger';
import type { MessageQueue } from './message-queue';

/**
 * Dependencies required for QueryModeHandler
 */
export interface QueryModeHandlerDependencies {
	session: Session;
	db: Database;
	daemonHub: DaemonHub;
	messageQueue: MessageQueue;
	logger: Logger;

	// Callback to ensure query is started
	ensureQueryStarted: () => Promise<void>;
}

/**
 * Handles query mode operations
 */
export class QueryModeHandler {
	private deps: QueryModeHandlerDependencies;

	constructor(deps: QueryModeHandlerDependencies) {
		this.deps = deps;
	}

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
		const { session, db, daemonHub, messageQueue, logger } = this.deps;

		logger.log('Handling query trigger (Manual mode)');

		try {
			// Get all saved messages
			const savedMessages = db.getMessagesByStatus(session.id, 'saved');

			if (savedMessages.length === 0) {
				logger.log('No saved messages to send');
				return { success: true, messageCount: 0 };
			}

			logger.log(`Found ${savedMessages.length} saved messages to send`);

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
			await this.deps.ensureQueryStarted();

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

			logger.log(`Successfully queued ${savedMessages.length} messages (waiting for system:init)`);
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
		const { session, db, messageQueue, logger } = this.deps;

		logger.log('Checking for queued messages on turn end');

		try {
			// Get all queued messages
			const queuedMessages = db.getMessagesByStatus(session.id, 'queued');

			if (queuedMessages.length === 0) {
				logger.log('No queued messages to send on turn end');
				return;
			}

			logger.log(`Found ${queuedMessages.length} queued messages to send on turn end`);

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

			logger.log(
				`Successfully queued ${queuedMessages.length} messages on turn end (waiting for system:init)`
			);
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
