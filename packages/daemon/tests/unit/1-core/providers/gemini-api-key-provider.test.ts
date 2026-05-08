/**
 * Tests for Gemini API Key Provider
 */

import { describe, expect, it } from 'bun:test';
import { GeminiApiKeyProvider } from '../../../../src/lib/providers/gemini/gemini-api-key-provider.js';

describe('GeminiApiKeyProvider', () => {
	describe('identity', () => {
		it('exposes correct id and displayName', () => {
			const provider = new GeminiApiKeyProvider({});
			expect(provider.id).toBe('google-gemini');
			expect(provider.displayName).toBe('Google Gemini');
		});

		it('declares correct capabilities', () => {
			const provider = new GeminiApiKeyProvider({});
			expect(provider.capabilities.streaming).toBe(true);
			expect(provider.capabilities.extendedThinking).toBe(false);
			expect(provider.capabilities.maxContextWindow).toBe(2_000_000);
			expect(provider.capabilities.functionCalling).toBe(true);
			expect(provider.capabilities.vision).toBe(false);
		});
	});

	describe('ownsModel', () => {
		it('claims gemini- model IDs', () => {
			const provider = new GeminiApiKeyProvider({});
			expect(provider.ownsModel('gemini-2.5-pro')).toBe(true);
			expect(provider.ownsModel('gemini-2.5-flash')).toBe(true);
			expect(provider.ownsModel('gemma-2b')).toBe(true);
		});

		it('does not claim non-gemini model IDs', () => {
			const provider = new GeminiApiKeyProvider({});
			expect(provider.ownsModel('claude-3-opus')).toBe(false);
			expect(provider.ownsModel('gpt-4')).toBe(false);
			expect(provider.ownsModel('sonnet')).toBe(false);
		});
	});

	describe('getModelForTier', () => {
		it('maps tiers to Gemini models', () => {
			const provider = new GeminiApiKeyProvider({});
			expect(provider.getModelForTier('sonnet')).toBe('gemini-2.5-pro');
			expect(provider.getModelForTier('opus')).toBe('gemini-2.5-pro');
			expect(provider.getModelForTier('haiku')).toBe('gemini-2.5-flash');
			expect(provider.getModelForTier('default')).toBe('gemini-2.5-pro');
		});
	});

	describe('isAvailable', () => {
		it('always returns true when provider is registered', () => {
			const provider = new GeminiApiKeyProvider({});
			expect(provider.isAvailable()).toBe(true);
		});

		it('returns true even without env key (session key may be provided)', () => {
			const provider = new GeminiApiKeyProvider({});
			expect(provider.isAvailable()).toBe(true);
		});
	});

	describe('getModels', () => {
		it('returns static model list', async () => {
			const provider = new GeminiApiKeyProvider({});
			const models = await provider.getModels();

			expect(models.length).toBeGreaterThan(0);
			expect(models.some((m) => m.id === 'gemini-2.5-pro')).toBe(true);
			expect(models.some((m) => m.id === 'gemini-2.5-flash')).toBe(true);
			expect(models.some((m) => m.id === 'gemini-2.0-flash')).toBe(true);

			// All models should have correct provider and family
			for (const model of models) {
				expect(model.provider).toBe('google-gemini');
				expect(model.family).toBe('gemini');
			}
		});
	});

	describe('getAuthStatus', () => {
		it('returns unauthenticated status when no API key is configured', async () => {
			const provider = new GeminiApiKeyProvider({});
			const status = await provider.getAuthStatus();

			expect(status.isAuthenticated).toBe(false);
			expect(status.method).toBe('api_key');
			expect(status.error).toContain('No Google Gemini API key');
		});

		it('returns authenticated status when API key is configured', async () => {
			const provider = new GeminiApiKeyProvider({ GOOGLE_API_KEY: 'test-key' });
			const status = await provider.getAuthStatus();

			expect(status.isAuthenticated).toBe(true);
			expect(status.method).toBe('api_key');
		});
	});

	describe('buildSdkConfig', () => {
		it('throws when no API key is available', () => {
			const provider = new GeminiApiKeyProvider({});
			expect(() => provider.buildSdkConfig('gemini-2.5-pro')).toThrow(
				'Google Gemini API key not configured'
			);
		});

		it('creates a bridge server when API key is available', () => {
			const provider = new GeminiApiKeyProvider({ GOOGLE_API_KEY: 'test-key' });
			const config = provider.buildSdkConfig('gemini-2.5-pro');

			expect(config.envVars.ANTHROPIC_BASE_URL).toContain('http://127.0.0.1:');
			expect(config.envVars.ANTHROPIC_API_KEY).toBe('gemini-apikey-placeholder');
			expect(config.isAnthropicCompatible).toBe(true);
		});

		it('reuses bridge server for same session', () => {
			const provider = new GeminiApiKeyProvider({ GOOGLE_API_KEY: 'test-key' });
			const config1 = provider.buildSdkConfig('gemini-2.5-pro', { sessionId: 'sess-1' });
			const config2 = provider.buildSdkConfig('gemini-2.5-pro', { sessionId: 'sess-1' });

			expect(config1.envVars.ANTHROPIC_BASE_URL).toBe(config2.envVars.ANTHROPIC_BASE_URL);
		});

		it('creates separate bridge servers for different sessions', () => {
			const provider = new GeminiApiKeyProvider({ GOOGLE_API_KEY: 'test-key' });
			const config1 = provider.buildSdkConfig('gemini-2.5-pro', { sessionId: 'sess-1' });
			const config2 = provider.buildSdkConfig('gemini-2.5-pro', { sessionId: 'sess-2' });

			expect(config1.envVars.ANTHROPIC_BASE_URL).not.toBe(config2.envVars.ANTHROPIC_BASE_URL);
		});

		it('recreates bridge when session API key changes', () => {
			const provider = new GeminiApiKeyProvider({ GOOGLE_API_KEY: 'old-key' });
			const config1 = provider.buildSdkConfig('gemini-2.5-pro', {
				sessionId: 'sess-1',
				apiKey: 'old-key',
			});
			const config2 = provider.buildSdkConfig('gemini-2.5-pro', {
				sessionId: 'sess-1',
				apiKey: 'new-key',
			});

			// Different API key should create a new bridge on a different port
			expect(config1.envVars.ANTHROPIC_BASE_URL).not.toBe(config2.envVars.ANTHROPIC_BASE_URL);
		});
	});

	describe('shutdown', () => {
		it('can be called without error when no bridges exist', async () => {
			const provider = new GeminiApiKeyProvider({});
			await expect(provider.shutdown()).resolves.toBeUndefined();
		});

		it('can be called after creating bridges', async () => {
			const provider = new GeminiApiKeyProvider({ GOOGLE_API_KEY: 'test-key' });
			provider.buildSdkConfig('gemini-2.5-pro', { sessionId: 'sess-1' });
			await expect(provider.shutdown()).resolves.toBeUndefined();
		});
	});
});
