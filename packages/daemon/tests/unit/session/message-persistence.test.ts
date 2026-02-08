/**
 * Message Persistence Tests
 *
 * Tests for user message persistence and broadcasting.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { MessagePersistence } from '../../../src/lib/session/message-persistence';
import type { MessageHub, Session } from '@neokai/shared';
import type { Database } from '../../../src/storage/database';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { SessionCache } from '../../../src/lib/session/session-cache';

describe('MessagePersistence', () => {
	let mockSessionCache: SessionCache;
	let mockDb: Database;
	let mockMessageHub: MessageHub;
	let mockEventBus: DaemonHub;
	let persistence: MessagePersistence;
	let mockAgentSession: {
		getSessionData: ReturnType<typeof mock>;
	};
	let mockSession: Session;

	beforeEach(() => {
		// Mock session data
		mockSession = {
			id: 'test-session-id',
			title: 'Test Session',
			workspacePath: '/test/workspace',
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: 'active',
			config: {
				model: 'claude-sonnet-4-20250514',
				maxTokens: 8192,
				temperature: 1.0,
			},
			metadata: {
				messageCount: 0,
				totalTokens: 0,
				inputTokens: 0,
				outputTokens: 0,
				totalCost: 0,
				toolCallCount: 0,
				titleGenerated: true,
			},
		};

		// Mock AgentSession
		mockAgentSession = {
			getSessionData: mock(() => mockSession),
		};

		// Mock SessionCache
		mockSessionCache = {
			getAsync: mock(async () => mockAgentSession),
		} as unknown as SessionCache;

		// Mock Database
		mockDb = {
			saveSDKMessage: mock(() => true),
		} as unknown as Database;

		// Mock MessageHub
		mockMessageHub = {
			event: mock(async () => {}),
			onQuery: mock((_method: string, _handler: Function) => () => {}),
			onCommand: mock((_method: string, _handler: Function) => () => {}),
			query: mock(async () => ({})),
			command: mock(async () => {}),
		} as unknown as MessageHub;

		// Mock EventBus
		mockEventBus = {
			emit: mock(async () => {}),
		} as unknown as DaemonHub;

		persistence = new MessagePersistence(mockSessionCache, mockDb, mockMessageHub, mockEventBus);
	});

	describe('persist', () => {
		it('should persist a simple text message', async () => {
			await persistence.persist({
				sessionId: 'test-session-id',
				messageId: 'msg-123',
				content: 'Hello, world!',
			});

			expect(mockSessionCache.getAsync).toHaveBeenCalledWith('test-session-id');
			expect(mockDb.saveSDKMessage).toHaveBeenCalled();
			expect(mockMessageHub.event).toHaveBeenCalled();
			expect(mockEventBus.emit).toHaveBeenCalledWith(
				'message.persisted',
				expect.objectContaining({
					sessionId: 'test-session-id',
					messageId: 'msg-123',
				})
			);
		});

		it('should throw error if session not found', async () => {
			(mockSessionCache.getAsync as ReturnType<typeof mock>).mockResolvedValue(null);

			await expect(
				persistence.persist({
					sessionId: 'nonexistent',
					messageId: 'msg-123',
					content: 'Hello',
				})
			).rejects.toThrow('Session nonexistent not found');
		});

		it('should validate image size', async () => {
			// Create a base64 string > 5MB
			const largeData = 'x'.repeat(6 * 1024 * 1024);

			await expect(
				persistence.persist({
					sessionId: 'test-session-id',
					messageId: 'msg-123',
					content: 'Check this image',
					images: [
						{
							media_type: 'image/png',
							data: largeData,
						},
					],
				})
			).rejects.toThrow('exceeds API limit');
		});

		it('should accept images within size limit', async () => {
			const smallData = 'x'.repeat(1000);

			await persistence.persist({
				sessionId: 'test-session-id',
				messageId: 'msg-123',
				content: 'Check this image',
				images: [
					{
						media_type: 'image/png',
						data: smallData,
					},
				],
			});

			expect(mockDb.saveSDKMessage).toHaveBeenCalled();
		});

		it('should expand built-in commands', async () => {
			await persistence.persist({
				sessionId: 'test-session-id',
				messageId: 'msg-123',
				content: '/merge-session',
			});

			// Should save and emit event
			expect(mockDb.saveSDKMessage).toHaveBeenCalled();
			expect(mockEventBus.emit).toHaveBeenCalled();
		});

		it('should set needsWorkspaceInit flag when title not generated', async () => {
			mockSession.metadata.titleGenerated = false;

			await persistence.persist({
				sessionId: 'test-session-id',
				messageId: 'msg-123',
				content: 'First message',
			});

			expect(mockEventBus.emit).toHaveBeenCalledWith(
				'message.persisted',
				expect.objectContaining({
					needsWorkspaceInit: true,
				})
			);
		});

		it('should set hasDraftToClear when content matches input draft', async () => {
			mockSession.metadata.inputDraft = 'draft content';

			await persistence.persist({
				sessionId: 'test-session-id',
				messageId: 'msg-123',
				content: 'draft content',
			});

			expect(mockEventBus.emit).toHaveBeenCalledWith(
				'message.persisted',
				expect.objectContaining({
					hasDraftToClear: true,
				})
			);
		});

		it('should publish to state.sdkMessages.delta channel', async () => {
			await persistence.persist({
				sessionId: 'test-session-id',
				messageId: 'msg-123',
				content: 'Hello',
			});

			expect(mockMessageHub.event).toHaveBeenCalledWith(
				'state.sdkMessages.delta',
				expect.objectContaining({
					added: expect.any(Array),
					timestamp: expect.any(Number),
				}),
				{ sessionId: 'test-session-id' }
			);
		});
	});
});
