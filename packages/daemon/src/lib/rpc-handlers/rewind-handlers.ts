/**
 * Rewind RPC Handlers
 *
 * RPC handlers for the rewind feature, which allows restoring workspace files
 * and/or conversation to a previous checkpoint.
 *
 * Follows the 3-layer communication pattern:
 * - RPC handlers do minimal work and return fast (<100ms)
 * - Heavy operations are deferred to DaemonHub subscribers
 * - State updates are broadcast via State Channels
 */

import type { MessageHub } from '@liuboer/shared';
import type { DaemonHub } from '../daemon-hub';
import type { SessionManager } from '../session-manager';
import type { RewindMode } from '@liuboer/shared';

export function setupRewindHandlers(
	messageHub: MessageHub,
	sessionManager: SessionManager,
	_daemonHub: DaemonHub
): void {
	/**
	 * Get all checkpoints for a session
	 *
	 * Request: { sessionId: string }
	 * Response: { checkpoints: Checkpoint[]; error?: string }
	 */
	messageHub.handle('rewind.checkpoints', async (data) => {
		const { sessionId } = data as { sessionId: string };

		const agentSession = await sessionManager.getSessionAsync(sessionId);
		if (!agentSession) {
			return {
				checkpoints: [],
				error: 'Session not found',
			};
		}

		const checkpoints = agentSession.getCheckpoints();
		return { checkpoints };
	});

	/**
	 * Preview a rewind operation (dry run)
	 *
	 * Request: { sessionId: string; checkpointId: string }
	 * Response: { preview: RewindPreview }
	 */
	messageHub.handle('rewind.preview', async (data) => {
		const { sessionId, checkpointId } = data as { sessionId: string; checkpointId: string };

		const agentSession = await sessionManager.getSessionAsync(sessionId);
		if (!agentSession) {
			return {
				preview: {
					canRewind: false,
					error: 'Session not found',
				},
			};
		}

		const preview = await agentSession.previewRewind(checkpointId);
		return { preview };
	});

	/**
	 * Execute a rewind operation
	 *
	 * Request: { sessionId: string; checkpointId: string; mode?: RewindMode }
	 * Response: { result: RewindResult }
	 *
	 * Modes:
	 * - 'files': Restore file changes only (default, non-destructive)
	 * - 'conversation': Resume conversation from checkpoint (deletes messages after checkpoint)
	 * - 'both': Full rewind of both files and conversation
	 */
	messageHub.handle('rewind.execute', async (data) => {
		const {
			sessionId,
			checkpointId,
			mode = 'files',
		} = data as {
			sessionId: string;
			checkpointId: string;
			mode?: RewindMode;
		};

		const agentSession = await sessionManager.getSessionAsync(sessionId);
		if (!agentSession) {
			return {
				result: {
					success: false,
					error: 'Session not found',
				},
			};
		}

		const result = await agentSession.executeRewind(checkpointId, mode);
		return { result };
	});
}
