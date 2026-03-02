/**
 * OpenAI Provider Online Tests
 *
 * REQUIREMENTS:
 * - Requires OPENAI_API_KEY environment variable
 * - Makes real API calls (costs money, uses rate limits)
 *
 * MODELS:
 * - Uses gpt-5-mini (cheaper) and gpt-5.3-codex for testing
 *
 * Run with: OPENAI_API_KEY=xxx bun test packages/daemon/tests/online/providers/openai-provider.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle, getProcessingState, getSession } from '../../helpers/daemon-actions';
import type { ContextInfo } from '@neokai/shared';

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

	test('should authenticate and have a simple conversation with gpt-5-mini', async () => {
		if (!process.env.OPENAI_API_KEY) {
			console.log('Skipping - OPENAI_API_KEY not set');
			return;
		}

		// Create session with OpenAI model
		const createResult = (await daemon.messageHub.request('session.create', {
			workspacePath: process.cwd(),
			title: 'OpenAI gpt-5-mini Test',
			config: {
				model: 'gpt-5-mini',
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
	}, 60000);

	test('should authenticate and have a simple conversation with gpt-5.3-codex', async () => {
		if (!process.env.OPENAI_API_KEY) {
			console.log('Skipping - OPENAI_API_KEY not set');
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
	}, 60000);

	test('should handle multi-turn conversation with context retention', async () => {
		if (!process.env.OPENAI_API_KEY) {
			console.log('Skipping - OPENAI_API_KEY not set');
			return;
		}

		// Create session with OpenAI model
		const createResult = (await daemon.messageHub.request('session.create', {
			workspacePath: process.cwd(),
			title: 'OpenAI Multi-turn Test',
			config: {
				model: 'gpt-5-mini',
				permissionMode: 'acceptEdits',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;
		daemon.trackSession(sessionId);

		// Turn 1: Initial question
		const result1 = await sendMessage(
			daemon,
			sessionId,
			'What is 5 + 7? Just reply with the number.'
		);
		expect(result1.messageId).toBeString();

		await waitForIdle(daemon, sessionId, 30000);

		// Turn 2: Follow-up question (tests context retention)
		const result2 = await sendMessage(
			daemon,
			sessionId,
			'Now add 3 to that result. Just reply with the number.'
		);
		expect(result2.messageId).toBeString();
		expect(result2.messageId).not.toBe(result1.messageId);

		await waitForIdle(daemon, sessionId, 30000);

		// Verify state is idle after all turns
		const finalState = await getProcessingState(daemon, sessionId);
		expect(finalState.status).toBe('idle');
	}, 90000); // 90 second timeout for 2 API calls

	test('should track context usage information', async () => {
		if (!process.env.OPENAI_API_KEY) {
			console.log('Skipping - OPENAI_API_KEY not set');
			return;
		}

		// Create session
		const createResult = (await daemon.messageHub.request('session.create', {
			workspacePath: process.cwd(),
			title: 'OpenAI Context Usage Test',
			config: {
				model: 'gpt-5-mini',
				permissionMode: 'acceptEdits',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;
		daemon.trackSession(sessionId);

		// Send message and wait for response
		await sendMessage(daemon, sessionId, 'Say "hello" and nothing else.');
		await waitForIdle(daemon, sessionId, 30000);

		// Get session and check that context info was updated
		const session = await getSession(daemon, sessionId);
		const metadata = session.metadata as {
			lastContextInfo?: ContextInfo;
		} | null;

		const contextInfo = metadata?.lastContextInfo;

		// Verify context info exists and has expected fields
		expect(contextInfo).toBeDefined();
		expect(contextInfo?.totalUsed).toBeGreaterThan(0);
		expect(contextInfo?.totalCapacity).toBeGreaterThan(0);
		expect(contextInfo?.percentUsed).toBeGreaterThanOrEqual(0);
		expect(contextInfo?.percentUsed).toBeLessThanOrEqual(100);

		// Verify API usage is tracked
		expect(contextInfo?.apiUsage).toBeDefined();
		expect(contextInfo?.apiUsage?.inputTokens).toBeGreaterThan(0);
		expect(contextInfo?.apiUsage?.outputTokens).toBeGreaterThan(0);
	}, 60000);
});
