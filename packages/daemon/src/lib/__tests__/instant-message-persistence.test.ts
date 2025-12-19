/**
 * Unit test for instant message persistence UX fix
 *
 * Verifies that user messages are saved to DB and published to UI
 * BEFORE workspace initialization, providing instant feedback.
 */

import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { AgentSession } from '../agent-session';
import { Database } from '../../storage/database';
import { EventBus } from '@liuboer/shared';
import type { MessageHub, Session } from '@liuboer/shared';
import { generateUUID } from '@liuboer/shared';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';

describe('Instant Message Persistence UX', () => {
	let db: Database;
	let messageHub: MessageHub;
	let eventBus: EventBus;
	let testDir: string;
	let session: Session;
	let agentSession: AgentSession;

	beforeEach(async () => {
		// Create temp directory for this test
		testDir = join(tmpdir(), `liuboer-test-${generateUUID()}`);
		mkdirSync(testDir, { recursive: true });

		// Initialize database
		const dbPath = join(testDir, 'test.db');
		db = new Database(dbPath);
		await db.initialize();

		// Create mock MessageHub
		const publishedMessages: unknown[] = [];
		messageHub = {
			publish: mock(async (channel: string, data: unknown) => {
				publishedMessages.push({ channel, data });
			}),
			handle: mock(() => {}),
			call: mock(async () => ({})),
			subscribe: mock(() => () => {}),
			unsubscribe: mock(() => {}),
			on: mock(() => {}),
			close: mock(() => {}),
		} as unknown as MessageHub;

		// Track published messages for assertions
		(messageHub as unknown as { _publishedMessages: unknown[] })._publishedMessages =
			publishedMessages;

		// Create EventBus
		eventBus = new EventBus();

		// Create test session
		session = {
			id: generateUUID(),
			title: 'Test Session',
			workspacePath: join(testDir, 'workspace'),
			createdAt: new Date().toISOString(),
			lastActiveAt: new Date().toISOString(),
			status: 'active',
			config: {
				model: 'claude-sonnet-4-5-20250929',
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
				titleGenerated: false,
				workspaceInitialized: true, // Already initialized to avoid triggering workspace init
			},
		};

		// Create workspace directory
		mkdirSync(session.workspacePath, { recursive: true });

		// Save session to DB
		db.createSession(session);

		// Create mock SettingsManager
		const mockSettingsManager = {
			prepareSDKOptions: async () => ({}),
		} as unknown as import('../settings-manager').SettingsManager;

		// Create AgentSession
		agentSession = new AgentSession(
			session,
			db,
			messageHub,
			mockSettingsManager,
			eventBus,
			async () => null
		);
	});

	afterEach(() => {
		// Cleanup
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test('persistAndQueueMessage saves to DB and publishes to UI immediately', async () => {
		const messageContent = 'Test message for instant persistence';

		// Measure time to persist
		const startTime = Date.now();
		const { messageId } = await agentSession.persistAndQueueMessage({
			content: messageContent,
		});
		const duration = Date.now() - startTime;

		// Verify message was saved to DB
		const savedMessages = db.getSDKMessages(session.id);
		expect(savedMessages.length).toBe(1);

		const savedMessage = savedMessages[0] as {
			type: string;
			uuid: string;
		};
		expect(savedMessage.type).toBe('user');
		expect(savedMessage.uuid).toBe(messageId);

		// Verify message was published to UI
		const publishedMessages = (messageHub as unknown as { _publishedMessages: unknown[] })
			._publishedMessages;
		expect(publishedMessages.length).toBeGreaterThanOrEqual(1);

		const sdkMessagePublish = publishedMessages.find(
			(p: unknown) => (p as { channel: string }).channel === 'sdk.message'
		) as { channel: string; data: { type: string; uuid: string } } | undefined;

		expect(sdkMessagePublish).toBeDefined();
		expect(sdkMessagePublish?.data.type).toBe('user');
		expect(sdkMessagePublish?.data.uuid).toBe(messageId);

		// Verify it was fast (should be <100ms for instant feedback)
		console.log(`Message persisted in ${duration}ms`);
		expect(duration).toBeLessThan(100);
	});

	test('message appears in DB before workspace initialization would complete', async () => {
		// Create a fresh session that needs workspace init
		const uninitializedSession: Session = {
			...session,
			id: generateUUID(),
			metadata: {
				...session.metadata,
				workspaceInitialized: false, // Not initialized yet
			},
		};

		db.createSession(uninitializedSession);
		mkdirSync(join(testDir, 'uninitialized-workspace'), { recursive: true });

		const mockSettingsManager = {
			prepareSDKOptions: async () => ({}),
		} as unknown as import('../settings-manager').SettingsManager;

		const uninitializedAgentSession = new AgentSession(
			{ ...uninitializedSession, workspacePath: join(testDir, 'uninitialized-workspace') },
			db,
			messageHub,
			mockSettingsManager,
			eventBus,
			async () => null
		);

		// Send message
		const startTime = Date.now();
		await uninitializedAgentSession.persistAndQueueMessage({
			content: 'Message before workspace init',
		});
		const persistDuration = Date.now() - startTime;

		// Verify message is already in DB (even though workspace not initialized)
		const messages = db.getSDKMessages(uninitializedSession.id);
		expect(messages.length).toBe(1);

		// Persistence should be instant, much faster than workspace init (~2s)
		console.log(`Persist duration: ${persistDuration}ms (workspace init would take ~2000ms)`);
		expect(persistDuration).toBeLessThan(100);
	});

	test('messages with images are persisted correctly', async () => {
		const { messageId } = await agentSession.persistAndQueueMessage({
			content: 'Message with image',
			images: [
				{
					media_type: 'image/png',
					data: 'base64data',
				},
			],
		});

		const messages = db.getSDKMessages(session.id);
		expect(messages.length).toBe(1);

		const savedMessage = messages[0] as {
			type: string;
			uuid: string;
			message: { content: Array<{ type: string }> };
		};
		expect(savedMessage.uuid).toBe(messageId);

		// Verify message content includes both text and image
		expect(savedMessage.message.content.length).toBe(2);
		expect(savedMessage.message.content[0].type).toBe('text');
		expect(savedMessage.message.content[1].type).toBe('image');
	});
});
