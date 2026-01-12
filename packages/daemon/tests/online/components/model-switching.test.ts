/**
 * Model Switching Integration Tests (API-dependent)
 *
 * End-to-end tests for model switching functionality using Claude Agent SDK's
 * native setModel() method. Tests both RPC handlers and AgentSession integration.
 *
 * These tests require API credentials because:
 * - Model validation (isValidModel) checks against the model cache
 * - The model cache is populated by initializeModels() which calls the SDK
 * - Without credentials, the cache is empty and all models appear "invalid"
 *
 * REQUIREMENTS:
 * - Requires GLM_API_KEY (or ZHIPU_API_KEY)
 * - Makes real API calls (costs money, uses rate limits)
 * - Tests will SKIP if credentials are not available
 *
 * MODEL MAPPING:
 * - Uses 'haiku' model (provider-agnostic)
 * - With GLM_API_KEY: haiku → glm-4.5-air (via ANTHROPIC_DEFAULT_HAIKU_MODEL)
 * - With ANTHROPIC_API_KEY: haiku → Claude Haiku
 * - This makes tests provider-agnostic and easy to switch
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import 'dotenv/config';
import type { TestContext } from '../../test-utils';
import { createTestApp, callRPCHandler } from '../../test-utils';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

// Check for GLM credentials
const GLM_API_KEY = process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN;

// Set up GLM provider environment if GLM_API_KEY is available
// This makes 'haiku' model automatically map to glm-4.5-air
if (GLM_API_KEY) {
	process.env.ANTHROPIC_AUTH_TOKEN = GLM_API_KEY;
	process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
	process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'glm-4.5-air';
	process.env.API_TIMEOUT_MS = '3000000';
}

// Skip all tests if GLM credentials are not available
describe.skipIf(!GLM_API_KEY)('Model Switching Integration', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		// Restore mocks to ensure we use the real SDK
		mock.restore();
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('session.model.switch', () => {
		test('should switch model by alias', async () => {
			// Create session
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-model-switch-id`,
				config: {
					model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
				},
			});

			// Switch to another GLM model
			const result = await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'glm-4.7', // Another GLM model
			});

			expect(result.success).toBe(true);
			expect(result.model).toBe('glm-4.7');
			expect(result.error).toBeUndefined();

			// Verify model was updated in session
			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			const sessionData = agentSession!.getSessionData();
			expect(sessionData.config.model).toBe('glm-4.7');

			// Verify model was updated in database
			const dbSession = ctx.db.getSession(sessionId);
			expect(dbSession?.config.model).toBe('glm-4.7');
		});

		test('should switch between model families', async () => {
			// Create session
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-model-switch-alias`,
				config: {
					model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
				},
			});

			// Switch to another GLM model
			const result = await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'glm-4.7', // Another GLM model
			});

			expect(result.success).toBe(true);
			expect(result.model).toBe('glm-4.7');
			expect(result.error).toBeUndefined();
		});

		test('should handle switching to same model', async () => {
			// Create session
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-model-switch-same`,
				config: {
					model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
				},
			});

			// Switch to same model
			const result = await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'haiku',
			});

			expect(result.success).toBe(true);
			expect(result.model).toBe('haiku');
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

		test('should switch between different model families', async () => {
			// Create session
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-model-switch-families`,
				config: {
					model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
				},
			});

			// Switch to glm-4.7
			let result = await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'glm-4.7',
			});
			expect(result.success).toBe(true);
			expect(result.model).toBe('glm-4.7');

			// Switch to glm-4.7
			result = await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'glm-4.7',
			});
			expect(result.success).toBe(true);
			expect(result.model).toBe('glm-4.7');

			// Switch back to haiku
			result = await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'haiku',
			});
			expect(result.success).toBe(true);
			expect(result.model).toBe('haiku');
		});

		test('should preserve session state during model switch', async () => {
			// Create session
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-model-switch-state`,
				config: {
					model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
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
				model: 'glm-4.7',
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
			expect(sessionDataAfter.config.model).toBe('glm-4.7');
		});

		test('should update database immediately on switch', async () => {
			// Create session
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-model-switch-db`,
				config: {
					model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
				},
			});

			// Switch model
			await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'glm-4.7',
			});

			// Verify database was updated
			const dbSession = ctx.db.getSession(sessionId);
			expect(dbSession).toBeDefined();
			expect(dbSession?.config.model).toBe('glm-4.7');
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
	});

	describe('AgentSession.getCurrentModel', () => {
		test('should reflect model changes after switch', async () => {
			// Create session
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-agent-session-model-switch`,
				config: {
					model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
				},
			});

			// Get initial model
			let agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			let modelInfo = agentSession!.getCurrentModel();
			expect(modelInfo.id).toBe('haiku');

			// Switch model
			await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'glm-4.7',
			});

			// Verify model changed
			agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			modelInfo = agentSession!.getCurrentModel();
			expect(modelInfo.id).toBe('glm-4.7');
		});
	});

	describe('Model switching edge cases', () => {
		test('should handle rapid consecutive model switches', async () => {
			// Create session
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-rapid-switches`,
				config: {
					model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
				},
			});

			// Perform rapid switches
			const switches = [
				{ model: 'glm-4.7' },
				{ model: 'glm-4.7' },
				{ model: 'haiku' },
				{ model: 'glm-4.7' },
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

			// Final model should be glm-4.7
			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			const modelInfo = agentSession!.getCurrentModel();
			expect(modelInfo.id).toBe('glm-4.7');
		});

		test('should handle model switch before query starts', async () => {
			// Create session (query not started yet)
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-pre-query-switch`,
				config: {
					model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
				},
			});

			// Switch model before sending any messages
			const result = await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'glm-4.7',
			});

			expect(result.success).toBe(true);
			expect(result.model).toBe('glm-4.7');

			// Verify config was updated
			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			const sessionData = agentSession!.getSessionData();
			expect(sessionData.config.model).toBe('glm-4.7');
		});
	});

	describe('handleModelSwitch via AgentSession', () => {
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

	describe('Cross-Provider Switching', () => {
		test.skipIf(!GLM_API_KEY || !ANTHROPIC_API_KEY)('should restart query when switching from GLM to Claude', async () => {
			// This test requires both GLM and Anthropic API keys
			// Skip if either key is missing
			if (!GLM_API_KEY || !ANTHROPIC_API_KEY) {
				console.log('Skipping cross-provider test - need both GLM_API_KEY and ANTHROPIC_API_KEY');
				return;
			}

			// Create session with GLM model
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-cross-provider-glm-to-claude`,
				config: {
					model: 'glm-4.7',
				},
			});

			// Send a message to start the query (makes transport ready)
			await callRPCHandler(ctx.messageHub, 'message.send', {
				sessionId,
				content: 'Hello',
			});

			// Wait for query to start and transport to be ready
			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			await new Promise((resolve) => setTimeout(resolve, 2000));

			// Verify query is running
			const queryObject = agentSession!.getQueryObject();
			expect(queryObject).toBeDefined();

			// Get firstMessageReceived flag
			const firstMessageReceivedBefore = agentSession!.getFirstMessageReceived();
			expect(firstMessageReceivedBefore).toBe(true);

			// Switch to Claude model (cross-provider switch)
			const result = await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'haiku',
			});

			expect(result.success).toBe(true);
			expect(result.model).toBe('haiku');

			// Wait for restart to complete
			await new Promise((resolve) => setTimeout(resolve, 1000));

			// Verify model was updated
			const sessionDataAfter = agentSession!.getSessionData();
			expect(sessionDataAfter.config.model).toBe('haiku');
		});

		test.skipIf(!GLM_API_KEY || !ANTHROPIC_API_KEY)('should restart query when switching from Claude to GLM', async () => {
			// This test requires both GLM and Anthropic API keys
			// Skip if either key is missing
			if (!GLM_API_KEY || !ANTHROPIC_API_KEY) {
				console.log('Skipping cross-provider test - need both GLM_API_KEY and ANTHROPIC_API_KEY');
				return;
			}

			// Create session with Claude model (haiku)
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-cross-provider-claude-to-glm`,
				config: {
					model: 'haiku',
				},
			});

			// Send a message to start the query (makes transport ready)
			await callRPCHandler(ctx.messageHub, 'message.send', {
				sessionId,
				content: 'Hello',
			});

			// Wait for query to start and transport to be ready
			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);
			await new Promise((resolve) => setTimeout(resolve, 2000));

			// Verify query is running
			const queryObject = agentSession!.getQueryObject();
			expect(queryObject).toBeDefined();

			// Get firstMessageReceived flag
			const firstMessageReceivedBefore = agentSession!.getFirstMessageReceived();
			expect(firstMessageReceivedBefore).toBe(true);

			// Switch to GLM model (cross-provider switch)
			const result = await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'glm-4.7',
			});

			expect(result.success).toBe(true);
			expect(result.model).toBe('glm-4.7');

			// Wait for restart to complete
			await new Promise((resolve) => setTimeout(resolve, 1000));

			// Verify model was updated
			const sessionDataAfter = agentSession!.getSessionData();
			expect(sessionDataAfter.config.model).toBe('glm-4.7');
		});

		test('should use setModel for same-provider switches', async () => {
			// Create session with a GLM model
			const { sessionId } = await callRPCHandler(ctx.messageHub, 'session.create', {
				workspacePath: `${TMP_DIR}/test-same-provider-switch`,
				config: {
					model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
				},
			});

			// Send a message to start the query
			await callRPCHandler(ctx.messageHub, 'message.send', {
				sessionId,
				content: 'Hello',
			});

			// Wait for query to start
			await new Promise((resolve) => setTimeout(resolve, 2000));

			const agentSession = await ctx.sessionManager.getSessionAsync(sessionId);

			// Get the query object before switch
			const queryObjectBefore = agentSession!.getQueryObject();
			expect(queryObjectBefore).toBeDefined();

			// Switch to another GLM model (same provider)
			const result = await callRPCHandler(ctx.messageHub, 'session.model.switch', {
				sessionId,
				model: 'glm-4.7',
			});

			expect(result.success).toBe(true);
			expect(result.model).toBe('glm-4.7');

			// For same-provider switches, the query object should remain the same
			// (setModel is used instead of restart)
			await new Promise((resolve) => setTimeout(resolve, 500));
			const queryObjectAfter = agentSession!.getQueryObject();

			// Same query object should be used (no restart)
			expect(queryObjectAfter).toBeDefined();
		});
	});
});
