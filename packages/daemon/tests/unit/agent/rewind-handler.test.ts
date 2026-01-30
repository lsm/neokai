/**
 * RewindHandler Tests
 *
 * Tests for rewind operations (preview and execute).
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { RewindHandler, type RewindHandlerContext } from '../../../src/lib/agent/rewind-handler';
import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { Session, Checkpoint } from '@neokai/shared';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { Database } from '../../../src/storage/database';
import type { CheckpointTracker } from '../../../src/lib/agent/checkpoint-tracker';
import type { QueryLifecycleManager } from '../../../src/lib/agent/query-lifecycle-manager';
import type { Logger } from '../../../src/lib/logger';

describe('RewindHandler', () => {
	let handler: RewindHandler;
	let mockSession: Session;
	let mockDb: Database;
	let mockDaemonHub: DaemonHub;
	let mockCheckpointTracker: CheckpointTracker;
	let mockLifecycleManager: QueryLifecycleManager;
	let mockLogger: Logger;
	let mockQueryObject: Query | null;

	let emitSpy: ReturnType<typeof mock>;
	let getCheckpointsSpy: ReturnType<typeof mock>;
	let getCheckpointSpy: ReturnType<typeof mock>;
	let rewindToSpy: ReturnType<typeof mock>;
	let restartSpy: ReturnType<typeof mock>;
	let deleteMessagesAfterSpy: ReturnType<typeof mock>;
	let rewindFilesSpy: ReturnType<typeof mock>;
	let updateSessionSpy: ReturnType<typeof mock>;

	const testCheckpoint: Checkpoint = {
		id: 'checkpoint-123',
		messagePreview: 'Test message',
		turnNumber: 1,
		timestamp: Date.now(),
		sessionId: 'test-session-id',
	};

	beforeEach(() => {
		mockSession = {
			id: 'test-session-id',
			title: 'Test Session',
			workspacePath: '/test/path',
			status: 'active',
			config: { model: 'claude-sonnet-4-20250514' },
			metadata: {},
			createdAt: Date.now(),
			updatedAt: Date.now(),
		} as Session;

		emitSpy = mock(async () => {});
		mockDaemonHub = {
			emit: emitSpy,
		} as unknown as DaemonHub;

		deleteMessagesAfterSpy = mock(() => 5);
		updateSessionSpy = mock(() => {});
		mockDb = {
			deleteMessagesAfter: deleteMessagesAfterSpy,
			updateSession: updateSessionSpy,
		} as unknown as Database;

		getCheckpointsSpy = mock(() => [testCheckpoint]);
		getCheckpointSpy = mock((id: string) =>
			id === testCheckpoint.id ? testCheckpoint : undefined
		);
		rewindToSpy = mock(() => 0);
		mockCheckpointTracker = {
			getCheckpoints: getCheckpointsSpy,
			getCheckpoint: getCheckpointSpy,
			rewindTo: rewindToSpy,
		} as unknown as CheckpointTracker;

		restartSpy = mock(async () => {});
		mockLifecycleManager = {
			restart: restartSpy,
		} as unknown as QueryLifecycleManager;

		mockLogger = {
			log: mock(() => {}),
			warn: mock(() => {}),
			error: mock(() => {}),
			debug: mock(() => {}),
			info: mock(() => {}),
		} as unknown as Logger;

		rewindFilesSpy = mock(async () => ({
			canRewind: true,
			filesChanged: ['file1.ts', 'file2.ts'],
			insertions: 10,
			deletions: 5,
		}));
		mockQueryObject = {
			rewindFiles: rewindFilesSpy,
		} as unknown as Query;
	});

	function createContext(overrides: Partial<RewindHandlerContext> = {}): RewindHandlerContext {
		return {
			session: mockSession,
			db: mockDb,
			daemonHub: mockDaemonHub,
			checkpointTracker: mockCheckpointTracker,
			lifecycleManager: mockLifecycleManager,
			logger: mockLogger,
			queryObject: mockQueryObject,
			firstMessageReceived: true,
			...overrides,
		};
	}

	function createHandler(overrides: Partial<RewindHandlerContext> = {}): RewindHandler {
		return new RewindHandler(createContext(overrides));
	}

	describe('constructor', () => {
		it('should create handler with context', () => {
			handler = createHandler();
			expect(handler).toBeDefined();
		});
	});

	describe('getCheckpoints', () => {
		it('should delegate to checkpointTracker', () => {
			handler = createHandler();
			const checkpoints = handler.getCheckpoints();

			expect(getCheckpointsSpy).toHaveBeenCalled();
			expect(checkpoints).toEqual([testCheckpoint]);
		});
	});

	describe('previewRewind', () => {
		it('should return error when checkpoint not found', async () => {
			handler = createHandler();
			const result = await handler.previewRewind('nonexistent-id');

			expect(result.canRewind).toBe(false);
			expect(result.error).toContain('not found');
		});

		it('should return error when SDK query not active', async () => {
			handler = createHandler({ queryObject: null });
			const result = await handler.previewRewind(testCheckpoint.id);

			expect(result.canRewind).toBe(false);
			expect(result.error).toContain('SDK query not active');
		});

		it('should return error when transport not ready', async () => {
			handler = createHandler({ firstMessageReceived: false });
			const result = await handler.previewRewind(testCheckpoint.id);

			expect(result.canRewind).toBe(false);
			expect(result.error).toContain('SDK not ready');
		});

		it('should call SDK rewindFiles with dryRun option', async () => {
			handler = createHandler();
			await handler.previewRewind(testCheckpoint.id);

			expect(rewindFilesSpy).toHaveBeenCalledWith(testCheckpoint.id, { dryRun: true });
		});

		it('should return SDK result on success', async () => {
			handler = createHandler();
			const result = await handler.previewRewind(testCheckpoint.id);

			expect(result.canRewind).toBe(true);
			expect(result.filesChanged).toEqual(['file1.ts', 'file2.ts']);
			expect(result.insertions).toBe(10);
			expect(result.deletions).toBe(5);
		});

		it('should handle SDK errors gracefully', async () => {
			rewindFilesSpy.mockRejectedValue(new Error('SDK error'));
			handler = createHandler();
			const result = await handler.previewRewind(testCheckpoint.id);

			expect(result.canRewind).toBe(false);
			expect(result.error).toBe('SDK error');
			expect(mockLogger.error).toHaveBeenCalledWith('Rewind preview failed:', expect.any(Error));
		});

		it('should handle non-Error exceptions in preview', async () => {
			rewindFilesSpy.mockRejectedValue('String error');
			handler = createHandler();
			const result = await handler.previewRewind(testCheckpoint.id);

			expect(result.canRewind).toBe(false);
			expect(result.error).toBe('Unknown error');
		});
	});

	describe('executeRewind', () => {
		describe('files mode', () => {
			it('should emit rewind.started event', async () => {
				handler = createHandler();
				await handler.executeRewind(testCheckpoint.id, 'files');

				expect(emitSpy).toHaveBeenCalledWith('rewind.started', {
					sessionId: mockSession.id,
					checkpointId: testCheckpoint.id,
					mode: 'files',
				});
			});

			it('should call SDK rewindFiles without dryRun', async () => {
				handler = createHandler();
				await handler.executeRewind(testCheckpoint.id, 'files');

				expect(rewindFilesSpy).toHaveBeenCalledWith(testCheckpoint.id);
			});

			it('should emit rewind.completed on success', async () => {
				handler = createHandler();
				await handler.executeRewind(testCheckpoint.id, 'files');

				expect(emitSpy).toHaveBeenCalledWith('rewind.completed', {
					sessionId: mockSession.id,
					checkpointId: testCheckpoint.id,
					mode: 'files',
					result: {
						success: true,
						filesChanged: ['file1.ts', 'file2.ts'],
						insertions: 10,
						deletions: 5,
					},
				});
			});

			it('should emit rewind.failed when SDK returns canRewind false', async () => {
				rewindFilesSpy.mockResolvedValue({ canRewind: false, error: 'Cannot rewind' });
				handler = createHandler();
				const result = await handler.executeRewind(testCheckpoint.id, 'files');

				expect(result.success).toBe(false);
				expect(result.error).toBe('Cannot rewind');
				expect(emitSpy).toHaveBeenCalledWith('rewind.failed', {
					sessionId: mockSession.id,
					checkpointId: testCheckpoint.id,
					mode: 'files',
					error: 'Cannot rewind',
				});
			});

			it('should return success with file changes', async () => {
				handler = createHandler();
				const result = await handler.executeRewind(testCheckpoint.id, 'files');

				expect(result.success).toBe(true);
				expect(result.filesChanged).toEqual(['file1.ts', 'file2.ts']);
			});
		});

		describe('conversation mode', () => {
			it('should delete messages from DB', async () => {
				handler = createHandler();
				await handler.executeRewind(testCheckpoint.id, 'conversation');

				expect(deleteMessagesAfterSpy).toHaveBeenCalledWith(
					mockSession.id,
					testCheckpoint.timestamp
				);
			});

			it('should set resumeSessionAt in metadata and persist to DB', async () => {
				handler = createHandler();
				await handler.executeRewind(testCheckpoint.id, 'conversation');

				expect(mockSession.metadata.resumeSessionAt).toBe(testCheckpoint.id);
				expect(updateSessionSpy).toHaveBeenCalledWith(mockSession.id, {
					metadata: mockSession.metadata,
				});
			});

			it('should rewind checkpoint tracker', async () => {
				handler = createHandler();
				await handler.executeRewind(testCheckpoint.id, 'conversation');

				expect(rewindToSpy).toHaveBeenCalledWith(testCheckpoint.id);
			});

			it('should restart query', async () => {
				handler = createHandler();
				await handler.executeRewind(testCheckpoint.id, 'conversation');

				expect(restartSpy).toHaveBeenCalled();
			});

			it('should return success with conversation rewound', async () => {
				handler = createHandler();
				const result = await handler.executeRewind(testCheckpoint.id, 'conversation');

				expect(result.success).toBe(true);
				expect(result.conversationRewound).toBe(true);
				expect(result.messagesDeleted).toBe(5);
			});
		});

		describe('both mode', () => {
			it('should rewind files first', async () => {
				handler = createHandler();
				await handler.executeRewind(testCheckpoint.id, 'both');

				expect(rewindFilesSpy).toHaveBeenCalledWith(testCheckpoint.id);
			});

			it('should rewind conversation after files succeed', async () => {
				handler = createHandler();
				await handler.executeRewind(testCheckpoint.id, 'both');

				expect(deleteMessagesAfterSpy).toHaveBeenCalled();
				expect(restartSpy).toHaveBeenCalled();
			});

			it('should return combined result', async () => {
				handler = createHandler();
				const result = await handler.executeRewind(testCheckpoint.id, 'both');

				expect(result.success).toBe(true);
				expect(result.filesChanged).toEqual(['file1.ts', 'file2.ts']);
				expect(result.conversationRewound).toBe(true);
				expect(result.messagesDeleted).toBe(5);
			});

			it('should fail if file rewind fails', async () => {
				rewindFilesSpy.mockResolvedValue({ canRewind: false, error: 'File rewind failed' });
				handler = createHandler();
				const result = await handler.executeRewind(testCheckpoint.id, 'both');

				expect(result.success).toBe(false);
				expect(result.error).toBe('File rewind failed');
				expect(deleteMessagesAfterSpy).not.toHaveBeenCalled();
			});
		});

		describe('error handling', () => {
			it('should return error when checkpoint not found', async () => {
				handler = createHandler();
				const result = await handler.executeRewind('nonexistent-id', 'files');

				expect(result.success).toBe(false);
				expect(result.error).toContain('not found');
			});

			it('should return error when SDK query not active', async () => {
				handler = createHandler({ queryObject: null });
				const result = await handler.executeRewind(testCheckpoint.id, 'files');

				expect(result.success).toBe(false);
				expect(result.error).toContain('SDK query not active');
			});

			it('should return error when firstMessageReceived is false', async () => {
				handler = createHandler({ firstMessageReceived: false });
				const result = await handler.executeRewind(testCheckpoint.id, 'files');

				expect(result.success).toBe(false);
				expect(result.error).toContain('SDK not ready');
			});

			it('should use default error message when SDK returns no error message for files mode', async () => {
				rewindFilesSpy.mockResolvedValue({ canRewind: false });
				handler = createHandler();
				const result = await handler.executeRewind(testCheckpoint.id, 'files');

				expect(result.success).toBe(false);
				expect(emitSpy).toHaveBeenCalledWith('rewind.failed', {
					sessionId: mockSession.id,
					checkpointId: testCheckpoint.id,
					mode: 'files',
					error: 'Rewind failed',
				});
			});

			it('should use default error message when SDK returns no error message for both mode', async () => {
				rewindFilesSpy.mockResolvedValue({ canRewind: false });
				handler = createHandler();
				const result = await handler.executeRewind(testCheckpoint.id, 'both');

				expect(result.success).toBe(false);
				expect(emitSpy).toHaveBeenCalledWith('rewind.failed', {
					sessionId: mockSession.id,
					checkpointId: testCheckpoint.id,
					mode: 'both',
					error: 'File rewind failed',
				});
			});

			it('should handle exceptions and emit rewind.failed', async () => {
				rewindFilesSpy.mockRejectedValue(new Error('Unexpected error'));
				handler = createHandler();
				const result = await handler.executeRewind(testCheckpoint.id, 'files');

				expect(result.success).toBe(false);
				expect(result.error).toBe('Unexpected error');
				expect(emitSpy).toHaveBeenCalledWith('rewind.failed', {
					sessionId: mockSession.id,
					checkpointId: testCheckpoint.id,
					mode: 'files',
					error: 'Unexpected error',
				});
			});

			it('should handle non-Error exceptions and emit rewind.failed', async () => {
				rewindFilesSpy.mockRejectedValue('String error');
				handler = createHandler();
				const result = await handler.executeRewind(testCheckpoint.id, 'files');

				expect(result.success).toBe(false);
				expect(result.error).toBe('Unknown error');
				expect(emitSpy).toHaveBeenCalledWith('rewind.failed', {
					sessionId: mockSession.id,
					checkpointId: testCheckpoint.id,
					mode: 'files',
					error: 'Unknown error',
				});
			});
		});
	});
});
