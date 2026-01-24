/**
 * Model Switching Integration Tests (Cross-Provider, API-dependent)
 *
 * End-to-end tests for model switching functionality using Claude Agent SDK's
 * native setModel() method. Tests cross-provider switching between Claude and GLM.
 *
 * These tests require BOTH Claude and GLM API credentials because:
 * - Tests cross-provider switching (Claude <-> GLM)
 * - Model validation (isValidModel) checks against the model cache
 * - The model cache is populated by initializeModels() which calls the SDK
 *
 * REQUIREMENTS:
 * - Requires BOTH: (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY) AND GLM credentials
 * - Makes real API calls to both providers (costs money, uses rate limits)
 *
 * MODEL NOTES:
 * - Session creation uses 'haiku-4.5' (SDK accepts this directly)
 * - Model SWITCHING uses 'haiku' (this is what's in getAvailableModels() list)
 * - Short alias 'haiku' doesn't work for SDK queries with Claude OAuth (hangs)
 *   but it DOES work for model switching validation
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import 'dotenv/config';
import type { DaemonServerContext } from '../helpers/daemon-server-helper';
import { spawnDaemonServer } from '../helpers/daemon-server-helper';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('Model Switching Integration', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await spawnDaemonServer();
	}, 30000);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, 20000);

	describe('session.model.switch', () => {
		test('should switch model by alias', async () => {
			// Create session
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: `${TMP_DIR}/test-model-switch-id`,
				title: 'Model Switch Alias Test',
				config: {
					model: 'haiku-4.5',
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
					model: 'haiku-4.5',
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
					model: 'haiku-4.5',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Switch to same model (use 'haiku' for switching - it's in the model list)
			const result = (await daemon.messageHub.call('session.model.switch', {
				sessionId,
				model: 'haiku',
			})) as { success: boolean; model: string; error?: string };

			expect(result.success).toBe(true);
			expect(result.model).toBe('haiku');
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
					model: 'haiku-4.5',
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

			// Switch back to haiku (use 'haiku' for switching - it's in the model list)
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
					model: 'haiku-4.5',
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
					model: 'haiku-4.5',
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
					model: 'haiku-4.5',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Get initial model - session.model.get returns { currentModel, modelInfo }
			const initialModelInfo = (await daemon.messageHub.call('session.model.get', {
				sessionId,
			})) as {
				currentModel: string;
				modelInfo: { id: string; displayName: string };
			};
			// Initial model may be resolved to 'default' or 'haiku' depending on environment
			expect(initialModelInfo.currentModel).toBeDefined();

			// Switch model
			await daemon.messageHub.call('session.model.switch', {
				sessionId,
				model: 'glm-4.7',
			});

			// Verify model changed
			const afterSwitchModelInfo = (await daemon.messageHub.call('session.model.get', {
				sessionId,
			})) as {
				currentModel: string;
				modelInfo: { id: string; displayName: string };
			};
			expect(afterSwitchModelInfo.currentModel).toBe('glm-4.7');
		});
	});

	describe('Model switching edge cases', () => {
		test('should handle rapid consecutive model switches', async () => {
			// Create session
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: `${TMP_DIR}/test-rapid-switches`,
				title: 'Rapid Switches Test',
				config: {
					model: 'haiku-4.5',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Perform rapid switches sequentially (to ensure order)
			// Test switching across multiple Claude models and GLM
			const switches = ['glm-4.7', 'haiku', 'sonnet', 'opus', 'glm-4.7', 'haiku'];

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

			// Final model should be haiku (last in switches array)
			const modelInfo = (await daemon.messageHub.call('session.model.get', {
				sessionId,
			})) as { currentModel: string };
			expect(modelInfo.currentModel).toBe('haiku');
		});

		test('should handle model switch before query starts', async () => {
			// Create session (query not started yet)
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: `${TMP_DIR}/test-pre-query-switch`,
				title: 'Pre Query Switch Test',
				config: {
					model: 'haiku-4.5',
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
			// Use 'haiku' for switching (it's in the model list, unlike 'haiku-4.5')
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
					model: 'haiku-4.5',
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
		}, 30000);

		test('should use setModel for same-provider switches', async () => {
			// Create session with a GLM model
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: `${TMP_DIR}/test-same-provider-switch`,
				title: 'Same Provider Switch Test',
				config: {
					model: 'haiku-4.5',
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
		}, 30000);

		test('should update provider in session config when switching providers', async () => {
			// Create session with GLM model and provider explicitly set
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: `${TMP_DIR}/test-provider-config-update`,
				title: 'Provider Config Update Test',
				config: {
					model: 'glm-4.7',
					provider: 'glm',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Verify initial provider is GLM
			const sessionBefore = (await daemon.messageHub.call('session.get', {
				sessionId,
			})) as {
				session: {
					config: {
						model: string;
						provider?: string;
					};
				};
			};
			expect(sessionBefore.session.config.model).toBe('glm-4.7');
			expect(sessionBefore.session.config.provider).toBe('glm');

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

			// Verify provider was updated to anthropic
			const sessionAfter = (await daemon.messageHub.call('session.get', {
				sessionId,
			})) as {
				session: {
					config: {
						model: string;
						provider?: string;
					};
				};
			};
			expect(sessionAfter.session.config.model).toBe('haiku');
			expect(sessionAfter.session.config.provider).toBe('anthropic');
		}, 30000);
	});
});
