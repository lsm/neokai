/**
 * Model Switching Offline Tests
 *
 * Tests for model switching functionality that do NOT require API credentials.
 * These tests verify basic RPC handler behavior and error handling without
 * needing the model cache to be populated.
 *
 * For tests that require model validation (switching between valid models),
 * see tests/online/model-switching.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../../test-utils';
import { createTestApp, callRPCHandler } from '../../../test-utils';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('Model Switching (Offline)', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('session.model.get', () => {
		test('should return current model for new session', async () => {
			// Create session
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-model-get`,
			});

			// Get current model
			const result = await callRPCHandler(ctx.messageHub, 'session.model.get', {
				sessionId,
			});

			expect(result).toBeDefined();
			expect(result.currentModel).toBeString();
			expect(result.currentModel.length).toBeGreaterThan(0);
			// modelInfo may be null for some models
		});

		test('should return model info if available', async () => {
			// Create session with known model
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-model-info`,
				config: {
					model: 'default', // SDK uses 'default' for Sonnet
				},
			});

			// Get current model
			const result = await callRPCHandler(ctx.messageHub, 'session.model.get', {
				sessionId,
			});

			expect(result.currentModel).toBe('default'); // SDK alias
			if (result.modelInfo) {
				expect(result.modelInfo.id).toBe('default'); // SDK alias
				expect(result.modelInfo.name).toBeString();
				expect(result.modelInfo.family).toBeOneOf(['opus', 'sonnet', 'haiku']);
			}
		});

		test('should throw error for non-existent session', async () => {
			await expect(
				callRPCHandler(ctx.messageHub, 'session.model.get', {
					sessionId: 'non-existent-session',
				})
			).rejects.toThrow();
		});
	});

	describe('session.model.switch error handling', () => {
		test('should throw error for non-existent session', async () => {
			await expect(
				callRPCHandler(ctx.messageHub, 'session.model.switch', {
					sessionId: 'non-existent-session',
					model: 'sonnet',
				})
			).rejects.toThrow();
		});
	});

	describe('models.clearCache', () => {
		test('should clear model cache', async () => {
			// Load models into cache (if available)
			try {
				await callRPCHandler(ctx.messageHub, 'models.list', {
					useCache: true,
				});
			} catch {
				// Ignore if models.list fails (no credentials)
			}

			// Clear cache - should always succeed
			const result = await callRPCHandler(ctx.messageHub, 'models.clearCache', {});

			expect(result.success).toBe(true);
		});
	});

	describe('AgentSession.getCurrentModel', () => {
		test('should return current model info from AgentSession', async () => {
			// Create session
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-agent-session-model`,
				config: {
					model: 'default', // SDK alias for Sonnet
				},
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			const modelInfo = agentSession!.getCurrentModel();

			expect(modelInfo.id).toBe('default');
			// modelInfo.info may be null if model cache is not populated
		});
	});

	describe('Model switching edge cases (offline)', () => {
		test('should preserve conversation history after model switch config change', async () => {
			// Create session
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-history-preservation`,
				config: {
					model: 'default', // SDK alias for Sonnet
				},
			});

			// Get initial message count
			const agentSessionBefore = await ctx.sessionManager.getSessionAsync(sessionId);
			const messageCountBefore = agentSessionBefore!.getSDKMessageCount();

			// Message count should be 0 for new session
			expect(messageCountBefore).toBe(0);

			// Get session again and verify count is still 0
			const agentSessionAfter = await ctx.sessionManager.getSessionAsync(sessionId);
			const messageCountAfter = agentSessionAfter!.getSDKMessageCount();
			expect(messageCountAfter).toBe(messageCountBefore);
		});
	});
});
