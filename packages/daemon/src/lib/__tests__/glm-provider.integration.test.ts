/**
 * Integration tests for GLM (智谱AI) provider support
 *
 * Tests the model-based provider detection flow:
 * 1. ProviderService model ID detection (glm-* models)
 * 2. QueryOptionsBuilder model-based env var injection
 * 3. Actual API call to GLM
 *
 * Run with: bun test packages/daemon/src/lib/__tests__/glm-provider.integration.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ProviderService } from '../provider-service';
import { QueryOptionsBuilder } from '../agent/query-options-builder';
import { SettingsManager } from '../settings-manager';
import { getAvailableModels, setModelsCache, getModelsCache } from '../model-service';
import {
	setupIntegrationTestEnv,
	cleanupIntegrationTestEnv,
	createTestSession,
	type IntegrationTestEnv,
} from './integration-test-utils';

describe('GLM Provider Integration', () => {
	let env: IntegrationTestEnv;

	beforeEach(async () => {
		env = await setupIntegrationTestEnv();
	});

	afterEach(async () => {
		await cleanupIntegrationTestEnv(env);
	});

	describe('ProviderService - Model-based Detection', () => {
		it('should detect GLM model IDs correctly', () => {
			const providerService = new ProviderService();

			// GLM models start with "glm-"
			expect(providerService.isGlmModel('glm-4.7')).toBe(true);
			expect(providerService.isGlmModel('glm-4')).toBe(true);
			expect(providerService.isGlmModel('GLM-4.7')).toBe(true); // case insensitive

			// Non-GLM models
			expect(providerService.isGlmModel('default')).toBe(false);
			expect(providerService.isGlmModel('opus')).toBe(false);
			expect(providerService.isGlmModel('haiku')).toBe(false);
			expect(providerService.isGlmModel('claude-sonnet-4-5')).toBe(false);
		});

		it('should detect provider from model ID', () => {
			const providerService = new ProviderService();

			expect(providerService.detectProviderFromModel('glm-4.7')).toBe('glm');
			expect(providerService.detectProviderFromModel('GLM-4')).toBe('glm');
			expect(providerService.detectProviderFromModel('default')).toBe('anthropic');
			expect(providerService.detectProviderFromModel('opus')).toBe('anthropic');
		});

		it('should return correct env vars for GLM model ID', () => {
			const providerService = new ProviderService();

			// Mock GLM_API_KEY
			const originalGlmKey = process.env.GLM_API_KEY;
			process.env.GLM_API_KEY = 'test-glm-api-key';

			try {
				const envVars = providerService.getEnvVarsForModel('glm-4.7');

				// Verify all required env vars are set
				expect(envVars.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
				// Changed from ANTHROPIC_API_KEY to ANTHROPIC_AUTH_TOKEN (matches Claude Code behavior)
				expect(envVars.ANTHROPIC_AUTH_TOKEN).toBe('test-glm-api-key');
				// ANTHROPIC_API_KEY is NOT set (only ANTHROPIC_AUTH_TOKEN is used)
				expect(envVars.ANTHROPIC_API_KEY).toBeUndefined();
				// ANTHROPIC_MODEL is NOT set - model ID is passed directly to SDK
				expect(envVars.ANTHROPIC_MODEL).toBeUndefined();
				expect(envVars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1');
				// API_TIMEOUT_MS is set for GLM (50 minutes)
				expect(envVars.API_TIMEOUT_MS).toBe('3000000');
				// Model mapping should be set
				expect(envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('glm-4.7');
				expect(envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('glm-4.7');
			} finally {
				if (originalGlmKey !== undefined) {
					process.env.GLM_API_KEY = originalGlmKey;
				} else {
					delete process.env.GLM_API_KEY;
				}
			}
		});

		it('should return correct env vars for glm-4.5-air', () => {
			const providerService = new ProviderService();

			// Mock GLM_API_KEY
			const originalGlmKey = process.env.GLM_API_KEY;
			process.env.GLM_API_KEY = 'test-glm-api-key';

			try {
				const envVars = providerService.getEnvVarsForModel('glm-4.5-air');

				// Verify base env vars are set
				expect(envVars.ANTHROPIC_BASE_URL).toBe('https://open.bigmodel.cn/api/anthropic');
				// Changed from ANTHROPIC_API_KEY to ANTHROPIC_AUTH_TOKEN
				expect(envVars.ANTHROPIC_AUTH_TOKEN).toBe('test-glm-api-key');
				// ANTHROPIC_API_KEY is NOT set (only ANTHROPIC_AUTH_TOKEN is used)
				expect(envVars.ANTHROPIC_API_KEY).toBeUndefined();
				// ANTHROPIC_MODEL is NOT set - model ID is passed directly to SDK
				expect(envVars.ANTHROPIC_MODEL).toBeUndefined();
				// glm-4.5-air maps to Haiku tier
				expect(envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('glm-4.5-air');
				// Extended timeout
				expect(envVars.API_TIMEOUT_MS).toBe('3000000');
			} finally {
				if (originalGlmKey !== undefined) {
					process.env.GLM_API_KEY = originalGlmKey;
				} else {
					delete process.env.GLM_API_KEY;
				}
			}
		});

		it('should return empty env vars for Anthropic model IDs', () => {
			const providerService = new ProviderService();

			expect(Object.keys(providerService.getEnvVarsForModel('default')).length).toBe(0);
			expect(Object.keys(providerService.getEnvVarsForModel('opus')).length).toBe(0);
			expect(Object.keys(providerService.getEnvVarsForModel('haiku')).length).toBe(0);
		});

		it('should check GLM availability correctly', () => {
			const providerService = new ProviderService();

			// GLM should be available if GLM_API_KEY or ZHIPU_API_KEY is set
			const originalGlmKey = process.env.GLM_API_KEY;
			const originalZhipuKey = process.env.ZHIPU_API_KEY;

			try {
				// Remove both keys
				delete process.env.GLM_API_KEY;
				delete process.env.ZHIPU_API_KEY;
				expect(providerService.isGlmAvailable()).toBe(false);

				// Set GLM_API_KEY
				process.env.GLM_API_KEY = 'test-key';
				expect(providerService.isGlmAvailable()).toBe(true);
			} finally {
				if (originalGlmKey !== undefined) {
					process.env.GLM_API_KEY = originalGlmKey;
				} else {
					delete process.env.GLM_API_KEY;
				}
				if (originalZhipuKey !== undefined) {
					process.env.ZHIPU_API_KEY = originalZhipuKey;
				}
			}
		});

		it('should list available providers correctly', () => {
			const providerService = new ProviderService();
			const providers = providerService.getAvailableProviders();

			// Should have at least Anthropic and GLM
			expect(providers.length).toBeGreaterThanOrEqual(2);

			// Find Anthropic
			const anthropic = providers.find((p) => p.id === 'anthropic');
			expect(anthropic).toBeDefined();
			expect(anthropic!.name).toBe('Anthropic');

			// Find GLM
			const glm = providers.find((p) => p.id === 'glm');
			expect(glm).toBeDefined();
			expect(glm!.name).toBe('GLM (智谱AI)');
			expect(glm!.baseUrl).toBe('https://open.bigmodel.cn/api/anthropic');
		});

		it('should get default model for each provider', () => {
			const providerService = new ProviderService();

			expect(providerService.getDefaultModelForProvider('anthropic')).toBe('default');
			expect(providerService.getDefaultModelForProvider('glm')).toBe('glm-4.7');
		});

		it('should validate provider switch correctly', () => {
			const providerService = new ProviderService();

			// Anthropic is always valid
			const anthropicResult = providerService.validateProviderSwitch('anthropic');
			expect(anthropicResult.valid).toBe(true);

			// GLM without API key should fail (unless GLM_API_KEY is set in env)
			const originalGlmKey = process.env.GLM_API_KEY;
			delete process.env.GLM_API_KEY;
			delete process.env.ZHIPU_API_KEY;

			try {
				const glmResult = providerService.validateProviderSwitch('glm');
				expect(glmResult.valid).toBe(false);
				expect(glmResult.error).toContain('No API key');
			} finally {
				if (originalGlmKey !== undefined) {
					process.env.GLM_API_KEY = originalGlmKey;
				}
			}

			// GLM with provided API key should pass
			const glmWithKey = providerService.validateProviderSwitch('glm', 'some-api-key');
			expect(glmWithKey.valid).toBe(true);
		});
	});

	describe('ModelService - GLM Model Inclusion', () => {
		it('should include GLM models in getAvailableModels when GLM_API_KEY is set', () => {
			const originalGlmKey = process.env.GLM_API_KEY;
			const originalZhipuKey = process.env.ZHIPU_API_KEY;
			const originalCache = getModelsCache();

			try {
				// Set up mock SDK models in cache (simulating what initializeModels() does)
				const mockSdkModels = [
					{
						value: 'default',
						displayName: 'Sonnet',
						description: 'Sonnet 4.5 · Best for everyday tasks',
					},
					{ value: 'opus', displayName: 'Opus', description: 'Opus 4.5 · Most capable model' },
					{ value: 'haiku', displayName: 'Haiku', description: 'Haiku 3.5 · Fast and efficient' },
				];
				const mockCache = new Map<string, typeof mockSdkModels>();
				mockCache.set('global', mockSdkModels);
				setModelsCache(mockCache);

				// Set GLM_API_KEY
				process.env.GLM_API_KEY = 'test-glm-key';
				delete process.env.ZHIPU_API_KEY;

				// Get available models
				const models = getAvailableModels('global');

				// Should include both Anthropic and GLM models
				expect(models.length).toBeGreaterThan(3);

				// Find GLM model
				const glmModel = models.find((m) => m.id === 'glm-4.7');
				expect(glmModel).toBeDefined();
				expect(glmModel!.name).toBe('GLM-4.7');
				expect(glmModel!.family).toBe('glm');

				// Should also have Anthropic models
				const sonnetModel = models.find((m) => m.id === 'default');
				expect(sonnetModel).toBeDefined();
			} finally {
				// Restore original state
				if (originalGlmKey !== undefined) {
					process.env.GLM_API_KEY = originalGlmKey;
				} else {
					delete process.env.GLM_API_KEY;
				}
				if (originalZhipuKey !== undefined) {
					process.env.ZHIPU_API_KEY = originalZhipuKey;
				}
				setModelsCache(originalCache);
			}
		});

		it('should NOT include GLM models when GLM_API_KEY is not set', () => {
			const originalGlmKey = process.env.GLM_API_KEY;
			const originalZhipuKey = process.env.ZHIPU_API_KEY;
			const originalCache = getModelsCache();

			try {
				// Set up mock SDK models in cache
				const mockSdkModels = [
					{
						value: 'default',
						displayName: 'Sonnet',
						description: 'Sonnet 4.5 · Best for everyday tasks',
					},
					{ value: 'opus', displayName: 'Opus', description: 'Opus 4.5 · Most capable model' },
					{ value: 'haiku', displayName: 'Haiku', description: 'Haiku 3.5 · Fast and efficient' },
				];
				const mockCache = new Map<string, typeof mockSdkModels>();
				mockCache.set('global', mockSdkModels);
				setModelsCache(mockCache);

				// Remove GLM API keys
				delete process.env.GLM_API_KEY;
				delete process.env.ZHIPU_API_KEY;

				// Get available models
				const models = getAvailableModels('global');

				// Should only have Anthropic models (3 families)
				expect(models.length).toBe(3);

				// Should NOT have GLM model
				const glmModel = models.find((m) => m.id === 'glm-4.7');
				expect(glmModel).toBeUndefined();

				// Should have Anthropic models
				const sonnetModel = models.find((m) => m.id === 'default');
				expect(sonnetModel).toBeDefined();
			} finally {
				// Restore original state
				if (originalGlmKey !== undefined) {
					process.env.GLM_API_KEY = originalGlmKey;
				}
				if (originalZhipuKey !== undefined) {
					process.env.ZHIPU_API_KEY = originalZhipuKey;
				}
				setModelsCache(originalCache);
			}
		});

		it('should include GLM models when ZHIPU_API_KEY is set (alternative key)', () => {
			const originalGlmKey = process.env.GLM_API_KEY;
			const originalZhipuKey = process.env.ZHIPU_API_KEY;
			const originalCache = getModelsCache();

			try {
				// Set up mock SDK models in cache
				const mockSdkModels = [
					{
						value: 'default',
						displayName: 'Sonnet',
						description: 'Sonnet 4.5 · Best for everyday tasks',
					},
				];
				const mockCache = new Map<string, typeof mockSdkModels>();
				mockCache.set('global', mockSdkModels);
				setModelsCache(mockCache);

				// Set ZHIPU_API_KEY instead of GLM_API_KEY
				delete process.env.GLM_API_KEY;
				process.env.ZHIPU_API_KEY = 'test-zhipu-key';

				// Get available models
				const models = getAvailableModels('global');

				// Should include GLM model
				const glmModel = models.find((m) => m.id === 'glm-4.7');
				expect(glmModel).toBeDefined();
				expect(glmModel!.name).toBe('GLM-4.7');
			} finally {
				// Restore original state
				if (originalGlmKey !== undefined) {
					process.env.GLM_API_KEY = originalGlmKey;
				} else {
					delete process.env.GLM_API_KEY;
				}
				if (originalZhipuKey !== undefined) {
					process.env.ZHIPU_API_KEY = originalZhipuKey;
				} else {
					delete process.env.ZHIPU_API_KEY;
				}
				setModelsCache(originalCache);
			}
		});
	});

	describe('QueryOptionsBuilder - Model-based Env Var Injection', () => {
		it('should inject GLM env vars when session uses GLM model', async () => {
			const settingsManager = new SettingsManager(env.db, env.testWorkspace);

			// Create session with GLM model (model-based detection, no provider config needed)
			const session = createTestSession(env.testWorkspace, {
				config: {
					model: 'glm-4.7', // GLM model ID triggers env var injection
				},
			});

			// Mock GLM_API_KEY
			const originalGlmKey = process.env.GLM_API_KEY;
			process.env.GLM_API_KEY = 'test-glm-key';

			try {
				const builder = new QueryOptionsBuilder(session, settingsManager);
				const options = await builder.build();

				// IMPORTANT: Provider env vars are NO LONGER passed via options.env
				// They are now applied to process.env before SDK query creation
				// So options.env should be undefined for Anthropic-only sessions
				expect(options.env).toBeUndefined();

				// The model ID is translated to SDK-recognized ID
				expect(options.model).toBe('default'); // glm-4.7 → default (Sonnet tier)
			} finally {
				if (originalGlmKey !== undefined) {
					process.env.GLM_API_KEY = originalGlmKey;
				} else {
					delete process.env.GLM_API_KEY;
				}
			}
		});

		it('should allow session env vars to be passed through', async () => {
			const settingsManager = new SettingsManager(env.db, env.testWorkspace);

			const session = createTestSession(env.testWorkspace, {
				config: {
					model: 'glm-4.7',
					env: {
						API_TIMEOUT_MS: '1000000', // Custom timeout
						CUSTOM_VAR: 'custom-value', // Additional var
					},
				},
			});

			const originalGlmKey = process.env.GLM_API_KEY;
			process.env.GLM_API_KEY = 'test-glm-key';

			try {
				const builder = new QueryOptionsBuilder(session, settingsManager);
				const options = await builder.build();

				// Session env vars should still be in options.env
				expect(options.env).toBeDefined();
				// Session override should take effect
				expect(options.env!.API_TIMEOUT_MS).toBe('1000000');
				// Custom var should be added
				expect(options.env!.CUSTOM_VAR).toBe('custom-value');
				// Note: Provider vars (ANTHROPIC_BASE_URL, etc.) are NO LONGER in options.env
				// They are applied to process.env before SDK query creation
			} finally {
				if (originalGlmKey !== undefined) {
					process.env.GLM_API_KEY = originalGlmKey;
				} else {
					delete process.env.GLM_API_KEY;
				}
			}
		});

		it('should not inject env vars for Anthropic models', async () => {
			const settingsManager = new SettingsManager(env.db, env.testWorkspace);

			const session = createTestSession(env.testWorkspace, {
				config: {
					model: 'default', // Anthropic model
				},
			});

			const builder = new QueryOptionsBuilder(session, settingsManager);
			const options = await builder.build();

			// Anthropic should not have env overrides
			expect(options.env).toBeUndefined();
		});

		it('should not inject env vars for opus/haiku models', async () => {
			const settingsManager = new SettingsManager(env.db, env.testWorkspace);

			const opusSession = createTestSession(env.testWorkspace, {
				config: { model: 'opus' },
			});
			const haikuSession = createTestSession(env.testWorkspace, {
				config: { model: 'haiku' },
			});

			const opusBuilder = new QueryOptionsBuilder(opusSession, settingsManager);
			const haikuBuilder = new QueryOptionsBuilder(haikuSession, settingsManager);

			const opusOptions = await opusBuilder.build();
			const haikuOptions = await haikuBuilder.build();

			expect(opusOptions.env).toBeUndefined();
			expect(haikuOptions.env).toBeUndefined();
		});
	});

	describe('GLM API Call', () => {
		it('should make actual API call to GLM', async () => {
			const glmApiKey = process.env.GLM_API_KEY || process.env.ZHIPU_API_KEY;

			// Skip test if no API key is available (e.g., in CI)
			if (!glmApiKey) {
				console.log('Skipping GLM API call test - no GLM_API_KEY set');
				return;
			}

			// This test makes an actual API call to GLM using fetch
			// It verifies that the Anthropic-compatible API works correctly
			console.log('Testing actual GLM API call...');

			const baseUrl = 'https://open.bigmodel.cn/api/anthropic';

			const response = await fetch(`${baseUrl}/v1/messages`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'x-api-key': glmApiKey!,
					'anthropic-version': '2023-06-01',
				},
				body: JSON.stringify({
					model: 'glm-4.7',
					max_tokens: 100,
					messages: [{ role: 'user', content: 'Say "Hello from GLM" in exactly 5 words.' }],
				}),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`GLM API error: ${response.status} ${errorText}`);
			}

			const data = (await response.json()) as {
				content: Array<{ type: string; text?: string }>;
				stop_reason: string;
			};

			// Verify we got a response
			expect(data.content).toBeDefined();
			expect(data.content.length).toBeGreaterThan(0);

			const textContent = data.content.find((c) => c.type === 'text');
			expect(textContent).toBeDefined();
			console.log('GLM Response:', textContent?.text);

			// Verify the stop reason
			expect(data.stop_reason).toBe('end_turn');
		}, 30000); // 30 second timeout for API call
	});
});
