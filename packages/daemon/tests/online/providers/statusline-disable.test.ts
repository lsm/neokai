/**
 * CLAUDE_STATUSLINE=none Disables Statusline Agent Test
 *
 * Tests that when CLAUDE_STATUSLINE=none is set in process.env,
 * the statusline agent is NOT included in the system:init message.
 *
 * REQUIREMENTS:
 * - Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Makes real API calls
 *
 * TEST SCENARIOS:
 * 1. With CLAUDE_STATUSLINE=none: verify statusline agent NOT in agents list
 * 2. Check the actual system:init message content to verify fix is working
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import 'dotenv/config';
import type { DaemonServerContext } from '../helpers/daemon-server-helper';
import { createDaemonServer } from '../helpers/daemon-server-helper';
import { sendMessage, waitForIdle } from '../helpers/daemon-test-helpers';

const TMP_DIR = process.env.TMPDIR || '/tmp';

/**
 * Wait for a system:init SDK message via subscription
 */
async function waitForSystemInit(
	daemon: DaemonServerContext,
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

		daemon.messageHub
			.subscribe(
				'state.sdkMessages.delta',
				(data: unknown) => {
					if (resolved) return;

					const delta = data as { added?: Array<Record<string, unknown>> };
					const addedMessages = delta.added || [];

					for (const msg of addedMessages) {
						if (msg.type === 'system' && msg.subtype === 'init') {
							cleanup();
							resolve(msg);
							return;
						}
					}
				},
				{ sessionId }
			)
			.then((fn) => {
				unsubscribe = fn;
			})
			.catch((error) => {
				cleanup();
				reject(error);
			});
	});
}

describe('CLAUDE_STATUSLINE=none Disables Statusline Agent', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		// Set CLAUDE_STATUSLINE=none before creating daemon server
		process.env.CLAUDE_STATUSLINE = 'none';
		daemon = await createDaemonServer();
	}, 30000);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
		// Clean up env var
		delete process.env.CLAUDE_STATUSLINE;
	}, 20000);

	test('should NOT include statusline agent in system:init when CLAUDE_STATUSLINE=none', async () => {
		// 1. Create session
		const createResult = (await daemon.messageHub.call('session.create', {
			workspacePath: `${TMP_DIR}/test-statusline-none-${Date.now()}`,
			title: 'Statusline None Test',
			config: {
				permissionMode: 'acceptEdits',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;
		daemon.trackSession(sessionId);

		// 2. Send message and capture system:init
		const systemInitPromise = waitForSystemInit(daemon, sessionId);
		await sendMessage(daemon, sessionId, 'What is 1+1? Answer with just the number.');
		const systemInit = await systemInitPromise;

		// 3. Log the actual system:init message for inspection
		console.log('\n=== SYSTEM:INIT MESSAGE CONTENT ===');
		console.log('Type:', systemInit.type);
		console.log('Subtype:', systemInit.subtype);
		console.log('Model:', systemInit.model);
		console.log('Agents:', systemInit.agents);
		console.log('Full message keys:', Object.keys(systemInit));
		console.log('===================================\n');

		// 4. Verify basic structure
		expect(systemInit.type).toBe('system');
		expect(systemInit.subtype).toBe('init');
		expect(systemInit.model).toBeDefined();

		// 5. Check that statusline agent is NOT in the agents list
		const agents = systemInit.agents as string[] | undefined;
		expect(agents).toBeDefined();

		console.log('\n=== CHECKING FOR STATUSLINE AGENT ===');
		console.log('Total agents:', agents!.length);
		console.log('Agent list:', agents);

		// The critical assertion: statusline should NOT be in the agents list
		const hasStatuslineAgent = agents!.some(
			(agent) =>
				agent.toLowerCase().includes('statusline') || agent.toLowerCase().includes('status')
		);

		console.log('Contains statusline agent:', hasStatuslineAgent);
		console.log('====================================\n');

		expect(hasStatuslineAgent).toBe(false);

		// Wait for completion
		await waitForIdle(daemon, sessionId, 60000);
	}, 120000);

	test('should include standard agents but exclude statusline when CLAUDE_STATUSLINE=none', async () => {
		// 1. Create session
		const createResult = (await daemon.messageHub.call('session.create', {
			workspacePath: `${TMP_DIR}/test-statusline-agents-${Date.now()}`,
			title: 'Statusline Agents Test',
			config: {
				permissionMode: 'acceptEdits',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;
		daemon.trackSession(sessionId);

		// 2. Send message and capture system:init
		const systemInitPromise = waitForSystemInit(daemon, sessionId);
		await sendMessage(daemon, sessionId, 'Say hello.');
		const systemInit = await systemInitPromise;

		// 3. Verify we have agents but no statusline
		const agents = systemInit.agents as string[];
		expect(agents).toBeDefined();
		expect(agents.length).toBeGreaterThan(0);

		// Should have standard tools
		const hasStandardTools = agents.some(
			(agent) =>
				agent.toLowerCase().includes('bash') ||
				agent.toLowerCase().includes('edit') ||
				agent.toLowerCase().includes('read')
		);
		expect(hasStandardTools).toBe(true);

		// Should NOT have statusline
		const hasStatusline = agents.some(
			(agent) =>
				agent.toLowerCase().includes('statusline') || agent.toLowerCase().includes('status')
		);
		expect(hasStatusline).toBe(false);

		console.log('\n=== AGENTS VERIFICATION ===');
		console.log('Total agents:', agents.length);
		console.log('Has standard tools:', hasStandardTools);
		console.log('Has statusline:', hasStatusline);
		console.log('Agent list:', agents);
		console.log('============================\n');

		await waitForIdle(daemon, sessionId, 60000);
	}, 120000);
});
