/**
 * Minimal GLM SDK Test
 *
 * Direct test of Claude Agent SDK with GLM using minimal settings.
 * Uses the transparent provider mapping: 'haiku' model → GLM-4.5-Air
 *
 * Run with: GLM_API_KEY=xxx bun test packages/daemon/tests/online/glm/glm-sdk-minimal.test.ts
 *
 * KEY FINDINGS:
 * 1. SDK works with GLM via ANTHROPIC_AUTH_TOKEN env var (in parent process)
 * 2. Model 'haiku' maps to glm-4.5-air via ANTHROPIC_DEFAULT_HAIKU_MODEL
 * 3. Response text is in `assistant` message's `message.content[0].text`
 * 4. The `result` message also contains the final result text in `result` field
 *
 * REQUIREMENTS:
 * - GLM_API_KEY environment variable (or ZHIPU_API_KEY)
 * - Makes real API calls (costs money, uses rate limits)
 * - Tests will SKIP if credentials are not available
 */

import { describe, test, expect } from 'bun:test';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Get API keys from env
const GLM_API_KEY = process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY;

describe('GLM SDK - Minimal Direct Test', () => {
	test('should work with GLM via haiku model (glm-4.5-air)', async () => {
		if (!GLM_API_KEY) {
			console.log('Skipping test - GLM_API_KEY not set');
			return;
		}

		console.log('[GLM Test] Starting minimal SDK test with haiku → glm-4.5-air...');
		console.log('[GLM Test] API Key:', GLM_API_KEY.substring(0, 10) + '...');

		// Set env vars in parent process - SDK subprocess inherits them
		// This is how the daemon works - ProviderService sets these env vars
		const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
		const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
		const originalTimeout = process.env.API_TIMEOUT_MS;
		const originalNoTraffic = process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
		const originalHaikuModel = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;

		process.env.ANTHROPIC_AUTH_TOKEN = GLM_API_KEY;
		process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
		process.env.API_TIMEOUT_MS = '3000000';
		process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
		// Map 'haiku' to glm-4.5-air
		process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'glm-4.5-air';

		console.log('[GLM Test] Env vars set in parent process:');
		console.log(
			'  ANTHROPIC_AUTH_TOKEN:',
			process.env.ANTHROPIC_AUTH_TOKEN.substring(0, 10) + '...'
		);
		console.log('  ANTHROPIC_BASE_URL:', process.env.ANTHROPIC_BASE_URL);
		console.log('  ANTHROPIC_DEFAULT_HAIKU_MODEL:', process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL);

		const tempDir = mkdtempSync(join(tmpdir(), 'glm-test-'));

		try {
			let responseText = '';
			let messageCount = 0;

			console.log('[GLM Test] Creating SDK query with model: haiku...');

			const agentQuery = query({
				prompt: 'Say "Hello from GLM" in exactly 5 words.',
				options: {
					model: 'haiku', // Maps to glm-4.5-air via env var
					cwd: tempDir,
					permissionMode: 'acceptEdits',
					settingSources: [],
					mcpServers: {},
					maxTurns: 1,
				},
			});

			console.log('[GLM Test] SDK query created, starting iteration...');

			const timeoutPromise = new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error('SDK timeout - no messages received after 20s')), 20000);
			});

			const messagesPromise = (async () => {
				for await (const msg of agentQuery) {
					messageCount++;
					console.log(`[GLM Test] Message ${messageCount}:`, msg.type);

					// Extract text from different message types
					if (msg.type === 'assistant') {
						// Assistant messages contain the full response from the API
						// The content is an array of content blocks
						if (msg.message && msg.message.content) {
							for (const block of msg.message.content) {
								if (block.type === 'text' && block.text) {
									responseText += block.text;
								}
							}
						}
					} else if (msg.type === 'result' && msg.subtype === 'success') {
						// Result message also contains the final text
						console.log('[GLM Test] Result text:', msg.result);
					}
				}
			})();

			await Promise.race([messagesPromise, timeoutPromise]);

			console.log('[GLM Test] Query completed');
			console.log('[GLM Test] Response:', responseText);
			console.log('[GLM Test] Stats:', {
				messageCount,
				responseLength: responseText.length,
			});

			// Verify we got a response from GLM
			expect(responseText.length).toBeGreaterThan(0);
			expect(messageCount).toBeGreaterThan(0);
			console.log('[GLM Test] SUCCESS - GLM works with haiku model!');
		} catch (error) {
			console.error('[GLM Test] Error:', error);
			throw error;
		} finally {
			// Restore original env vars
			if (originalAuthToken !== undefined) {
				process.env.ANTHROPIC_AUTH_TOKEN = originalAuthToken;
			} else {
				delete process.env.ANTHROPIC_AUTH_TOKEN;
			}
			if (originalBaseUrl !== undefined) {
				process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
			} else {
				delete process.env.ANTHROPIC_BASE_URL;
			}
			if (originalTimeout !== undefined) {
				process.env.API_TIMEOUT_MS = originalTimeout;
			} else {
				delete process.env.API_TIMEOUT_MS;
			}
			if (originalNoTraffic !== undefined) {
				process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = originalNoTraffic;
			} else {
				delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
			}
			if (originalHaikuModel !== undefined) {
				process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = originalHaikuModel;
			} else {
				delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
			}

			rmSync(tempDir, { recursive: true, force: true });
		}
	}, 30000);
});
