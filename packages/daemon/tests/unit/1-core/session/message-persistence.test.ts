/**
 * Message Persistence Tests
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MessageHub, Session } from '@neokai/shared';
import type { Database } from '../../../../src/storage/database';
import type { DaemonHub } from '../../../../src/lib/daemon-hub';
import { MessagePersistence } from '../../../../src/lib/session/message-persistence';
import type { SessionCache } from '../../../../src/lib/session/session-cache';

describe('MessagePersistence', () => {
	let mockSessionCache: SessionCache;
	let mockDb: Database;
	let mockMessageHub: MessageHub;
	let mockEventBus: DaemonHub;
	let persistence: MessagePersistence;
	let mockSession: Session;
	let mockAgentSession: {
		getSessionData: ReturnType<typeof mock>;
		getProcessingState: ReturnType<typeof mock>;
		startQueryAndEnqueue: ReturnType<typeof mock>;
	};

	let saveUserMessageSpy: ReturnType<typeof mock>;
	let messageHubEventSpy: ReturnType<typeof mock>;
	let eventBusEmitSpy: ReturnType<typeof mock>;
	let processingStateSpy: ReturnType<typeof mock>;

	beforeEach(() => {
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
				queryMode: 'immediate',
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

		processingStateSpy = mock(() => ({ status: 'idle' }));
		mockAgentSession = {
			getSessionData: mock(() => mockSession),
			getProcessingState: processingStateSpy,
			startQueryAndEnqueue: mock(async () => {}),
		};

		mockSessionCache = {
			getAsync: mock(async () => mockAgentSession),
		} as unknown as SessionCache;

		saveUserMessageSpy = mock(() => 'db-msg-1');
		mockDb = {
			saveUserMessage: saveUserMessageSpy,
		} as unknown as Database;

		messageHubEventSpy = mock(async () => {});
		mockMessageHub = {
			event: messageHubEventSpy,
			onRequest: mock((_method: string, _handler: Function) => () => {}),
			query: mock(async () => ({})),
			command: mock(async () => {}),
		} as unknown as MessageHub;

		eventBusEmitSpy = mock(async () => {});
		mockEventBus = {
			emit: eventBusEmitSpy,
		} as unknown as DaemonHub;

		persistence = new MessagePersistence(mockSessionCache, mockDb, mockMessageHub, mockEventBus);
	});

	it('persists idle immediate as enqueued and waits for SDK queue consumption', async () => {
		await persistence.persist({
			sessionId: 'test-session-id',
			messageId: 'msg-1',
			content: 'hello idle',
		});

		expect(saveUserMessageSpy).toHaveBeenCalledWith(
			'test-session-id',
			expect.objectContaining({ uuid: 'msg-1', type: 'user' }),
			'enqueued',
			undefined
		);
		expect(messageHubEventSpy).not.toHaveBeenCalled();
		expect(mockAgentSession.startQueryAndEnqueue).toHaveBeenCalledWith('msg-1', 'hello idle');
		expect(eventBusEmitSpy).toHaveBeenCalledWith('messages.statusChanged', {
			sessionId: 'test-session-id',
			messageIds: ['db-msg-1'],
			status: 'enqueued',
		});
		expect(eventBusEmitSpy).toHaveBeenCalledWith(
			'message.persisted',
			expect.objectContaining({
				sessionId: 'test-session-id',
				messageId: 'msg-1',
				sendStatus: 'enqueued',
				deliveryMode: 'immediate',
				skipQueryStart: true,
			})
		);
	});

	it('persists busy immediate as enqueued and does not immediately echo', async () => {
		processingStateSpy.mockReturnValue({ status: 'processing' });

		await persistence.persist({
			sessionId: 'test-session-id',
			messageId: 'msg-2',
			content: 'hello busy',
		});

		expect(saveUserMessageSpy).toHaveBeenCalledWith(
			'test-session-id',
			expect.objectContaining({ uuid: 'msg-2', type: 'user' }),
			'enqueued',
			undefined
		);
		expect(messageHubEventSpy).not.toHaveBeenCalled();
		expect(mockAgentSession.startQueryAndEnqueue).toHaveBeenCalledWith('msg-2', 'hello busy');
		expect(eventBusEmitSpy).toHaveBeenCalledWith(
			'message.persisted',
			expect.objectContaining({
				messageId: 'msg-2',
				sendStatus: 'enqueued',
				deliveryMode: 'immediate',
				skipQueryStart: true,
			})
		);
	});

	it('persists busy defer as deferred and does not dispatch', async () => {
		processingStateSpy.mockReturnValue({ status: 'processing' });

		await persistence.persist({
			sessionId: 'test-session-id',
			messageId: 'msg-3',
			content: 'next turn please',
			deliveryMode: 'defer',
		});

		expect(saveUserMessageSpy).toHaveBeenCalledWith(
			'test-session-id',
			expect.objectContaining({ uuid: 'msg-3', type: 'user' }),
			'deferred',
			undefined
		);
		expect(eventBusEmitSpy).not.toHaveBeenCalledWith(
			'message.persisted',
			expect.objectContaining({ messageId: 'msg-3' })
		);
		expect(mockAgentSession.startQueryAndEnqueue).not.toHaveBeenCalled();
	});

	it('falls back idle defer to enqueued immediate and dispatches', async () => {
		processingStateSpy.mockReturnValue({ status: 'idle' });

		await persistence.persist({
			sessionId: 'test-session-id',
			messageId: 'msg-4',
			content: 'next turn while idle',
			deliveryMode: 'defer',
		});

		expect(saveUserMessageSpy).toHaveBeenCalledWith(
			'test-session-id',
			expect.objectContaining({ uuid: 'msg-4', type: 'user' }),
			'enqueued',
			undefined
		);
		expect(mockAgentSession.startQueryAndEnqueue).toHaveBeenCalledWith(
			'msg-4',
			'next turn while idle'
		);
		expect(eventBusEmitSpy).toHaveBeenCalledWith(
			'message.persisted',
			expect.objectContaining({
				messageId: 'msg-4',
				sendStatus: 'enqueued',
				deliveryMode: 'immediate',
				skipQueryStart: true,
			})
		);
	});
});
