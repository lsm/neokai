/**
 * Unit test for instant message persistence UX fix
 *
 * Verifies that user messages are saved to DB and published to UI
 * BEFORE workspace initialization, providing instant feedback.
 */

import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { AgentSession } from '../../src/lib/agent';
import { SessionManager } from '../../src/lib/session-manager';
import { Database } from '../../src/storage/database';
import { EventBus } from '@liuboer/shared';
import type { MessageHub, Session } from '@liuboer/shared';
import { generateUUID } from '@liuboer/shared';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, rmSync } from 'fs';
import { sendMessageSync } from '../helpers/test-message-sender';

describe('Instant Message Persistence UX', () => {
	let db: Database;
	let messageHub: MessageHub;
	let eventBus: EventBus;
	let sessionManager: SessionManager;
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

		// Create EventBus
		eventBus = new EventBus();

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
		sessionManager = new SessionManager(
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

		// Get the AgentSession created by SessionManager
		// Wait a bit for SessionManager to initialize
		await new Promise((resolve) => setTimeout(resolve, 100));
		const agentSessionOrNull = await sessionManager.getSessionAsync(session.id);
		if (!agentSessionOrNull) {
			throw new Error('AgentSession not created by SessionManager');
		}
		agentSession = agentSessionOrNull;
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

		// Create a promise that resolves when message is persisted
		let resolvePersisted: (() => void) | null = null;
		const persistedPromise = new Promise<void>((resolve) => {
			resolvePersisted = resolve;
		});

		// Subscribe to message:persisted event
		eventBus.once('message:persisted', () => {
			if (resolvePersisted) {
				resolvePersisted();
			}
		});

		// Measure time to persist
		const startTime = Date.now();

		// Emit message:send:request event (same as production RPC handler)
		await eventBus.emit('message:send:request', {
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
		) as { channel: string; data: { added: Array<{ type: string; uuid: string }> } } | undefined;

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

		const uninitializedAgentSession = new AgentSession(
			{ ...uninitializedSession, workspacePath: join(testDir, 'uninitialized-workspace') },
			db,
			messageHub,
			eventBus,
			async () => null
		);

		// Send message
		const startTime = Date.now();
		await sendMessageSync(uninitializedAgentSession, {
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
		const { messageId } = await sendMessageSync(agentSession, {
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
