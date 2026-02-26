/**
 * MessageRecoveryHandler - Recovers orphaned messages
 *
 * Extracted from AgentSession to reduce complexity.
 * Handles:
 * - Detecting messages stuck in 'queued' or 'sent' status
 * - Identifying messages that never got a system:init response
 * - Resetting orphaned messages to 'saved' for retry
 */

import type { Session } from '@neokai/shared';
import type { SDKMessage } from '@neokai/shared/sdk';
import { isSDKUserMessage, isSDKSystemMessage } from '@neokai/shared/sdk/type-guards';
import { Database } from '../../storage/database';
import { Logger } from '../logger';

/**
 * Recovers orphaned messages for a session
 */
export class MessageRecoveryHandler {
	private session: Session;
	private db: Database;
	private logger: Logger;

	constructor(session: Session, db: Database, logger: Logger) {
		this.session = session;
		this.db = db;
		this.logger = logger;
	}

	/**
	 * Recover orphaned sent messages
	 *
	 * Recovery strategy:
	 * 1. For sent messages, detect orphaned ones with no system:init boundary after send
	 *    and reset them to saved for retry.
	 *
	 * This allows startup replay logic to re-dispatch recoverable messages safely.
	 */
	recoverOrphanedSentMessages(): void {
		const { session, db, logger } = this;

		try {
			// Sent messages may need recovery if they never got a corresponding
			// system:init/response boundary after being marked sent.
			const sentMessages = db.getMessagesByStatus(session.id, 'sent');
			const allStuckMessages = [...sentMessages];

			if (allStuckMessages.length === 0) {
				return;
			}

			// Get all SDK messages to check for responses
			const { messages: allMessages } = db.getSDKMessages(session.id, 10000);

			// Find the latest system:init message timestamp
			let latestInitTimestamp = 0;
			for (const msg of allMessages) {
				if (isSDKSystemMessage(msg) && msg.subtype === 'init') {
					const msgWithTimestamp = msg as SDKMessage & { timestamp?: number };
					if (msgWithTimestamp.timestamp && msgWithTimestamp.timestamp > latestInitTimestamp) {
						latestInitTimestamp = msgWithTimestamp.timestamp;
					}
				}
			}

			// Find orphaned user messages
			const orphanedMessages: Array<{
				dbId: string;
				uuid: string;
				timestamp: number;
			}> = [];

			for (const sentMsg of allStuckMessages) {
				if (!isSDKUserMessage(sentMsg)) {
					continue;
				}

				const msgWithTimestamp = sentMsg as SDKMessage & { timestamp?: number };
				const msgTimestamp = msgWithTimestamp.timestamp || 0;

				// If no system:init after this message, it's orphaned
				if (msgTimestamp > latestInitTimestamp) {
					orphanedMessages.push({
						dbId: sentMsg.dbId,
						uuid: sentMsg.uuid || 'unknown',
						timestamp: msgTimestamp,
					});
				}
			}

			if (orphanedMessages.length === 0) {
				return;
			}

			// Reset orphaned messages to 'saved' status
			const dbIds = orphanedMessages.map((m) => m.dbId);
			db.updateMessageStatus(dbIds, 'saved');
		} catch (error) {
			logger.warn('Failed to recover orphaned sent messages:', error);
			// Don't throw - recovery failure shouldn't prevent session from loading
		}
	}
}
