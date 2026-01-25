/**
 * GLM Model Switching Tests
 *
 * Tests for model switching functionality specific to GLM provider.
 * These tests verify that switching TO GLM models works correctly.
 *
 * For generic model switching tests (same-provider Claude switches, validation),
 * see tests/online/providers/model-switch-system-init.test.ts
 *
 * For cross-provider switching tests (Claude <-> GLM with system:init verification),
 * see tests/online/providers/model-switch-system-init.test.ts
 *
 * REQUIREMENTS:
 * - Requires BOTH: (CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY) AND GLM credentials
 * - Makes real API calls to both providers (costs money, uses rate limits)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import 'dotenv/config';
import type { DaemonServerContext } from '../helpers/daemon-server-helper';
import { spawnDaemonServer } from '../helpers/daemon-server-helper';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('GLM Model Switching', () => {
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

	describe('Switch to GLM model', () => {
		test('should switch from Claude to GLM model', async () => {
			// Create session with Claude model
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: `${TMP_DIR}/test-switch-to-glm`,
				title: 'Switch to GLM Test',
				config: {
					model: 'haiku',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Switch to GLM model
			const result = (await daemon.messageHub.call('session.model.switch', {
				sessionId,
				model: 'glm-4.7',
			})) as { success: boolean; model: string; error?: string };

			expect(result.success).toBe(true);
			expect(result.model).toBe('glm-4.7');
			expect(result.error).toBeUndefined();

			// Verify model was updated in session config
			const sessionResult = (await daemon.messageHub.call('session.get', {
				sessionId,
			})) as { session: { config: { model: string } } };

			expect(sessionResult.session.config.model).toBe('glm-4.7');
		});

		test('should preserve session state when switching to GLM', async () => {
			// Create session
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: `${TMP_DIR}/test-glm-state-preservation`,
				title: 'GLM State Preservation Test',
				config: {
					model: 'haiku',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Get initial state
			const sessionBefore = (await daemon.messageHub.call('session.get', {
				sessionId,
			})) as {
				session: {
					id: string;
					title: string;
					workspacePath: string;
					status: string;
				};
			};

			// Switch to GLM model
			await daemon.messageHub.call('session.model.switch', {
				sessionId,
				model: 'glm-4.7',
			});

			// Get state after switch
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

			// Verify session metadata preserved
			expect(sessionAfter.session.id).toBe(sessionBefore.session.id);
			expect(sessionAfter.session.title).toBe(sessionBefore.session.title);
			expect(sessionAfter.session.workspacePath).toBe(sessionBefore.session.workspacePath);
			expect(sessionAfter.session.status).toBe(sessionBefore.session.status);

			// Model should be GLM
			expect(sessionAfter.session.config.model).toBe('glm-4.7');
		});

		// Note: Provider config update tests are in tests/online/providers/model-switch-system-init.test.ts
		// which tests cross-provider switching more thoroughly with system:init verification
	});

	describe('GLM model switching edge cases', () => {
		test('should handle rapid switches involving GLM', async () => {
			// Create session
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: `${TMP_DIR}/test-rapid-glm-switches`,
				title: 'Rapid GLM Switches Test',
				config: {
					model: 'haiku',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Perform rapid switches between Claude and GLM
			const switches = ['glm-4.7', 'haiku', 'glm-4.7', 'sonnet', 'glm-4.7'];

			for (const model of switches) {
				const result = (await daemon.messageHub.call('session.model.switch', {
					sessionId,
					model,
				})) as { success: boolean };
				expect(result.success).toBe(true);
			}

			// Final model should be glm-4.7
			const modelInfo = (await daemon.messageHub.call('session.model.get', {
				sessionId,
			})) as { currentModel: string };
			expect(modelInfo.currentModel).toBe('glm-4.7');
		});

		test('should switch to GLM before first message', async () => {
			// Create session with Claude model
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath: `${TMP_DIR}/test-glm-before-message`,
				title: 'GLM Before Message Test',
				config: {
					model: 'haiku',
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;

			// Switch to GLM before sending any messages
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
});
