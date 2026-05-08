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
			const storage = new InMemoryAccountStorage();
			const rotationManager = new AccountRotationManager({ healthCheckOnStartup: false }, storage);
			const provider = new GeminiOAuthProvider(undefined, rotationManager);
			const available = await provider.isAvailable();
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
		it('returns fallback models when discovery is disabled', async () => {
			const storage = new InMemoryAccountStorage();
			const rotationManager = new AccountRotationManager({ healthCheckOnStartup: false }, storage);
			const provider = new GeminiOAuthProvider(undefined, rotationManager);

			// Discovery is disabled — returns static fallback list
			const models = await provider.getModels();
			expect(models.some((m) => m.id === 'gemini-2.5-pro')).toBe(true);
			expect(models.some((m) => m.id === 'gemini-2.5-flash')).toBe(true);
		});

		it('returns consistent fallback models on repeated calls', async () => {
			const storage = new InMemoryAccountStorage();
			const rotationManager = new AccountRotationManager({ healthCheckOnStartup: false }, storage);
			const provider = new GeminiOAuthProvider(undefined, rotationManager);

			const models1 = await provider.getModels();
			const models2 = await provider.getModels();
			expect(models2).toEqual(models1);
		});
	});

	describe('bridge model sync', () => {
		it('buildSdkConfig creates a bridge server', () => {
			const provider = new GeminiOAuthProvider();

			// buildSdkConfig is synchronous and should not block
			const config = provider.buildSdkConfig('gemini-2.5-pro');
			expect(config.envVars.ANTHROPIC_BASE_URL).toContain('http://127.0.0.1:');
		});

		it('clearModelCache returns fallback models when discovery is disabled', async () => {
			const provider = new GeminiOAuthProvider();

			// Create a bridge
			provider.buildSdkConfig('gemini-2.5-pro', { sessionId: 'test-session' });

			// Warm cache first
			const modelsBefore = await provider.getModels();
			expect(modelsBefore.some((m) => m.id === 'gemini-2.5-pro')).toBe(true);

			// Clear cache — should return fallback again since discovery is disabled
			provider.clearModelCache();

			const models = await provider.getModels();
			expect(models.some((m) => m.id === 'gemini-2.5-pro')).toBe(true);
		});
	});
});
