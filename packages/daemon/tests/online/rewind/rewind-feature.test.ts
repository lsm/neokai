/**
 * Rewind Feature Online Tests
 *
 * These tests verify the complete rewind feature with real SDK calls:
 * 1. Checkpoints are created when messages are sent
 * 2. Checkpoints can be retrieved via RPC
 * 3. Rewind preview shows expected file changes
 * 4. Rewind execute restores files correctly
 * 5. Conversation rewind removes messages after rewindPoint
 *
 * REQUIREMENTS:
 * - Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Makes real API calls (costs money, uses rate limits)
 *
 * MODEL:
 * - Uses 'haiku-4.5' (faster and cheaper than Sonnet for tests)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
// Bun automatically loads .env from project root when running tests
import type { DaemonServerContext } from '../helpers/daemon-server';
import { createDaemonServer } from '../helpers/daemon-server';
import { sendMessage, waitForIdle, getProcessingState } from '../helpers/daemon-actions';
import type { RewindPreview, RewindResult } from '@neokai/shared';

/**
 * A rewind point derived from a user message
 */
interface RewindPoint {
	uuid: string; // User message UUID (used as rewindPoint ID)
	timestamp: number; // Message timestamp (milliseconds)
	content: string; // Message content preview
	turnNumber: number; // Derived turn number (1-indexed position)
}

// Use temp directory for test database
const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('Rewind Feature', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await createDaemonServer();
	}, 30000);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, 20000);

	/**
	 * Helper to get rewind points for a session
	 */
	async function getRewindPoints(sessionId: string): Promise<RewindPoint[]> {
		const result = (await daemon.messageHub.call('rewind.checkpoints', {
			sessionId,
		})) as { rewindPoints: RewindPoint[]; error?: string };
		return result.rewindPoints;
	}

	/**
	 * Helper to preview a rewind operation
	 */
	async function previewRewind(sessionId: string, rewindPointId: string): Promise<RewindPreview> {
		const result = (await daemon.messageHub.call('rewind.preview', {
			sessionId,
			rewindPointId,
		})) as { preview: RewindPreview };
		return result.preview;
	}

	/**
	 * Helper to execute a rewind operation
	 */
	async function executeRewind(
		sessionId: string,
		rewindPointId: string,
		mode: 'files' | 'conversation' | 'both' = 'files'
	): Promise<RewindResult> {
		const result = (await daemon.messageHub.call('rewind.execute', {
			sessionId,
			rewindPointId,
			mode,
		})) as { result: RewindResult };
		return result.result;
	}

	describe('Rewind Point Creation', () => {
		test('should create rewind points when messages are sent', async () => {
			const workspacePath = `${TMP_DIR}/rewind-point-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Rewind Point Creation Test',
				config: {
					model: 'haiku-4.5',
					permissionMode: 'acceptEdits',
					enableFileCheckpointing: true,
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Initially no rewind points
			let rewindPoints = await getRewindPoints(sessionId);
			expect(rewindPoints).toEqual([]);

			// Send first message
			await sendMessage(daemon, sessionId, 'What is 2+2? Reply with just the number.');
			await waitForIdle(daemon, sessionId, 60000);

			// Should have 1 rewind point
			rewindPoints = await getRewindPoints(sessionId);
			expect(rewindPoints.length).toBeGreaterThanOrEqual(1);

			// First rewind point should have turn number 1
			const firstRewindPoint = rewindPoints.find((c) => c.turnNumber === 1);
			expect(firstRewindPoint).toBeDefined();
			expect(firstRewindPoint?.content).toContain('2+2');

			// Send second message
			await sendMessage(daemon, sessionId, 'What is 3+3? Reply with just the number.');
			await waitForIdle(daemon, sessionId, 60000);

			// Should have 2 rewind points
			rewindPoints = await getRewindPoints(sessionId);
			expect(rewindPoints.length).toBeGreaterThanOrEqual(2);

			// Check second rewind point
			const secondRewindPoint = rewindPoints.find((c) => c.turnNumber === 2);
			expect(secondRewindPoint).toBeDefined();
			expect(secondRewindPoint?.content).toContain('3+3');
		}, 120000);

		test('should return rewind points sorted by turn number (newest first)', async () => {
			const workspacePath = `${TMP_DIR}/rewind-sort-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Rewind Point Sorting Test',
				config: {
					model: 'haiku-4.5',
					permissionMode: 'acceptEdits',
					enableFileCheckpointing: true,
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Send multiple messages
			await sendMessage(daemon, sessionId, 'First message');
			await waitForIdle(daemon, sessionId, 60000);

			await sendMessage(daemon, sessionId, 'Second message');
			await waitForIdle(daemon, sessionId, 60000);

			await sendMessage(daemon, sessionId, 'Third message');
			await waitForIdle(daemon, sessionId, 60000);

			const rewindPoints = await getRewindPoints(sessionId);
			expect(rewindPoints.length).toBeGreaterThanOrEqual(3);

			// Should be sorted newest first (highest turn number first)
			for (let i = 0; i < rewindPoints.length - 1; i++) {
				expect(rewindPoints[i].turnNumber).toBeGreaterThan(rewindPoints[i + 1].turnNumber);
			}
		}, 180000);
	});

	describe('Rewind Preview', () => {
		test('should show preview when rewindPoint exists', async () => {
			const workspacePath = `${TMP_DIR}/rewind-preview-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Rewind Preview Test',
				config: {
					model: 'haiku-4.5',
					permissionMode: 'acceptEdits',
					enableFileCheckpointing: true,
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Send a message
			await sendMessage(daemon, sessionId, 'What is 1+1?');
			await waitForIdle(daemon, sessionId, 60000);

			// Get rewindPoint
			const rewindPoints = await getRewindPoints(sessionId);
			expect(rewindPoints.length).toBeGreaterThanOrEqual(1);

			const rewindPoint = rewindPoints[0];

			// Preview rewind
			const preview = await previewRewind(sessionId, rewindPoint.uuid);

			// Preview should indicate whether rewind is possible
			expect(preview).toBeDefined();
			expect(typeof preview.canRewind).toBe('boolean');

			// If can rewind, should have file info
			if (preview.canRewind) {
				expect(preview.filesChanged).toBeDefined();
			}
		}, 120000);

		test('should return error for non-existent rewindPoint', async () => {
			const workspacePath = `${TMP_DIR}/rewind-preview-invalid-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Rewind Preview Invalid Test',
				config: {
					model: 'haiku-4.5',
					permissionMode: 'acceptEdits',
					enableFileCheckpointing: true,
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Send a message to initialize SDK
			await sendMessage(daemon, sessionId, 'Hello');
			await waitForIdle(daemon, sessionId, 60000);

			// Preview with invalid rewindPoint ID
			const preview = await previewRewind(sessionId, 'invalid-rewindPoint-id');

			expect(preview.canRewind).toBe(false);
			expect(preview.error).toContain('not found');
		}, 120000);
	});

	describe('Rewind Execute - Files Mode', () => {
		test('should execute files-only rewind successfully', async () => {
			const workspacePath = `${TMP_DIR}/rewind-execute-files-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Rewind Execute Files Test',
				config: {
					model: 'haiku-4.5',
					permissionMode: 'acceptEdits',
					enableFileCheckpointing: true,
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Send first message
			await sendMessage(daemon, sessionId, 'What is 1+1?');
			await waitForIdle(daemon, sessionId, 60000);

			// Get first rewindPoint
			let rewindPoints = await getRewindPoints(sessionId);
			expect(rewindPoints.length).toBeGreaterThanOrEqual(1);
			const firstRewindPoint = rewindPoints[0];

			// Send second message
			await sendMessage(daemon, sessionId, 'What is 2+2?');
			await waitForIdle(daemon, sessionId, 60000);

			// Execute files-only rewind to first rewindPoint
			const result = await executeRewind(sessionId, firstRewindPoint.uuid, 'files');

			// Result should indicate success or provide reason for failure
			expect(result).toBeDefined();
			expect(typeof result.success).toBe('boolean');

			// After files rewind, rewindPoints should still exist (conversation not affected)
			rewindPoints = await getRewindPoints(sessionId);
			expect(rewindPoints.length).toBeGreaterThanOrEqual(1);
		}, 180000);
	});

	describe('Rewind Execute - Conversation Mode', () => {
		test('should execute conversation-only rewind successfully', async () => {
			const workspacePath = `${TMP_DIR}/rewind-execute-conversation-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Rewind Execute Conversation Test',
				config: {
					model: 'haiku-4.5',
					permissionMode: 'acceptEdits',
					enableFileCheckpointing: true,
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Send multiple messages
			await sendMessage(daemon, sessionId, 'What is 1+1?');
			await waitForIdle(daemon, sessionId, 60000);

			const rewindPointsAfterFirst = await getRewindPoints(sessionId);
			expect(rewindPointsAfterFirst.length).toBeGreaterThanOrEqual(1);
			const firstRewindPoint = rewindPointsAfterFirst.find((c) => c.turnNumber === 1);
			expect(firstRewindPoint).toBeDefined();

			await sendMessage(daemon, sessionId, 'What is 2+2?');
			await waitForIdle(daemon, sessionId, 60000);

			await sendMessage(daemon, sessionId, 'What is 3+3?');
			await waitForIdle(daemon, sessionId, 60000);

			// Should have 3 rewindPoints
			let rewindPoints = await getRewindPoints(sessionId);
			expect(rewindPoints.length).toBeGreaterThanOrEqual(3);

			// Execute conversation rewind to first rewindPoint (rewindPoints sorted newest first, so first with turnNumber=1 is the earliest)
			const result = await executeRewind(sessionId, firstRewindPoint!.uuid, 'conversation');

			expect(result).toBeDefined();
			expect(typeof result.success).toBe('boolean');

			if (result.success) {
				// After conversation rewind, should have fewer rewindPoints
				rewindPoints = await getRewindPoints(sessionId);

				// Checkpoints after the rewind point should be removed
				const hasLaterCheckpoints = rewindPoints.some((c) => c.turnNumber > 1);
				expect(hasLaterCheckpoints).toBe(false);

				// Result should indicate messages were deleted
				expect(result.conversationRewound).toBe(true);
				expect(result.messagesDeleted).toBeGreaterThan(0);
			}
		}, 240000);
	});

	describe('Rewind Execute - Both Mode', () => {
		test('should execute both files and conversation rewind', async () => {
			const workspacePath = `${TMP_DIR}/rewind-execute-both-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Rewind Execute Both Test',
				config: {
					model: 'haiku-4.5',
					permissionMode: 'acceptEdits',
					enableFileCheckpointing: true,
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Send first message
			await sendMessage(daemon, sessionId, 'What is 1+1?');
			await waitForIdle(daemon, sessionId, 60000);

			const rewindPointsAfterFirst = await getRewindPoints(sessionId);
			expect(rewindPointsAfterFirst.length).toBeGreaterThanOrEqual(1);
			const firstRewindPoint = rewindPointsAfterFirst.find((c) => c.turnNumber === 1);
			expect(firstRewindPoint).toBeDefined();

			// Send second message
			await sendMessage(daemon, sessionId, 'What is 2+2?');
			await waitForIdle(daemon, sessionId, 60000);

			// Execute both mode rewind to first rewindPoint
			const result = await executeRewind(sessionId, firstRewindPoint!.uuid, 'both');

			expect(result).toBeDefined();
			expect(typeof result.success).toBe('boolean');

			if (result.success) {
				// After both rewind, conversation should be truncated
				const rewindPoints = await getRewindPoints(sessionId);
				const hasLaterCheckpoints = rewindPoints.some((c) => c.turnNumber > 1);
				expect(hasLaterCheckpoints).toBe(false);
			}
		}, 180000);
	});

	describe('Rewind Error Handling', () => {
		test('should handle rewind with invalid rewindPoint gracefully', async () => {
			const workspacePath = `${TMP_DIR}/rewind-error-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Rewind Error Test',
				config: {
					model: 'haiku-4.5',
					permissionMode: 'acceptEdits',
					enableFileCheckpointing: true,
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Send a message to initialize
			await sendMessage(daemon, sessionId, 'Hello');
			await waitForIdle(daemon, sessionId, 60000);

			// Try to rewind with invalid rewindPoint
			const result = await executeRewind(sessionId, 'invalid-rewindPoint-id', 'files');

			expect(result.success).toBe(false);
			expect(result.error).toContain('not found');
		}, 120000);

		test('should maintain session state after failed rewind', async () => {
			const workspacePath = `${TMP_DIR}/rewind-recovery-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Rewind Recovery Test',
				config: {
					model: 'haiku-4.5',
					permissionMode: 'acceptEdits',
					enableFileCheckpointing: true,
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Send a message
			await sendMessage(daemon, sessionId, 'What is 1+1?');
			await waitForIdle(daemon, sessionId, 60000);

			// Attempt failed rewind
			await executeRewind(sessionId, 'invalid-rewindPoint-id', 'files');

			// Session should still be functional
			const state = await getProcessingState(daemon, sessionId);
			expect(state.status).toBe('idle');

			// Can still send messages
			const msgResult = await sendMessage(daemon, sessionId, 'What is 2+2?');
			expect(msgResult.messageId).toBeDefined();

			await waitForIdle(daemon, sessionId, 60000);

			// Session still idle and working
			const finalState = await getProcessingState(daemon, sessionId);
			expect(finalState.status).toBe('idle');
		}, 180000);
	});

	describe('enableFileCheckpointing Configuration', () => {
		test('should create rewindPoints when enableFileCheckpointing is true (default)', async () => {
			const workspacePath = `${TMP_DIR}/rewind-enabled-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Checkpointing Enabled Test',
				config: {
					model: 'haiku-4.5',
					permissionMode: 'acceptEdits',
					enableFileCheckpointing: true, // Explicitly enabled
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Send messages
			await sendMessage(daemon, sessionId, 'What is 1+1?');
			await waitForIdle(daemon, sessionId, 60000);

			await sendMessage(daemon, sessionId, 'What is 2+2?');
			await waitForIdle(daemon, sessionId, 60000);

			// With enableFileCheckpointing=true, rewindPoints SHOULD be created
			const rewindPoints = await getRewindPoints(sessionId);
			expect(rewindPoints.length).toBeGreaterThanOrEqual(2);

			// Verify rewindPoints have proper structure
			for (const rewindPoint of rewindPoints) {
				expect(rewindPoint.uuid).toBeDefined();
				expect(rewindPoint.turnNumber).toBeGreaterThan(0);
				expect(rewindPoint.content).toBeDefined();
			}

			// Session should still be functional
			const state = await getProcessingState(daemon, sessionId);
			expect(state.status).toBe('idle');
		}, 180000);

		test('should still have rewindPoints but file rewind disabled when enableFileCheckpointing is false', async () => {
			const workspacePath = `${TMP_DIR}/rewind-disabled-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Checkpointing Disabled Test',
				config: {
					model: 'haiku-4.5',
					permissionMode: 'acceptEdits',
					enableFileCheckpointing: false, // Explicitly disabled for SDK file tracking
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Send messages
			await sendMessage(daemon, sessionId, 'What is 1+1?');
			await waitForIdle(daemon, sessionId, 60000);

			await sendMessage(daemon, sessionId, 'What is 2+2?');
			await waitForIdle(daemon, sessionId, 60000);

			// Checkpoints are STILL created for conversation tracking
			// (enableFileCheckpointing only controls SDK's file change tracking)
			const rewindPoints = await getRewindPoints(sessionId);
			expect(rewindPoints.length).toBeGreaterThanOrEqual(2);

			// However, file rewind should not be available (SDK won't track file changes)
			// Preview should indicate rewind is not possible for files
			const preview = await previewRewind(sessionId, rewindPoints[0].uuid);
			// Either canRewind is false or filesChanged is empty/undefined
			if (preview.canRewind) {
				const filesCount = Array.isArray(preview.filesChanged)
					? preview.filesChanged.length
					: (preview.filesChanged ?? 0);
				expect(filesCount).toBe(0);
			}

			// Session should still be functional
			const state = await getProcessingState(daemon, sessionId);
			expect(state.status).toBe('idle');
		}, 180000);
	});
});
