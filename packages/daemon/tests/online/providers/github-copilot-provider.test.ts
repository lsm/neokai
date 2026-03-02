/**
 * GitHub Copilot Provider Online Tests
 *
 * REQUIREMENTS:
 * - Requires GitHub Copilot OAuth login (stored in ~/.neokai/auth.json)
 * - Login via Settings > Providers > GitHub Copilot > Login
 * - Makes real API calls (uses GitHub Copilot quota)
 *
 * MODELS:
 * - Uses claude-sonnet-4-6 and gpt-5-mini available through GitHub Copilot
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import {
	sendMessage,
	waitForIdle,
	getProcessingState,
	waitForSdkMessages,
} from '../../helpers/daemon-actions';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('GitHub Copilot Provider (Online)', () => {
	let daemon: DaemonServerContext;

	beforeEach(async () => {
		daemon = await createDaemonServer();
	}, 30000);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, 30000);

	/**
	 * Helper to check if GitHub Copilot is authenticated
	 */
	async function isGitHubCopilotAuthenticated(): Promise<boolean> {
		try {
			const result = (await daemon.messageHub.request('auth.providers', {})) as {
				providers: Array<{ id: string; isAuthenticated: boolean }>;
			};

			const copilotProvider = result.providers.find((p) => p.id === 'github-copilot');
			return copilotProvider?.isAuthenticated ?? false;
		} catch {
			return false;
		}
	}

	test('should have simple conversation with claude-sonnet-4-6', async () => {
		// Check if GitHub Copilot is authenticated
		if (!(await isGitHubCopilotAuthenticated())) {
			console.log('Skipping - GitHub Copilot not authenticated. Login via Settings.');
			return;
		}

		// Create session with GitHub Copilot Claude Sonnet model
		const createResult = (await daemon.messageHub.request('session.create', {
			workspacePath: `${TMP_DIR}/test-github-copilot-sonnet-${Date.now()}`,
			title: 'GitHub Copilot Claude Sonnet Test',
			config: {
				model: 'claude-sonnet-4-6',
				permissionMode: 'acceptEdits',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;
		daemon.trackSession(sessionId);

		// Send message and wait for response
		await sendMessage(daemon, sessionId, 'What is 3+4? Reply with just the number.');
		await waitForIdle(daemon, sessionId, 50000);

		// Verify idle state
		const state = await getProcessingState(daemon, sessionId);
		expect(state.status).toBe('idle');

		// Verify we got SDK messages (response content)
		const messages = await waitForSdkMessages(daemon, sessionId, { minCount: 1, timeout: 5000 });
		expect(messages.sdkMessages.length).toBeGreaterThanOrEqual(1);

		// Check that we got an assistant message
		const assistantMessages = messages.sdkMessages.filter(
			(msg) => (msg as { type?: string }).type === 'assistant'
		);
		expect(assistantMessages.length).toBeGreaterThanOrEqual(1);
	}, 60000);

	test('should have simple conversation with gpt-5-mini', async () => {
		// Check if GitHub Copilot is authenticated
		if (!(await isGitHubCopilotAuthenticated())) {
			console.log('Skipping - GitHub Copilot not authenticated. Login via Settings.');
			return;
		}

		// Create session with GitHub Copilot GPT-5 Mini model
		const createResult = (await daemon.messageHub.request('session.create', {
			workspacePath: `${TMP_DIR}/test-github-copilot-gpt-${Date.now()}`,
			title: 'GitHub Copilot GPT Test',
			config: {
				model: 'gpt-5-mini',
				permissionMode: 'acceptEdits',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;
		daemon.trackSession(sessionId);

		// Send message and wait for response
		await sendMessage(daemon, sessionId, 'What is 7+2? Reply with just the number.');
		await waitForIdle(daemon, sessionId, 50000);

		// Verify idle state
		const state = await getProcessingState(daemon, sessionId);
		expect(state.status).toBe('idle');

		// Verify we got SDK messages (response content)
		const messages = await waitForSdkMessages(daemon, sessionId, { minCount: 1, timeout: 5000 });
		expect(messages.sdkMessages.length).toBeGreaterThanOrEqual(1);

		// Check that we got an assistant message
		const assistantMessages = messages.sdkMessages.filter(
			(msg) => (msg as { type?: string }).type === 'assistant'
		);
		expect(assistantMessages.length).toBeGreaterThanOrEqual(1);
	}, 60000);

	test('should handle multi-turn conversation', async () => {
		// Check if GitHub Copilot is authenticated
		if (!(await isGitHubCopilotAuthenticated())) {
			console.log('Skipping - GitHub Copilot not authenticated. Login via Settings.');
			return;
		}

		// Create session with GitHub Copilot Claude Sonnet model
		const createResult = (await daemon.messageHub.request('session.create', {
			workspacePath: `${TMP_DIR}/test-github-copilot-multi-turn-${Date.now()}`,
			title: 'GitHub Copilot Multi-turn Test',
			config: {
				model: 'claude-sonnet-4-6',
				permissionMode: 'acceptEdits',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;
		daemon.trackSession(sessionId);

		// First turn: Ask about a number
		await sendMessage(daemon, sessionId, 'Remember the number 42.');
		await waitForIdle(daemon, sessionId, 50000);

		// Verify first turn completed
		let state = await getProcessingState(daemon, sessionId);
		expect(state.status).toBe('idle');

		// Second turn: Ask about the remembered number
		await sendMessage(
			daemon,
			sessionId,
			'What number did I ask you to remember? Reply with just the number.'
		);
		await waitForIdle(daemon, sessionId, 50000);

		// Verify second turn completed
		state = await getProcessingState(daemon, sessionId);
		expect(state.status).toBe('idle');

		// Verify we got multiple assistant messages (context retention)
		const messages = await waitForSdkMessages(daemon, sessionId, { minCount: 2, timeout: 5000 });
		const assistantMessages = messages.sdkMessages.filter(
			(msg) => (msg as { type?: string }).type === 'assistant'
		);
		expect(assistantMessages.length).toBeGreaterThanOrEqual(2);
	}, 90000);
});
