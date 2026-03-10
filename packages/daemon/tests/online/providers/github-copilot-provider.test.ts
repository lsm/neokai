/**
 * GitHub Copilot Provider Online Tests
 *
 * REQUIREMENTS:
 * - Requires GitHub Copilot OAuth login (stored in ~/.neokai/auth.json)
 * - Login via Settings > Providers > GitHub Copilot > Login
 * - Makes real API calls (uses GitHub Copilot quota)
 *
 * MODELS:
 * - Uses copilot-sonnet (claude-sonnet-4.6) and copilot-mini (gpt-5-mini) via GitHub Copilot
 *
 * WHAT THESE TESTS PROVE:
 * - The pi-mono code path (GitHub Copilot provider's createQuery) is exercised
 * - Content verification ensures the response came from a real model call
 * - Multi-turn test proves sequential queries work on the pi-mono path
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

/**
 * Extract text from an SDK assistant message
 * Structure: { type: 'assistant', message: { content: [{ type: 'text', text: '...' }] } }
 */
function extractAssistantText(msg: Record<string, unknown>): string {
	const message = msg.message as { content?: unknown };
	if (!message?.content) return '';
	if (typeof message.content === 'string') return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.filter((b: unknown) => (b as { type?: string }).type === 'text')
			.map((b: unknown) => (b as { text?: string }).text ?? '')
			.join('');
	}
	return '';
}

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

	test('should get correct answer via copilot-sonnet (pi-mono path)', async () => {
		// Check if GitHub Copilot is authenticated
		if (!(await isGitHubCopilotAuthenticated())) {
			console.log('Skipping - GitHub Copilot not authenticated. Login via Settings.');
			return;
		}

		// Use copilot-sonnet alias — only GitHubCopilotProvider owns this, guaranteeing
		// the pi-mono path is exercised (not AnthropicProvider which also owns claude-*)
		const createResult = (await daemon.messageHub.request('session.create', {
			workspacePath: `${TMP_DIR}/test-github-copilot-sonnet-${Date.now()}`,
			title: 'GitHub Copilot Claude Sonnet Test',
			config: {
				model: 'copilot-sonnet',
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

		// Verify response content — proves pi-mono path returned a real model response
		const messages = await waitForSdkMessages(daemon, sessionId, { minCount: 1, timeout: 5000 });
		const assistantMessages = messages.sdkMessages.filter(
			(msg) => (msg as { type?: string }).type === 'assistant'
		);
		expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

		// Extract text and verify the model answered correctly
		const responseText = assistantMessages.map(extractAssistantText).join('');
		expect(responseText).toContain('7');
	}, 60000);

	test('should get correct answer via copilot-mini (pi-mono path)', async () => {
		// Check if GitHub Copilot is authenticated
		if (!(await isGitHubCopilotAuthenticated())) {
			console.log('Skipping - GitHub Copilot not authenticated. Login via Settings.');
			return;
		}

		// Use copilot-mini alias — only GitHubCopilotProvider owns this, guaranteeing
		// the pi-mono path is exercised (not OpenAiProvider which also owns gpt-*)
		const createResult = (await daemon.messageHub.request('session.create', {
			workspacePath: `${TMP_DIR}/test-github-copilot-gpt-${Date.now()}`,
			title: 'GitHub Copilot GPT Test',
			config: {
				model: 'copilot-mini',
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

		// Verify response content — proves pi-mono path returned a real model response
		const messages = await waitForSdkMessages(daemon, sessionId, { minCount: 1, timeout: 5000 });
		const assistantMessages = messages.sdkMessages.filter(
			(msg) => (msg as { type?: string }).type === 'assistant'
		);
		expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

		// Extract text and verify the model answered correctly
		const responseText = assistantMessages.map(extractAssistantText).join('');
		expect(responseText).toContain('9');
	}, 60000);

	test('should handle sequential queries (multi-turn pi-mono path)', async () => {
		// Check if GitHub Copilot is authenticated
		if (!(await isGitHubCopilotAuthenticated())) {
			console.log('Skipping - GitHub Copilot not authenticated. Login via Settings.');
			return;
		}

		// Use copilot-sonnet alias to ensure GitHub Copilot pi-mono path is used
		const createResult = (await daemon.messageHub.request('session.create', {
			workspacePath: `${TMP_DIR}/test-github-copilot-multi-turn-${Date.now()}`,
			title: 'GitHub Copilot Multi-turn Test',
			config: {
				model: 'copilot-sonnet',
				permissionMode: 'acceptEdits',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;
		daemon.trackSession(sessionId);

		// First query: math question
		await sendMessage(daemon, sessionId, 'What is 5+3? Reply with just the number.');
		await waitForIdle(daemon, sessionId, 50000);

		let state = await getProcessingState(daemon, sessionId);
		expect(state.status).toBe('idle');

		// Second query: another math question — proves sequential queries work on pi-mono path
		await sendMessage(daemon, sessionId, 'What is 10-4? Reply with just the number.');
		await waitForIdle(daemon, sessionId, 50000);

		state = await getProcessingState(daemon, sessionId);
		expect(state.status).toBe('idle');

		// Verify we got 2 assistant messages (one per query)
		const messages = await waitForSdkMessages(daemon, sessionId, { minCount: 2, timeout: 5000 });
		const assistantMessages = messages.sdkMessages.filter(
			(msg) => (msg as { type?: string }).type === 'assistant'
		);
		expect(assistantMessages.length).toBeGreaterThanOrEqual(2);

		// Verify both queries returned correct answers
		const allResponseText = assistantMessages.map(extractAssistantText).join(' ');
		expect(allResponseText).toContain('8'); // 5+3=8
		expect(allResponseText).toContain('6'); // 10-4=6
	}, 120000);
});
