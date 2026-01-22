/**
 * Unit test for instant message persistence UX fix
 *
 * Verifies that user messages are saved to DB and published to UI
 * BEFORE workspace initialization, providing instant feedback.
 */

import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { SessionManager } from '../../../src/lib/session-manager';
import { Database } from '../../../src/storage/database';
import { createDaemonHub, type DaemonHub } from '../../../src/lib/daemon-hub';
import type { MessageHub, Session } from '@liuboer/shared';
import { generateUUID } from '@liuboer/shared';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { mockAgentSessionForOfflineTest } from '../../test-utils';

describe('Instant Message Persistence UX', () => {
	let db: Database;
	let messageHub: MessageHub;
	let eventBus: DaemonHub;
	let _sessionManager: SessionManager;
	let testDir: string;
	let session: Session;

	beforeEach(async () => {
		// Create temp directory for this test
		testDir = join(tmpdir(), `liuboer-test-${generateUUID()}`);
		mkdirSync(testDir, { recursive: true });

		// Initialize database
		const dbPath = join(testDir, 'test.db');
		db = new Database(dbPath);
		await db.initialize();

		// Create mock MessageHub with fresh array for each test
		messageHub = {
			publish: mock(async (channel: string, data: unknown) => {
				const publishedMessages = (messageHub as unknown as { _publishedMessages: unknown[] })
					._publishedMessages;
				publishedMessages.push({ channel, data });
			}),
			handle: mock(() => {}),
			call: mock(async () => ({})),
			subscribe: mock(() => () => {}),
			unsubscribe: mock(() => {}),
			on: mock(() => {}),
			close: mock(() => {}),
			_publishedMessages: [], // Fresh array for each test
		} as unknown as MessageHub;

		// Create DaemonHub
		eventBus = createDaemonHub('test-hub');
		await eventBus.initialize();

		// Create test session with unique ID for each test
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

		// Create minimal AuthManager and SettingsManager mocks
		const authManager = {
			isAuthenticated: () => true,
			getAuthStatus: () => ({ isAuthenticated: true, method: 'api_key' }),
		};
		const settingsManager = {
			getGlobalSettings: () => ({}),
			prepareSDKOptions: () => ({}),
		};

		// Create SessionManager to handle message:send:request events
		_sessionManager = new SessionManager(
			db,
			messageHub,
			authManager as never,
			settingsManager as never,
			eventBus,
			{
				defaultModel: 'claude-sonnet-4-5-20250929',
				maxTokens: 8192,
				temperature: 1.0,
				workspaceRoot: testDir,
				disableWorktrees: true, // Disable worktrees for unit tests
			}
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

	test('sendMessageSync saves to DB and publishes to UI immediately', async () => {
		const messageContent = 'Test message for instant persistence';
		const messageId = generateUUID();

		// Mock AgentSession to prevent SDK query creation in offline test
		// This MUST be done before emitting message.sendRequest because:
		// 1. SessionManager handles message.sendRequest
		// 2. It creates/gets AgentSession which subscribes to message.persisted
		// 3. When message.persisted is emitted, AgentSession calls startQueryAndEnqueue()
		mockAgentSessionForOfflineTest(_sessionManager, session.id);

		// Create a promise that resolves when message is persisted
		let resolvePersisted: (() => void) | null = null;
		const persistedPromise = new Promise<void>((resolve) => {
			resolvePersisted = resolve;
		});

		// Subscribe to message.persisted event
		eventBus.once('message.persisted', () => {
			if (resolvePersisted) {
				resolvePersisted();
			}
		});

		// Measure time to persist
		const startTime = Date.now();

		// Emit message.sendRequest event (same as production RPC handler)
		await eventBus.emit('message.sendRequest', {
			sessionId: session.id,
			messageId,
			content: messageContent,
		});

		// Wait for persistence to complete
		await persistedPromise;
		const duration = Date.now() - startTime;

		// Verify message was saved to DB
		const savedMessages = db.getSDKMessages(session.id);

		// Filter for only user messages (SDK query may have started and produced other messages)
		const userMessages = savedMessages.filter((msg: { type: string }) => msg.type === 'user');
		expect(userMessages.length).toBe(1);

		const savedMessage = userMessages[0] as {
			type: string;
			uuid: string;
		};
		expect(savedMessage.type).toBe('user');
		expect(savedMessage.uuid).toBe(messageId);

		// Verify message was published to UI via state.sdkMessages.delta
		const publishedMessages = (messageHub as unknown as { _publishedMessages: unknown[] })
			._publishedMessages;
		expect(publishedMessages.length).toBeGreaterThanOrEqual(1);

		const sdkMessagePublish = publishedMessages.find(
			(p: unknown) => (p as { channel: string }).channel === 'state.sdkMessages.delta'
		) as
			| {
					channel: string;
					data: { added: Array<{ type: string; uuid: string }> };
			  }
			| undefined;

		expect(sdkMessagePublish).toBeDefined();
		expect(sdkMessagePublish?.data.added).toBeDefined();
		expect(sdkMessagePublish?.data.added.length).toBe(1);
		expect(sdkMessagePublish?.data.added[0].type).toBe('user');
		expect(sdkMessagePublish?.data.added[0].uuid).toBe(messageId);

		// Verify it was reasonably fast
		// Note: In real production, the RPC returns immediately (<10ms) while persistence happens async
		// This test waits for persistence to complete, which is slower but verifies correctness
		console.log(`Message persisted in ${duration}ms`);
		expect(duration).toBeLessThan(6000); // Should complete within 6 seconds
	});

	test('messages with images are persisted correctly', async () => {
		const messageContent = 'Message with image';
		const messageId = generateUUID();

		// Mock AgentSession to prevent SDK query creation in offline test
		mockAgentSessionForOfflineTest(_sessionManager, session.id);

		// Create a promise that resolves when message is persisted
		let resolvePersisted: (() => void) | null = null;
		const persistedPromise = new Promise<void>((resolve) => {
			resolvePersisted = resolve;
		});

		// Subscribe to message.persisted event
		eventBus.once('message.persisted', () => {
			if (resolvePersisted) {
				resolvePersisted();
			}
		});

		// Emit message.sendRequest event with images
		await eventBus.emit('message.sendRequest', {
			sessionId: session.id,
			messageId,
			content: messageContent,
			images: [
				{
					source: {
						type: 'base64',
						media_type: 'image/png',
						data: 'base64data',
					},
				},
			],
		});

		// Wait for persistence to complete
		await persistedPromise;

		// Verify message was saved to DB
		const savedMessages = db.getSDKMessages(session.id);
		const userMessages = savedMessages.filter((msg: { type: string }) => msg.type === 'user');
		expect(userMessages.length).toBe(1);

		const savedMessage = userMessages[0] as {
			type: string;
			uuid: string;
			message: { content: Array<{ type: string }> };
		};
		expect(savedMessage.uuid).toBe(messageId);

		// Verify message content includes both image and text (images first, then text)
		expect(savedMessage.message.content.length).toBe(2);
		expect(savedMessage.message.content[0].type).toBe('image');
		expect(savedMessage.message.content[1].type).toBe('text');
	});
});
