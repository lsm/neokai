/**
 * RewindHandler Tests
 *
 * Tests for rewind operations (preview and execute).
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type { Session } from '@neokai/shared';
import type { QueryLifecycleManager } from '../../../src/lib/agent/query-lifecycle-manager';
import {
	RewindHandler,
	type RewindHandlerContext,
	type RewindPoint,
} from '../../../src/lib/agent/rewind-handler';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { Logger } from '../../../src/lib/logger';
import type { Database } from '../../../src/storage/database';

describe('RewindHandler', () => {
	let handler: RewindHandler;
	let mockSession: Session;
	let mockDb: Database;
	let mockDaemonHub: DaemonHub;
	let mockLifecycleManager: QueryLifecycleManager;
	let mockLogger: Logger;
	let mockQueryObject: Query | null;

	let emitSpy: ReturnType<typeof mock>;
	let getUserMessagesSpy: ReturnType<typeof mock>;
	let getUserMessageByUuidSpy: ReturnType<typeof mock>;
	let countMessagesAfterSpy: ReturnType<typeof mock>;
	let restartSpy: ReturnType<typeof mock>;
	let deleteMessagesAfterSpy: ReturnType<typeof mock>;
	let deleteMessagesAtAndAfterSpy: ReturnType<typeof mock>;
	let rewindFilesSpy: ReturnType<typeof mock>;
	let updateSessionSpy: ReturnType<typeof mock>;

	const testTimestamp = Date.now();
	const testRewindPoint: RewindPoint = {
		uuid: 'message-uuid-123',
		content: 'Test message',
		turnNumber: 1,
		timestamp: testTimestamp,
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
		deleteMessagesAtAndAfterSpy = mock(() => 5);
		updateSessionSpy = mock(() => {});
		getUserMessagesSpy = mock(() => [
			{
				uuid: testRewindPoint.uuid,
				content: testRewindPoint.content,
				timestamp: testRewindPoint.timestamp,
			},
		]);
		getUserMessageByUuidSpy = mock((_sessionId: string, uuid: string) =>
			uuid === testRewindPoint.uuid ? testRewindPoint : undefined
		);
		countMessagesAfterSpy = mock(() => 5);
		mockDb = {
			deleteMessagesAfter: deleteMessagesAfterSpy,
			deleteMessagesAtAndAfter: deleteMessagesAtAndAfterSpy,
			updateSession: updateSessionSpy,
			getUserMessages: getUserMessagesSpy,
			getUserMessageByUuid: getUserMessageByUuidSpy,
			countMessagesAfter: countMessagesAfterSpy,
			getSDKMessages: mock(() => []),
		} as unknown as Database;

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

	describe('getRewindPoints', () => {
		it('should get user messages from DB and add turn numbers', () => {
			handler = createHandler();
			const rewindPoints = handler.getRewindPoints();

			expect(getUserMessagesSpy).toHaveBeenCalledWith(mockSession.id);
			expect(rewindPoints).toEqual([
				{
					uuid: testRewindPoint.uuid,
					content: testRewindPoint.content,
					timestamp: testRewindPoint.timestamp,
					turnNumber: 1,
				},
			]);
		});

		it('should reverse the order so newest is first', () => {
			getUserMessagesSpy.mockReturnValue([
				{
					uuid: 'msg-1',
					content: 'First',
					timestamp: 1000,
				},
				{
					uuid: 'msg-2',
					content: 'Second',
					timestamp: 2000,
				},
				{
					uuid: 'msg-3',
					content: 'Third',
					timestamp: 3000,
				},
			]);

			handler = createHandler();
			const rewindPoints = handler.getRewindPoints();

			expect(rewindPoints).toHaveLength(3);
			expect(rewindPoints[0].uuid).toBe('msg-3'); // Newest first
			expect(rewindPoints[0].turnNumber).toBe(3);
			expect(rewindPoints[2].uuid).toBe('msg-1');
			expect(rewindPoints[2].turnNumber).toBe(1);
		});
	});

	describe('getRewindPoint', () => {
		it('should get specific message by UUID', () => {
			handler = createHandler();
			const rewindPoint = handler.getRewindPoint(testRewindPoint.uuid);

			expect(getUserMessageByUuidSpy).toHaveBeenCalledWith(mockSession.id, testRewindPoint.uuid);
			expect(rewindPoint).toEqual(testRewindPoint);
		});

		it('should return undefined for non-existent UUID', () => {
			handler = createHandler();
			const rewindPoint = handler.getRewindPoint('non-existent');

			expect(rewindPoint).toBeUndefined();
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
			const result = await handler.previewRewind(testRewindPoint.uuid);

			expect(result.canRewind).toBe(false);
			expect(result.error).toContain('SDK query not active');
		});

		it('should return error when transport not ready', async () => {
			handler = createHandler({ firstMessageReceived: false });
			const result = await handler.previewRewind(testRewindPoint.uuid);

			expect(result.canRewind).toBe(false);
			expect(result.error).toContain('SDK not ready');
		});

		it('should call SDK rewindFiles with dryRun option', async () => {
			handler = createHandler();
			await handler.previewRewind(testRewindPoint.uuid);

			expect(rewindFilesSpy).toHaveBeenCalledWith(testRewindPoint.uuid, { dryRun: true });
		});

		it('should include messages affected count from DB', async () => {
			handler = createHandler();
			const result = await handler.previewRewind(testRewindPoint.uuid);

			expect(countMessagesAfterSpy).toHaveBeenCalledWith(mockSession.id, testTimestamp);
			expect(result.messagesAffected).toBe(5);
		});

		it('should return SDK result on success', async () => {
			handler = createHandler();
			const result = await handler.previewRewind(testRewindPoint.uuid);

			expect(result.canRewind).toBe(true);
			expect(result.filesChanged).toEqual(['file1.ts', 'file2.ts']);
			expect(result.insertions).toBe(10);
			expect(result.deletions).toBe(5);
			expect(result.messagesAffected).toBe(5);
		});

		it('should handle SDK errors gracefully', async () => {
			rewindFilesSpy.mockRejectedValue(new Error('SDK error'));
			handler = createHandler();
			const result = await handler.previewRewind(testRewindPoint.uuid);

			expect(result.canRewind).toBe(false);
			expect(result.error).toBe('SDK error');
			expect(mockLogger.error).toHaveBeenCalledWith('Rewind preview failed:', expect.any(Error));
		});

		it('should handle non-Error exceptions in preview', async () => {
			rewindFilesSpy.mockRejectedValue('String error');
			handler = createHandler();
			const result = await handler.previewRewind(testRewindPoint.uuid);

			expect(result.canRewind).toBe(false);
			expect(result.error).toBe('Unknown error');
		});
	});

	describe('executeRewind', () => {
		describe('files mode', () => {
			it('should emit rewind.started event', async () => {
				handler = createHandler();
				await handler.executeRewind(testRewindPoint.uuid, 'files');

				expect(emitSpy).toHaveBeenCalledWith('rewind.started', {
					sessionId: mockSession.id,
					checkpointId: testRewindPoint.uuid,
					mode: 'files',
				});
			});

			it('should call SDK rewindFiles without dryRun', async () => {
				handler = createHandler();
				await handler.executeRewind(testRewindPoint.uuid, 'files');

				expect(rewindFilesSpy).toHaveBeenCalledWith(testRewindPoint.uuid);
			});

			it('should emit rewind.completed on success', async () => {
				handler = createHandler();
				await handler.executeRewind(testRewindPoint.uuid, 'files');

				expect(emitSpy).toHaveBeenCalledWith('rewind.completed', {
					sessionId: mockSession.id,
					checkpointId: testRewindPoint.uuid,
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
				const result = await handler.executeRewind(testRewindPoint.uuid, 'files');

				expect(result.success).toBe(false);
				expect(result.error).toBe('Cannot rewind');
				expect(emitSpy).toHaveBeenCalledWith('rewind.failed', {
					sessionId: mockSession.id,
					checkpointId: testRewindPoint.uuid,
					mode: 'files',
					error: 'Cannot rewind',
				});
			});

			it('should return success with file changes', async () => {
				handler = createHandler();
				const result = await handler.executeRewind(testRewindPoint.uuid, 'files');

				expect(result.success).toBe(true);
				expect(result.filesChanged).toEqual(['file1.ts', 'file2.ts']);
			});
		});

		describe('conversation mode', () => {
			it('should delete messages from DB', async () => {
				handler = createHandler();
				await handler.executeRewind(testRewindPoint.uuid, 'conversation');

				expect(deleteMessagesAtAndAfterSpy).toHaveBeenCalledWith(mockSession.id, testTimestamp);
			});

			it('should set resumeSessionAt to previous user message after deletion', async () => {
				const previousMessage = {
					uuid: 'prev-msg-uuid',
					timestamp: testTimestamp - 10000,
					content: 'Previous message',
				};
				// getUserMessages is called AFTER deleteMessagesAtAndAfter, so it should return only remaining messages
				getUserMessagesSpy.mockReturnValue([previousMessage]);

				handler = createHandler();
				await handler.executeRewind(testRewindPoint.uuid, 'conversation');

				expect(mockSession.metadata.resumeSessionAt).toBe('prev-msg-uuid');
				expect(updateSessionSpy).toHaveBeenCalledWith(mockSession.id, {
					metadata: mockSession.metadata,
				});
			});

			it('should clear resumeSessionAt when no previous user message exists', async () => {
				// After deleting the only user message, getUserMessages returns empty
				getUserMessagesSpy.mockReturnValue([]);

				handler = createHandler();
				await handler.executeRewind(testRewindPoint.uuid, 'conversation');

				expect(mockSession.metadata.resumeSessionAt).toBeUndefined();
				expect(updateSessionSpy).toHaveBeenCalledWith(mockSession.id, {
					metadata: mockSession.metadata,
				});
			});

			it('should restart query', async () => {
				handler = createHandler();
				await handler.executeRewind(testRewindPoint.uuid, 'conversation');

				expect(restartSpy).toHaveBeenCalled();
			});

			it('should return success with conversation rewound', async () => {
				handler = createHandler();
				const result = await handler.executeRewind(testRewindPoint.uuid, 'conversation');

				expect(result.success).toBe(true);
				expect(result.conversationRewound).toBe(true);
				expect(result.messagesDeleted).toBe(5);
			});
		});

		describe('both mode', () => {
			it('should rewind files first', async () => {
				handler = createHandler();
				await handler.executeRewind(testRewindPoint.uuid, 'both');

				expect(rewindFilesSpy).toHaveBeenCalledWith(testRewindPoint.uuid);
			});

			it('should rewind conversation after files succeed', async () => {
				handler = createHandler();
				await handler.executeRewind(testRewindPoint.uuid, 'both');

				expect(deleteMessagesAtAndAfterSpy).toHaveBeenCalled();
				expect(restartSpy).toHaveBeenCalled();
			});

			it('should return combined result', async () => {
				handler = createHandler();
				const result = await handler.executeRewind(testRewindPoint.uuid, 'both');

				expect(result.success).toBe(true);
				expect(result.filesChanged).toEqual(['file1.ts', 'file2.ts']);
				expect(result.conversationRewound).toBe(true);
				expect(result.messagesDeleted).toBe(5);
			});

			it('should proceed with conversation rewind even if file rewind fails', async () => {
				rewindFilesSpy.mockResolvedValue({ canRewind: false, error: 'File rewind failed' });
				handler = createHandler();
				const result = await handler.executeRewind(testRewindPoint.uuid, 'both');

				// File rewind is best-effort - conversation rewind should still proceed
				expect(result.success).toBe(true);
				expect(result.conversationRewound).toBe(true);
				expect(deleteMessagesAtAndAfterSpy).toHaveBeenCalled();
				expect(result.filesChanged).toBeUndefined(); // No files changed since file rewind failed
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
				const result = await handler.executeRewind(testRewindPoint.uuid, 'files');

				expect(result.success).toBe(false);
				expect(result.error).toContain('SDK query not active');
			});

			it('should return error when firstMessageReceived is false', async () => {
				handler = createHandler({ firstMessageReceived: false });
				const result = await handler.executeRewind(testRewindPoint.uuid, 'files');

				expect(result.success).toBe(false);
				expect(result.error).toContain('SDK not ready');
			});

			it('should use default error message when SDK returns no error message for files mode', async () => {
				rewindFilesSpy.mockResolvedValue({ canRewind: false });
				handler = createHandler();
				const result = await handler.executeRewind(testRewindPoint.uuid, 'files');

				expect(result.success).toBe(false);
				expect(emitSpy).toHaveBeenCalledWith('rewind.failed', {
					sessionId: mockSession.id,
					checkpointId: testRewindPoint.uuid,
					mode: 'files',
					error: 'Rewind failed',
				});
			});

			it('should proceed with conversation rewind when file rewind returns no error for both mode', async () => {
				rewindFilesSpy.mockResolvedValue({ canRewind: false });
				handler = createHandler();
				const result = await handler.executeRewind(testRewindPoint.uuid, 'both');

				// Best-effort: conversation rewind succeeds even when file rewind fails
				expect(result.success).toBe(true);
				expect(result.conversationRewound).toBe(true);
				expect(emitSpy).toHaveBeenCalledWith(
					'rewind.completed',
					expect.objectContaining({
						sessionId: mockSession.id,
						checkpointId: testRewindPoint.uuid,
						mode: 'both',
					})
				);
			});

			it('should handle exceptions and emit rewind.failed', async () => {
				rewindFilesSpy.mockRejectedValue(new Error('Unexpected error'));
				handler = createHandler();
				const result = await handler.executeRewind(testRewindPoint.uuid, 'files');

				expect(result.success).toBe(false);
				expect(result.error).toBe('Unexpected error');
				expect(emitSpy).toHaveBeenCalledWith('rewind.failed', {
					sessionId: mockSession.id,
					checkpointId: testRewindPoint.uuid,
					mode: 'files',
					error: 'Unexpected error',
				});
			});

			it('should handle non-Error exceptions and emit rewind.failed', async () => {
				rewindFilesSpy.mockRejectedValue('String error');
				handler = createHandler();
				const result = await handler.executeRewind(testRewindPoint.uuid, 'files');

				expect(result.success).toBe(false);
				expect(result.error).toBe('Unknown error');
				expect(emitSpy).toHaveBeenCalledWith('rewind.failed', {
					sessionId: mockSession.id,
					checkpointId: testRewindPoint.uuid,
					mode: 'files',
					error: 'Unknown error',
				});
			});
		});
	});

	describe('previewSelectiveRewind', () => {
		it('should return error when SDK query not active', async () => {
			handler = createHandler({ queryObject: null });
			const result = await handler.previewSelectiveRewind([testRewindPoint.uuid]);

			expect(result.canRewind).toBe(false);
			expect(result.error).toContain('SDK query not active');
		});

		it('should return error when firstMessageReceived is false', async () => {
			handler = createHandler({ firstMessageReceived: false });
			const result = await handler.previewSelectiveRewind([testRewindPoint.uuid]);

			expect(result.canRewind).toBe(false);
			expect(result.error).toContain('SDK not ready');
		});

		it('should return error when no valid messages found', async () => {
			mockDb.getSDKMessages = mock(() => [{ uuid: 'different-uuid', timestamp: 1000 }]);
			handler = createHandler();
			const result = await handler.previewSelectiveRewind([testRewindPoint.uuid]);

			expect(result.canRewind).toBe(false);
			expect(result.error).toBe('No valid messages found');
		});

		it('should count messages to delete and preview file changes', async () => {
			mockDb.getSDKMessages = mock(() => [
				{ uuid: testRewindPoint.uuid, timestamp: testTimestamp },
				{ uuid: 'msg-2', timestamp: testTimestamp + 1000 },
				{ uuid: 'msg-3', timestamp: testTimestamp + 2000 },
			]);

			handler = createHandler();
			const result = await handler.previewSelectiveRewind([testRewindPoint.uuid]);

			expect(result.canRewind).toBe(true);
			expect(result.messagesToDelete).toBe(2); // Messages after the first
			expect(result.filesToRevert).toEqual([
				{ path: 'file1.ts', hasCheckpoint: true, hasEditDiff: false },
				{ path: 'file2.ts', hasCheckpoint: true, hasEditDiff: false },
			]);
		});
	});

	describe('executeSelectiveRewind', () => {
		it('should return error when SDK query not active', async () => {
			handler = createHandler({ queryObject: null });
			const result = await handler.executeSelectiveRewind([testRewindPoint.uuid]);

			expect(result.success).toBe(false);
			expect(result.error).toContain('SDK query not active');
		});

		it('should return error when firstMessageReceived is false', async () => {
			handler = createHandler({ firstMessageReceived: false });
			const result = await handler.executeSelectiveRewind([testRewindPoint.uuid]);

			expect(result.success).toBe(false);
			expect(result.error).toContain('SDK not ready');
		});

		it('should rewind files, delete messages, and restart query', async () => {
			mockDb.getSDKMessages = mock(() => [
				{ uuid: testRewindPoint.uuid, timestamp: testTimestamp },
				{ uuid: 'msg-2', timestamp: testTimestamp + 1000 },
			]);

			handler = createHandler();
			const result = await handler.executeSelectiveRewind([testRewindPoint.uuid]);

			expect(rewindFilesSpy).toHaveBeenCalledWith(testRewindPoint.uuid);
			expect(deleteMessagesAtAndAfterSpy).toHaveBeenCalledWith(mockSession.id, testTimestamp);
			expect(restartSpy).toHaveBeenCalled();
			expect(result.success).toBe(true);
		});

		it('should set resumeSessionAt to previous user message after selective rewind', async () => {
			const previousMessage = {
				uuid: 'prev-msg-uuid',
				timestamp: testTimestamp - 10000,
				content: 'Previous message',
			};
			mockDb.getSDKMessages = mock(() => [
				{ uuid: testRewindPoint.uuid, timestamp: testTimestamp },
			]);
			// After deletion, getUserMessages returns only the previous message
			getUserMessagesSpy.mockReturnValue([previousMessage]);

			handler = createHandler();
			await handler.executeSelectiveRewind([testRewindPoint.uuid]);

			expect(mockSession.metadata.resumeSessionAt).toBe('prev-msg-uuid');
			expect(updateSessionSpy).toHaveBeenCalled();
		});
	});
});
