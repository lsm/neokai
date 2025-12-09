/**
 * Test to replicate daemon's exact SDK usage
 * This helps us debug why the daemon hangs but tests pass
 */

import { describe, test, expect } from 'bun:test';
import { query } from '@anthropic-ai/claude-agent-sdk';
import 'dotenv/config';
import { hasAnyCredentials } from './test-utils';

describe('Daemon-style SDK Usage', () => {
	const verbose = !!process.env.TEST_VERBOSE;
	const log = verbose ? console.log : () => {};

	// Skip in CI as these tests can be flaky with OAuth tokens
	const skipInCI = process.env.CI === 'true';
	const shouldSkip = !hasAnyCredentials() || skipInCI;

	test.skipIf(shouldSkip)(
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

	test.skipIf(shouldSkip)(
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
