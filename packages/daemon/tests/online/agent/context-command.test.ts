/**
 * Context Command Online Tests
 *
 * These tests use the REAL Claude Agent SDK with actual API credentials.
 * They verify that the /context command is sent at turn end and the response
 * is correctly parsed.
 *
 * REQUIREMENTS:
 * - Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Makes real API calls (costs money, uses rate limits)
 *
 * MODEL:
 * - Uses 'haiku-4.5' (faster and cheaper than Sonnet for tests)
 *
 * Test Coverage:
 * 1. /context command is queued after each turn
 * 2. /context response is detected and parsed correctly (source === 'context-command')
 * 3. SDK format categories are parsed (including integer k-notation like '18k')
 * 4. Sub-table rows (e.g. Skills breakdown) don't pollute category breakdown
 * 5. Context info is persisted to session metadata
 * 6. Internal /context handling does not create repeated zero-token result loops
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// Bun automatically loads .env from project root when running tests
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import { sendMessage, waitForIdle, getSession } from '../../helpers/daemon-actions';
import type { ContextInfo } from '@neokai/shared';

interface SDKMessageResult {
	type: string;
	subtype?: string;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
}

describe('Context Command Online Tests', () => {
	let daemon: DaemonServerContext;

	// Skip all tests if no Anthropic credentials (context command requires Claude SDK)
	const hasAnthropicCredentials =
		process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN;

	beforeEach(async () => {
		if (!hasAnthropicCredentials) {
			return; // Skip setup if no credentials
		}
		daemon = await createDaemonServer();
	}, 30000);

	afterEach(
		async () => {
			if (!hasAnthropicCredentials) {
				return; // Skip cleanup if no credentials
			}
			if (daemon) {
				daemon.kill('SIGTERM');
				await daemon.waitForExit();
			}
		},
		{ timeout: 20000 }
	);

	describe('Automatic /context at turn end', () => {
		test('should parse /context replay and produce source=context-command with SDK categories', async () => {
			if (!hasAnthropicCredentials) {
				console.log('Skipping - no Anthropic API credentials');
				return;
			}
			const createResult = (await daemon.messageHub.request('session.create', {
				workspacePath: process.cwd(),
				title: 'Context Command Test',
				config: { model: 'haiku-4.5', permissionMode: 'acceptEdits' },
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			await sendMessage(daemon, sessionId, 'What is 1+1? Answer with just the number.');
			await waitForIdle(daemon, sessionId, 30000);

			const session = await getSession(daemon, sessionId);
			const metadata = session.metadata as {
				lastContextInfo?: ContextInfo;
				messageCount?: number;
			} | null;

			expect(metadata).toBeDefined();
			expect(metadata?.messageCount).toBeGreaterThan(0);
			expect(metadata?.lastContextInfo).toBeDefined();

			const contextInfo = metadata?.lastContextInfo as ContextInfo;

			// source === 'context-command' proves the /context replay message was received and
			// successfully parsed by ContextFetcher.
			expect(contextInfo.source).toBe('context-command');

			// Basic numeric sanity
			expect(contextInfo.model).toBeString();
			expect(contextInfo.totalCapacity).toBeGreaterThan(0);
			expect(contextInfo.percentUsed).toBeGreaterThanOrEqual(0);
			expect(contextInfo.percentUsed).toBeLessThanOrEqual(100);
			expect(contextInfo.totalUsed).toBeGreaterThan(0);

			// Breakdown must exist and have entries
			const categories = Object.keys(contextInfo.breakdown);
			expect(categories.length).toBeGreaterThan(0);

			// SDK 0.2.55 emits these categories; fail loudly if format changes
			const expectedCategories = ['System prompt', 'System tools', 'Messages', 'Free space'];
			for (const expected of expectedCategories) {
				const found = categories.find((cat) => cat.toLowerCase() === expected.toLowerCase());
				expect(found).toBeDefined();
			}

			// Each category must have valid token counts and percentages
			for (const [cat, data] of Object.entries(contextInfo.breakdown)) {
				expect(data.tokens).toBeGreaterThanOrEqual(0);
				if (data.percent !== null) {
					expect(data.percent).toBeGreaterThanOrEqual(0);
					expect(data.percent).toBeLessThanOrEqual(100);
				}
				// System tools are always substantial (thousands of tokens) due to
				// built-in tool definitions — verifies k-notation parsing (e.g. '18k' → 18000)
				if (cat.toLowerCase() === 'system tools') {
					expect(data.tokens).toBeGreaterThan(1000);
				}
			}

			// totalUsed must match the sum of non-free-space categories
			// This verifies ContextFetcher.parseMarkdownContext() recalculation logic
			const summedUsed = Object.entries(contextInfo.breakdown)
				.filter(([cat]) => !cat.toLowerCase().includes('free space'))
				.reduce((sum, [, data]) => sum + data.tokens, 0);
			expect(contextInfo.totalUsed).toBe(summedUsed);
		}, 60000);

		test('should not produce repeated zero-token result messages after one turn', async () => {
			if (!hasAnthropicCredentials) {
				console.log('Skipping - no Anthropic API credentials');
				return;
			}
			const createResult = (await daemon.messageHub.request('session.create', {
				workspacePath: process.cwd(),
				title: 'Context Loop Regression Test',
				config: { model: 'haiku-4.5', permissionMode: 'acceptEdits' },
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			await sendMessage(daemon, sessionId, 'Say hello in one short sentence.');
			await waitForIdle(daemon, sessionId, 60000);

			// Allow any queued internal follow-up to settle, then ensure idle again
			await new Promise((resolve) => setTimeout(resolve, 1500));
			await waitForIdle(daemon, sessionId, 30000);

			const result = (await daemon.messageHub.request('message.sdkMessages', {
				sessionId,
				limit: 200,
			})) as { sdkMessages: SDKMessageResult[] };
			const sdkMessages = result.sdkMessages || [];

			const zeroTokenSuccessResults = sdkMessages.filter((msg) => {
				if (msg.type !== 'result' || msg.subtype !== 'success' || !msg.usage) return false;
				return (
					(msg.usage.input_tokens ?? 0) === 0 &&
					(msg.usage.output_tokens ?? 0) === 0 &&
					(msg.usage.cache_read_input_tokens ?? 0) === 0 &&
					(msg.usage.cache_creation_input_tokens ?? 0) === 0
				);
			});

			// A single internal zero-token result may appear depending on SDK format,
			// but repeated 0->0 loops should never occur.
			expect(zeroTokenSuccessResults.length).toBeLessThanOrEqual(1);
		}, 90000);
	});
});
