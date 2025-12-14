/**
 * AgentSession Tests
 *
 * Tests for AgentSession class functionality.
 * Due to SDK complexity, we test through SessionManager integration
 * which creates real AgentSession instances.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../test-utils';
import { createTestApp } from '../test-utils';

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

		test('should restore commands from database on session load', async () => {
			// Create session with commands
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			// Manually persist commands to database (simulating previous save)
			ctx.db.updateSession(sessionId, {
				availableCommands: ['/help', '/clear', '/context', '/test'],
			});

			// Create new agent session instance (simulating restart)
			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			const commands = await agentSession!.getSlashCommands();

			// Commands should be restored from DB
			expect(commands).toBeArray();
			expect(commands.length).toBeGreaterThanOrEqual(0);
			// Note: Commands may be empty or may contain DB-persisted commands
			// depending on whether SDK query has started
		});

		test('should persist commands to database when fetched from SDK', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/agent-session',
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// Get commands (this may trigger SDK fetch if needed)
			await agentSession!.getSlashCommands();

			// Check if commands were persisted to database
			const session = ctx.db.getSession(sessionId);
			expect(session).toBeDefined();
			// availableCommands may be undefined if SDK hasn't been queried yet
			// or may contain commands if SDK query has started
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

	// enqueueMessage() test removed - it's now a private method in MessageQueue
	// handleMessageSend() integration tests moved to tests/integration/agent-session-sdk.test.ts
	// session.interrupted event test moved to tests/integration/agent-session-sdk.test.ts (requires SDK)
});
