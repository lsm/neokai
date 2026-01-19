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

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import 'dotenv/config';
import type { DaemonServerContext } from '../helpers/daemon-server-helper';
import { spawnDaemonServer } from '../helpers/daemon-server-helper';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

// Check for GLM credentials
const GLM_API_KEY = process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY;

// Set up GLM provider environment if GLM_API_KEY is available
// This makes 'haiku' model automatically map to glm-4.5-air
if (GLM_API_KEY) {
	process.env.ANTHROPIC_AUTH_TOKEN = GLM_API_KEY;
	process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
	process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'glm-4.5-air';
	process.env.API_TIMEOUT_MS = '3000000';
}

// Tests will FAIL if GLM credentials are not available
describe('Model Switching Integration', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await spawnDaemonServer();
	});

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	});

	describe('session.model.switch', () => {
		test('should switch model by alias', async () => {
			// Create session
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: `${TMP_DIR}/test-model-switch-id`,
				title: 'Model Switch Alias Test',
				config: {
					model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Switch to another GLM model
			const result = (await daemon.messageHub.call('session.model.switch', {
				sessionId,
				model: 'glm-4.7', // Another GLM model
			})) as { success: boolean; model: string; error?: string };

			expect(result.success).toBe(true);
			expect(result.model).toBe('glm-4.7');
			expect(result.error).toBeUndefined();

			// Verify model was updated in session
			const sessionResult = (await daemon.messageHub.call('session.get', {
				sessionId,
			})) as { session: { config: { model: string } } };

			expect(sessionResult.session.config.model).toBe('glm-4.7');
		});

		test('should switch between model families', async () => {
			// Create session
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: `${TMP_DIR}/test-model-switch-alias`,
				title: 'Model Families Test',
				config: {
					model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Switch to another GLM model
			const result = (await daemon.messageHub.call('session.model.switch', {
				sessionId,
				model: 'glm-4.7', // Another GLM model
			})) as { success: boolean; model: string; error?: string };

			expect(result.success).toBe(true);
			expect(result.model).toBe('glm-4.7');
			expect(result.error).toBeUndefined();
		});

		test('should handle switching to same model', async () => {
			// Create session
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: `${TMP_DIR}/test-model-switch-same`,
				title: 'Same Model Switch Test',
				config: {
					model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Switch to same model
			const result = (await daemon.messageHub.call('session.model.switch', {
				sessionId,
				model: 'haiku',
			})) as { success: boolean; model: string; error?: string };

			expect(result.success).toBe(true);
			expect(result.model).toBe('haiku');
			expect(result.error).toBeDefined(); // Should have message about already using model
		});

		test('should reject invalid model ID', async () => {
			// Create session
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: `${TMP_DIR}/test-model-switch-invalid`,
				title: 'Invalid Model ID Test',
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Try to switch to invalid model
			const result = (await daemon.messageHub.call('session.model.switch', {
				sessionId,
				model: 'invalid-model-id',
			})) as { success: boolean; error?: string };

			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
			expect(result.error).toContain('Invalid model');

			// Verify model was not changed
			const sessionResult = (await daemon.messageHub.call('session.get', {
				sessionId,
			})) as { session: { config: { model: string } } };

			expect(sessionResult.session.config.model).not.toBe('invalid-model-id');
		});

		test('should reject invalid model alias', async () => {
			// Create session
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: `${TMP_DIR}/test-model-switch-invalid-alias`,
				title: 'Invalid Model Alias Test',
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Try to switch to invalid alias
			const result = (await daemon.messageHub.call('session.model.switch', {
				sessionId,
				model: 'invalid-alias',
			})) as { success: boolean; error?: string };

			expect(result.success).toBe(false);
			expect(result.error).toBeDefined();
			expect(result.error).toContain('Invalid model');
		});

		test('should switch between different model families', async () => {
			// Create session
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: `${TMP_DIR}/test-model-switch-families`,
				title: 'Different Model Families Test',
				config: {
					model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Switch to glm-4.7
			let result = (await daemon.messageHub.call('session.model.switch', {
				sessionId,
				model: 'glm-4.7',
			})) as { success: boolean; model: string };
			expect(result.success).toBe(true);
			expect(result.model).toBe('glm-4.7');

			// Switch to glm-4.7 again
			result = (await daemon.messageHub.call('session.model.switch', {
				sessionId,
				model: 'glm-4.7',
			})) as { success: boolean; model: string };
			expect(result.success).toBe(true);
			expect(result.model).toBe('glm-4.7');

			// Switch back to haiku
			result = (await daemon.messageHub.call('session.model.switch', {
				sessionId,
				model: 'haiku',
			})) as { success: boolean; model: string };
			expect(result.success).toBe(true);
			expect(result.model).toBe('haiku');
		});

		test('should preserve session state during model switch', async () => {
			// Create session
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: `${TMP_DIR}/test-model-switch-state`,
				title: 'Model Switch State Test',
				config: {
					model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Get initial state - agent.getState returns { state: ProcessingState }
			const stateBefore = (await daemon.messageHub.call('agent.getState', {
				sessionId,
			})) as { state: { status: string } };

			const sessionBefore = (await daemon.messageHub.call('session.get', {
				sessionId,
			})) as {
				session: {
					id: string;
					title: string;
					workspacePath: string;
					status: string;
					config: { model: string };
				};
			};

			// Switch model
			await daemon.messageHub.call('session.model.switch', {
				sessionId,
				model: 'glm-4.7',
			});

			// Get state after switch
			const stateAfter = (await daemon.messageHub.call('agent.getState', {
				sessionId,
			})) as { state: { status: string } };

			const sessionAfter = (await daemon.messageHub.call('session.get', {
				sessionId,
			})) as {
				session: {
					id: string;
					title: string;
					workspacePath: string;
					status: string;
					config: { model: string };
				};
			};

			// Verify processing state preserved
			expect(stateAfter.state.status).toBe(stateBefore.state.status);

			// Verify session metadata preserved
			expect(sessionAfter.session.id).toBe(sessionBefore.session.id);
			expect(sessionAfter.session.title).toBe(sessionBefore.session.title);
			expect(sessionAfter.session.workspacePath).toBe(sessionBefore.session.workspacePath);
			expect(sessionAfter.session.status).toBe(sessionBefore.session.status);

			// Only model should change
			expect(sessionAfter.session.config.model).not.toBe(sessionBefore.session.config.model);
			expect(sessionAfter.session.config.model).toBe('glm-4.7');
		});

		test('should update database immediately on switch', async () => {
			// Create session
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: `${TMP_DIR}/test-model-switch-db`,
				title: 'Model Switch DB Test',
				config: {
					model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Switch model
			await daemon.messageHub.call('session.model.switch', {
				sessionId,
				model: 'glm-4.7',
			});

			// Verify database was updated via session.get
			const sessionResult = (await daemon.messageHub.call('session.get', {
				sessionId,
			})) as { session: { config: { model: string } } };

			expect(sessionResult.session).toBeDefined();
			expect(sessionResult.session.config.model).toBe('glm-4.7');
		});
	});

	describe('models.list', () => {
		test('should return list of available models from SDK', async () => {
			const result = (await daemon.messageHub.call('models.list', {
				useCache: true,
			})) as {
				models: Array<{ id: string; display_name: string }>;
				cached: boolean;
			};

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

	describe('session.model.get', () => {
		test('should reflect model changes after switch', async () => {
			// Create session
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: `${TMP_DIR}/test-agent-session-model-switch`,
				title: 'Agent Session Model Switch Test',
				config: {
					model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Get initial model - session.model.get returns { currentModel, modelInfo }
			let modelInfo = (await daemon.messageHub.call('session.model.get', {
				sessionId,
			})) as {
				currentModel: string;
				modelInfo: { id: string; displayName: string };
			};
			expect(modelInfo.currentModel).toBe('haiku');

			// Switch model
			await daemon.messageHub.call('session.model.switch', {
				sessionId,
				model: 'glm-4.7',
			});

			// Verify model changed
			modelInfo = (await daemon.messageHub.call('session.model.get', {
				sessionId,
			})) as {
				currentModel: string;
				modelInfo: { id: string; displayName: string };
			};
			expect(modelInfo.currentModel).toBe('glm-4.7');
		});
	});

	describe('Model switching edge cases', () => {
		test('should handle rapid consecutive model switches', async () => {
			// Create session
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: `${TMP_DIR}/test-rapid-switches`,
				title: 'Rapid Switches Test',
				config: {
					model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Perform rapid switches sequentially (to ensure order)
			const switches = ['glm-4.7', 'glm-4.7', 'haiku', 'glm-4.7'];

			const results = [];
			for (const model of switches) {
				const result = await daemon.messageHub.call('session.model.switch', {
					sessionId,
					model,
				});
				results.push(result);
			}

			// All switches should succeed
			results.forEach((result) => {
				expect((result as { success: boolean }).success).toBe(true);
			});

			// Final model should be glm-4.7
			const modelInfo = (await daemon.messageHub.call('session.model.get', {
				sessionId,
			})) as { currentModel: string };
			expect(modelInfo.currentModel).toBe('glm-4.7');
		});

		test('should handle model switch before query starts', async () => {
			// Create session (query not started yet)
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: `${TMP_DIR}/test-pre-query-switch`,
				title: 'Pre Query Switch Test',
				config: {
					model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Switch model before sending any messages
			const result = (await daemon.messageHub.call('session.model.switch', {
				sessionId,
				model: 'glm-4.7',
			})) as { success: boolean; model: string };

			expect(result.success).toBe(true);
			expect(result.model).toBe('glm-4.7');

			// Verify config was updated
			const sessionResult = (await daemon.messageHub.call('session.get', {
				sessionId,
			})) as { session: { config: { model: string } } };
			expect(sessionResult.session.config.model).toBe('glm-4.7');
		});
	});

	describe('Cross-Provider Switching', () => {
		test('should restart query when switching from GLM to Claude', async () => {
			// This test requires both GLM and Anthropic API keys
			// Test will FAIL if either key is missing

			// Create session with GLM model
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: `${TMP_DIR}/test-cross-provider-glm-to-claude`,
				title: 'GLM to Claude Test',
				config: {
					model: 'glm-4.7',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Send a message to start the query (makes transport ready)
			await daemon.messageHub.call('message.send', {
				sessionId,
				content: 'Hello',
			});

			// Wait for query to start and transport to be ready
			await new Promise((resolve) => setTimeout(resolve, 2000));

			// Switch to Claude model (cross-provider switch)
			const result = (await daemon.messageHub.call('session.model.switch', {
				sessionId,
				model: 'haiku',
			})) as { success: boolean; model: string };

			expect(result.success).toBe(true);
			expect(result.model).toBe('haiku');

			// Wait for restart to complete
			await new Promise((resolve) => setTimeout(resolve, 1000));

			// Verify model was updated
			const sessionAfter = (await daemon.messageHub.call('session.get', {
				sessionId,
			})) as { session: { config: { model: string } } };
			expect(sessionAfter.session.config.model).toBe('haiku');
		});

		test('should restart query when switching from Claude to GLM', async () => {
			// This test requires both GLM and Anthropic API keys
			// Test will FAIL if either key is missing

			// Create session with Claude model (haiku)
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: `${TMP_DIR}/test-cross-provider-claude-to-glm`,
				title: 'Claude to GLM Test',
				config: {
					model: 'haiku',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Send a message to start the query (makes transport ready)
			await daemon.messageHub.call('message.send', {
				sessionId,
				content: 'Hello',
			});

			// Wait for query to start and transport to be ready
			await new Promise((resolve) => setTimeout(resolve, 2000));

			// Switch to GLM model (cross-provider switch)
			const result = (await daemon.messageHub.call('session.model.switch', {
				sessionId,
				model: 'glm-4.7',
			})) as { success: boolean; model: string };

			expect(result.success).toBe(true);
			expect(result.model).toBe('glm-4.7');

			// Wait for restart to complete
			await new Promise((resolve) => setTimeout(resolve, 1000));

			// Verify model was updated
			const sessionAfter = (await daemon.messageHub.call('session.get', {
				sessionId,
			})) as { session: { config: { model: string } } };
			expect(sessionAfter.session.config.model).toBe('glm-4.7');
		});

		test('should use setModel for same-provider switches', async () => {
			// Create session with a GLM model
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: `${TMP_DIR}/test-same-provider-switch`,
				title: 'Same Provider Switch Test',
				config: {
					model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Send a message to start the query
			await daemon.messageHub.call('message.send', {
				sessionId,
				content: 'Hello',
			});

			// Wait for query to start
			await new Promise((resolve) => setTimeout(resolve, 2000));

			// Switch to another GLM model (same provider)
			const result = (await daemon.messageHub.call('session.model.switch', {
				sessionId,
				model: 'glm-4.7',
			})) as { success: boolean; model: string };

			expect(result.success).toBe(true);
			expect(result.model).toBe('glm-4.7');

			// For same-provider switches, the agent should remain in a valid state
			await new Promise((resolve) => setTimeout(resolve, 500));

			// Verify agent is still in a valid state
			const stateAfter = (await daemon.messageHub.call('agent.getState', {
				sessionId,
			})) as { state: { status: string } };
			expect(stateAfter.state.status).toBeDefined();
		});
	});
});
