/**
 * Sub-Session RPC Handlers
 *
 * Handles sub-session lifecycle operations:
 * - Create sub-session under a parent
 * - List sub-sessions for a parent
 * - Delete sub-session
 * - Reorder sub-sessions
 */

import type { MessageHub, Session, SubSessionConfig } from '@liuboer/shared';
import type { SessionManager } from '../session-manager';

export function setupSubSessionHandlers(
	messageHub: MessageHub,
	sessionManager: SessionManager
): void {
	/**
	 * Create a sub-session under a parent session
	 *
	 * Request: {
	 *   parentId: string;
	 *   title?: string;
	 *   config?: Partial<SessionConfig>;
	 *   subSessionConfig?: SubSessionConfig;
	 * }
	 *
	 * Response: {
	 *   sessionId: string;
	 *   session: Session;
	 * }
	 */
	messageHub.handle('session.sub.create', async (data) => {
		const { parentId, title, config, subSessionConfig } = data as {
			parentId: string;
			title?: string;
			config?: Partial<Session['config']>;
			subSessionConfig?: SubSessionConfig;
		};

		if (!parentId) {
			throw new Error('parentId is required');
		}

		const sessionId = await sessionManager.createSubSession({
			parentId,
			title,
			config,
			subSessionConfig,
		});

		// Get the created session
		const agentSession = sessionManager.getSession(sessionId);
		const session = agentSession?.getSessionData();

		return { sessionId, session };
	});

	/**
	 * List sub-sessions for a parent session
	 *
	 * Request: {
	 *   parentId: string;
	 *   labels?: string[];  // Optional filter by labels
	 * }
	 *
	 * Response: {
	 *   subSessions: Session[];
	 * }
	 */
	messageHub.handle('session.sub.list', async (data) => {
		const { parentId, labels } = data as {
			parentId: string;
			labels?: string[];
		};

		if (!parentId) {
			throw new Error('parentId is required');
		}

		const subSessions = sessionManager.getSubSessions(parentId, labels);

		return { subSessions };
	});

	/**
	 * Delete a sub-session
	 *
	 * Request: {
	 *   sessionId: string;
	 * }
	 *
	 * Response: {
	 *   success: boolean;
	 * }
	 */
	messageHub.handle('session.sub.delete', async (data) => {
		const { sessionId } = data as { sessionId: string };

		if (!sessionId) {
			throw new Error('sessionId is required');
		}

		await sessionManager.deleteSubSession(sessionId);

		return { success: true };
	});

	/**
	 * Reorder sub-sessions within a parent
	 *
	 * Request: {
	 *   parentId: string;
	 *   orderedIds: string[];  // Sub-session IDs in desired order
	 * }
	 *
	 * Response: {
	 *   success: boolean;
	 * }
	 */
	messageHub.handle('session.sub.reorder', async (data) => {
		const { parentId, orderedIds } = data as {
			parentId: string;
			orderedIds: string[];
		};

		if (!parentId) {
			throw new Error('parentId is required');
		}

		if (!orderedIds || !Array.isArray(orderedIds)) {
			throw new Error('orderedIds must be an array');
		}

		await sessionManager.reorderSubSessions(parentId, orderedIds);

		return { success: true };
	});
}
