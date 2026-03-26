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
	 * IMPORTANT CAVEAT: In dev proxy mode the workspace is a fresh temp dir with no
	 * prior Claude session files. The daemon's missing-file recovery logic clears
	 * sdkSessionId before the post-switch query, so the test passes — but for the
	 * wrong reason. In production (real workspaces), session files exist and the
	 * recovery does NOT fire, so Bug 2 may still manifest there.
	 */
	describe('system:init model field observation (Bug 2 investigation)', () => {
		/**
		 * Wait for the next system:init SDK message on a session channel.
		 * Must be called BEFORE the action that triggers a new query turn.
		 *
		 * Adapted from packages/daemon/tests/online/coordinator/coordinator-mode-switch.test.ts
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

		test('system:init model field should change after session.model.switch', async () => {
			const INITIAL_MODEL = 'claude-sonnet-4-20250514';
			const SWITCHED_MODEL = 'claude-haiku-4-5-20251001';

			const { sessionId } = (await daemon.messageHub.request('session.create', {
				workspacePath: `${TMP_DIR}/test-model-switch-sysinit-${Date.now()}`,
				config: {
					model: INITIAL_MODEL,
					permissionMode: 'acceptEdits',
				},
			})) as { sessionId: string };
			daemon.trackSession(sessionId);

			// --- Phase 1: Capture system:init model BEFORE the first message ---
			const initialSystemInitPromise = waitForSystemInit(sessionId);
			await sendMessage(daemon, sessionId, 'Say "hello" in one word.');
			const initialSystemInit = await initialSystemInitPromise;

			expect(initialSystemInit.type).toBe('system');
			expect(initialSystemInit.subtype).toBe('init');
			const initialModel = initialSystemInit.model as string | undefined;
			expect(initialModel).toBeDefined();

			await waitForIdle(daemon, sessionId, 30000);

			// --- Phase 2: Switch model ---
			const switchResult = (await daemon.messageHub.request('session.model.switch', {
				sessionId,
				model: SWITCHED_MODEL,
				provider: 'anthropic',
			})) as { success: boolean; model?: string };
			expect(switchResult.success).toBe(true);

			// --- Phase 3: Capture system:init model AFTER the switch ---
			// Subscribe AFTER the RPC returns to avoid racing with restart() teardown.
			const postSwitchSystemInitPromise = waitForSystemInit(sessionId);
			await sendMessage(daemon, sessionId, 'Say "world" in one word.');
			const postSwitchSystemInit = await postSwitchSystemInitPromise;

			const postSwitchModel = postSwitchSystemInit.model as string | undefined;
			await waitForIdle(daemon, sessionId, 30000);

			// Pass: postSwitchModel !== initialModel → SDK uses new model (Bug 2 absent/fixed)
			// Fail: postSwitchModel === initialModel → SDK still uses old model (Bug 2 confirmed)
			expect(postSwitchModel).toBeDefined();
			expect(postSwitchModel).not.toBe(initialModel);
		}, 60000);
	});
});
