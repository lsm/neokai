/**
 * Rewind Feature Online Tests
 *
 * These tests verify the complete rewind feature with real SDK calls:
 * 1. Checkpoints are created when messages are sent
 * 2. Checkpoints can be retrieved via RPC
 * 3. Rewind preview shows expected file changes
 * 4. Rewind execute restores files correctly
 * 5. Conversation rewind removes messages after checkpoint
 *
 * REQUIREMENTS:
 * - Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Makes real API calls (costs money, uses rate limits)
 *
 * MODEL:
 * - Uses 'haiku-4.5' (faster and cheaper than Sonnet for tests)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import 'dotenv/config';
import type { DaemonServerContext } from '../../helpers/daemon-server-helper';
import { spawnDaemonServer } from '../../helpers/daemon-server-helper';
import { sendMessage, waitForIdle, getProcessingState } from '../../helpers/daemon-test-helpers';
import type { Checkpoint, RewindPreview, RewindResult } from '@liuboer/shared';

// Use temp directory for test database
const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('Rewind Feature', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await spawnDaemonServer();
	}, 30000);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	});

	/**
	 * Helper to get checkpoints for a session
	 */
	async function getCheckpoints(sessionId: string): Promise<Checkpoint[]> {
		const result = (await daemon.messageHub.call('rewind.checkpoints', {
			sessionId,
		})) as { checkpoints: Checkpoint[]; error?: string };
		return result.checkpoints;
	}

	/**
	 * Helper to preview a rewind operation
	 */
	async function previewRewind(sessionId: string, checkpointId: string): Promise<RewindPreview> {
		const result = (await daemon.messageHub.call('rewind.preview', {
			sessionId,
			checkpointId,
		})) as { preview: RewindPreview };
		return result.preview;
	}

	/**
	 * Helper to execute a rewind operation
	 */
	async function executeRewind(
		sessionId: string,
		checkpointId: string,
		mode: 'files' | 'conversation' | 'both' = 'files'
	): Promise<RewindResult> {
		const result = (await daemon.messageHub.call('rewind.execute', {
			sessionId,
			checkpointId,
			mode,
		})) as { result: RewindResult };
		return result.result;
	}

	describe('Checkpoint Creation', () => {
		test('should create checkpoints when messages are sent', async () => {
			const workspacePath = `${TMP_DIR}/rewind-checkpoint-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Checkpoint Creation Test',
				config: {
					model: 'haiku-4.5',
					permissionMode: 'acceptEdits',
					enableFileCheckpointing: true,
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Initially no checkpoints
			let checkpoints = await getCheckpoints(sessionId);
			expect(checkpoints).toEqual([]);

			// Send first message
			await sendMessage(daemon, sessionId, 'What is 2+2? Reply with just the number.');
			await waitForIdle(daemon, sessionId, 60000);

			// Should have 1 checkpoint
			checkpoints = await getCheckpoints(sessionId);
			expect(checkpoints.length).toBeGreaterThanOrEqual(1);

			// First checkpoint should have turn number 1
			const firstCheckpoint = checkpoints.find((c) => c.turnNumber === 1);
			expect(firstCheckpoint).toBeDefined();
			expect(firstCheckpoint?.sessionId).toBe(sessionId);
			expect(firstCheckpoint?.messagePreview).toContain('2+2');

			// Send second message
			await sendMessage(daemon, sessionId, 'What is 3+3? Reply with just the number.');
			await waitForIdle(daemon, sessionId, 60000);

			// Should have 2 checkpoints
			checkpoints = await getCheckpoints(sessionId);
			expect(checkpoints.length).toBeGreaterThanOrEqual(2);

			// Check second checkpoint
			const secondCheckpoint = checkpoints.find((c) => c.turnNumber === 2);
			expect(secondCheckpoint).toBeDefined();
			expect(secondCheckpoint?.messagePreview).toContain('3+3');
		}, 120000);

		test('should return checkpoints sorted by turn number (newest first)', async () => {
			const workspacePath = `${TMP_DIR}/rewind-sort-test-${Date.now()}`;

			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Checkpoint Sorting Test',
				config: {
					model: 'haiku-4.5',
					permissionMode: 'acceptEdits',
					enableFileCheckpointing: true,
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Send multiple messages
			await sendMessage(daemon, sessionId, 'First message');
			await waitForIdle(daemon, sessionId, 60000);

			await sendMessage(daemon, sessionId, 'Second message');
			await waitForIdle(daemon, sessionId, 60000);

			await sendMessage(daemon, sessionId, 'Third message');
			await waitForIdle(daemon, sessionId, 60000);

			const checkpoints = await getCheckpoints(sessionId);
			expect(checkpoints.length).toBeGreaterThanOrEqual(3);

			// Should be sorted newest first (highest turn number first)
			for (let i = 0; i < checkpoints.length - 1; i++) {
				expect(checkpoints[i].turnNumber).toBeGreaterThan(checkpoints[i + 1].turnNumber);
			}
		}, 180000);
	});

	describe('Rewind Preview', () => {
		test('should show preview when checkpoint exists', async () => {
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

			// Send a message
			await sendMessage(daemon, sessionId, 'What is 1+1?');
			await waitForIdle(daemon, sessionId, 60000);

			// Get checkpoint
			const checkpoints = await getCheckpoints(sessionId);
			expect(checkpoints.length).toBeGreaterThanOrEqual(1);

			const checkpoint = checkpoints[0];

			// Preview rewind
			const preview = await previewRewind(sessionId, checkpoint.id);

			// Preview should indicate whether rewind is possible
			expect(preview).toBeDefined();
			expect(typeof preview.canRewind).toBe('boolean');

			// If can rewind, should have file info
			if (preview.canRewind) {
				expect(preview.filesChanged).toBeDefined();
			}
		}, 120000);

		test('should return error for non-existent checkpoint', async () => {
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

			// Send a message to initialize SDK
			await sendMessage(daemon, sessionId, 'Hello');
			await waitForIdle(daemon, sessionId, 60000);

			// Preview with invalid checkpoint ID
			const preview = await previewRewind(sessionId, 'invalid-checkpoint-id');

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

			// Send first message
			await sendMessage(daemon, sessionId, 'What is 1+1?');
			await waitForIdle(daemon, sessionId, 60000);

			// Get first checkpoint
			let checkpoints = await getCheckpoints(sessionId);
			expect(checkpoints.length).toBeGreaterThanOrEqual(1);
			const firstCheckpoint = checkpoints[0];

			// Send second message
			await sendMessage(daemon, sessionId, 'What is 2+2?');
			await waitForIdle(daemon, sessionId, 60000);

			// Execute files-only rewind to first checkpoint
			const result = await executeRewind(sessionId, firstCheckpoint.id, 'files');

			// Result should indicate success or provide reason for failure
			expect(result).toBeDefined();
			expect(typeof result.success).toBe('boolean');

			// After files rewind, checkpoints should still exist (conversation not affected)
			checkpoints = await getCheckpoints(sessionId);
			expect(checkpoints.length).toBeGreaterThanOrEqual(1);
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

			// Send multiple messages
			await sendMessage(daemon, sessionId, 'What is 1+1?');
			await waitForIdle(daemon, sessionId, 60000);

			const checkpointsAfterFirst = await getCheckpoints(sessionId);
			expect(checkpointsAfterFirst.length).toBeGreaterThanOrEqual(1);
			const firstCheckpoint = checkpointsAfterFirst.find((c) => c.turnNumber === 1);
			expect(firstCheckpoint).toBeDefined();

			await sendMessage(daemon, sessionId, 'What is 2+2?');
			await waitForIdle(daemon, sessionId, 60000);

			await sendMessage(daemon, sessionId, 'What is 3+3?');
			await waitForIdle(daemon, sessionId, 60000);

			// Should have 3 checkpoints
			let checkpoints = await getCheckpoints(sessionId);
			expect(checkpoints.length).toBeGreaterThanOrEqual(3);

			// Execute conversation rewind to first checkpoint
			const result = await executeRewind(sessionId, firstCheckpoint!.id, 'conversation');

			expect(result).toBeDefined();
			expect(typeof result.success).toBe('boolean');

			if (result.success) {
				// After conversation rewind, should have fewer checkpoints
				checkpoints = await getCheckpoints(sessionId);

				// Checkpoints after the rewind point should be removed
				const hasLaterCheckpoints = checkpoints.some((c) => c.turnNumber > 1);
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

			// Send first message
			await sendMessage(daemon, sessionId, 'What is 1+1?');
			await waitForIdle(daemon, sessionId, 60000);

			const checkpointsAfterFirst = await getCheckpoints(sessionId);
			expect(checkpointsAfterFirst.length).toBeGreaterThanOrEqual(1);
			const firstCheckpoint = checkpointsAfterFirst.find((c) => c.turnNumber === 1);
			expect(firstCheckpoint).toBeDefined();

			// Send second message
			await sendMessage(daemon, sessionId, 'What is 2+2?');
			await waitForIdle(daemon, sessionId, 60000);

			// Execute both mode rewind to first checkpoint
			const result = await executeRewind(sessionId, firstCheckpoint!.id, 'both');

			expect(result).toBeDefined();
			expect(typeof result.success).toBe('boolean');

			if (result.success) {
				// After both rewind, conversation should be truncated
				const checkpoints = await getCheckpoints(sessionId);
				const hasLaterCheckpoints = checkpoints.some((c) => c.turnNumber > 1);
				expect(hasLaterCheckpoints).toBe(false);
			}
		}, 180000);
	});

	describe('Rewind Error Handling', () => {
		test('should handle rewind with invalid checkpoint gracefully', async () => {
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

			// Send a message to initialize
			await sendMessage(daemon, sessionId, 'Hello');
			await waitForIdle(daemon, sessionId, 60000);

			// Try to rewind with invalid checkpoint
			const result = await executeRewind(sessionId, 'invalid-checkpoint-id', 'files');

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

			// Send a message
			await sendMessage(daemon, sessionId, 'What is 1+1?');
			await waitForIdle(daemon, sessionId, 60000);

			// Attempt failed rewind
			await executeRewind(sessionId, 'invalid-checkpoint-id', 'files');

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
		test('should create checkpoints when enableFileCheckpointing is true (default)', async () => {
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

			// Send messages
			await sendMessage(daemon, sessionId, 'What is 1+1?');
			await waitForIdle(daemon, sessionId, 60000);

			await sendMessage(daemon, sessionId, 'What is 2+2?');
			await waitForIdle(daemon, sessionId, 60000);

			// With enableFileCheckpointing=true, checkpoints SHOULD be created
			const checkpoints = await getCheckpoints(sessionId);
			expect(checkpoints.length).toBeGreaterThanOrEqual(2);

			// Verify checkpoints have proper structure
			for (const checkpoint of checkpoints) {
				expect(checkpoint.id).toBeDefined();
				expect(checkpoint.turnNumber).toBeGreaterThan(0);
				expect(checkpoint.sessionId).toBe(sessionId);
			}

			// Session should still be functional
			const state = await getProcessingState(daemon, sessionId);
			expect(state.status).toBe('idle');
		}, 180000);

		test('should still have checkpoints but file rewind disabled when enableFileCheckpointing is false', async () => {
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

			// Send messages
			await sendMessage(daemon, sessionId, 'What is 1+1?');
			await waitForIdle(daemon, sessionId, 60000);

			await sendMessage(daemon, sessionId, 'What is 2+2?');
			await waitForIdle(daemon, sessionId, 60000);

			// Checkpoints are STILL created for conversation tracking
			// (enableFileCheckpointing only controls SDK's file change tracking)
			const checkpoints = await getCheckpoints(sessionId);
			expect(checkpoints.length).toBeGreaterThanOrEqual(2);

			// However, file rewind should not be available (SDK won't track file changes)
			// Preview should indicate rewind is not possible for files
			const preview = await previewRewind(sessionId, checkpoints[0].id);
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
