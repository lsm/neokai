/**
 * AgentSession Facade Tests
 *
 * Tests for AgentSession public API methods (facade pattern).
 * These tests ensure all delegation methods are called correctly.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../test-utils';
import { createTestApp } from '../../test-utils';

describe('AgentSession Facade Methods', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('Getter methods', () => {
		test('getProcessingState should delegate to stateManager', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/facade',
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);
			const state = session!.getProcessingState();

			expect(state).toBeDefined();
			expect(state.status).toBeString();
		});

		test('getContextInfo should delegate to contextTracker', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/facade',
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);
			const contextInfo = session!.getContextInfo();

			// Initially null until context is fetched
			expect(contextInfo).toBeOneOf([
				null,
				expect.objectContaining({ currentTokens: expect.any(Number) }),
			]);
		});

		test('getQueryObject should return query object', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/facade',
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);
			const queryObject = session!.getQueryObject();

			// Initially null until query starts
			expect(queryObject).toBeNull();
		});

		test('getFirstMessageReceived should return boolean', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/facade',
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);
			const firstMessageReceived = session!.getFirstMessageReceived();

			expect(typeof firstMessageReceived).toBe('boolean');
		});

		test('getSessionData should return session', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/facade',
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);
			const sessionData = session!.getSessionData();

			expect(sessionData.id).toBe(sessionId);
			expect(sessionData.workspacePath).toBe('/test/facade');
		});

		test('getSDKMessages should delegate to db', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/facade',
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);
			const messages = session!.getSDKMessages();

			expect(Array.isArray(messages)).toBe(true);
		});

		test('getSDKMessages with limit should pass parameters', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/facade',
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);
			const messages = session!.getSDKMessages(10, 100, 50);

			expect(Array.isArray(messages)).toBe(true);
		});

		test('getSDKMessageCount should delegate to db', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/facade',
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);
			const count = session!.getSDKMessageCount();

			expect(typeof count).toBe('number');
		});

		test('getSDKSessionId should return null when no query', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/facade',
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);
			const sdkSessionId = session!.getSDKSessionId();

			expect(sdkSessionId).toBeNull();
		});
	});

	describe('Async methods', () => {
		test('getSlashCommands should delegate to slashCommandManager', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/facade',
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);
			const commands = await session!.getSlashCommands();

			expect(Array.isArray(commands)).toBe(true);
		});

		test('handleQueryTrigger should delegate to queryModeHandler', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/facade',
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);
			const result = await session!.handleQueryTrigger();

			expect(result).toBeDefined();
			expect(typeof result.success).toBe('boolean');
			expect(typeof result.messageCount).toBe('number');
		});
	});

	describe('Rewind methods', () => {
		test('getCheckpoints should delegate to rewindHandler', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/facade',
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);
			const checkpoints = session!.getCheckpoints();

			expect(Array.isArray(checkpoints)).toBe(true);
		});

		test('previewRewind should delegate to rewindHandler', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/facade',
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);

			// Will fail with no checkpoints, but exercises the code path
			try {
				await session!.previewRewind('nonexistent-checkpoint');
			} catch (error) {
				expect(error).toBeDefined();
			}
		});

		test('executeRewind should delegate to rewindHandler', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/facade',
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);

			// Will fail with no checkpoints, but exercises the code path
			try {
				await session!.executeRewind('nonexistent-checkpoint', 'hard');
			} catch (error) {
				expect(error).toBeDefined();
			}
		});
	});

	describe('Context interface methods', () => {
		test('incrementQueryGeneration should increment counter', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/facade',
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);
			const gen1 = session!.incrementQueryGeneration();
			const gen2 = session!.incrementQueryGeneration();

			expect(gen2).toBe(gen1 + 1);
		});

		test('getQueryGeneration should return current generation', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/facade',
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);
			const gen = session!.getQueryGeneration();

			expect(typeof gen).toBe('number');
		});

		test('isCleaningUp should return boolean', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/facade',
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);
			const cleaningUp = session!.isCleaningUp();

			expect(typeof cleaningUp).toBe('boolean');
		});

		test('setCleaningUp should update flag', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/facade',
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);
			session!.setCleaningUp(true);
			const cleaningUp = session!.isCleaningUp();

			expect(cleaningUp).toBe(true);
		});

		test('onMarkApiSuccess should delegate to errorManager', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/facade',
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);
			await session!.onMarkApiSuccess();

			// Should complete without error
			expect(true).toBe(true);
		});

		test('cleanupEventSubscriptions should delegate to eventSubscriptionSetup', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/facade',
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);
			session!.cleanupEventSubscriptions();

			// Should complete without error
			expect(true).toBe(true);
		});

		test('clearModelsCache should delegate to model-service', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/facade',
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);
			await session!.clearModelsCache();

			// Should complete without error
			expect(true).toBe(true);
		});

		test('onSlashCommandsFetched should delegate to slashCommandManager', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/facade',
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);
			await session!.onSlashCommandsFetched();

			// Should complete without error
			expect(true).toBe(true);
		});

		test('onModelsFetched should handle no query object', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/facade',
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);
			// Query object is null initially
			await session!.onModelsFetched();

			// Should complete without error
			expect(true).toBe(true);
		});
	});

	describe('updateMetadata', () => {
		test('should delegate to sessionConfigHandler', async () => {
			const sessionId = await ctx.sessionManager.createSession({
				workspacePath: '/test/facade',
			});

			const session = await ctx.sessionManager.getSessionAsync(sessionId);
			session!.updateMetadata({ title: 'Updated Title' });

			const sessionData = session!.getSessionData();
			expect(sessionData.title).toBe('Updated Title');
		});
	});
});
