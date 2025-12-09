/**
 * AgentSession Tests
 *
 * Tests for AgentSession class functionality.
 * Due to SDK complexity, we test through SessionManager integration
 * which creates real AgentSession instances.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../test-utils';
import {
	createTestApp,
	waitForWebSocketState,
	waitForWebSocketMessage,
	createWebSocketWithFirstMessage,
	hasAnyCredentials,
} from '../test-utils';

describe('AgentSession', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('getProcessingState', () => {
		test('should return idle state for new session', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			const state = agentSession!.getProcessingState();

			expect(state.status).toBe('idle');
		});
	});

	describe('getCurrentModel', () => {
		test('should return current model info', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			const modelInfo = agentSession!.getCurrentModel();

			expect(modelInfo.id).toBeString();
			expect(modelInfo.id.length).toBeGreaterThan(0);
			// modelInfo.info may be null for some models
		});
	});

	describe('getMessages', () => {
		test('should return empty array for new session', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			const messages = agentSession!.getMessages();

			expect(messages).toBeArray();
			expect(messages.length).toBe(0);
		});

		test('should support pagination', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			const messages = agentSession!.getMessages(10, 0);

			expect(messages).toBeArray();
		});
	});

	describe('getSDKMessages', () => {
		test('should return empty array for new session', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			const sdkMessages = agentSession!.getSDKMessages();

			expect(sdkMessages).toBeArray();
			expect(sdkMessages.length).toBe(0);
		});

		test('should support pagination and since parameter', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			const sdkMessages = agentSession!.getSDKMessages(10, 0, Date.now() - 1000);

			expect(sdkMessages).toBeArray();
		});
	});

	describe('getSessionData', () => {
		test('should return session data', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			const sessionData = agentSession!.getSessionData();

			expect(sessionData.id).toBe(sessionId);
			expect(sessionData.workspacePath).toBe('/test/agent-session');
			expect(sessionData.status).toBe('active');
			expect(sessionData.config).toBeDefined();
			expect(sessionData.metadata).toBeDefined();
		});
	});

	describe('updateMetadata', () => {
		test('should update session title', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			agentSession!.updateMetadata({ title: 'New Title' });

			const sessionData = agentSession!.getSessionData();
			expect(sessionData.title).toBe('New Title');

			// Verify persisted to database
			const dbSession = ctx.db.getSession(sessionId);
			expect(dbSession?.title).toBe('New Title');
		});

		test('should update workspace path', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			agentSession!.updateMetadata({ workspacePath: '/new/path' });

			const sessionData = agentSession!.getSessionData();
			expect(sessionData.workspacePath).toBe('/new/path');
		});

		test('should update status', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			agentSession!.updateMetadata({ status: 'paused' });

			const sessionData = agentSession!.getSessionData();
			expect(sessionData.status).toBe('paused');
		});

		test('should update metadata', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			agentSession!.updateMetadata({
				metadata: {
					messageCount: 5,
					totalTokens: 1000,
					inputTokens: 400,
					outputTokens: 600,
					totalCost: 0.05,
					toolCallCount: 3,
				},
			});

			const sessionData = agentSession!.getSessionData();
			expect(sessionData.metadata?.messageCount).toBe(5);
			expect(sessionData.metadata?.totalTokens).toBe(1000);
		});
	});

	describe('clearHistory', () => {
		test('should clear conversation history', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// Clear history
			agentSession!.clearHistory();

			// Internal history should be empty
			// (We can't directly check this, but getMessages will still show DB messages)
		});
	});

	describe('reloadHistory', () => {
		test('should reload history from database', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// Clear and reload
			agentSession!.clearHistory();
			agentSession!.reloadHistory();

			// Should not throw
		});
	});

	describe('cleanup', () => {
		test('should cleanup resources without error', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// Cleanup should not throw
			await agentSession!.cleanup();
		});
	});

	describe('abort', () => {
		test('should abort current operation', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// Abort should not throw
			agentSession!.abort();
		});
	});

	describe('getSlashCommands', () => {
		test('should return empty array for new session', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			const commands = await agentSession!.getSlashCommands();

			// Commands may be empty if query hasn't started
			expect(commands).toBeArray();
		});
	});

	describe('handleInterrupt', () => {
		test('should handle interrupt for session', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// Interrupt should not throw
			await agentSession!.handleInterrupt();

			// State should be idle after interrupt
			const state = agentSession!.getProcessingState();
			expect(state.status).toBe('idle');
		});
	});

	describe('handleModelSwitch', () => {
		test('should reject invalid model', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			const result = await agentSession!.handleModelSwitch('invalid-model');

			expect(result.success).toBe(false);
			expect(result.error).toContain('Invalid model');
		});

		test('should indicate already using model if same model', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			const currentModel = agentSession!.getCurrentModel().id;

			const result = await agentSession!.handleModelSwitch(currentModel);

			expect(result.success).toBe(true);
			expect(result.error).toContain('Already using');
		});

		test('should resolve model aliases', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// Try with alias - this may or may not work depending on current model
			// The alias 'sonnet' should resolve to a valid model ID
			const result = await agentSession!.handleModelSwitch('sonnet');

			// Either success or already using (if session already has sonnet)
			expect(result.success).toBe(true);
		});
	});

	describe('enqueueMessage and sendMessage', () => {
		// Note: This test requires authentication (API key or OAuth) because it uses Claude SDK
		test.skipIf(!hasAnyCredentials())('should enqueue message for processing', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// This will start the query and enqueue the message
			const _messageIdPromise = agentSession!.enqueueMessage('Hello');

			// We can't easily wait for this without real SDK, but it should not throw immediately
			// The promise will resolve when the message is yielded to the SDK
		});
	});

	describe('handleMessageSend', () => {
		// Note: This test requires authentication (API key or OAuth) because it uses Claude SDK
		test.skipIf(!hasAnyCredentials())('should handle message send with images', async () => {
			const tmpDir = process.env.TMPDIR || '/tmp';
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: `${tmpDir}/liuboer-test-agent-session-${Date.now()}`,
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// This will start the query and handle the message
			const result = await agentSession!.handleMessageSend({
				content: 'What is in this image?',
				images: [
					{
						media_type: 'image/png',
						data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', // 1x1 pixel
					},
				],
			});

			expect(result.messageId).toBeString();
		});
	});
});

describe('AgentSession via WebSocket', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('session.interrupted event', () => {
		test('should emit session.interrupted event on interrupt', async () => {
			// Create a session
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/interrupt-event',
			});

			const { ws, firstMessagePromise } = createWebSocketWithFirstMessage(ctx.baseUrl, 'global');
			await waitForWebSocketState(ws, WebSocket.OPEN);
			await firstMessagePromise; // Drain connection event

			// Set up promise for subscribe confirmation
			const subPromise = waitForWebSocketMessage(ws);

			// Subscribe to session.interrupted event
			ws.send(
				JSON.stringify({
					id: 'sub-1',
					type: 'SUBSCRIBE',
					method: 'session.interrupted',
					sessionId,
					timestamp: new Date().toISOString(),
					version: '1.0.0',
				})
			);

			// Wait for subscribe confirmation
			await subPromise;

			// Set up promise for event BEFORE triggering interrupt
			const eventPromise = waitForWebSocketMessage(ws, 2000);

			// Trigger interrupt
			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			await agentSession!.handleInterrupt();

			// Should receive interrupted event
			const event = await eventPromise;

			expect(event.type).toBe('EVENT');
			expect(event.method).toBe('session.interrupted');

			ws.close();
		});
	});
});
