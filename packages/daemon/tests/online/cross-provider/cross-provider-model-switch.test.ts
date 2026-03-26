/**
 * Cross-Provider Model Switching Tests (MiniMax <-> GLM)
 *
 * Tests end-to-end cross-provider model switching between MiniMax and GLM providers.
 *
 * REQUIREMENTS:
 * - Requires BOTH MINIMAX_API_KEY AND (GLM_API_KEY or ZHIPU_API_KEY)
 * - Makes real API calls to both providers (costs money, uses rate limits)
 * - Tests FAIL (not skip) when credentials are absent — by design per CLAUDE.md
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { sendMessage } from '../../helpers/daemon-actions';
import { MinimaxProvider } from '../../../src/lib/providers/minimax-provider';
import { GlmProvider } from '../../../src/lib/providers/glm-provider';

// Temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

/**
 * Hard-fail if credentials are absent — per CLAUDE.md policy.
 * Tests must fail with clear messages when secrets are missing, not silently skip.
 */
function requireProvidersOrFail(): void {
	const hasMinimax = new MinimaxProvider().isAvailable();
	const hasGlm = new GlmProvider().isAvailable();

	if (!hasMinimax || !hasGlm) {
		const missing: string[] = [];
		if (!hasMinimax) missing.push('MINIMAX_API_KEY');
		if (!hasGlm) missing.push('GLM_API_KEY or ZHIPU_API_KEY');
		throw new Error(
			`Cross-provider tests require both MiniMax and GLM credentials. Missing: ${missing.join(', ')}`
		);
	}
}

describe('Cross-Provider Model Switching (MiniMax <-> GLM)', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		requireProvidersOrFail();
		daemon = await createDaemonServer();
	}, 30000);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, 20000);

	describe('1. Room Chat Session Model Switching', () => {
		test('should switch from MiniMax to GLM and continue session', async () => {
			// Create session with MiniMax model
			const createResult = (await daemon.messageHub.request('session.create', {
				workspacePath: `${TMP_DIR}/test-minimax-to-glm-${Date.now()}`,
				title: 'MiniMax to GLM Test',
				config: {
					model: 'MiniMax-M2.5',
					provider: 'minimax',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Verify initial model is MiniMax
			const initialModel = (await daemon.messageHub.request('session.model.get', {
				sessionId,
			})) as { currentModel: string; modelInfo?: { provider: string } };

			expect(initialModel.currentModel).toBe('MiniMax-M2.5');
			expect(initialModel.modelInfo?.provider).toBe('minimax');

			// Switch to GLM
			const switchResult = (await daemon.messageHub.request('session.model.switch', {
				sessionId,
				model: 'glm-5',
				provider: 'glm',
			})) as { success: boolean; model: string; error?: string };

			expect(switchResult.success).toBe(true);
			expect(switchResult.model).toBe('glm-5');

			// Verify model switched in session config
			const sessionResult = (await daemon.messageHub.request('session.get', {
				sessionId,
			})) as { session: { config: { model: string; provider: string } } };

			expect(sessionResult.session.config.model).toBe('glm-5');
			expect(sessionResult.session.config.provider).toBe('glm');

			// Verify model.get RPC also returns new model
			const afterSwitchModel = (await daemon.messageHub.request('session.model.get', {
				sessionId,
			})) as { currentModel: string; modelInfo?: { provider: string } };

			expect(afterSwitchModel.currentModel).toBe('glm-5');
			expect(afterSwitchModel.modelInfo?.provider).toBe('glm');
		});

		test('should switch from GLM to MiniMax and continue session', async () => {
			// Create session with GLM model
			const createResult = (await daemon.messageHub.request('session.create', {
				workspacePath: `${TMP_DIR}/test-glm-to-minimax-${Date.now()}`,
				title: 'GLM to MiniMax Test',
				config: {
					model: 'glm-5',
					provider: 'glm',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Verify initial model is GLM
			const initialModel = (await daemon.messageHub.request('session.model.get', {
				sessionId,
			})) as { currentModel: string; modelInfo?: { provider: string } };

			expect(initialModel.currentModel).toBe('glm-5');
			expect(initialModel.modelInfo?.provider).toBe('glm');

			// Switch to MiniMax
			const switchResult = (await daemon.messageHub.request('session.model.switch', {
				sessionId,
				model: 'MiniMax-M2.5',
				provider: 'minimax',
			})) as { success: boolean; model: string; error?: string };

			expect(switchResult.success).toBe(true);
			expect(switchResult.model).toBe('MiniMax-M2.5');

			// Verify model switched
			const afterSwitchModel = (await daemon.messageHub.request('session.model.get', {
				sessionId,
			})) as { currentModel: string; modelInfo?: { provider: string } };

			expect(afterSwitchModel.currentModel).toBe('MiniMax-M2.5');
			expect(afterSwitchModel.modelInfo?.provider).toBe('minimax');
		});

		test('should handle multiple rapid switches between providers', async () => {
			// Create session
			const createResult = (await daemon.messageHub.request('session.create', {
				workspacePath: `${TMP_DIR}/test-rapid-switches-${Date.now()}`,
				title: 'Rapid Switch Test',
				config: {
					model: 'glm-5',
					provider: 'glm',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Perform rapid switches
			const switches = [
				{ model: 'MiniMax-M2.5', provider: 'minimax' },
				{ model: 'glm-5', provider: 'glm' },
				{ model: 'MiniMax-M2.7', provider: 'minimax' },
				{ model: 'glm-4.7', provider: 'glm' },
			];

			for (const { model, provider } of switches) {
				const result = (await daemon.messageHub.request('session.model.switch', {
					sessionId,
					model,
					provider,
				})) as { success: boolean };

				expect(result.success).toBe(true, `Failed to switch to ${provider}/${model}`);
			}

			// Final model should be glm-4.7
			const finalModel = (await daemon.messageHub.request('session.model.get', {
				sessionId,
			})) as { currentModel: string; modelInfo?: { provider: string } };

			expect(finalModel.currentModel).toBe('glm-4.7');
			expect(finalModel.modelInfo?.provider).toBe('glm');
		});
	});

	describe('2. Cross-Provider Message Delivery', () => {
		test('should send message after model switch to GLM', async () => {
			// Create session with MiniMax
			const createResult = (await daemon.messageHub.request('session.create', {
				workspacePath: `${TMP_DIR}/test-e2e-minimax-to-glm-${Date.now()}`,
				title: 'E2E MiniMax to GLM',
				config: {
					model: 'MiniMax-M2.5',
					provider: 'minimax',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Send message using message.send via helper
			const sendResult = await sendMessage(daemon, sessionId, 'Reply with just the word "ok"');
			expect(sendResult.messageId).toBeTruthy();

			// Switch to GLM
			const switchResult = (await daemon.messageHub.request('session.model.switch', {
				sessionId,
				model: 'glm-5',
				provider: 'glm',
			})) as { success: boolean; model: string };

			expect(switchResult.success).toBe(true);
			expect(switchResult.model).toBe('glm-5');

			// Verify model switched
			const modelAfter = (await daemon.messageHub.request('session.model.get', {
				sessionId,
			})) as { currentModel: string; modelInfo?: { provider: string } };

			expect(modelAfter.currentModel).toBe('glm-5');
			expect(modelAfter.modelInfo?.provider).toBe('glm');

			// Send message to GLM - verify it doesn't crash
			const glmSendResult = await sendMessage(daemon, sessionId, 'Reply with just the word "ok"');
			expect(glmSendResult.messageId).toBeTruthy();
		}, 30000);

		test('should send message after model switch to MiniMax', async () => {
			// Create session with GLM
			const createResult = (await daemon.messageHub.request('session.create', {
				workspacePath: `${TMP_DIR}/test-e2e-glm-to-minimax-${Date.now()}`,
				title: 'E2E GLM to MiniMax',
				config: {
					model: 'glm-5',
					provider: 'glm',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Send message to GLM
			const glmSendResult = await sendMessage(daemon, sessionId, 'Reply with just the word "ok"');
			expect(glmSendResult.messageId).toBeTruthy();

			// Switch to MiniMax
			const switchResult = (await daemon.messageHub.request('session.model.switch', {
				sessionId,
				model: 'MiniMax-M2.5',
				provider: 'minimax',
			})) as { success: boolean; model: string };

			expect(switchResult.success).toBe(true);
			expect(switchResult.model).toBe('MiniMax-M2.5');

			// Verify model switched
			const modelAfter = (await daemon.messageHub.request('session.model.get', {
				sessionId,
			})) as { currentModel: string; modelInfo?: { provider: string } };

			expect(modelAfter.currentModel).toBe('MiniMax-M2.5');
			expect(modelAfter.modelInfo?.provider).toBe('minimax');

			// Send message to MiniMax - verify it doesn't crash
			const minimaxSendResult = await sendMessage(
				daemon,
				sessionId,
				'Reply with just the word "ok"'
			);
			expect(minimaxSendResult.messageId).toBeTruthy();
		}, 30000);
	});

	describe('3. Fallback Settings Configuration', () => {
		test('should store fallback chain configuration via settings.global.update', async () => {
			// NOTE: This verifies fallback settings can be stored, but does NOT test
			// actual trySwitchToFallbackModel behavior (which requires triggering a rate
			// limit error). Testing actual fallback switching would require SDK mocking.

			// Create session with MiniMax
			const createResult = (await daemon.messageHub.request('session.create', {
				workspacePath: `${TMP_DIR}/test-fallback-chain-${Date.now()}`,
				title: 'Fallback Chain Test',
				config: {
					model: 'MiniMax-M2.5',
					provider: 'minimax',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Update settings with fallback chain using correct RPC name
			await daemon.messageHub.request('settings.global.update', {
				updates: {
					fallbackModels: [
						{ model: 'glm-5', provider: 'glm' },
						{ model: 'glm-4.7', provider: 'glm' },
					],
				},
			});

			// Verify fallback chain is stored using correct RPC name
			const settings = (await daemon.messageHub.request('settings.global.get', {})) as {
				fallbackModels?: Array<{ model: string; provider: string }>;
			};

			expect(settings.fallbackModels).toBeDefined();
			expect(settings.fallbackModels!.length).toBeGreaterThan(0);

			// Verify model still reports correctly after config change
			const modelInfo = (await daemon.messageHub.request('session.model.get', {
				sessionId,
			})) as { currentModel: string };

			expect(modelInfo.currentModel).toBe('MiniMax-M2.5');
		});

		test('should read current model correctly for fallback logic', async () => {
			// NOTE: This tests session.model.get RPC works correctly, which is a
			// prerequisite for trySwitchToFallbackModel to work.

			// Create session with GLM
			const createResult = (await daemon.messageHub.request('session.create', {
				workspacePath: `${TMP_DIR}/test-fallback-read-${Date.now()}`,
				title: 'Fallback Read Test',
				config: {
					model: 'glm-5',
					provider: 'glm',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Get current model - this is what trySwitchToFallbackModel calls
			const modelInfo = (await daemon.messageHub.request('session.model.get', {
				sessionId,
			})) as { currentModel: string; modelInfo?: { provider: string } };

			expect(modelInfo.currentModel).toBe('glm-5');
			expect(modelInfo.modelInfo?.provider).toBe('glm');

			// Switch model
			await daemon.messageHub.request('session.model.switch', {
				sessionId,
				model: 'MiniMax-M2.5',
				provider: 'minimax',
			});

			// Verify model changed
			const afterSwitch = (await daemon.messageHub.request('session.model.get', {
				sessionId,
			})) as { currentModel: string; modelInfo?: { provider: string } };

			expect(afterSwitch.currentModel).toBe('MiniMax-M2.5');
			expect(afterSwitch.modelInfo?.provider).toBe('minimax');
		});
	});

	describe('4. SDK Session Continuity After Model Switch', () => {
		test('should restart SDK session correctly after model switch', async () => {
			// Create session with GLM
			const createResult = (await daemon.messageHub.request('session.create', {
				workspacePath: `${TMP_DIR}/test-sdk-restart-${Date.now()}`,
				title: 'SDK Restart Test',
				config: {
					model: 'glm-5',
					provider: 'glm',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Switch to MiniMax
			const switchResult = (await daemon.messageHub.request('session.model.switch', {
				sessionId,
				model: 'MiniMax-M2.5',
				provider: 'minimax',
			})) as { success: boolean };

			expect(switchResult.success).toBe(true);

			// Verify session still exists and is accessible
			const sessionAfter = (await daemon.messageHub.request('session.get', {
				sessionId,
			})) as { session: { id: string; status: string; config: { model: string } } };

			expect(sessionAfter.session.id).toBe(sessionId);
			expect(sessionAfter.session.status).toBeTruthy();
			expect(sessionAfter.session.config.model).toBe('MiniMax-M2.5');

			// Verify model.get returns the new model immediately
			const modelAfter = (await daemon.messageHub.request('session.model.get', {
				sessionId,
			})) as { currentModel: string };

			expect(modelAfter.currentModel).toBe('MiniMax-M2.5');
		});

		test('should maintain session state after model switch', async () => {
			// Create session
			const createResult = (await daemon.messageHub.request('session.create', {
				workspacePath: `${TMP_DIR}/test-context-preservation-${Date.now()}`,
				title: 'Context Preservation Test',
				config: {
					model: 'glm-5',
					provider: 'glm',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Switch model
			await daemon.messageHub.request('session.model.switch', {
				sessionId,
				model: 'MiniMax-M2.5',
				provider: 'minimax',
			});

			// Verify session is still active and accessible
			const sessionAfter = (await daemon.messageHub.request('session.get', {
				sessionId,
			})) as { session: { id: string; status: string } };

			expect(sessionAfter.session.id).toBe(sessionId);
			// Session should remain in active/processing state
			expect(['active', 'processing']).toContain(sessionAfter.session.status);
		});
	});

	describe('5. DB as Source of Truth', () => {
		test('should persist model/provider changes to DB session record', async () => {
			// Create session with GLM
			const createResult = (await daemon.messageHub.request('session.create', {
				workspacePath: `${TMP_DIR}/test-db-truth-${Date.now()}`,
				title: 'DB Truth Test',
				config: {
					model: 'glm-5',
					provider: 'glm',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Verify initial state
			const initial = (await daemon.messageHub.request('session.get', {
				sessionId,
			})) as { session: { config: { model: string; provider: string } } };

			expect(initial.session.config.model).toBe('glm-5');
			expect(initial.session.config.provider).toBe('glm');

			// Switch to MiniMax
			await daemon.messageHub.request('session.model.switch', {
				sessionId,
				model: 'MiniMax-M2.5',
				provider: 'minimax',
			});

			// Verify persisted state via session.get
			const after = (await daemon.messageHub.request('session.get', {
				sessionId,
			})) as { session: { config: { model: string; provider: string } } };

			expect(after.session.config.model).toBe('MiniMax-M2.5');
			expect(after.session.config.provider).toBe('minimax');

			// Verify model.get also returns the new model
			const modelInfo = (await daemon.messageHub.request('session.model.get', {
				sessionId,
			})) as { currentModel: string; modelInfo?: { provider: string } };

			expect(modelInfo.currentModel).toBe('MiniMax-M2.5');
			expect(modelInfo.modelInfo?.provider).toBe('minimax');
		});

		test('should reflect model changes correctly across multiple queries', async () => {
			// Create session
			const createResult = (await daemon.messageHub.request('session.create', {
				workspacePath: `${TMP_DIR}/test-multi-query-${Date.now()}`,
				title: 'Multi Query Test',
				config: {
					model: 'MiniMax-M2.5',
					provider: 'minimax',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Switch to GLM
			await daemon.messageHub.request('session.model.switch', {
				sessionId,
				model: 'glm-5',
				provider: 'glm',
			});

			// Query model multiple times to verify consistency
			for (let i = 0; i < 3; i++) {
				const modelInfo = (await daemon.messageHub.request('session.model.get', {
					sessionId,
				})) as { currentModel: string };

				expect(modelInfo.currentModel).toBe('glm-5');
			}

			// Switch back to MiniMax
			await daemon.messageHub.request('session.model.switch', {
				sessionId,
				model: 'MiniMax-M2.7',
				provider: 'minimax',
			});

			// Query again
			for (let i = 0; i < 3; i++) {
				const modelInfo = (await daemon.messageHub.request('session.model.get', {
					sessionId,
				})) as { currentModel: string };

				expect(modelInfo.currentModel).toBe('MiniMax-M2.7');
			}
		});

		test('should handle provider-specific model aliases correctly', async () => {
			// Test that provider-specific model aliases resolve to canonical IDs

			// Create session with GLM using alias 'glm' (which maps to glm-5)
			const createResult = (await daemon.messageHub.request('session.create', {
				workspacePath: `${TMP_DIR}/test-aliases-${Date.now()}`,
				title: 'Alias Test',
				config: {
					model: 'glm', // alias for glm-5
					provider: 'glm',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Verify model is resolved to full ID
			const modelInfo = (await daemon.messageHub.request('session.model.get', {
				sessionId,
			})) as { currentModel: string };

			// Should resolve to glm-5 (the canonical model for 'glm' alias)
			expect(modelInfo.currentModel).toBe('glm-5');
		});
	});

	describe('Error Handling', () => {
		test('should fail gracefully when switching to non-existent model', async () => {
			// Create session
			const createResult = (await daemon.messageHub.request('session.create', {
				workspacePath: `${TMP_DIR}/test-invalid-model-${Date.now()}`,
				title: 'Invalid Model Test',
				config: {
					model: 'glm-5',
					provider: 'glm',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Try to switch to non-existent model
			const result = (await daemon.messageHub.request('session.model.switch', {
				sessionId,
				model: 'non-existent-model-xyz',
				provider: 'minimax',
			})) as { success: boolean; error?: string };

			expect(result.success).toBe(false);
			expect(result.error).toBeTruthy();
		});

		test('should throw error when switching without provider', async () => {
			// Create session
			const createResult = (await daemon.messageHub.request('session.create', {
				workspacePath: `${TMP_DIR}/test-no-provider-${Date.now()}`,
				title: 'No Provider Test',
				config: {
					model: 'glm-5',
					provider: 'glm',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Try to switch without provider - handler throws, not returns error
			await expect(
				daemon.messageHub.request('session.model.switch', {
					sessionId,
					model: 'MiniMax-M2.5',
				})
			).rejects.toThrow(/provider/i);
		});
	});
});
