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
});

/**
 * Model Switching - system:init model field observation
 *
 * Uses NEOKAI_USE_DEV_PROXY=1 (dev proxy mode).
 *
 * Investigation for Bug 2: Does model switching take effect without code changes?
 *
 * The SDK's `system:init` message is emitted by the SDK subprocess BEFORE any
 * API request, so its `model` field reflects the `--model` CLI flag used when
 * the query was started. By comparing the `model` field before and after a
 * `session.model.switch` call, we can determine whether the new model is honored.
 *
 * If Bug 2 exists (sdkSessionId not cleared during model switch), the resumed
 * session file was created with the old model and the SDK may use the session
 * file's model over the `--model` CLI flag — causing `postSwitchModel` to equal
 * `initialModel` (test fails → forkSession or sdkSessionId-clear fix needed).
 *
 * If Bug 2 does NOT exist (or is already fixed), `postSwitchModel` will differ
 * from `initialModel` (test passes → model switching works correctly).
 *
 * NOTE on dev proxy: The dev proxy mock does not distinguish between models —
 * all API requests return the same mock response. However, `system:init.model`
 * is set by the SDK before any API call, so it correctly reflects the CLI flag
 * even in dev proxy mode. The test result is therefore meaningful.
 *
 * IMPORTANT CAVEAT observed during test run: In dev proxy mode the workspace is
 * a fresh temp directory with no prior Claude session files. The daemon logs show
 * "SDK session file missing for ..., clearing sdkSessionId to start fresh" which
 * means its existing missing-file recovery logic already clears sdkSessionId
 * before the post-switch query. This gives the correct model in system:init
 * but for the WRONG reason — not because session.model.switch clears sdkSessionId,
 * but because the session file never existed. In production (real workspaces),
 * the session file DOES exist, so this recovery does NOT fire and Bug 2 may still
 * manifest. A true verification of Bug 2 requires a real session (not dev proxy)
 * where the session file was created by a prior query turn.
 */
describe('Model Switching - system:init model field observation', () => {
	let daemon: DaemonServerContext;

	beforeAll(async () => {
		daemon = await createDaemonServer();
	}, 15_000);

	afterAll(async () => {
		await daemon?.waitForExit();
	}, 15_000);

	/**
	 * Wait for the next system:init SDK message on a session channel.
	 *
	 * Subscribes to `state.sdkMessages.delta` events and resolves with the full
	 * `system:init` message object (including the `model` field).
	 *
	 * The caller must call this BEFORE the action that triggers a new query turn
	 * (sending a message) to avoid missing the event.
	 *
	 * Adapted from packages/daemon/tests/online/coordinator/coordinator-mode-switch.test.ts
	 */
	function waitForSystemInit(sessionId: string, timeout = 30000): Promise<Record<string, unknown>> {
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
				const addedMessages = delta.added ?? [];

				for (const msg of addedMessages) {
					if (msg.type === 'system' && msg.subtype === 'init') {
						cleanup();
						resolve(msg);
						return;
					}
				}
			});

			// Join the session channel (idempotent — safe to call multiple times)
			daemon.messageHub.joinChannel('session:' + sessionId).catch(() => {
				// Join failed — events may still arrive if channel was already joined
			});
		});
	}

	test('system:init model field should change after session.model.switch (Bug 2 investigation)', async () => {
		const INITIAL_MODEL = 'claude-sonnet-4-20250514';
		const SWITCHED_MODEL = 'claude-haiku-4-5-20251001';

		// Create a session with a known starting model
		const { sessionId } = (await daemon.messageHub.request('session.create', {
			workspacePath: `${TMP_DIR}/test-model-switch-sysinit-${Date.now()}`,
			config: {
				model: INITIAL_MODEL,
				permissionMode: 'acceptEdits',
			},
		})) as { sessionId: string };
		daemon.trackSession(sessionId);

		// --- Phase 1: Capture system:init model BEFORE the first message ---
		// Set up the listener before sending so no event is missed.
		const initialSystemInitPromise = waitForSystemInit(sessionId);
		await sendMessage(daemon, sessionId, 'Say "hello" in one word.');
		const initialSystemInit = await initialSystemInitPromise;

		expect(initialSystemInit.type).toBe('system');
		expect(initialSystemInit.subtype).toBe('init');
		const initialModel = initialSystemInit.model as string | undefined;
		// initialModel may be the full ID or a resolved alias — either is valid
		expect(initialModel).toBeDefined();

		// Wait for the first query to complete before switching
		await waitForIdle(daemon, sessionId, 30000);

		// --- Phase 2: Switch model ---
		const switchResult = (await daemon.messageHub.request('session.model.switch', {
			sessionId,
			model: SWITCHED_MODEL,
			provider: 'anthropic',
		})) as { success: boolean; model?: string };
		expect(switchResult.success).toBe(true);

		// --- Phase 3: Capture system:init model AFTER the switch ---
		// Subscribe AFTER the RPC returns to avoid racing with restart() teardown events.
		// The subscription must be set up before the next message is sent (which triggers
		// the new query turn that emits the system:init we want to observe).
		const postSwitchSystemInitPromise = waitForSystemInit(sessionId);

		await sendMessage(daemon, sessionId, 'Say "world" in one word.');
		const postSwitchSystemInit = await postSwitchSystemInitPromise;

		const postSwitchModel = postSwitchSystemInit.model as string | undefined;

		// Wait for the second query to complete
		await waitForIdle(daemon, sessionId, 30000);

		// --- Evidence assertion ---
		// Pass: postSwitchModel !== initialModel
		//   → The SDK subprocess is using the new model. Model switching works correctly.
		//   → Bug 2 may not exist as described, or is already fixed.
		//
		// Fail: postSwitchModel === initialModel
		//   → The SDK subprocess is still using the old model after the switch.
		//   → Bug 2 confirmed: sdkSessionId must be cleared in restart() (or forkSession used).
		expect(postSwitchModel).toBeDefined();
		expect(postSwitchModel).not.toBe(initialModel);
	}, 60000);
});
