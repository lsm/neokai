/**
 * Unit tests for OpenAI Provider
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { getModel } from '@mariozechner/pi-ai';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { OpenAiProvider } from '../../../src/lib/providers/openai-provider';

// Use a temp dir for auth storage to avoid reading real ~/.neokai/auth.json
const TMP_DIR = path.join(os.tmpdir(), `openai-provider-test-${Date.now()}`);

describe('OpenAiProvider', () => {
	let provider: OpenAiProvider;
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(async () => {
		originalEnv = { ...process.env };
		delete process.env.OPENAI_API_KEY;
		await fs.mkdir(TMP_DIR, { recursive: true });
		// Use empty env and isolated auth dir for default provider
		provider = new OpenAiProvider({}, TMP_DIR);
	});

	afterEach(async () => {
		process.env = originalEnv;
		await fs.rm(TMP_DIR, { recursive: true, force: true });
	});

	describe('basic properties', () => {
		it('should have correct ID', () => {
			expect(provider.id).toBe('openai');
		});

		it('should have correct display name', () => {
			expect(provider.displayName).toBe('OpenAI');
		});

		it('should have correct capabilities', () => {
			expect(provider.capabilities).toEqual({
				streaming: true,
				extendedThinking: false,
				maxContextWindow: 200000,
				functionCalling: true,
				vision: true,
			});
		});
	});

	describe('isAvailable', () => {
		it('should return true when OPENAI_API_KEY is set', async () => {
			const providerWithKey = new OpenAiProvider({ OPENAI_API_KEY: 'test-key' });
			expect(await providerWithKey.isAvailable()).toBe(true);
		});

		it('should return false when no credentials are set', async () => {
			const providerNoKey = new OpenAiProvider({}, TMP_DIR);
			expect(await providerNoKey.isAvailable()).toBe(false);
		});
	});

	describe('getAuthStatus', () => {
		it('should return api_key method when OPENAI_API_KEY is set', async () => {
			const providerWithKey = new OpenAiProvider({ OPENAI_API_KEY: 'test-key' });
			const status = await providerWithKey.getAuthStatus();
			expect(status.isAuthenticated).toBe(true);
			expect(status.method).toBe('api_key');
		});

		it('should return unauthenticated when no credentials exist', async () => {
			const providerNoKey = new OpenAiProvider({}, TMP_DIR);
			const status = await providerNoKey.getAuthStatus();
			expect(status.isAuthenticated).toBe(false);
			expect(status.error).toBeDefined();
		});
	});

	describe('getApiKey', () => {
		it('should return OPENAI_API_KEY from env', async () => {
			const providerWithKey = new OpenAiProvider({ OPENAI_API_KEY: 'my-api-key' });
			expect(await providerWithKey.getApiKey()).toBe('my-api-key');
		});

		it('should return undefined when no key set', async () => {
			const providerNoKey = new OpenAiProvider({}, TMP_DIR);
			expect(await providerNoKey.getApiKey()).toBeUndefined();
		});
	});

	describe('ownsModel', () => {
		it('should own gpt- prefixed models', () => {
			expect(provider.ownsModel('gpt-5-mini')).toBe(true);
			expect(provider.ownsModel('gpt-5.3-codex')).toBe(true);
			expect(provider.ownsModel('gpt-4')).toBe(true);
			expect(provider.ownsModel('gpt-4o')).toBe(true);
		});

		it('should own known model aliases', () => {
			expect(provider.ownsModel('codex')).toBe(true);
			expect(provider.ownsModel('mini')).toBe(true);
		});

		it('should not own claude models', () => {
			expect(provider.ownsModel('claude-sonnet-4.6')).toBe(false);
			expect(provider.ownsModel('claude-opus-4.6')).toBe(false);
		});

		it('should not own other provider models', () => {
			expect(provider.ownsModel('glm-5')).toBe(false);
			expect(provider.ownsModel('deepseek-coder')).toBe(false);
			expect(provider.ownsModel('gemini-3.1-pro-preview')).toBe(false);
		});
	});

	describe('getModelForTier', () => {
		it('should map tiers correctly', () => {
			expect(provider.getModelForTier('opus')).toBe('gpt-5.3-codex');
			expect(provider.getModelForTier('sonnet')).toBe('gpt-5.3-codex');
			expect(provider.getModelForTier('haiku')).toBe('gpt-5-mini');
			expect(provider.getModelForTier('default')).toBe('gpt-5.3-codex');
		});
	});

	describe('buildSdkConfig', () => {
		it('should return empty env vars and non-Anthropic compatible', () => {
			const config = provider.buildSdkConfig('gpt-5-mini');
			expect(config.envVars).toEqual({});
			expect(config.isAnthropicCompatible).toBe(false);
		});
	});

	describe('getModels', () => {
		it('should return models when authenticated', async () => {
			const providerWithKey = new OpenAiProvider({ OPENAI_API_KEY: 'test-key' });
			const models = await providerWithKey.getModels();
			expect(models.length).toBeGreaterThanOrEqual(2);
			expect(models.every((m) => m.provider === 'openai')).toBe(true);
		});

		it('should return empty array when not authenticated', async () => {
			const providerNoKey = new OpenAiProvider({}, TMP_DIR);
			const models = await providerNoKey.getModels();
			expect(models).toEqual([]);
		});

		it('should include expected model IDs', async () => {
			const providerWithKey = new OpenAiProvider({ OPENAI_API_KEY: 'test-key' });
			const models = await providerWithKey.getModels();
			const ids = models.map((m) => m.id);
			expect(ids).toContain('gpt-5.3-codex');
			expect(ids).toContain('gpt-5-mini');
		});
	});

	describe('model ID validation against pi-ai registry', () => {
		it('should have all model IDs resolvable in pi-ai registry', async () => {
			const providerWithKey = new OpenAiProvider({ OPENAI_API_KEY: 'test-key' });
			const models = await providerWithKey.getModels();

			for (const model of models) {
				const piAiModel = getModel('openai', model.id);
				expect(piAiModel).toBeDefined();
			}
		});
	});

	describe('credential storage', () => {
		it('should load OAuth credentials from auth.json', async () => {
			const authPath = path.join(TMP_DIR, 'auth.json');
			await fs.writeFile(
				authPath,
				JSON.stringify({
					openai: {
						type: 'oauth',
						access: 'test-access-token',
						refresh: 'test-refresh-token',
						expires: Date.now() + 3600000,
					},
				})
			);

			const providerWithAuth = new OpenAiProvider({}, TMP_DIR);
			const status = await providerWithAuth.getAuthStatus();
			expect(status.isAuthenticated).toBe(true);
			expect(status.method).toBe('oauth');
		});

		it('should return unauthenticated when auth.json does not exist', async () => {
			const providerWithAuth = new OpenAiProvider({}, TMP_DIR);
			const status = await providerWithAuth.getAuthStatus();
			expect(status.isAuthenticated).toBe(false);
		});

		it('should return needsRefresh when OAuth token is expired', async () => {
			const authPath = path.join(TMP_DIR, 'auth.json');
			await fs.writeFile(
				authPath,
				JSON.stringify({
					openai: {
						type: 'oauth',
						access: 'test-access-token',
						refresh: 'test-refresh-token',
						expires: Date.now() - 1000, // Expired
					},
				})
			);

			const providerWithAuth = new OpenAiProvider({}, TMP_DIR);
			const status = await providerWithAuth.getAuthStatus();
			expect(status.isAuthenticated).toBe(true);
			expect(status.needsRefresh).toBe(true);
		});

		it('should prefer OPENAI_API_KEY over stored OAuth', async () => {
			const authPath = path.join(TMP_DIR, 'auth.json');
			await fs.writeFile(
				authPath,
				JSON.stringify({
					openai: {
						type: 'oauth',
						access: 'oauth-token',
						refresh: 'refresh-token',
						expires: Date.now() + 3600000,
					},
				})
			);

			const providerWithBoth = new OpenAiProvider({ OPENAI_API_KEY: 'env-key' }, TMP_DIR);
			const apiKey = await providerWithBoth.getApiKey();
			expect(apiKey).toBe('env-key');
		});

		it('should return OAuth access token when no env key', async () => {
			const authPath = path.join(TMP_DIR, 'auth.json');
			await fs.writeFile(
				authPath,
				JSON.stringify({
					openai: {
						type: 'oauth',
						access: 'oauth-access-token',
						refresh: 'refresh-token',
						expires: Date.now() + 3600000,
					},
				})
			);

			const providerWithAuth = new OpenAiProvider({}, TMP_DIR);
			const apiKey = await providerWithAuth.getApiKey();
			expect(apiKey).toBe('oauth-access-token');
		});

		it('should only remove openai key on logout', async () => {
			const authPath = path.join(TMP_DIR, 'auth.json');
			await fs.writeFile(
				authPath,
				JSON.stringify({
					openai: { type: 'oauth', access: 'token' },
					'github-copilot': { refresh: 'gh-token', access: 'cp-token', expires: 9999999 },
				})
			);

			const providerWithAuth = new OpenAiProvider({}, TMP_DIR);
			await providerWithAuth.logout();

			const content = JSON.parse(await fs.readFile(authPath, 'utf-8'));
			expect(content['openai']).toBeUndefined();
			expect(content['github-copilot']).toBeDefined();
		});

		it('should delete auth.json when last provider logs out', async () => {
			const authPath = path.join(TMP_DIR, 'auth.json');
			await fs.writeFile(
				authPath,
				JSON.stringify({
					openai: { type: 'oauth', access: 'token' },
				})
			);

			const providerWithAuth = new OpenAiProvider({}, TMP_DIR);
			await providerWithAuth.logout();

			const exists = await fs
				.access(authPath)
				.then(() => true)
				.catch(() => false);
			expect(exists).toBe(false);
		});
	});
});
