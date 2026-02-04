/**
 * Credential Discovery Integration Tests
 *
 * Tests credential discovery with real file I/O using temporary directories.
 * Verifies that credentials are correctly read from:
 * - ~/.claude/.credentials.json (OAuth tokens)
 * - ~/.claude/settings.json env block (third-party providers)
 *
 * Uses claudeDir parameter injection to isolate tests from real ~/.claude/ directory.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { discoverCredentials } from '../../../src/lib/credential-discovery';

describe('Credential Discovery Integration', () => {
	let tempDir: string;
	let claudeDir: string;
	let originalEnv: Record<string, string | undefined>;

	beforeEach(() => {
		tempDir = join(
			process.env.TMPDIR || '/tmp',
			`neokai-cred-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
		);
		claudeDir = join(tempDir, '.claude');
		mkdirSync(claudeDir, { recursive: true });

		// Save auth-related env vars and clear them
		originalEnv = {
			ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
			CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
			ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
			ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
			ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
			ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
			ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
			API_TIMEOUT_MS: process.env.API_TIMEOUT_MS,
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:
				process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC,
		};

		delete process.env.ANTHROPIC_API_KEY;
		delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
		delete process.env.ANTHROPIC_AUTH_TOKEN;
		delete process.env.ANTHROPIC_BASE_URL;
		delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
		delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
		delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
		delete process.env.API_TIMEOUT_MS;
		delete process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
	});

	afterEach(() => {
		// Restore all saved env vars
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value !== undefined) {
				process.env[key] = value;
			} else {
				delete process.env[key];
			}
		}

		// Clean up temp directory
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe('credentials.json reading', () => {
		test('should discover OAuth token from .credentials.json', () => {
			const credentials = {
				claudeAiOauth: {
					accessToken: 'test-oauth-token-from-file',
					refreshToken: 'test-refresh-token',
					expiresAt: Date.now() + 86400000,
				},
			};
			writeFileSync(join(claudeDir, '.credentials.json'), JSON.stringify(credentials));

			const result = discoverCredentials(claudeDir);

			expect(result.credentialSource).toBe('credentials-file');
			expect(result.errors).toHaveLength(0);
			expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('test-oauth-token-from-file');
		});

		test('should handle malformed .credentials.json gracefully', () => {
			writeFileSync(join(claudeDir, '.credentials.json'), '{ invalid json }');

			const result = discoverCredentials(claudeDir);

			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors[0]).toContain('.credentials.json');
			// Should not crash, should continue
			expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		});

		test('should handle .credentials.json without claudeAiOauth field', () => {
			writeFileSync(
				join(claudeDir, '.credentials.json'),
				JSON.stringify({ someOtherField: 'value' })
			);

			const result = discoverCredentials(claudeDir);

			// No error - file parsed OK, just no relevant data
			expect(result.errors).toHaveLength(0);
			expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		});

		test('should handle .credentials.json with null accessToken', () => {
			writeFileSync(
				join(claudeDir, '.credentials.json'),
				JSON.stringify({ claudeAiOauth: { accessToken: null } })
			);

			const result = discoverCredentials(claudeDir);

			// accessToken is falsy, should not be set
			expect(result.errors).toHaveLength(0);
			expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		});

		test('should NOT read .credentials.json if CLAUDE_CODE_OAUTH_TOKEN already set', () => {
			process.env.CLAUDE_CODE_OAUTH_TOKEN = 'existing-token';

			writeFileSync(
				join(claudeDir, '.credentials.json'),
				JSON.stringify({
					claudeAiOauth: { accessToken: 'file-token-should-not-be-used' },
				})
			);

			const result = discoverCredentials(claudeDir);

			// Existing env var should win
			expect(result.errors).toHaveLength(0);
			expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('existing-token');
		});

		test('should handle missing .claude directory gracefully', () => {
			rmSync(claudeDir, { recursive: true, force: true });
			const result = discoverCredentials(claudeDir);
			expect(result.credentialSource).toBe('none');
		});
	});

	describe('settings.json env block reading', () => {
		test('should inject env vars from settings.json env block', () => {
			const settings = {
				env: {
					ANTHROPIC_AUTH_TOKEN: 'zhipu-api-key',
					ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
					ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
					ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7',
					ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.7',
					API_TIMEOUT_MS: '3000000',
				},
			};
			writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(settings));

			const result = discoverCredentials(claudeDir);

			expect(result.settingsEnvApplied).toBe(6);
			expect(result.credentialSource).toBe('settings-json');
			expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('zhipu-api-key');
			expect(process.env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
			expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-4.5-air');
			expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-4.7');
			expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-4.7');
			expect(process.env.API_TIMEOUT_MS).toBe('3000000');
		});

		test('should NOT overwrite existing env vars from settings.json', () => {
			process.env.ANTHROPIC_AUTH_TOKEN = 'explicit-token';

			const settings = {
				env: {
					ANTHROPIC_AUTH_TOKEN: 'settings-token-should-not-win',
					ANTHROPIC_BASE_URL: 'https://example.com',
				},
			};
			writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(settings));

			const result = discoverCredentials(claudeDir);

			// Explicit env var should win
			expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('explicit-token');
			// But ANTHROPIC_BASE_URL should be injected (was not already set)
			expect(process.env.ANTHROPIC_BASE_URL).toBe('https://example.com');
			// Only 1 was applied (BASE_URL), AUTH_TOKEN was skipped
			expect(result.settingsEnvApplied).toBe(1);
		});

		test('should handle settings.json without env block', () => {
			writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ allowedTools: ['Bash'] }));

			const result = discoverCredentials(claudeDir);

			expect(result.settingsEnvApplied).toBe(0);
		});

		test('should handle malformed settings.json gracefully', () => {
			writeFileSync(join(claudeDir, 'settings.json'), 'not valid json');

			const result = discoverCredentials(claudeDir);

			expect(result.errors.length).toBeGreaterThan(0);
			expect(result.errors[0]).toContain('settings.json');
		});

		test('should handle missing settings.json gracefully', () => {
			// No settings.json created
			const result = discoverCredentials(claudeDir);

			expect(result.settingsEnvApplied).toBe(0);
			expect(result.errors).toHaveLength(0);
		});

		test('should convert non-string env values to strings', () => {
			const settings = {
				env: {
					CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 1,
					API_TIMEOUT_MS: 3000000,
				},
			};
			writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(settings));

			const result = discoverCredentials(claudeDir);

			expect(result.settingsEnvApplied).toBe(2);
			expect(process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
			expect(process.env.API_TIMEOUT_MS).toBe('3000000');
		});
	});

	describe('combined credentials + settings', () => {
		test('should read both .credentials.json and settings.json', () => {
			// Write credentials file
			writeFileSync(
				join(claudeDir, '.credentials.json'),
				JSON.stringify({
					claudeAiOauth: { accessToken: 'my-oauth-token' },
				})
			);

			// Write settings file
			writeFileSync(
				join(claudeDir, 'settings.json'),
				JSON.stringify({
					env: {
						ANTHROPIC_BASE_URL: 'https://custom-proxy.example.com',
						API_TIMEOUT_MS: '5000',
					},
				})
			);

			const result = discoverCredentials(claudeDir);

			expect(result.credentialSource).toBe('credentials-file');
			expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('my-oauth-token');
			expect(process.env.ANTHROPIC_BASE_URL).toBe('https://custom-proxy.example.com');
			expect(process.env.API_TIMEOUT_MS).toBe('5000');
			expect(result.settingsEnvApplied).toBe(2);
		});

		test('full Zhipu GLM scenario: settings.json only, no credentials file', () => {
			// Simulates a user who has configured Zhipu GLM in Claude Code settings
			const settings = {
				env: {
					ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
					ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7',
					ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.7',
					ANTHROPIC_AUTH_TOKEN: 'zhipu_api_key_here',
					ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
					API_TIMEOUT_MS: '3000000',
					CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: 1,
				},
			};
			writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify(settings));

			const result = discoverCredentials(claudeDir);

			expect(result.credentialSource).toBe('settings-json');
			expect(result.settingsEnvApplied).toBe(7);
			expect(process.env.ANTHROPIC_AUTH_TOKEN).toBe('zhipu_api_key_here');
			expect(process.env.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
			expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-4.7');
		});
	});
});
