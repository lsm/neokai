/**
 * Real SDK Integration Tests
 *
 * WHY NO MOCKS HERE:
 * ------------------
 * These tests use the REAL Claude Agent SDK with actual credentials to verify:
 * 1. The SDK query() function works correctly with both cwd and without
 * 2. Our daemon usage pattern matches the SDK's expected behavior
 * 3. OAuth tokens work correctly with the SDK (officially supported)
 * 4. Network, API, and authentication integration is working end-to-end
 *
 * This complements agent-session-mocked.test.ts which tests AgentSession
 * logic in isolation using mocks.
 *
 * REQUIREMENTS:
 * - Requires ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
 * - Tests are skipped if credentials are not available
 * - Makes real API calls (costs money, uses rate limits)
 */

import { describe, test, expect } from 'bun:test';
import { query } from '@anthropic-ai/claude-agent-sdk';
import 'dotenv/config';
import { hasAnyCredentials } from './test-utils';

describe('Daemon-style SDK Usage', () => {
	const verbose = !!process.env.TEST_VERBOSE;
	const log = verbose ? console.log : () => {};

	test.skipIf(!hasAnyCredentials())(
		'should work with cwd option (like daemon does)',
		async () => {
			log('\n[TEST] Testing with cwd option...');
			log('[TEST] Current working directory:', process.cwd());

			const queryStream = query({
				prompt: 'What is 2+2? Answer with just the number.',
				options: {
					model: 'claude-sonnet-4-5-20250929',
					cwd: process.cwd(), // DAEMON SETS THIS
					permissionMode: 'bypassPermissions',
					allowDangerouslySkipPermissions: true,
					maxTurns: 1,
				},
			});

			log('[TEST] Query stream created, processing...');
			let assistantResponse = '';
			let messageCount = 0;

			for await (const message of queryStream) {
				messageCount++;
				log(`[TEST] Received message #${messageCount}, type: ${message.type}`);

				if (message.type === 'assistant') {
					for (const block of message.message.content) {
						if (block.type === 'text') {
							assistantResponse += block.text;
							log('[TEST] Response:', block.text);
						}
					}
				}
			}

			log('[TEST] Final response:', assistantResponse);
			log('[TEST] Total messages:', messageCount);

			expect(assistantResponse.length).toBeGreaterThan(0);
			expect(messageCount).toBeGreaterThan(0);
			log('[TEST] Success!');
		},
		60000 // 60 second timeout
	);

	test.skipIf(!hasAnyCredentials())(
		'should work WITHOUT cwd option (like original test)',
		async () => {
			log('\n[TEST] Testing WITHOUT cwd option...');

			const queryStream = query({
				prompt: 'What is 2+2? Answer with just the number.',
				options: {
					model: 'claude-sonnet-4-5-20250929',
					// NO cwd option
					permissionMode: 'bypassPermissions',
					allowDangerouslySkipPermissions: true,
					maxTurns: 1,
				},
			});

			log('[TEST] Query stream created, processing...');
			let assistantResponse = '';
			let messageCount = 0;

			for await (const message of queryStream) {
				messageCount++;
				log(`[TEST] Received message #${messageCount}, type: ${message.type}`);

				if (message.type === 'assistant') {
					for (const block of message.message.content) {
						if (block.type === 'text') {
							assistantResponse += block.text;
						}
					}
				}
			}

			log('[TEST] Final response:', assistantResponse);
			log('[TEST] Total messages:', messageCount);

			expect(assistantResponse.length).toBeGreaterThan(0);
			expect(messageCount).toBeGreaterThan(0);
			log('[TEST] Success!');
		},
		60000
	);
});
