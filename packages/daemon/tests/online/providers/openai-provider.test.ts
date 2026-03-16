/**
 * OpenAI Provider Online Tests
 *
 * REQUIREMENTS:
 * - OPENAI_API_KEY or CODEX_API_KEY must be set
 * - Requires the `codex` binary on PATH (models are now served via the
 *   AnthropicToCodexBridgeProvider bridge, which wraps codex app-server)
 * - Makes real API calls (costs money, uses rate limits)
 *
 * MODELS:
 * - Uses gpt-5.1-codex-mini (cheaper) and gpt-5.3-codex for testing
 *
 * WHAT THESE TESTS PROVE:
 * - GPT model IDs are correctly owned and routed through AnthropicToCodexBridgeProvider
 * - Content verification ensures the response came from a real model call via the bridge
 * - Multi-turn test proves sequential queries work through the bridge
 *
 * Run with:
 *   OPENAI_API_KEY=xxx bun test packages/daemon/tests/online/providers/openai-provider.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	getProcessingState,
	sendMessage,
	waitForIdle,
	waitForSdkMessages,
} from '../../helpers/daemon-actions';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';

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

describe('OpenAI Provider (Online)', () => {
	let daemon: DaemonServerContext;

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
