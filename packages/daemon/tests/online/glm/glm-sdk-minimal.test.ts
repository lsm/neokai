/**
 * Minimal GLM SDK Test
 *
 * Direct test of Claude Agent SDK with GLM using minimal settings.
 * Tests transparent provider mapping for all model tiers:
 * - 'haiku' model → GLM-4.5-Air
 * - 'default' (sonnet) model → GLM-4.7
 * - 'opus' model → GLM-4.7
 *
 * Run with: GLM_API_KEY=xxx bun test packages/daemon/tests/online/glm/glm-sdk-minimal.test.ts
 *
 * KEY FINDINGS:
 * 1. SDK works with GLM via ANTHROPIC_AUTH_TOKEN env var (in parent process)
 * 2. Model tier mapping via ANTHROPIC_DEFAULT_*_MODEL env vars
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

	test('should work with GLM via default/sonnet model (glm-4.7)', async () => {
		if (!GLM_API_KEY) {
			console.log('Skipping test - GLM_API_KEY not set');
			return;
		}

		console.log('[GLM Test] Starting SDK test with default → glm-4.7...');

		// Set env vars in parent process
		const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
		const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
		const originalTimeout = process.env.API_TIMEOUT_MS;
		const originalNoTraffic = process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
		const originalSonnetModel = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;

		process.env.ANTHROPIC_AUTH_TOKEN = GLM_API_KEY;
		process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
		process.env.API_TIMEOUT_MS = '3000000';
		process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
		// Map 'default' (sonnet tier) to glm-4.7
		process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'glm-4.7';

		console.log(
			'[GLM Test] ANTHROPIC_DEFAULT_SONNET_MODEL:',
			process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
		);

		const tempDir = mkdtempSync(join(tmpdir(), 'glm-test-'));

		try {
			let responseText = '';

			const agentQuery = query({
				prompt: 'Say "Sonnet mapped to GLM" in exactly 5 words.',
				options: {
					model: 'default', // Maps to glm-4.7 via env var
					cwd: tempDir,
					permissionMode: 'acceptEdits',
					settingSources: [],
					mcpServers: {},
					maxTurns: 1,
				},
			});

			const timeoutPromise = new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error('SDK timeout - no messages received after 20s')), 20000);
			});

			const messagesPromise = (async () => {
				for await (const msg of agentQuery) {
					if (msg.type === 'assistant' && msg.message?.content) {
						for (const block of msg.message.content) {
							if (block.type === 'text' && block.text) {
								responseText += block.text;
							}
						}
					}
				}
			})();

			await Promise.race([messagesPromise, timeoutPromise]);

			console.log('[GLM Test] Sonnet Response:', responseText);
			expect(responseText.length).toBeGreaterThan(0);
			console.log('[GLM Test] SUCCESS - GLM works with default (sonnet) model!');
		} finally {
			// Restore env vars
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
			if (originalSonnetModel !== undefined) {
				process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = originalSonnetModel;
			} else {
				delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
			}

			rmSync(tempDir, { recursive: true, force: true });
		}
	}, 30000);

	test('should work with GLM via opus model (glm-4.7)', async () => {
		if (!GLM_API_KEY) {
			console.log('Skipping test - GLM_API_KEY not set');
			return;
		}

		console.log('[GLM Test] Starting SDK test with opus → glm-4.7...');

		// Set env vars in parent process
		const originalAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
		const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;
		const originalTimeout = process.env.API_TIMEOUT_MS;
		const originalNoTraffic = process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
		const originalOpusModel = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;

		process.env.ANTHROPIC_AUTH_TOKEN = GLM_API_KEY;
		process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
		process.env.API_TIMEOUT_MS = '3000000';
		process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
		// Map 'opus' to glm-4.7
		process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'glm-4.7';

		console.log(
			'[GLM Test] ANTHROPIC_DEFAULT_OPUS_MODEL:',
			process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
		);

		const tempDir = mkdtempSync(join(tmpdir(), 'glm-test-'));

		try {
			let responseText = '';

			const agentQuery = query({
				prompt: 'Say "Opus mapped to GLM" in exactly 5 words.',
				options: {
					model: 'opus', // Maps to glm-4.7 via env var
					cwd: tempDir,
					permissionMode: 'acceptEdits',
					settingSources: [],
					mcpServers: {},
					maxTurns: 1,
				},
			});

			const timeoutPromise = new Promise<never>((_, reject) => {
				setTimeout(() => reject(new Error('SDK timeout - no messages received after 20s')), 20000);
			});

			const messagesPromise = (async () => {
				for await (const msg of agentQuery) {
					if (msg.type === 'assistant' && msg.message?.content) {
						for (const block of msg.message.content) {
							if (block.type === 'text' && block.text) {
								responseText += block.text;
							}
						}
					}
				}
			})();

			await Promise.race([messagesPromise, timeoutPromise]);

			console.log('[GLM Test] Opus Response:', responseText);
			expect(responseText.length).toBeGreaterThan(0);
			console.log('[GLM Test] SUCCESS - GLM works with opus model!');
		} finally {
			// Restore env vars
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
			if (originalOpusModel !== undefined) {
				process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = originalOpusModel;
			} else {
				delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
			}

			rmSync(tempDir, { recursive: true, force: true });
		}
	}, 30000);
});
