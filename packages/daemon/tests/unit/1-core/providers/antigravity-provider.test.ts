/**
 * Tests for Antigravity Provider
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import { AntigravityProvider } from '../../../../src/lib/providers/gemini/antigravity-provider.js';

describe('AntigravityProvider', () => {
	describe('identity', () => {
		it('exposes correct id and displayName', () => {
			const provider = new AntigravityProvider();
			expect(provider.id).toBe('google-antigravity');
			expect(provider.displayName).toBe('Antigravity (Gemini 3, Claude, GPT-OSS)');
		});

		it('declares correct capabilities', () => {
			const provider = new AntigravityProvider();
			expect(provider.capabilities.streaming).toBe(true);
			expect(provider.capabilities.extendedThinking).toBe(true);
			expect(provider.capabilities.thinkingModes).toBe('on');
			expect(provider.capabilities.maxContextWindow).toBe(1_000_000);
			expect(provider.capabilities.functionCalling).toBe(true);
			expect(provider.capabilities.vision).toBe(false);
		});
	});

	describe('ownsModel', () => {
		it('claims Gemini 3 model IDs', () => {
			const provider = new AntigravityProvider();
			expect(provider.ownsModel('gemini-3.1-pro-preview')).toBe(true);
			expect(provider.ownsModel('gemini-3-pro-preview')).toBe(true);
			expect(provider.ownsModel('gemini-3-flash-preview')).toBe(true);
			expect(provider.ownsModel('gemini-3.1-flash-lite-preview')).toBe(true);
		});

		it('claims Claude model IDs', () => {
			const provider = new AntigravityProvider();
			expect(provider.ownsModel('claude-sonnet-4-5-20250929')).toBe(true);
			expect(provider.ownsModel('claude-opus-4-5-20250929')).toBe(true);
			expect(provider.ownsModel('claude-haiku-4-5-20250929')).toBe(true);
		});

		it('claims GPT-OSS model IDs', () => {
			const provider = new AntigravityProvider();
			expect(provider.ownsModel('gpt-oss-120b')).toBe(true);
			expect(provider.ownsModel('gpt-oss-20b')).toBe(true);
		});

		it('does not claim non-antigravity model IDs', () => {
			const provider = new AntigravityProvider();
			expect(provider.ownsModel('gemini-2.5-pro')).toBe(false);
			expect(provider.ownsModel('claude-3-opus')).toBe(false);
			expect(provider.ownsModel('gpt-4')).toBe(false);
			expect(provider.ownsModel('sonnet')).toBe(false);
		});
	});

	describe('getModelForTier', () => {
		it('maps tiers to Antigravity models', () => {
			const provider = new AntigravityProvider();
			expect(provider.getModelForTier('sonnet')).toBe('claude-sonnet-4-5-20250929');
			expect(provider.getModelForTier('opus')).toBe('claude-opus-4-5-20250929');
			expect(provider.getModelForTier('haiku')).toBe('claude-haiku-4-5-20250929');
			expect(provider.getModelForTier('default')).toBe('gemini-3.1-pro-preview');
		});
	});

	describe('getModels', () => {
		it('returns the Antigravity model list', async () => {
			const provider = new AntigravityProvider();
			const models = await provider.getModels();

			expect(models.length).toBeGreaterThan(0);
			expect(models.some((m) => m.id === 'gemini-3.1-pro-preview')).toBe(true);
			expect(models.some((m) => m.id === 'claude-sonnet-4-5-20250929')).toBe(true);
			expect(models.some((m) => m.id === 'gpt-oss-120b')).toBe(true);

			// All models should have correct provider
			for (const model of models) {
				expect(model.provider).toBe('google-antigravity');
			}
		});
	});

	describe('isAvailable', () => {
		it('returns false when no credentials are configured', () => {
			const provider = new AntigravityProvider();
			expect(provider.isAvailable()).toBe(false);
		});

		it('returns true when credentials are set', () => {
			const provider = new AntigravityProvider();
			provider.setCredentials({
				refreshToken: 'test-refresh',
				accessToken: 'test-access',
				expiresAt: Date.now() + 3600_000,
				projectId: 'test-project',
				email: 'test@example.com',
			});
			expect(provider.isAvailable()).toBe(true);
		});
	});

	describe('getAuthStatus', () => {
		it('returns unauthenticated status when no credentials configured', async () => {
			const provider = new AntigravityProvider();
			const status = await provider.getAuthStatus();

			expect(status.isAuthenticated).toBe(false);
			expect(status.method).toBe('oauth');
			expect(status.error).toContain('No Antigravity account');
		});

		it('returns authenticated status when credentials are set', async () => {
			const provider = new AntigravityProvider();
			provider.setCredentials({
				refreshToken: 'test-refresh',
				accessToken: 'test-access',
				expiresAt: Date.now() + 3600_000,
				projectId: 'test-project',
				email: 'test@example.com',
			});
			const status = await provider.getAuthStatus();

			expect(status.isAuthenticated).toBe(true);
			expect(status.method).toBe('oauth');
			expect(status.user?.email).toBe('test@example.com');
			expect(status.needsRefresh).toBe(false);
		});

		it('returns needsRefresh when token is expired', async () => {
			const provider = new AntigravityProvider();
			provider.setCredentials({
				refreshToken: 'test-refresh',
				accessToken: 'test-access',
				expiresAt: Date.now() - 1000,
				projectId: 'test-project',
			});
			const status = await provider.getAuthStatus();

			expect(status.isAuthenticated).toBe(true);
			expect(status.needsRefresh).toBe(true);
		});
	});

	describe('startOAuthFlow', () => {
		it('returns a redirect auth URL with a dynamic callback port', async () => {
			const provider = new AntigravityProvider();
			const flow = await provider.startOAuthFlow();
			const params = new URL(flow.authUrl!).searchParams;

			expect(flow.type).toBe('redirect');
			expect(flow.authUrl).toContain('accounts.google.com');
			expect(flow.authUrl).toContain('client_id=');
			// Callback port is dynamically allocated, not hardcoded to 51121
			expect(params.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth-callback$/);
			expect(params.get('scope')).toContain('cloud-platform');
			expect(params.get('scope')).toContain('cclog');
			expect(params.get('scope')).toContain('experimentsandconfigs');
			expect(params.get('code_challenge_method')).toBe('S256');
			expect(flow.message).toContain('authorize');
		});
	});

	describe('buildSdkConfig', () => {
		it('throws when no credentials are available', () => {
			const provider = new AntigravityProvider();
			expect(() => provider.buildSdkConfig('gemini-3.1-pro-preview')).toThrow(
				'Antigravity credentials not configured'
			);
		});

		it('creates a bridge server when credentials are available', () => {
			const provider = new AntigravityProvider();
			provider.setCredentials({
				refreshToken: 'test-refresh',
				accessToken: 'test-access',
				expiresAt: Date.now() + 3600_000,
				projectId: 'test-project',
			});
			const config = provider.buildSdkConfig('gemini-3.1-pro-preview');

			expect(config.envVars.ANTHROPIC_BASE_URL).toContain('http://127.0.0.1:');
			expect(config.envVars.ANTHROPIC_API_KEY).toBe('antigravity-placeholder');
			expect(config.isAnthropicCompatible).toBe(true);
		});

		it('reuses bridge server for same session', () => {
			const provider = new AntigravityProvider();
			provider.setCredentials({
				refreshToken: 'test-refresh',
				accessToken: 'test-access',
				expiresAt: Date.now() + 3600_000,
				projectId: 'test-project',
			});
			const config1 = provider.buildSdkConfig('gemini-3.1-pro-preview', { sessionId: 'sess-1' });
			const config2 = provider.buildSdkConfig('gemini-3.1-pro-preview', { sessionId: 'sess-1' });

			expect(config1.envVars.ANTHROPIC_BASE_URL).toBe(config2.envVars.ANTHROPIC_BASE_URL);
		});

		it('creates separate bridge servers for different sessions', () => {
			const provider = new AntigravityProvider();
			provider.setCredentials({
				refreshToken: 'test-refresh',
				accessToken: 'test-access',
				expiresAt: Date.now() + 3600_000,
				projectId: 'test-project',
			});
			const config1 = provider.buildSdkConfig('gemini-3.1-pro-preview', { sessionId: 'sess-1' });
			const config2 = provider.buildSdkConfig('gemini-3.1-pro-preview', { sessionId: 'sess-2' });

			expect(config1.envVars.ANTHROPIC_BASE_URL).not.toBe(config2.envVars.ANTHROPIC_BASE_URL);
		});

		it('rebuilds bridge when credentials change', () => {
			const provider = new AntigravityProvider();
			provider.setCredentials({
				refreshToken: 'test-refresh',
				accessToken: 'test-access',
				expiresAt: Date.now() + 3600_000,
				projectId: 'test-project',
			});
			const config1 = provider.buildSdkConfig('gemini-3.1-pro-preview', { sessionId: 'sess-1' });

			// Change credentials (simulating OAuth completion)
			provider.setCredentials({
				refreshToken: 'new-refresh',
				accessToken: 'new-access',
				expiresAt: Date.now() + 3600_000,
				projectId: 'test-project',
			});
			const config2 = provider.buildSdkConfig('gemini-3.1-pro-preview', { sessionId: 'sess-1' });

			expect(config1.envVars.ANTHROPIC_BASE_URL).not.toBe(config2.envVars.ANTHROPIC_BASE_URL);
		});
	});

	describe('logout', () => {
		it('clears credentials and makes provider unavailable', async () => {
			const provider = new AntigravityProvider();
			provider.setCredentials({
				refreshToken: 'test-refresh',
				accessToken: 'test-access',
				expiresAt: Date.now() + 3600_000,
				projectId: 'test-project',
			});
			expect(provider.isAvailable()).toBe(true);

			await provider.logout();
			expect(provider.isAvailable()).toBe(false);
			expect(provider.getCredentials()).toBeNull();
		});
	});

	describe('shutdown', () => {
		it('can be called without error when no bridges exist', async () => {
			const provider = new AntigravityProvider();
			await expect(provider.shutdown()).resolves.toBeUndefined();
		});

		it('can be called after creating bridges', async () => {
			const provider = new AntigravityProvider();
			provider.setCredentials({
				refreshToken: 'test-refresh',
				accessToken: 'test-access',
				expiresAt: Date.now() + 3600_000,
				projectId: 'test-project',
			});
			provider.buildSdkConfig('gemini-3.1-pro-preview', { sessionId: 'sess-1' });
			await expect(provider.shutdown()).resolves.toBeUndefined();
		});
	});
});
