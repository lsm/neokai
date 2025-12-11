/**
 * Model Switching Integration Tests
 *
 * End-to-end tests for model switching functionality using Claude Agent SDK's
 * native setModel() method. Tests both RPC handlers and AgentSession integration.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../test-utils';
import { createTestApp, callRPCHandler } from '../test-utils';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('Model Switching Integration', () => {
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
					model: 'claude-sonnet-4-5-20250929',
				},
			});

			// Get current model
			const result = await callRPCHandler(ctx.messageHub, 'session.model.get', {
				sessionId,
			});

			expect(result.currentModel).toBe('claude-sonnet-4-5-20250929');
			if (result.modelInfo) {
				expect(result.modelInfo.id).toBe('claude-sonnet-4-5-20250929');
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

	describe('session.model.switch', () => {
		test('should switch model by full ID', async () => {
			// Create session
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-model-switch-id`,
				config: {
					model: 'claude-sonnet-4-5-20250929',
				},
			});

			// Switch to Haiku
			const result = await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'claude-haiku-4-5-20251001',
			});

			expect(result.success).toBe(true);
			expect(result.model).toBe('claude-haiku-4-5-20251001');
			expect(result.error).toBeUndefined();

			// Verify model was updated in session
			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			const sessionData = agentSession!.getSessionData();
			expect(sessionData.config.model).toBe('claude-haiku-4-5-20251001');

			// Verify model was updated in database
			const dbSession = ctx.db.getSession(sessionId);
			expect(dbSession?.config.model).toBe('claude-haiku-4-5-20251001');
		});

		test('should switch model by alias', async () => {
			// Create session
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-model-switch-alias`,
				config: {
					model: 'sonnet',
				},
			});

			// Switch using alias
			const result = await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'opus',
			});

			expect(result.success).toBe(true);
			expect(result.model).toBe('claude-opus-4-5-20251101'); // Resolved from alias
			expect(result.error).toBeUndefined();
		});

		test('should handle switching to same model', async () => {
			// Create session
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-model-switch-same`,
				config: {
					model: 'claude-sonnet-4-5-20250929',
				},
			});

			// Switch to same model
			const result = await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'claude-sonnet-4-5-20250929',
			});

			expect(result.success).toBe(true);
			expect(result.model).toBe('claude-sonnet-4-5-20250929');
			expect(result.error).toBeDefined(); // Should have message about already using model
		});

		test('should reject invalid model ID', async () => {
			// Create session
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-model-switch-invalid`,
			});

			// Try to switch to invalid model
			const result = await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'invalid-model-id',
			});

			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
			expect(result.error).toContain('Invalid model');

			// Verify model was not changed
			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			const sessionData = agentSession!.getSessionData();
			expect(sessionData.config.model).not.toBe('invalid-model-id');
		});

		test('should reject invalid model alias', async () => {
			// Create session
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-model-switch-invalid-alias`,
			});

			// Try to switch to invalid alias
			const result = await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'invalid-alias',
			});

			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
			expect(result.error).toContain('Invalid model');
		});

		test('should throw error for non-existent session', async () => {
			await expect(
				callRPCHandler(ctx.messageHub, 'session.model.switch', {
					sessionId: 'non-existent-session',
					model: 'sonnet',
				})
			).rejects.toThrow();
		});

		test('should switch between different model families', async () => {
			// Create session
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-model-switch-families`,
				config: {
					model: 'sonnet',
				},
			});

			// Switch to Opus
			let result = await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'opus',
			});
			expect(result.success).toBe(true);
			expect(result.model).toContain('opus');

			// Switch to Haiku
			result = await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'haiku',
			});
			expect(result.success).toBe(true);
			expect(result.model).toContain('haiku');

			// Switch back to Sonnet
			result = await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'sonnet',
			});
			expect(result.success).toBe(true);
			expect(result.model).toContain('sonnet');
		});

		test('should preserve session state during model switch', async () => {
			// Create session
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-model-switch-state`,
				config: {
					model: 'sonnet',
				},
			});

			// Get initial state
			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			const stateBefore = agentSession!.getProcessingState();
			const sessionDataBefore = agentSession!.getSessionData();
			const modelBefore = sessionDataBefore.config.model;

			// Switch model
			await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'haiku',
			});

			// Get state after switch (same instance, but config should be updated)
			const stateAfter = agentSession!.getProcessingState();
			const sessionDataAfter = agentSession!.getSessionData();

			// Verify processing state preserved
			expect(stateAfter.status).toBe(stateBefore.status);

			// Verify session metadata preserved
			expect(sessionDataAfter.id).toBe(sessionDataBefore.id);
			expect(sessionDataAfter.title).toBe(sessionDataBefore.title);
			expect(sessionDataAfter.workspacePath).toBe(sessionDataBefore.workspacePath);
			expect(sessionDataAfter.status).toBe(sessionDataBefore.status);

			// Only model should change
			expect(sessionDataAfter.config.model).not.toBe(modelBefore);
			expect(sessionDataAfter.config.model).toBe('claude-haiku-4-5-20251001');
		});

		test('should update database immediately on switch', async () => {
			// Create session
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-model-switch-db`,
				config: {
					model: 'sonnet',
				},
			});

			// Switch model
			await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'opus',
			});

			// Verify database was updated
			const dbSession = ctx.db.getSession(sessionId);
			expect(dbSession).toBeDefined();
			expect(dbSession?.config.model).toBe('claude-opus-4-5-20251101');
		});
	});

	describe('models.list', () => {
		test('should return list of available models from SDK', async () => {
			const result = await callRPCHandler(ctx.messageHub, 'models.list', {
				useCache: true,
			});

			expect(result).toBeDefined();
			expect(result.models).toBeArray();
			expect(result.models.length).toBeGreaterThan(0);
			expect(result.cached).toBeBoolean();

			// Verify model structure
			const firstModel = result.models[0];
			expect(firstModel.id).toBeString();
			expect(firstModel.display_name).toBeString();
		});

		test('should support force refresh', async () => {
			const result = await callRPCHandler(ctx.messageHub, 'models.list', {
				useCache: false,
				forceRefresh: true,
			});

			expect(result).toBeDefined();
			expect(result.models).toBeArray();
			expect(result.cached).toBe(false);
		});

		test('should cache models by default', async () => {
			// First call
			const result1 = await callRPCHandler(ctx.messageHub, 'models.list', {
				useCache: true,
			});

			// Second call should use cache
			const result2 = await callRPCHandler(ctx.messageHub, 'models.list', {
				useCache: true,
			});

			expect(result1.models).toEqual(result2.models);
			// Second call should be from cache
			expect(result2.cached).toBe(true);
		});
	});

	describe('models.clearCache', () => {
		test('should clear model cache', async () => {
			// Load models into cache
			await callRPCHandler(ctx.messageHub, 'models.list', {
				useCache: true,
			});

			// Clear cache
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
					model: 'claude-sonnet-4-5-20250929',
				},
			});

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			const modelInfo = agentSession!.getCurrentModel();

			expect(modelInfo.id).toBe('claude-sonnet-4-5-20250929');
			if (modelInfo.info) {
				expect(modelInfo.info.name).toBeString();
				expect(modelInfo.info.family).toBe('sonnet');
			}
		});

		test('should reflect model changes after switch', async () => {
			// Create session
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-agent-session-model-switch`,
				config: {
					model: 'sonnet',
				},
			});

			// Get initial model
			let agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			let modelInfo = agentSession!.getCurrentModel();
			expect(modelInfo.id).toContain('sonnet');

			// Switch model
			await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'haiku',
			});

			// Verify model changed
			agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			modelInfo = agentSession!.getCurrentModel();
			expect(modelInfo.id).toContain('haiku');
		});
	});

	describe('Model switching edge cases', () => {
		test('should handle rapid consecutive model switches', async () => {
			// Create session
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-rapid-switches`,
				config: {
					model: 'sonnet',
				},
			});

			// Perform rapid switches
			const switches = [
				{ model: 'opus' },
				{ model: 'haiku' },
				{ model: 'sonnet' },
				{ model: 'opus' },
			];

			const results = await Promise.all(
				switches.map((sw) =>
					callRPCHandler(ctx.messageHub, 'session.model.switch', {
						sessionId,
						...sw,
					})
				)
			);

			// All switches should succeed
			results.forEach((result) => {
				expect(result.success).toBe(true);
			});

			// Final model should be opus
			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			const modelInfo = agentSession!.getCurrentModel();
			expect(modelInfo.id).toContain('opus');
		});

		test('should handle model switch before query starts', async () => {
			// Create session (query not started yet)
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-pre-query-switch`,
				config: {
					model: 'sonnet',
				},
			});

			// Switch model before sending any messages
			const result = await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'haiku',
			});

			expect(result.success).toBe(true);
			expect(result.model).toContain('haiku');

			// Verify config was updated
			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			const sessionData = agentSession!.getSessionData();
			expect(sessionData.config.model).toContain('haiku');
		});

		test('should preserve conversation history after model switch', async () => {
			// Create session
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-history-preservation`,
				config: {
					model: 'sonnet',
				},
			});

			// Get initial message count
			const agentSessionBefore = await ctx.sessionManager.getSessionAsync(sessionId);
			const messageCountBefore = agentSessionBefore!.getSDKMessageCount();

			// Switch model
			await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'haiku',
			});

			// Verify message count unchanged
			const agentSessionAfter = await ctx.sessionManager.getSessionAsync(sessionId);
			const messageCountAfter = agentSessionAfter!.getSDKMessageCount();
			expect(messageCountAfter).toBe(messageCountBefore);
		});
	});
});
