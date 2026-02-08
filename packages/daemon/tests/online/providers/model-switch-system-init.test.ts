/**
 * Model Switch System Init Message Test
 *
 * Tests that the system:init message reflects the correct model after switching.
 * This test uses real WebSocket communication like the UI does.
 *
 * REQUIREMENTS:
 * - Same-provider tests: Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Cross-provider tests: Requires BOTH Anthropic AND GLM credentials
 * - Makes real API calls (costs money, uses rate limits)
 *
 * TEST SCENARIOS:
 *
 * Same-Provider Switches (Anthropic only):
 * 1. Switch before first message (Sonnet → Opus)
 * 2. Switch between model families (Sonnet → Haiku)
 * 3. Switch before query starts
 * 4. Switch after query is running (critical test)
 *
 * Cross-Provider Switches (Anthropic + GLM):
 * 1. Switch from Claude to GLM mid-conversation
 * 2. Switch from GLM to Claude mid-conversation
 * 3. Multiple back-and-forth switches
 *
 * This mimics the exact user flow:
 * - User creates session with one model
 * - User switches to different model via UI
 * - User sends a message
 * - MessageInfoDropdown shows the model from system:init message
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
// Bun automatically loads .env from project root when running tests
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle } from '../../helpers/daemon-actions';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

/**
 * Wait for a specific SDK message type
 */
async function waitForSDKMessage(
	daemon: DaemonServerContext,
	sessionId: string,
	messageType: string,
	messageSubtype?: string,
	timeout = 15000
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		let unsubscribe: (() => void) | undefined;
		let resolved = false;

		const cleanup = () => {
			if (!resolved) {
				resolved = true;
				clearTimeout(timer);
				unsubscribe?.();
				daemon.messageHub.leaveRoom('session:' + sessionId);
			}
		};

		const timer = setTimeout(() => {
			cleanup();
			reject(
				new Error(
					`Timeout waiting for SDK message type="${messageType}"${messageSubtype ? `, subtype="${messageSubtype}"` : ''} after ${timeout}ms`
				)
			);
		}, timeout);

		unsubscribe = daemon.messageHub.onEvent('state.sdkMessages.delta', (data: unknown) => {
			if (resolved) return;

			const delta = data as { added?: Array<Record<string, unknown>> };
			const addedMessages = delta.added || [];

			for (const msg of addedMessages) {
				if (msg.type === messageType) {
					// Check subtype if specified
					if (messageSubtype && msg.subtype !== messageSubtype) {
						continue;
					}
					cleanup();
					resolve(msg);
					return;
				}
			}
		});

		// Join the session room so events are routed to this client
		daemon.messageHub.joinRoom('session:' + sessionId);
	});
}

describe('Model Switch System Init Message', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await createDaemonServer();
	}, 30000);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, 20000);

	test('should show correct model in system:init after switching to opus', async () => {
		// 1. Create session with Sonnet model (default)
		const createResult = (await daemon.messageHub.query('session.create', {
			workspacePath: `${TMP_DIR}/test-model-switch-system-init`,
			title: 'Model Switch System Init Test',
			config: {
				model: 'sonnet', // Start with Sonnet
				permissionMode: 'acceptEdits',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;
		daemon.trackSession(sessionId);

		// 2. Switch model to Opus
		const switchResult = (await daemon.messageHub.query('session.model.switch', {
			sessionId,
			model: 'opus',
		})) as { success: boolean; model: string; error?: string };

		expect(switchResult.success).toBe(true);
		expect(switchResult.model).toBe('opus');

		// Verify session config was updated
		const sessionAfterSwitch = (await daemon.messageHub.query('session.get', {
			sessionId,
		})) as { session: { config: { model: string } } };
		expect(sessionAfterSwitch.session.config.model).toBe('opus');

		// 3. Send a message (this triggers SDK to emit system:init)
		// Set up subscription BEFORE sending message to catch system:init
		const systemInitPromise = waitForSDKMessage(daemon, sessionId, 'system', 'init', 15000);

		await sendMessage(daemon, sessionId, 'What is 1+1? Answer with just the number.');

		// 4. Wait for system:init message
		const systemInitMessage = await systemInitPromise;

		// 5. Verify system:init shows Opus model
		expect(systemInitMessage.type).toBe('system');
		expect(systemInitMessage.subtype).toBe('init');
		expect(systemInitMessage.model).toBeDefined();

		// The model field should contain 'opus' (SDK uses short IDs: opus, sonnet, haiku, default)
		// Note: 'default' is the legacy Sonnet identifier, 'sonnet' is the new canonical ID
		const model = systemInitMessage.model as string;
		const isOpusModel = model === 'opus' || model.includes('opus');
		if (!isOpusModel) {
			// Log the actual model value for debugging
			console.error(`Expected model to be 'opus' or contain 'opus', got: '${model}'`);
		}
		expect(isOpusModel).toBe(true);

		// Wait for processing to complete
		await waitForIdle(daemon, sessionId, 20000);

		// Verify final state
		const finalState = (await daemon.messageHub.query('agent.getState', {
			sessionId,
		})) as { state: { status: string } };
		expect(finalState.state.status).toBe('idle');
	}, 30000);

	test('should show correct model in system:init when switching from sonnet to haiku', async () => {
		// Create session with Sonnet
		const createResult = (await daemon.messageHub.query('session.create', {
			workspacePath: `${TMP_DIR}/test-switch-sonnet-to-haiku`,
			title: 'Sonnet to Haiku Test',
			config: {
				model: 'sonnet',
				permissionMode: 'acceptEdits',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;
		daemon.trackSession(sessionId);

		// Switch to Haiku
		const switchResult = (await daemon.messageHub.query('session.model.switch', {
			sessionId,
			model: 'haiku',
		})) as { success: boolean; model: string };

		expect(switchResult.success).toBe(true);
		expect(switchResult.model).toBe('haiku');

		// Send message and wait for system:init
		const systemInitPromise = waitForSDKMessage(daemon, sessionId, 'system', 'init', 15000);
		await sendMessage(daemon, sessionId, 'Say hello. Just respond "Hello".');

		const systemInitMessage = await systemInitPromise;

		// Verify system:init shows Haiku model
		expect(systemInitMessage.type).toBe('system');
		expect(systemInitMessage.subtype).toBe('init');

		const model = systemInitMessage.model as string;
		const isHaikuModel = model === 'haiku' || model.includes('haiku');
		if (!isHaikuModel) {
			console.error(`Expected model to be 'haiku' or contain 'haiku', got: '${model}'`);
		}
		expect(isHaikuModel).toBe(true);

		// Wait for completion
		await waitForIdle(daemon, sessionId, 20000);
	}, 30000);

	test('should show correct model when switching before first message', async () => {
		// Create session
		const createResult = (await daemon.messageHub.query('session.create', {
			workspacePath: `${TMP_DIR}/test-switch-before-first-message`,
			title: 'Switch Before First Message Test',
			config: {
				model: 'sonnet',
				permissionMode: 'acceptEdits',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;
		daemon.trackSession(sessionId);

		// Switch model BEFORE sending any messages
		const switchResult = (await daemon.messageHub.query('session.model.switch', {
			sessionId,
			model: 'haiku',
		})) as { success: boolean; model: string };

		expect(switchResult.success).toBe(true);

		// Send first message - should use Haiku from the start
		const systemInitPromise = waitForSDKMessage(daemon, sessionId, 'system', 'init', 15000);
		await sendMessage(daemon, sessionId, 'What is 2+2? Just the number.');

		const systemInitMessage = await systemInitPromise;

		// System:init should show Haiku (the switched model)
		const model = systemInitMessage.model as string;
		const isHaikuModel = model === 'haiku' || model.includes('haiku');
		if (!isHaikuModel) {
			console.error(`Expected model to be 'haiku' or contain 'haiku', got: '${model}'`);
		}
		expect(isHaikuModel).toBe(true);

		await waitForIdle(daemon, sessionId, 20000);
	}, 30000);

	test('should show correct model when switching AFTER query is already running', async () => {
		// Create session with Sonnet
		const createResult = (await daemon.messageHub.query('session.create', {
			workspacePath: `${TMP_DIR}/test-switch-after-running`,
			title: 'Switch After Running Test',
			config: {
				model: 'sonnet',
				permissionMode: 'acceptEdits',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;
		daemon.trackSession(sessionId);

		// Send first message to START the query with Sonnet
		await sendMessage(daemon, sessionId, 'What is 1+1? Just the number.');
		await waitForIdle(daemon, sessionId, 20000);

		// NOW switch to Opus (query is already running)
		const switchResult = (await daemon.messageHub.query('session.model.switch', {
			sessionId,
			model: 'opus',
		})) as { success: boolean; model: string };

		expect(switchResult.success).toBe(true);
		expect(switchResult.model).toBe('opus');

		// Send second message - should get system:init with Opus
		const systemInitPromise = waitForSDKMessage(daemon, sessionId, 'system', 'init', 15000);
		await sendMessage(daemon, sessionId, 'What is 2+2? Just the number.');

		const systemInitMessage = await systemInitPromise;

		// Verify system:init shows Opus (not Sonnet)
		// The model field should contain 'opus' (SDK uses short IDs: opus, sonnet, haiku, default)
		const model = systemInitMessage.model as string;
		const isOpusModel = model === 'opus' || model.includes('opus');
		if (!isOpusModel) {
			// Log the actual model value for debugging
			console.error(`Expected model to be 'opus' or contain 'opus', got: '${model}'`);
		}
		expect(isOpusModel).toBe(true);

		await waitForIdle(daemon, sessionId, 20000);
	}, 60000);

	describe('Cross-Provider Switching', () => {
		test('should show correct model when switching from Claude to GLM', async () => {
			// Create session with Claude Sonnet
			const createResult = (await daemon.messageHub.query('session.create', {
				workspacePath: `${TMP_DIR}/test-switch-claude-to-glm`,
				title: 'Claude to GLM Test',
				config: {
					model: 'sonnet',
					permissionMode: 'acceptEdits',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Send first message with Claude
			await sendMessage(daemon, sessionId, 'What is 1+1? Just the number.');
			await waitForIdle(daemon, sessionId, 20000);

			// Switch to GLM (cross-provider switch)
			const switchResult = (await daemon.messageHub.query('session.model.switch', {
				sessionId,
				model: 'glm-4.7',
			})) as { success: boolean; model: string };

			expect(switchResult.success).toBe(true);
			expect(switchResult.model).toBe('glm-4.7');

			// Send message with GLM - should get system:init with GLM model
			const systemInitPromise = waitForSDKMessage(daemon, sessionId, 'system', 'init', 15000);
			await sendMessage(daemon, sessionId, 'What is 2+2? Just the number.');

			const systemInitMessage = await systemInitPromise;

			// Verify system:init shows GLM model
			// The SDK's system:init message returns the original GLM model ID (glm-4.7)
			// even though translateModelIdForSdk translates it to 'default' for the query
			const model = systemInitMessage.model as string;
			const isGlmModel = model.includes('glm');
			if (!isGlmModel) {
				console.error(`Expected model to contain 'glm', got: '${model}'`);
			}
			expect(isGlmModel).toBe(true);

			await waitForIdle(daemon, sessionId, 20000);
		}, 60000);

		test('should show correct model when switching from GLM to Claude', async () => {
			// Create session with GLM
			const createResult = (await daemon.messageHub.query('session.create', {
				workspacePath: `${TMP_DIR}/test-switch-glm-to-claude`,
				title: 'GLM to Claude Test',
				config: {
					model: 'glm-4.7',
					permissionMode: 'acceptEdits',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// Send first message with GLM
			await sendMessage(daemon, sessionId, 'What is 1+1? Just the number.');
			await waitForIdle(daemon, sessionId, 20000);

			// Switch to Claude Haiku (cross-provider switch)
			const switchResult = (await daemon.messageHub.query('session.model.switch', {
				sessionId,
				model: 'haiku',
			})) as { success: boolean; model: string };

			expect(switchResult.success).toBe(true);
			expect(switchResult.model).toBe('haiku');

			// Send message with Claude - should get system:init with Claude model
			const systemInitPromise = waitForSDKMessage(daemon, sessionId, 'system', 'init', 15000);
			await sendMessage(daemon, sessionId, 'What is 2+2? Just the number.');

			const systemInitMessage = await systemInitPromise;

			// Verify system:init shows Claude/Haiku model
			const model = systemInitMessage.model as string;
			const isClaudeModel = model.includes('haiku') || model.includes('claude');
			if (!isClaudeModel) {
				console.error(`Expected model to contain 'haiku' or 'claude', got: '${model}'`);
			}
			expect(isClaudeModel).toBe(true);

			await waitForIdle(daemon, sessionId, 20000);
		}, 60000);

		test('should handle multiple cross-provider switches', async () => {
			// Create session with Claude Sonnet
			const createResult = (await daemon.messageHub.query('session.create', {
				workspacePath: `${TMP_DIR}/test-multiple-cross-provider-switches`,
				title: 'Multiple Cross-Provider Switches Test',
				config: {
					model: 'sonnet',
					permissionMode: 'acceptEdits',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			// 1. Start with Sonnet
			let systemInitPromise = waitForSDKMessage(daemon, sessionId, 'system', 'init', 15000);
			await sendMessage(daemon, sessionId, 'Message 1');
			let systemInitMessage = await systemInitPromise;
			let model = systemInitMessage.model as string;
			const isValidModel =
				model.includes('sonnet') || model.includes('claude') || model === 'default';
			if (!isValidModel) {
				console.error(`Expected model to be Sonnet, got: '${model}'`);
			}
			expect(isValidModel).toBe(true);
			await waitForIdle(daemon, sessionId, 20000);

			// 2. Switch to GLM
			await daemon.messageHub.query('session.model.switch', {
				sessionId,
				model: 'glm-4.7',
			});
			systemInitPromise = waitForSDKMessage(daemon, sessionId, 'system', 'init', 15000);
			await sendMessage(daemon, sessionId, 'Message 2');
			systemInitMessage = await systemInitPromise;
			model = systemInitMessage.model as string;
			// The SDK's system:init message returns the original GLM model ID
			const isGlmModel = model.includes('glm');
			if (!isGlmModel) {
				console.error(`Expected model to contain 'glm', got: '${model}'`);
			}
			expect(isGlmModel).toBe(true);
			await waitForIdle(daemon, sessionId, 20000);

			// 3. Switch back to Claude Haiku
			await daemon.messageHub.query('session.model.switch', {
				sessionId,
				model: 'haiku',
			});
			systemInitPromise = waitForSDKMessage(daemon, sessionId, 'system', 'init', 15000);
			await sendMessage(daemon, sessionId, 'Message 3');
			systemInitMessage = await systemInitPromise;
			model = systemInitMessage.model as string;
			const isHaikuModel = model.includes('haiku') || model.includes('claude');
			if (!isHaikuModel) {
				console.error(`Expected model to contain 'haiku' or 'claude', got: '${model}'`);
			}
			expect(isHaikuModel).toBe(true);
			await waitForIdle(daemon, sessionId, 20000);

			// 4. Switch to GLM again
			await daemon.messageHub.query('session.model.switch', {
				sessionId,
				model: 'glm-4.7',
			});
			systemInitPromise = waitForSDKMessage(daemon, sessionId, 'system', 'init', 15000);
			await sendMessage(daemon, sessionId, 'Message 4');
			systemInitMessage = await systemInitPromise;
			model = systemInitMessage.model as string;
			// The SDK's system:init message returns the original GLM model ID
			const isGlmModel2 = model.includes('glm');
			if (!isGlmModel2) {
				console.error(`Expected model to contain 'glm', got: '${model}'`);
			}
			expect(isGlmModel2).toBe(true);
			await waitForIdle(daemon, sessionId, 20000);
		}, 120000);
	});
});
