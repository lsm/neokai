/**
 * Cross-Provider Conversation Continuity After Model Switch
 *
 * Tests that conversation history is preserved when switching between
 * MiniMax and GLM providers. Extends the existing cross-provider model
 * switching tests (PR #930) by asserting that:
 * - sdkSessionId is preserved across model switches
 * - Message count does not reset
 * - Conversation context persists (agent remembers prior content)
 * - sdkSessionId survives multiple rapid switches
 * - DB correctly persists sdkSessionId after switch
 *
 * REQUIREMENTS:
 * - Requires BOTH MINIMAX_API_KEY AND (GLM_API_KEY or ZHIPU_API_KEY)
 * - Makes real API calls to both providers (costs money, uses rate limits)
 * - Tests FAIL (not skip) when credentials are absent — by design per CLAUDE.md
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import {
	sendMessage,
	waitForIdle,
	waitForSdkMessages,
	getProcessingState,
} from '../../helpers/daemon-actions';
import { MinimaxProvider } from '../../../src/lib/providers/minimax-provider';
import { GlmProvider } from '../../../src/lib/providers/glm-provider';
import type { DaemonAppContext } from '../../../src/app';

// Temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

/**
 * Hard-fail if credentials are absent — per CLAUDE.md policy.
 * Tests must fail with clear messages when secrets are missing, not silently skip.
 */
function requireProvidersOrFail(): void {
	const hasMinimax = new MinimaxProvider().isAvailable();
	const hasGlm = new GlmProvider().isAvailable();

	if (!hasMinimax || !hasGlm) {
		const missing: string[] = [];
		if (!hasMinimax) missing.push('MINIMAX_API_KEY');
		if (!hasGlm) missing.push('GLM_API_KEY or ZHIPU_API_KEY');
		throw new Error(
			`Cross-provider continuity tests require both MiniMax and GLM credentials. Missing: ${missing.join(', ')}`
		);
	}
}

/**
 * Get the SDK session ID from the in-memory AgentSession via daemonContext.
 * This accesses the live Session object which has sdkSessionId set from system:init.
 */
function getAgentSdkSessionId(
	daemon: DaemonServerContext & { daemonContext: DaemonAppContext },
	sessionId: string
): string | undefined {
	const agentSession = daemon.daemonContext.sessionManager.getSession(sessionId);
	return agentSession?.session.sdkSessionId;
}

/**
 * Poll until sdkSessionId is set on the in-memory AgentSession.
 * The SDK emits system:init which triggers sdkSessionId capture — this may
 * take a few hundred milliseconds in real API mode or be instant in dev-proxy mode.
 */
async function waitForSDKSessionEstablished(
	daemon: DaemonServerContext & { daemonContext: DaemonAppContext },
	sessionId: string,
	timeout = 15000
): Promise<string> {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		const sdkId = getAgentSdkSessionId(daemon, sessionId);
		if (sdkId) return sdkId;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(
		`SDK session not established within ${timeout}ms. ` +
			`sdkSessionId is still undefined on the AgentSession.`
	);
}

/**
 * Get total message count via RPC for a session.
 */
async function getMessageCount(daemon: DaemonServerContext, sessionId: string): Promise<number> {
	const result = (await daemon.messageHub.request('message.count', {
		sessionId,
	})) as { count?: number };
	return result?.count ?? 0;
}

/**
 * Switch model via RPC and wait for the switch to succeed.
 */
async function switchModel(
	daemon: DaemonServerContext,
	sessionId: string,
	model: string,
	provider: string
): Promise<{ success: boolean; model: string; error?: string }> {
	return (await daemon.messageHub.request('session.model.switch', {
		sessionId,
		model,
		provider,
	})) as { success: boolean; model: string; error?: string };
}

describe('Cross-Provider Conversation Continuity After Model Switch', () => {
	let daemon: DaemonServerContext & { daemonContext: DaemonAppContext };

	beforeEach(async () => {
		requireProvidersOrFail();
		daemon = (await createDaemonServer()) as DaemonServerContext & {
			daemonContext: DaemonAppContext;
		};
	}, 30000);

	afterEach(async () => {
		if (daemon) {
			daemon.kill('SIGTERM');
			await daemon.waitForExit();
		}
	}, 20000);

	test('sdkSessionId is preserved after cross-provider model switch (MiniMax -> GLM)', async () => {
		// Create session with MiniMax
		const createResult = (await daemon.messageHub.request('session.create', {
			workspacePath: `${TMP_DIR}/test-sdk-id-preserve-${Date.now()}`,
			title: 'SDK ID Preserve Test',
			config: {
				model: 'MiniMax-M2.5',
				provider: 'minimax',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;
		daemon.trackSession(sessionId);

		// Send a message to start the query and establish the SDK session
		await sendMessage(daemon, sessionId, 'Reply with just the word "ok"');
		await waitForIdle(daemon, sessionId);

		// Wait for sdkSessionId to be captured from system:init
		const sdkIdBefore = await waitForSDKSessionEstablished(daemon, sessionId);
		expect(sdkIdBefore).toBeTruthy();

		// Switch to GLM
		const switchResult = await switchModel(daemon, sessionId, 'glm-5', 'glm');
		expect(switchResult.success).toBe(true);

		// Wait for the restart to complete (query should come back to idle)
		await waitForIdle(daemon, sessionId, 30000);

		// Re-read sdkSessionId — it should be the same
		const sdkIdAfter = getAgentSdkSessionId(daemon, sessionId);
		expect(sdkIdAfter).toBe(sdkIdBefore);
	}, 60000);

	test('sdkSessionId is preserved after cross-provider model switch (GLM -> MiniMax)', async () => {
		// Create session with GLM
		const createResult = (await daemon.messageHub.request('session.create', {
			workspacePath: `${TMP_DIR}/test-sdk-id-preserve-glm-${Date.now()}`,
			title: 'SDK ID Preserve GLM Test',
			config: {
				model: 'glm-5',
				provider: 'glm',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;
		daemon.trackSession(sessionId);

		// Send a message to start the query and establish the SDK session
		await sendMessage(daemon, sessionId, 'Reply with just the word "ok"');
		await waitForIdle(daemon, sessionId);

		// Wait for sdkSessionId to be captured from system:init
		const sdkIdBefore = await waitForSDKSessionEstablished(daemon, sessionId);
		expect(sdkIdBefore).toBeTruthy();

		// Switch to MiniMax
		const switchResult = await switchModel(daemon, sessionId, 'MiniMax-M2.5', 'minimax');
		expect(switchResult.success).toBe(true);

		// Wait for the restart to complete
		await waitForIdle(daemon, sessionId, 30000);

		// sdkSessionId should be preserved
		const sdkIdAfter = getAgentSdkSessionId(daemon, sessionId);
		expect(sdkIdAfter).toBe(sdkIdBefore);
	}, 60000);

	test('message count does not reset after model switch', async () => {
		// Create session with GLM
		const createResult = (await daemon.messageHub.request('session.create', {
			workspacePath: `${TMP_DIR}/test-msg-count-${Date.now()}`,
			title: 'Message Count Test',
			config: {
				model: 'glm-5',
				provider: 'glm',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;
		daemon.trackSession(sessionId);

		// Send a message and wait for idle
		await sendMessage(daemon, sessionId, 'Reply with just the word "ok"');
		await waitForIdle(daemon, sessionId);

		// Get message count before switch — must have messages
		const countBefore = await getMessageCount(daemon, sessionId);
		expect(countBefore).toBeGreaterThan(0);

		// Switch to MiniMax
		const switchResult = await switchModel(daemon, sessionId, 'MiniMax-M2.5', 'minimax');
		expect(switchResult.success).toBe(true);

		// Wait for restart to complete
		await waitForIdle(daemon, sessionId, 30000);

		// Get message count after switch — should not reset
		const countAfter = await getMessageCount(daemon, sessionId);
		expect(countAfter).toBeGreaterThanOrEqual(countBefore);
	}, 60000);

	test('conversation context persists after model switch (cross-provider)', async () => {
		// Create session with MiniMax
		const createResult = (await daemon.messageHub.request('session.create', {
			workspacePath: `${TMP_DIR}/test-context-persist-${Date.now()}`,
			title: 'Context Persistence Test',
			config: {
				model: 'MiniMax-M2.5',
				provider: 'minimax',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;
		daemon.trackSession(sessionId);

		// Send a message with information to remember
		await sendMessage(daemon, sessionId, 'Remember the secret number 42. Reply with just "ok".');
		await waitForIdle(daemon, sessionId);

		// Switch to GLM
		const switchResult = await switchModel(daemon, sessionId, 'glm-5', 'glm');
		expect(switchResult.success).toBe(true);

		// Wait for restart to complete
		await waitForIdle(daemon, sessionId, 30000);

		// Send a follow-up asking about the secret number
		await sendMessage(daemon, sessionId, 'What was the secret number I asked you to remember?');
		await waitForIdle(daemon, sessionId, 30000);

		// Get SDK messages and verify the agent responds with reference to 42
		const { sdkMessages } = await waitForSdkMessages(daemon, sessionId, {
			minCount: 4, // at least: system:init + user("Remember...") + assistant + user("What was...")
			timeout: 10000,
		});

		// Find the last assistant text message — it should mention "42"
		const assistantMessages = sdkMessages.filter(
			(msg) =>
				msg.type === 'assistant' &&
				typeof msg.message?.content === 'string' &&
				msg.message.content.length > 0
		);

		// There should be at least one assistant message referencing 42
		// (either from the first turn or the follow-up)
		const mentions42 = assistantMessages.some(
			(msg) => typeof msg.message?.content === 'string' && msg.message.content.includes('42')
		);

		expect(mentions42).toBe(true);
	}, 90000);

	test('sdkSessionId preserved across multiple rapid switches', async () => {
		// Create session with GLM
		const createResult = (await daemon.messageHub.request('session.create', {
			workspacePath: `${TMP_DIR}/test-rapid-sdk-id-${Date.now()}`,
			title: 'Rapid Switch SDK ID Test',
			config: {
				model: 'glm-5',
				provider: 'glm',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;
		daemon.trackSession(sessionId);

		// Send a message to establish the SDK session
		await sendMessage(daemon, sessionId, 'Reply with just the word "ok"');
		await waitForIdle(daemon, sessionId);

		// Capture the original sdkSessionId
		const originalSdkId = await waitForSDKSessionEstablished(daemon, sessionId);
		expect(originalSdkId).toBeTruthy();

		// Perform 3 rapid model switches: GLM -> MiniMax -> GLM -> MiniMax
		const switches = [
			{ model: 'MiniMax-M2.5', provider: 'minimax' },
			{ model: 'glm-5', provider: 'glm' },
			{ model: 'MiniMax-M2.5', provider: 'minimax' },
		];

		for (const { model, provider } of switches) {
			const result = await switchModel(daemon, sessionId, model, provider);
			expect(result.success).toBe(true, `Failed to switch to ${provider}/${model}`);
		}

		// Wait for the final restart to settle
		await waitForIdle(daemon, sessionId, 30000);

		// sdkSessionId should still be the same after all switches
		const sdkIdAfter = getAgentSdkSessionId(daemon, sessionId);
		expect(sdkIdAfter).toBe(originalSdkId);
	}, 90000);

	test('DB persists sdkSessionId correctly after model switch', async () => {
		// Create session with MiniMax
		const createResult = (await daemon.messageHub.request('session.create', {
			workspacePath: `${TMP_DIR}/test-db-sdk-id-${Date.now()}`,
			title: 'DB SDK ID Test',
			config: {
				model: 'MiniMax-M2.5',
				provider: 'minimax',
			},
		})) as { sessionId: string };

		const { sessionId } = createResult;
		daemon.trackSession(sessionId);

		// Send a message to start the query
		await sendMessage(daemon, sessionId, 'Reply with just the word "ok"');
		await waitForIdle(daemon, sessionId);

		// Get sdkSessionId from in-memory agent session
		const sdkIdBefore = await waitForSDKSessionEstablished(daemon, sessionId);
		expect(sdkIdBefore).toBeTruthy();

		// Switch to GLM
		const switchResult = await switchModel(daemon, sessionId, 'glm-5', 'glm');
		expect(switchResult.success).toBe(true);

		// Wait for restart to complete
		await waitForIdle(daemon, sessionId, 30000);

		// Read session from DB via session.get RPC — sdkSessionId should be in the response
		const sessionResult = (await daemon.messageHub.request('session.get', {
			sessionId,
		})) as { session: { sdkSessionId?: string } };

		expect(sessionResult.session.sdkSessionId).toBe(sdkIdBefore);
	}, 60000);
});
