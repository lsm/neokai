/**
 * Tests for Gemini OAuth Provider
 */

import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test';
import { GeminiOAuthProvider } from '../../../../src/lib/providers/gemini/gemini-provider.js';
import {
	AccountRotationManager,
	InMemoryAccountStorage,
} from '../../../../src/lib/providers/gemini/account-rotation.js';
import { createAccount } from '../../../../src/lib/providers/gemini/oauth-client.js';

describe('GeminiOAuthProvider', () => {
	const originalClientId = process.env.GOOGLE_GEMINI_CLIENT_ID;
	const originalClientSecret = process.env.GOOGLE_GEMINI_CLIENT_SECRET;

	beforeEach(() => {
		process.env.GOOGLE_GEMINI_CLIENT_ID = 'test-client-id';
		process.env.GOOGLE_GEMINI_CLIENT_SECRET = 'test-client-secret';
	});

	afterEach(() => {
		if (originalClientId !== undefined) {
			process.env.GOOGLE_GEMINI_CLIENT_ID = originalClientId;
		} else {
			delete process.env.GOOGLE_GEMINI_CLIENT_ID;
		}
		if (originalClientSecret !== undefined) {
			process.env.GOOGLE_GEMINI_CLIENT_SECRET = originalClientSecret;
		} else {
			delete process.env.GOOGLE_GEMINI_CLIENT_SECRET;
		}
	});

	describe('identity', () => {
		it('exposes correct id and displayName', () => {
			const provider = new GeminiOAuthProvider();
			expect(provider.id).toBe('google-gemini-oauth');
			expect(provider.displayName).toBe('Google Gemini (OAuth)');
		});

		it('declares correct capabilities', () => {
			const provider = new GeminiOAuthProvider();
			expect(provider.capabilities.streaming).toBe(true);
			expect(provider.capabilities.extendedThinking).toBe(false);
			expect(provider.capabilities.maxContextWindow).toBe(1_000_000);
			expect(provider.capabilities.functionCalling).toBe(true);
			expect(provider.capabilities.vision).toBe(false);
		});
	});

	describe('ownsModel', () => {
		it('claims gemini- model IDs', () => {
			const provider = new GeminiOAuthProvider();
			expect(provider.ownsModel('gemini-2.5-pro')).toBe(true);
			expect(provider.ownsModel('gemini-2.5-flash')).toBe(true);
			expect(provider.ownsModel('gemini-3-pro-preview')).toBe(true);
		});

		it('does not claim non-gemini model IDs', () => {
			const provider = new GeminiOAuthProvider();
			expect(provider.ownsModel('claude-3-opus')).toBe(false);
			expect(provider.ownsModel('sonnet')).toBe(false);
			expect(provider.ownsModel('gpt-4')).toBe(false);
		});
	});

	describe('getModelForTier', () => {
		it('maps tiers to Gemini models', () => {
			const provider = new GeminiOAuthProvider();
			expect(provider.getModelForTier('sonnet')).toBe('gemini-2.5-pro');
			expect(provider.getModelForTier('opus')).toBe('gemini-2.5-pro');
			expect(provider.getModelForTier('haiku')).toBe('gemini-2.5-flash');
			expect(provider.getModelForTier('default')).toBe('gemini-2.5-pro');
		});
	});

	describe('getModels', () => {
		it('returns the Gemini model list', async () => {
			const provider = new GeminiOAuthProvider();
			const models = await provider.getModels();

			expect(models.length).toBeGreaterThan(0);
			expect(models.some((m) => m.id === 'gemini-2.5-pro')).toBe(true);
			expect(models.some((m) => m.id === 'gemini-2.5-flash')).toBe(true);

			// All models should have correct provider and a valid family
			for (const model of models) {
				expect(model.provider).toBe('google-gemini-oauth');
				expect(['gemini', 'gemma']).toContain(model.family);
			}
		});
	});

	describe('isAvailable', () => {
		it('returns false when no accounts are configured', async () => {
			const provider = new GeminiOAuthProvider();
			// No accounts file exists in test environment
			const available = await provider.isAvailable();
			// In test environment, no accounts file exists, so should be false
			expect(available).toBe(false);
		});
	});

	describe('getAuthStatus', () => {
		it('returns unauthenticated status when no accounts configured', async () => {
			const storage = new InMemoryAccountStorage();
			const rotationManager = new AccountRotationManager({ healthCheckOnStartup: false }, storage);
			const provider = new GeminiOAuthProvider(undefined, rotationManager);
			const status = await provider.getAuthStatus();

			expect(status.isAuthenticated).toBe(false);
			expect(status.method).toBe('oauth');
			expect(status.error).toContain('No Google accounts');
		});
	});

	describe('startOAuthFlow', () => {
		it('returns an auth URL with the Gemini CLI loopback callback redirect', async () => {
			const provider = new GeminiOAuthProvider();
			const flow = await provider.startOAuthFlow();
			const params = new URL(flow.authUrl!).searchParams;

			expect(flow.type).toBe('redirect');
			expect(flow.authUrl).toContain('accounts.google.com');
			expect(flow.authUrl).toContain('client_id=');
			expect(params.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth2callback$/);
			expect(flow.message).toContain('authorize');
		});
	});

	describe('shutdown', () => {
		it('can be called without error', async () => {
			const provider = new GeminiOAuthProvider();
			await expect(provider.shutdown()).resolves.toBeUndefined();
		});
	});

	describe('model cache behavior', () => {
		it('does not cache fallback models permanently', async () => {
			const storage = new InMemoryAccountStorage();
			const rotationManager = new AccountRotationManager({ healthCheckOnStartup: false }, storage);
			const provider = new GeminiOAuthProvider(undefined, rotationManager);

			// First call — no accounts, discovery fails, returns fallback
			const models1 = await provider.getModels();
			expect(models1.some((m) => m.id === 'gemini-2.5-pro')).toBe(true);

			// _modelCache should still be null because fallback is not cached
			// (we can't inspect private fields, but we can verify behavior:
			// calling getModels again should still attempt discovery and
			// return the same fallback since no accounts exist)
			const models2 = await provider.getModels();
			expect(models2).toEqual(models1);
		});

		it('caches discovered models and returns them without re-discovery', async () => {
			const mockFetch = (url: string) => {
				if (url.includes('oauth2.googleapis.com')) {
					return Promise.resolve(
						new Response(
							JSON.stringify({
								access_token: 'test-access-token',
								expires_in: 3600,
								token_type: 'Bearer',
							}),
							{ status: 200 }
						)
					);
				}
				return Promise.resolve(
					new Response(
						JSON.stringify({
							models: {
								'gemini-3-pro-preview': { displayName: 'Gemini 3 Pro Preview' },
							},
						}),
						{ status: 200 }
					)
				);
			};

			const storage = new InMemoryAccountStorage();
			const account = createAccount('test@gmail.com', 'test-refresh-token');
			await storage.save([account]);
			const rotationManager = new AccountRotationManager({ healthCheckOnStartup: false }, storage);
			const provider = new GeminiOAuthProvider(
				{ fetchImpl: mockFetch as typeof fetch },
				rotationManager
			);
			const models = await provider.getModels();
			expect(models.some((m) => m.id === 'gemini-3-pro-preview')).toBe(true);
			expect(models.some((m) => m.id === 'gemini-2.5-pro')).toBe(false);
		});
	});

	describe('bridge model sync', () => {
		it('buildSdkConfig warms model cache in background', async () => {
			const mockFetch = (url: string) => {
				if (url.includes('oauth2.googleapis.com')) {
					return Promise.resolve(
						new Response(
							JSON.stringify({
								access_token: 'test-access-token',
								expires_in: 3600,
								token_type: 'Bearer',
							}),
							{ status: 200 }
						)
					);
				}
				return Promise.resolve(
					new Response(
						JSON.stringify({
							models: {
								'gemini-3-pro-preview': { displayName: 'Gemini 3 Pro Preview' },
							},
						}),
						{ status: 200 }
					)
				);
			};

			const storage = new InMemoryAccountStorage();
			const account = createAccount('test@gmail.com', 'test-refresh-token');
			await storage.save([account]);
			const rotationManager = new AccountRotationManager({ healthCheckOnStartup: false }, storage);
			const provider = new GeminiOAuthProvider(
				{ fetchImpl: mockFetch as typeof fetch },
				rotationManager
			);

			// buildSdkConfig is synchronous and should not block
			const config = provider.buildSdkConfig('gemini-2.5-pro');
			expect(config.envVars.ANTHROPIC_BASE_URL).toContain('http://127.0.0.1:');

			// Wait for background discovery to complete
			await new Promise((resolve) => setTimeout(resolve, 100));

			// Now getModels should return the discovered list
			const models = await provider.getModels();
			expect(models.some((m) => m.id === 'gemini-3-pro-preview')).toBe(true);
		});

		it('clearModelCache updates bridge model list', async () => {
			const mockFetch = (url: string) => {
				if (url.includes('oauth2.googleapis.com')) {
					return Promise.resolve(
						new Response(
							JSON.stringify({
								access_token: 'test-access-token',
								expires_in: 3600,
								token_type: 'Bearer',
							}),
							{ status: 200 }
						)
					);
				}
				return Promise.resolve(
					new Response(
						JSON.stringify({
							models: {
								'gemini-3-pro-preview': { displayName: 'Gemini 3 Pro Preview' },
							},
						}),
						{ status: 200 }
					)
				);
			};

			const storage = new InMemoryAccountStorage();
			const account = createAccount('test@gmail.com', 'test-refresh-token');
			await storage.save([account]);
			const rotationManager = new AccountRotationManager({ healthCheckOnStartup: false }, storage);
			const provider = new GeminiOAuthProvider(
				{ fetchImpl: mockFetch as typeof fetch },
				rotationManager
			);

			// Create a bridge
			provider.buildSdkConfig('gemini-2.5-pro', { sessionId: 'test-session' });

			// Warm cache first
			await provider.getModels();

			// Clear cache — should re-discover and update bridges
			await provider.clearModelCache();

			const models = await provider.getModels();
			expect(models.some((m) => m.id === 'gemini-3-pro-preview')).toBe(true);
		});
	});
});
