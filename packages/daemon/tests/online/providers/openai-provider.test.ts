/**
 * OpenAI Provider Online Tests
 *
 * REQUIREMENTS:
 * - One of the following credentials must be set:
 *     OPENAI_API_KEY               — used directly as the API key
 *     CODEX_REFRESH_TOKEN          — exchanged for a fresh access token in beforeAll
 * - Requires the `codex` binary on PATH (models are now served via the
 *   AnthropicCodexProvider bridge, which wraps codex app-server)
 * - Makes real API calls (costs money, uses rate limits)
 *
 * CI behaviour: when running with CI=true, the shard fails hard if no credential
 * is available rather than silently passing with skipped tests.
 *
 * MODELS:
 * - Uses gpt-5.1-codex-mini (cheaper) and gpt-5.3-codex for testing
 *
 * WHAT THESE TESTS PROVE:
 * - GPT model IDs are correctly owned and routed through AnthropicCodexProvider
 * - Content verification ensures the response came from a real model call via the bridge
 * - Multi-turn test proves sequential queries work through the bridge
 *
 * Run with:
 *   OPENAI_API_KEY=xxx bun test packages/daemon/tests/online/providers/openai-provider.test.ts
 *   # or via refresh token:
 *   CODEX_REFRESH_TOKEN=<token> bun test packages/daemon/tests/online/providers/openai-provider.test.ts
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import {
	sendMessage,
	waitForIdle,
	getProcessingState,
	waitForSdkMessages,
} from '../../helpers/daemon-actions';
import { refreshCodexToken } from '../../../src/lib/providers/anthropic-codex-provider';

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

/**
 * Evaluate skip conditions once at module load.
 * Models formerly owned by OpenAiProvider are now served through
 * AnthropicCodexProvider (Codex bridge), so the codex binary is required.
 * CODEX_REFRESH_TOKEN is accepted in place of a direct API key; the token
 * is exchanged for a live access token in beforeAll.
 */
const CI = process.env.CI === 'true';

let SKIP_REASON: string | null = (() => {
	const hasDirectKey = !!(process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY);
	const hasRefreshToken = !!process.env.CODEX_REFRESH_TOKEN;
	if (!hasDirectKey && !hasRefreshToken)
		return 'OPENAI_API_KEY, CODEX_API_KEY, or CODEX_REFRESH_TOKEN not set';
	const which = Bun.spawnSync(['which', 'codex'], { stderr: 'pipe' });
	if (which.exitCode !== 0)
		return 'codex binary not found on PATH (required by AnthropicCodexProvider)';
	return null;
})();

describe('OpenAI Provider (Online)', () => {
	let daemon: DaemonServerContext;

	beforeAll(async () => {
		// In CI, fail hard if no credential is available.
		if (SKIP_REASON) {
			if (CI) throw new Error(`[openai-provider] Credential check failed: ${SKIP_REASON}`);
			return;
		}

		// Exchange CODEX_REFRESH_TOKEN for a live access token when no direct key is present.
		if (
			!process.env.OPENAI_API_KEY &&
			!process.env.CODEX_API_KEY &&
			process.env.CODEX_REFRESH_TOKEN
		) {
			const token = await refreshCodexToken(process.env.CODEX_REFRESH_TOKEN);
			if (!token) {
				SKIP_REASON = 'CODEX_REFRESH_TOKEN exchange failed';
				if (CI) throw new Error(`[openai-provider] ${SKIP_REASON}`);
				return;
			}
			process.env.OPENAI_API_KEY = token.access_token;
		}
	}, 15000);

	beforeEach(async () => {
		daemon = await createDaemonServer();
	}, 30000);

	afterEach(
		async () => {
			if (daemon) {
				daemon.kill('SIGTERM');
				await daemon.waitForExit();
			}
		},
		{ timeout: 30000 }
	);

	test('should get correct answer via gpt-5.1-codex-mini (bridge path)', async () => {
		if (SKIP_REASON) {
			if (CI) throw new Error(`[openai-provider] Skipping — ${SKIP_REASON}`);
			console.log(`[openai-provider] Skipping — ${SKIP_REASON}`);
			return;
		}

		// Create session with OpenAI model
		const createResult = (await daemon.messageHub.request('session.create', {
			workspacePath: process.cwd(),
			title: 'OpenAI gpt-5.1-codex-mini Test',
			config: {
				model: 'gpt-5.1-codex-mini',
				permissionMode: 'acceptEdits',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;
		daemon.trackSession(sessionId);

		// Send message and wait for response
		await sendMessage(daemon, sessionId, 'What is 2+2? Reply with just the number.');
		await waitForIdle(daemon, sessionId, 30000);

		// Verify idle state
		const state = await getProcessingState(daemon, sessionId);
		expect(state.status).toBe('idle');

		// Verify response content — proves bridge path returned a real model response
		const messages = await waitForSdkMessages(daemon, sessionId, { minCount: 1, timeout: 5000 });
		const assistantMessages = messages.sdkMessages.filter(
			(msg) => (msg as { type?: string }).type === 'assistant'
		);
		expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

		// Extract text and verify the model answered correctly
		const responseText = assistantMessages.map(extractAssistantText).join('');
		expect(responseText).toContain('4');
	}, 60000);

	test('should get correct answer via gpt-5.3-codex (bridge path)', async () => {
		if (SKIP_REASON) {
			if (CI) throw new Error(`[openai-provider] Skipping — ${SKIP_REASON}`);
			console.log(`[openai-provider] Skipping — ${SKIP_REASON}`);
			return;
		}

		// Create session with OpenAI model
		const createResult = (await daemon.messageHub.request('session.create', {
			workspacePath: process.cwd(),
			title: 'OpenAI gpt-5.3-codex Test',
			config: {
				model: 'gpt-5.3-codex',
				permissionMode: 'acceptEdits',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;
		daemon.trackSession(sessionId);

		// Send message and wait for response
		await sendMessage(daemon, sessionId, 'What is 3+3? Reply with just the number.');
		await waitForIdle(daemon, sessionId, 30000);

		// Verify idle state
		const state = await getProcessingState(daemon, sessionId);
		expect(state.status).toBe('idle');

		// Verify response content — proves bridge path returned a real model response
		const messages = await waitForSdkMessages(daemon, sessionId, { minCount: 1, timeout: 5000 });
		const assistantMessages = messages.sdkMessages.filter(
			(msg) => (msg as { type?: string }).type === 'assistant'
		);
		expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

		// Extract text and verify the model answered correctly
		const responseText = assistantMessages.map(extractAssistantText).join('');
		expect(responseText).toContain('6');
	}, 60000);

	test('should handle sequential queries (multi-turn bridge path)', async () => {
		if (SKIP_REASON) {
			if (CI) throw new Error(`[openai-provider] Skipping — ${SKIP_REASON}`);
			console.log(`[openai-provider] Skipping — ${SKIP_REASON}`);
			return;
		}

		// Create session with OpenAI model
		const createResult = (await daemon.messageHub.request('session.create', {
			workspacePath: process.cwd(),
			title: 'OpenAI Multi-turn Test',
			config: {
				model: 'gpt-5.1-codex-mini',
				permissionMode: 'acceptEdits',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;
		daemon.trackSession(sessionId);

		// First query: math question
		const result1 = await sendMessage(
			daemon,
			sessionId,
			'What is 5+7? Reply with just the number.'
		);
		expect(result1.messageId).toBeString();
		await waitForIdle(daemon, sessionId, 30000);

		// Second query: another math question — proves sequential queries work on bridge path
		const result2 = await sendMessage(
			daemon,
			sessionId,
			'What is 8-3? Reply with just the number.'
		);
		expect(result2.messageId).toBeString();
		expect(result2.messageId).not.toBe(result1.messageId);
		await waitForIdle(daemon, sessionId, 30000);

		// Verify state is idle after all turns
		const finalState = await getProcessingState(daemon, sessionId);
		expect(finalState.status).toBe('idle');

		// Verify we got 2 assistant messages (one per query)
		const messages = await waitForSdkMessages(daemon, sessionId, { minCount: 2, timeout: 5000 });
		const assistantMessages = messages.sdkMessages.filter(
			(msg) => (msg as { type?: string }).type === 'assistant'
		);
		expect(assistantMessages.length).toBeGreaterThanOrEqual(2);

		// Verify both queries returned correct answers
		const allResponseText = assistantMessages.map(extractAssistantText).join(' ');
		expect(allResponseText).toContain('12'); // 5+7=12
		expect(allResponseText).toContain('5'); // 8-3=5
	}, 90000);
});
