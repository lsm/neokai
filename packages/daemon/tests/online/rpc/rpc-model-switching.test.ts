/**
 * Model Switching Tests
 *
 * Tests for model switching functionality via WebSocket:
 * - session.model.get
 * - session.model.switch error handling
 * - Model switching edge cases
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle } from '../../helpers/daemon-actions';

const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('Model Switching', () => {
	let daemon: DaemonServerContext;

	beforeAll(async () => {
		daemon = await createDaemonServer();
	}, 15_000);

	afterAll(async () => {
		await daemon?.waitForExit();
	}, 15_000);

	async function createSession(
		workspacePath: string,
		config?: Record<string, unknown>
	): Promise<string> {
		const { sessionId } = (await daemon.messageHub.request('session.create', {
			workspacePath,
			config,
		})) as { sessionId: string };
		daemon.trackSession(sessionId);
		return sessionId;
	}

	describe('session.model.get', () => {
		test('should return current model for new session', async () => {
			const sessionId = await createSession('/test/model-get');

			const result = (await daemon.messageHub.request('session.model.get', {
				sessionId,
			})) as { currentModel: string };

			expect(result).toBeDefined();
			expect(result.currentModel).toBeString();
			expect(result.currentModel.length).toBeGreaterThan(0);
		});

		test('should return model info if available', async () => {
			const sessionId = await createSession('/test/model-info', { model: 'default' });

			const result = (await daemon.messageHub.request('session.model.get', {
				sessionId,
			})) as {
				currentModel: string;
				modelInfo?: { id: string; name: string; family: string };
			};

			// 'default' alias may resolve to 'sonnet' if model cache is populated
			expect(result.currentModel).toBeOneOf(['default', 'sonnet']);
			if (result.modelInfo) {
				expect(result.modelInfo.id).toBeOneOf(['default', 'sonnet']);
				expect(result.modelInfo.name).toBeString();
				expect(result.modelInfo.family).toBeOneOf(['opus', 'sonnet', 'haiku']);
			}
		});

		test('should throw error for non-existent session', async () => {
			await expect(
				daemon.messageHub.request('session.model.get', {
					sessionId: 'non-existent-session',
				})
			).rejects.toThrow();
		});
	});

	describe('session.model.switch error handling', () => {
		test('should throw error for non-existent session', async () => {
			await expect(
				daemon.messageHub.request('session.model.switch', {
					sessionId: 'non-existent-session',
					model: 'sonnet',
					provider: 'anthropic',
				})
			).rejects.toThrow();
		});
	});

	/**
	 * Bug 2 investigation: observe system:init.model before and after session.model.switch.
	 *
	 * Uses NEOKAI_USE_DEV_PROXY=1 (dev proxy mode).
	 *
	 * The SDK's `system:init` message is emitted BEFORE any API request, so its
	 * `model` field reflects the `--model` CLI flag used when the query started.
	 * Comparing it before and after a switch shows whether the new model takes effect.
	 *
	 * The test uses CROSS-PROVIDER switching (MiniMax ↔ GLM) so the CLI model
	 * strings genuinely differ:
	 * - MiniMax provider: routingModelId = 'MiniMax-M2.5' (or the MiniMax model if owned)
	 * - GLM provider: routingModelId = 'glm-5' (or the GLM model if owned)
	 *
	 * These produce different ANTHROPIC_DEFAULT_H[SO]NET_MODEL env vars, so
	 * system:init.model will be 'MiniMax-M2.5' vs 'glm-5' — a definitive,
	 * observable difference that proves whether the switch took effect.
	 *
	 * LIMITATION: In dev proxy mode, the SDK mock doesn't write session files, so
	 * sdkSessionId is cleared on restart and every query starts fresh. This means
	 * the test passes even if the SDK ignores --model during resume (Bug 2 masked).
	 * The test IS conclusive in a real environment with actual SDK session files.
	 */
	describe('system:init model field observation (Bug 2 investigation)', () => {
		/**
		 * Wait for the next system:init SDK message on a session channel.
		 * Must be called BEFORE the action that triggers a new query turn.
		 */
		function waitForSystemInit(
			sessionId: string,
			timeout = 30000
		): Promise<Record<string, unknown>> {
			return new Promise((resolve, reject) => {
				let unsubscribe: (() => void) | undefined;
				let resolved = false;

				const cleanup = () => {
					if (!resolved) {
						resolved = true;
						clearTimeout(timer);
						unsubscribe?.();
					}
				};

				const timer = setTimeout(() => {
					cleanup();
					reject(new Error(`Timeout waiting for system:init message after ${timeout}ms`));
				}, timeout);

				// Subscribe FIRST so no events are missed once the channel is joined
				unsubscribe = daemon.messageHub.onEvent('state.sdkMessages.delta', (data: unknown) => {
					if (resolved) return;
					const delta = data as { added?: Array<Record<string, unknown>> };
					for (const msg of delta.added ?? []) {
						if (msg.type === 'system' && msg.subtype === 'init') {
							cleanup();
							resolve(msg);
							return;
						}
					}
				});

				// Join the session channel (idempotent — safe to call multiple times)
				daemon.messageHub.joinChannel('session:' + sessionId).catch(() => {});
			});
		}

		/**
		 * Cross-provider test: MiniMax-M2.5 → glm-5
		 *
		 * Initial: MiniMax-M2.5 (minimax provider):
		 *   ownsModel('MiniMax-M2.5') = true → routingModelId = 'MiniMax-M2.5'
		 *   → ANTHROPIC_DEFAULT_H[SO]NET_MODEL = 'MiniMax-M2.5'
		 *   → system:init.model = 'MiniMax-M2.5'
		 *
		 * Switched: glm-5 (glm provider):
		 *   ownsModel('glm-5') = true → routingModelId = 'glm-5'
		 *   → ANTHROPIC_DEFAULT_H[SO]NET_MODEL = 'glm-5'
		 *   → system:init.model = 'glm-5'
		 *
		 * If SDK honors --model during resume: system:init.model changes (test passes)
		 * If SDK ignores --model during resume: system:init.model stays same (test fails)
		 */
		test('system:init model should differ after switch from MiniMax-M2.5 to glm-5', async () => {
			const INITIAL_MODEL = 'MiniMax-M2.5';
			const INITIAL_PROVIDER = 'minimax';
			const SWITCHED_MODEL = 'glm-5';
			const SWITCHED_PROVIDER = 'glm';

			const { sessionId } = (await daemon.messageHub.request('session.create', {
				workspacePath: `${TMP_DIR}/test-cross-provider-minimax-to-glm-${Date.now()}`,
				config: {
					model: INITIAL_MODEL,
					provider: INITIAL_PROVIDER,
					permissionMode: 'acceptEdits',
				},
			})) as { sessionId: string };
			daemon.trackSession(sessionId);

			// --- Phase 1: Capture system:init model BEFORE the switch ---
			const initialSystemInitPromise = waitForSystemInit(sessionId);
			await sendMessage(daemon, sessionId, 'Say "hello" in one word.');
			const initialSystemInit = await initialSystemInitPromise;

			expect(initialSystemInit.type).toBe('system');
			expect(initialSystemInit.subtype).toBe('init');
			const initialModel = initialSystemInit.model as string | undefined;
			expect(initialModel).toBeDefined();

			await waitForIdle(daemon, sessionId, 30000);

			// --- Phase 2: Switch model (cross-provider MiniMax → GLM) ---
			const switchResult = (await daemon.messageHub.request('session.model.switch', {
				sessionId,
				model: SWITCHED_MODEL,
				provider: SWITCHED_PROVIDER,
			})) as { success: boolean; model?: string };
			expect(switchResult.success).toBe(true);
			expect(switchResult.model).toBe(SWITCHED_MODEL);

			// --- Phase 3: Capture system:init model AFTER the switch ---
			// Subscribe AFTER the RPC returns to avoid racing with restart() teardown.
			const postSwitchSystemInitPromise = waitForSystemInit(sessionId);
			await sendMessage(daemon, sessionId, 'Say "world" in one word.');
			const postSwitchSystemInit = await postSwitchSystemInitPromise;

			const postSwitchModel = postSwitchSystemInit.model as string | undefined;
			await waitForIdle(daemon, sessionId, 30000);

			// Verify models are different — this proves the SDK used the new model
			expect(postSwitchModel).toBeDefined();
			expect(postSwitchModel).not.toBe(initialModel);
			// Initial: MiniMax-M2.5, Post-switch: glm-5
			expect(initialModel).toBe('MiniMax-M2.5');
			expect(postSwitchModel).toBe('glm-5');
		}, 60000);

		/**
		 * Cross-provider test: GLM → MiniMax
		 *
		 * Verifies the model switch works in both directions (GLM → MiniMax).
		 *
		 * Initial: glm-5 (glm provider):
		 *   ownsModel('glm-5') = true → routingModelId = 'glm-5'
		 *   → ANTHROPIC_DEFAULT_H[SO]NET_MODEL = 'glm-5'
		 *   → system:init.model = 'glm-5'
		 *
		 * Switched: MiniMax-M2.5 (minimax provider):
		 *   ownsModel('MiniMax-M2.5') = true → routingModelId = 'MiniMax-M2.5'
		 *   → ANTHROPIC_DEFAULT_H[SO]NET_MODEL = 'MiniMax-M2.5'
		 *   → system:init.model = 'MiniMax-M2.5'
		 */
		test('system:init model should differ after switch from glm-5 to MiniMax-M2.5', async () => {
			const INITIAL_MODEL = 'glm-5';
			const INITIAL_PROVIDER = 'glm';
			const SWITCHED_MODEL = 'MiniMax-M2.5';
			const SWITCHED_PROVIDER = 'minimax';

			const { sessionId } = (await daemon.messageHub.request('session.create', {
				workspacePath: `${TMP_DIR}/test-cross-provider-glm-to-minimax-${Date.now()}`,
				config: {
					model: INITIAL_MODEL,
					provider: INITIAL_PROVIDER,
					permissionMode: 'acceptEdits',
				},
			})) as { sessionId: string };
			daemon.trackSession(sessionId);

			// --- Phase 1: Capture system:init model BEFORE the switch ---
			const initialSystemInitPromise = waitForSystemInit(sessionId);
			await sendMessage(daemon, sessionId, 'Say "hello" in one word.');
			const initialSystemInit = await initialSystemInitPromise;

			expect(initialSystemInit.type).toBe('system');
			expect(initialSystemInit.subtype).toBe('init');
			const initialModel = initialSystemInit.model as string | undefined;
			expect(initialModel).toBeDefined();

			await waitForIdle(daemon, sessionId, 30000);

			// --- Phase 2: Switch model (cross-provider GLM → MiniMax) ---
			const switchResult = (await daemon.messageHub.request('session.model.switch', {
				sessionId,
				model: SWITCHED_MODEL,
				provider: SWITCHED_PROVIDER,
			})) as { success: boolean; model?: string };
			expect(switchResult.success).toBe(true);
			expect(switchResult.model).toBe(SWITCHED_MODEL);

			// --- Phase 3: Capture system:init model AFTER the switch ---
			const postSwitchSystemInitPromise = waitForSystemInit(sessionId);
			await sendMessage(daemon, sessionId, 'Say "world" in one word.');
			const postSwitchSystemInit = await postSwitchSystemInitPromise;

			const postSwitchModel = postSwitchSystemInit.model as string | undefined;
			await waitForIdle(daemon, sessionId, 30000);

			expect(postSwitchModel).toBeDefined();
			expect(postSwitchModel).not.toBe(initialModel);
			// Initial: glm-5, Post-switch: MiniMax-M2.5
			expect(initialModel).toBe('glm-5');
			expect(postSwitchModel).toBe('MiniMax-M2.5');
		}, 60000);
	});
});
