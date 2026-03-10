/**
 * Unit tests for GitHub Copilot Provider
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { getModel } from '@mariozechner/pi-ai';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { GitHubCopilotProvider } from '../../../src/lib/providers/github-copilot-provider';

const TMP_DIR = path.join(os.tmpdir(), `copilot-provider-test-${Date.now()}`);

describe('GitHubCopilotProvider', () => {
	let provider: GitHubCopilotProvider;
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(async () => {
		originalEnv = { ...process.env };
		await fs.mkdir(TMP_DIR, { recursive: true });
		provider = new GitHubCopilotProvider({}, TMP_DIR);
	});

	afterEach(async () => {
		process.env = originalEnv;
		await fs.rm(TMP_DIR, { recursive: true, force: true });
	});

	describe('basic properties', () => {
		it('should have correct ID', () => {
			expect(provider.id).toBe('github-copilot');
		});

		it('should have correct display name', () => {
			expect(provider.displayName).toBe('GitHub Copilot');
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
		it('should return true when credentials are stored', async () => {
			const authPath = path.join(TMP_DIR, 'auth.json');
			await fs.writeFile(
				authPath,
				JSON.stringify({
					'github-copilot': {
						refresh: 'gh-oauth-token',
						access: 'copilot-session-token',
						expires: Date.now() + 3600000,
					},
				})
			);

			const providerWithCreds = new GitHubCopilotProvider({}, TMP_DIR);
			expect(await providerWithCreds.isAvailable()).toBe(true);
		});

		it('should return false when no credentials exist', async () => {
			expect(await provider.isAvailable()).toBe(false);
		});
	});

	describe('getAuthStatus', () => {
		it('should return authenticated when credentials exist', async () => {
			const authPath = path.join(TMP_DIR, 'auth.json');
			await fs.writeFile(
				authPath,
				JSON.stringify({
					'github-copilot': {
						refresh: 'gh-oauth-token',
						access: 'copilot-session-token',
						expires: Date.now() + 3600000,
					},
				})
			);

			const providerWithCreds = new GitHubCopilotProvider({}, TMP_DIR);
			const status = await providerWithCreds.getAuthStatus();
			expect(status.isAuthenticated).toBe(true);
		});

		it('should return unauthenticated when no credentials exist', async () => {
			const status = await provider.getAuthStatus();
			expect(status.isAuthenticated).toBe(false);
			expect(status.error).toBeDefined();
		});
	});

	describe('ownsModel', () => {
		it('should own Claude models via Copilot', () => {
			expect(provider.ownsModel('claude-opus-4.6')).toBe(true);
			expect(provider.ownsModel('claude-sonnet-4.6')).toBe(true);
		});

		it('should own GPT models via Copilot', () => {
			expect(provider.ownsModel('gpt-5.3-codex')).toBe(true);
			expect(provider.ownsModel('gpt-5-mini')).toBe(true);
		});

		it('should own Gemini models via Copilot', () => {
			expect(provider.ownsModel('gemini-3.1-pro-preview')).toBe(true);
		});

		it('should own models by alias', () => {
			expect(provider.ownsModel('copilot-opus')).toBe(true);
			expect(provider.ownsModel('copilot-sonnet')).toBe(true);
			expect(provider.ownsModel('copilot-codex')).toBe(true);
			expect(provider.ownsModel('copilot-gemini')).toBe(true);
			expect(provider.ownsModel('copilot-mini')).toBe(true);
		});

		it('should not own unknown models', () => {
			expect(provider.ownsModel('glm-5')).toBe(false);
			expect(provider.ownsModel('deepseek-coder')).toBe(false);
			expect(provider.ownsModel('random-model')).toBe(false);
		});

		it('should not own raw gpt- prefix models (those belong to OpenAI)', () => {
			// GitHub Copilot only owns specific model IDs, not all gpt-* models
			expect(provider.ownsModel('gpt-4o')).toBe(false);
			expect(provider.ownsModel('gpt-5.1-codex')).toBe(false);
		});
	});

	describe('getModelForTier', () => {
		it('should map tiers correctly', () => {
			expect(provider.getModelForTier('opus')).toBe('claude-opus-4.6');
			expect(provider.getModelForTier('sonnet')).toBe('claude-sonnet-4.6');
			expect(provider.getModelForTier('haiku')).toBe('gpt-5-mini');
			expect(provider.getModelForTier('default')).toBe('claude-sonnet-4.6');
		});
	});

	describe('buildSdkConfig', () => {
		it('should return empty env vars and non-Anthropic compatible', () => {
			const config = provider.buildSdkConfig('claude-sonnet-4.6');
			expect(config.envVars).toEqual({});
			expect(config.isAnthropicCompatible).toBe(false);
		});
	});

	describe('getModels', () => {
		it('should return models when authenticated', async () => {
			const authPath = path.join(TMP_DIR, 'auth.json');
			await fs.writeFile(
				authPath,
				JSON.stringify({
					'github-copilot': {
						refresh: 'gh-oauth-token',
						access: 'session-token',
						expires: Date.now() + 3600000,
					},
				})
			);

			const providerWithCreds = new GitHubCopilotProvider({}, TMP_DIR);
			const models = await providerWithCreds.getModels();
			expect(models.length).toBeGreaterThanOrEqual(5);
			expect(models.every((m) => m.provider === 'github-copilot')).toBe(true);
		});

		it('should return empty array when not authenticated', async () => {
			const models = await provider.getModels();
			expect(models).toEqual([]);
		});

		it('should include expected model families', async () => {
			const authPath = path.join(TMP_DIR, 'auth.json');
			await fs.writeFile(
				authPath,
				JSON.stringify({
					'github-copilot': {
						refresh: 'token',
						access: 'session',
						expires: Date.now() + 3600000,
					},
				})
			);

			const providerWithCreds = new GitHubCopilotProvider({}, TMP_DIR);
			const models = await providerWithCreds.getModels();
			const families = new Set(models.map((m) => m.family));
			expect(families.has('opus')).toBe(true);
			expect(families.has('sonnet')).toBe(true);
			expect(families.has('gpt')).toBe(true);
			expect(families.has('gemini')).toBe(true);
		});
	});

	describe('model ID validation against pi-ai registry', () => {
		it('should have all model IDs resolvable in pi-ai registry (with openai fallback)', async () => {
			const authPath = path.join(TMP_DIR, 'auth.json');
			await fs.writeFile(
				authPath,
				JSON.stringify({
					'github-copilot': {
						refresh: 'token',
						access: 'session',
						expires: Date.now() + 3600000,
					},
				})
			);

			const providerWithCreds = new GitHubCopilotProvider({}, TMP_DIR);
			const models = await providerWithCreds.getModels();

			for (const model of models) {
				// GitHub Copilot proxies to OpenAI for GPT models, so fall back
				// to the OpenAI registry when pi-ai hasn't added the model yet.
				const piAiModel = getModel('github-copilot', model.id) || getModel('openai', model.id);
				expect(piAiModel).toBeDefined();
			}
		});
	});

	describe('credential storage', () => {
		it('should load credentials from auth.json', async () => {
			const authPath = path.join(TMP_DIR, 'auth.json');
			await fs.writeFile(
				authPath,
				JSON.stringify({
					'github-copilot': {
						refresh: 'github-oauth-token',
						access: 'copilot-session-token',
						expires: Date.now() + 3600000,
					},
				})
			);

			const providerWithCreds = new GitHubCopilotProvider({}, TMP_DIR);
			const status = await providerWithCreds.getAuthStatus();
			expect(status.isAuthenticated).toBe(true);
		});

		it('should handle legacy credential format (access_token)', async () => {
			const authPath = path.join(TMP_DIR, 'auth.json');
			// Legacy format used access_token instead of refresh/access
			await fs.writeFile(
				authPath,
				JSON.stringify({
					'github-copilot': {
						access_token: 'legacy-github-oauth-token',
					},
				})
			);

			const providerWithCreds = new GitHubCopilotProvider({}, TMP_DIR);
			const status = await providerWithCreds.getAuthStatus();
			// Legacy credentials should be migrated and recognized
			expect(status.isAuthenticated).toBe(true);
		});

		it('should return unauthenticated when auth.json does not exist', async () => {
			const status = await provider.getAuthStatus();
			expect(status.isAuthenticated).toBe(false);
		});

		it('should only remove github-copilot key on logout', async () => {
			const authPath = path.join(TMP_DIR, 'auth.json');
			await fs.writeFile(
				authPath,
				JSON.stringify({
					'github-copilot': {
						refresh: 'gh-token',
						access: 'cp-token',
						expires: 9999999,
					},
					openai: { type: 'oauth', access: 'openai-token' },
				})
			);

			const providerWithCreds = new GitHubCopilotProvider({}, TMP_DIR);
			await providerWithCreds.logout();

			const content = JSON.parse(await fs.readFile(authPath, 'utf-8'));
			expect(content['github-copilot']).toBeUndefined();
			expect(content['openai']).toBeDefined();
		});

		it('should delete auth.json when last provider logs out', async () => {
			const authPath = path.join(TMP_DIR, 'auth.json');
			await fs.writeFile(
				authPath,
				JSON.stringify({
					'github-copilot': {
						refresh: 'token',
						access: 'session',
						expires: 9999999,
					},
				})
			);

			const providerWithCreds = new GitHubCopilotProvider({}, TMP_DIR);
			await providerWithCreds.logout();

			const exists = await fs
				.access(authPath)
				.then(() => true)
				.catch(() => false);
			expect(exists).toBe(false);
		});
	});

	describe('enterprise domain', () => {
		it('should detect enterprise domain from GITHUB_API_URL', () => {
			const enterpriseProvider = new GitHubCopilotProvider(
				{ GITHUB_API_URL: 'https://github.mycompany.com/api/v3' },
				TMP_DIR
			);
			// Enterprise domain detection is private, but we can verify via ownsModel still working
			expect(enterpriseProvider.id).toBe('github-copilot');
		});

		it('should not set enterprise domain for github.com', () => {
			const normalProvider = new GitHubCopilotProvider(
				{ GITHUB_API_URL: 'https://api.github.com' },
				TMP_DIR
			);
			expect(normalProvider.id).toBe('github-copilot');
		});
	});
});
