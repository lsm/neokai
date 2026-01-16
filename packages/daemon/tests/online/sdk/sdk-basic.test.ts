/**
 * Real SDK Integration Tests
 *
 * WHY NO MOCKS HERE:
 * ------------------
 * These tests use the REAL Claude Agent SDK with actual credentials to verify:
 * 1. The SDK query() function works correctly with both cwd and without
 * 2. Our daemon usage pattern matches the SDK's expected behavior
 * 3. Provider-agnostic testing: 'haiku' model → glm-4.5-air (when GLM_API_KEY is set)
 * 4. Network, API, and authentication integration is working end-to-end
 *
 * This complements agent-session-mocked.test.ts which tests AgentSession
 * logic in isolation using mocks.
 *
 * REQUIREMENTS:
 * - Requires GLM_API_KEY (or ZHIPU_API_KEY)
 * - Makes real API calls (costs money, uses rate limits)
 * - Tests will SKIP if credentials are not available
 *
 * MODEL MAPPING:
 * - Uses 'haiku' model (provider-agnostic)
 * - With GLM_API_KEY: haiku → glm-4.5-air (via ANTHROPIC_DEFAULT_HAIKU_MODEL)
 * - With ANTHROPIC_API_KEY: haiku → Claude Haiku
 * - This makes tests provider-agnostic and easy to switch
 *
 * MOCK LEAK PREVENTION:
 * - Explicitly restores any mocks before running these tests
 * - This prevents mock leakage from agent-session-mocked.test.ts
 */

import { describe, test, expect, beforeAll, mock } from 'bun:test';
import { query } from '@anthropic-ai/claude-agent-sdk';
import 'dotenv/config';

// Check for GLM credentials
const GLM_API_KEY = process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY;

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

// Set up GLM provider environment if GLM_API_KEY is available
// This makes 'haiku' model automatically map to glm-4.5-air
if (GLM_API_KEY) {
	process.env.ANTHROPIC_AUTH_TOKEN = GLM_API_KEY;
	process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
	process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'glm-4.5-air';
	process.env.API_TIMEOUT_MS = '3000000';
}

// Tests will FAIL if GLM credentials are not available
describe('Daemon-style SDK Usage', () => {
	test('should work with cwd option (like daemon does)', async () => {
		// ENHANCED DEBUG LOGGING
		console.log('\n========================================');
		console.log('[TEST] Environment:', {
			CI: process.env.CI,
			NODE_ENV: process.env.NODE_ENV,
			hasGlmKey: !!GLM_API_KEY,
			glmKeyPrefix: GLM_API_KEY?.substring(0, 10) + '...',
		});
		console.log('[TEST] Current working directory:', process.cwd());
		console.log('[TEST] Starting test at:', new Date().toISOString());
		console.log('========================================\n');

		const startTime = Date.now();
		let queryStream;

		try {
			console.log('[TEST] Creating query stream...');
			// Use acceptEdits instead of bypassPermissions because GitHub Actions
			// self-hosted runner runs as root, and --dangerously-skip-permissions
			// is rejected when running as root for security reasons
			queryStream = query({
				prompt: 'What is 2+2? Answer with just the number.',
				options: {
					model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
					cwd: process.cwd(), // DAEMON SETS THIS
					permissionMode: 'acceptEdits', // Safe for root, auto-accepts tool edits
					maxTurns: 1,
					// Capture stderr to debug CLI crashes in CI
					stderr: (message: string) => {
						console.log('[TEST] CLI STDERR:', message);
					},
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
	}, 60000); // 60 second timeout

	test('should work WITHOUT cwd option (like original test)', async () => {
		// ENHANCED DEBUG LOGGING
		console.log('\n========================================');
		console.log('[TEST] Testing WITHOUT cwd option');
		console.log('[TEST] Starting test at:', new Date().toISOString());
		console.log('========================================\n');

		const startTime = Date.now();
		let queryStream;

		try {
			console.log('[TEST] Creating query stream WITHOUT cwd...');
			// Use acceptEdits instead of bypassPermissions because GitHub Actions
			// self-hosted runner runs as root, and --dangerously-skip-permissions
			// is rejected when running as root for security reasons
			queryStream = query({
				prompt: 'What is 2+2? Answer with just the number.',
				options: {
					model: 'haiku', // Provider-agnostic: maps to glm-4.5-air with GLM_API_KEY
					// NO cwd option
					permissionMode: 'acceptEdits', // Safe for root, auto-accepts tool edits
					maxTurns: 1,
					// Capture stderr to debug CLI crashes in CI
					stderr: (message: string) => {
						console.log('[TEST] CLI STDERR:', message);
					},
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

		const totalTime = Date.now - startTime;
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
	}, 60000);
});
