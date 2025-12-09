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
 *
 * MOCK LEAK PREVENTION:
 * - Explicitly restores any mocks before running these tests
 * - This prevents mock leakage from agent-session-mocked.test.ts
 */

import { describe, test, expect, beforeAll, mock } from 'bun:test';
import { query } from '@anthropic-ai/claude-agent-sdk';
import 'dotenv/config';
import { hasAnyCredentials } from './test-utils';

/**
 * CRITICAL: Restore any mocks before running these tests.
 *
 * In CI, agent-session-mocked.test.ts runs before this file and mocks
 * the Claude Agent SDK. Even though it calls mock.restore() in afterAll(),
 * there appears to be a race condition or Bun bug where the mock is still
 * active when this test file runs.
 *
 * Explicitly restoring here ensures we get the real SDK.
 */
beforeAll(() => {
	mock.restore();
});

describe('Daemon-style SDK Usage', () => {
	test.skipIf(!hasAnyCredentials())(
		'should work with cwd option (like daemon does)',
		async () => {
			// ENHANCED DEBUG LOGGING
			console.log('\n========================================');
			console.log('[TEST] Environment:', {
				CI: process.env.CI,
				NODE_ENV: process.env.NODE_ENV,
				hasApiKey: !!process.env.ANTHROPIC_API_KEY,
				hasOAuthToken: !!process.env.CLAUDE_CODE_OAUTH_TOKEN,
				apiKeyPrefix: process.env.ANTHROPIC_API_KEY?.substring(0, 10) + '...',
				oauthTokenPrefix: process.env.CLAUDE_CODE_OAUTH_TOKEN?.substring(0, 10) + '...',
			});
			console.log('[TEST] Current working directory:', process.cwd());
			console.log('[TEST] Starting test at:', new Date().toISOString());
			console.log('========================================\n');

			const startTime = Date.now();
			let queryStream;

			try {
				console.log('[TEST] Creating query stream...');
				queryStream = query({
					prompt: 'What is 2+2? Answer with just the number.',
					options: {
						model: 'claude-sonnet-4-5-20250929',
						cwd: process.cwd(), // DAEMON SETS THIS
						permissionMode: 'bypassPermissions',
						allowDangerouslySkipPermissions: true,
						maxTurns: 1,
					},
				});
				console.log('[TEST] Query stream created successfully');
			} catch (error) {
				console.error('[TEST] FAILED to create query stream:', error);
				throw error;
			}

			console.log('[TEST] Query stream created, processing messages...');
			let assistantResponse = '';
			let messageCount = 0;
			let lastMessageTime = Date.now();
			const messageTypes: string[] = [];

			try {
				for await (const message of queryStream) {
					const timeSinceLastMessage = Date.now() - lastMessageTime;
					lastMessageTime = Date.now();
					messageCount++;
					messageTypes.push(message.type);

					console.log(`[TEST] Message #${messageCount} (${timeSinceLastMessage}ms since last):`, {
						type: message.type,
						hasContent: 'message' in message && 'content' in message.message,
						contentBlocks:
							'message' in message && 'content' in message.message
								? message.message.content.length
								: 0,
					});

					if (message.type === 'assistant') {
						for (const block of message.message.content) {
							console.log('[TEST]   Content block:', {
								type: block.type,
								hasText: 'text' in block,
								textLength: 'text' in block ? block.text.length : 0,
							});
							if (block.type === 'text') {
								assistantResponse += block.text;
								console.log('[TEST]   Text content:', block.text);
							}
						}
					}
				}
			} catch (error) {
				console.error('[TEST] ERROR during message iteration:', error);
				console.error('[TEST] Error stack:', error instanceof Error ? error.stack : 'No stack');
				throw error;
			}

			const totalTime = Date.now() - startTime;
			console.log('\n========================================');
			console.log('[TEST] Test completed:', {
				totalTime: `${totalTime}ms`,
				messageCount,
				messageTypes,
				responseLength: assistantResponse.length,
				response: assistantResponse,
			});
			console.log('========================================\n');

			expect(assistantResponse.length).toBeGreaterThan(0);
			expect(messageCount).toBeGreaterThan(0);
			console.log('[TEST] ✓ All assertions passed');
		},
		60000 // 60 second timeout
	);

	test.skipIf(!hasAnyCredentials())(
		'should work WITHOUT cwd option (like original test)',
		async () => {
			// ENHANCED DEBUG LOGGING
			console.log('\n========================================');
			console.log('[TEST] Testing WITHOUT cwd option');
			console.log('[TEST] Starting test at:', new Date().toISOString());
			console.log('========================================\n');

			const startTime = Date.now();
			let queryStream;

			try {
				console.log('[TEST] Creating query stream WITHOUT cwd...');
				queryStream = query({
					prompt: 'What is 2+2? Answer with just the number.',
					options: {
						model: 'claude-sonnet-4-5-20250929',
						// NO cwd option
						permissionMode: 'bypassPermissions',
						allowDangerouslySkipPermissions: true,
						maxTurns: 1,
					},
				});
				console.log('[TEST] Query stream created successfully');
			} catch (error) {
				console.error('[TEST] FAILED to create query stream:', error);
				throw error;
			}

			console.log('[TEST] Query stream created, processing messages...');
			let assistantResponse = '';
			let messageCount = 0;
			let lastMessageTime = Date.now();
			const messageTypes: string[] = [];

			try {
				for await (const message of queryStream) {
					const timeSinceLastMessage = Date.now() - lastMessageTime;
					lastMessageTime = Date.now();
					messageCount++;
					messageTypes.push(message.type);

					console.log(`[TEST] Message #${messageCount} (${timeSinceLastMessage}ms since last):`, {
						type: message.type,
						hasContent: 'message' in message && 'content' in message.message,
						contentBlocks:
							'message' in message && 'content' in message.message
								? message.message.content.length
								: 0,
					});

					if (message.type === 'assistant') {
						for (const block of message.message.content) {
							console.log('[TEST]   Content block:', {
								type: block.type,
								hasText: 'text' in block,
								textLength: 'text' in block ? block.text.length : 0,
							});
							if (block.type === 'text') {
								assistantResponse += block.text;
								console.log('[TEST]   Text content:', block.text);
							}
						}
					}
				}
			} catch (error) {
				console.error('[TEST] ERROR during message iteration:', error);
				console.error('[TEST] Error stack:', error instanceof Error ? error.stack : 'No stack');
				throw error;
			}

			const totalTime = Date.now() - startTime;
			console.log('\n========================================');
			console.log('[TEST] Test completed:', {
				totalTime: `${totalTime}ms`,
				messageCount,
				messageTypes,
				responseLength: assistantResponse.length,
				response: assistantResponse,
			});
			console.log('========================================\n');

			expect(assistantResponse.length).toBeGreaterThan(0);
			expect(messageCount).toBeGreaterThan(0);
			console.log('[TEST] ✓ All assertions passed');
		},
		60000
	);
});
