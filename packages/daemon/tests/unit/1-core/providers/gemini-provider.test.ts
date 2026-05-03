/**
 * Tests for Gemini OAuth Provider
 */

import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test';
import { GeminiOAuthProvider } from '../../../../src/lib/providers/gemini/gemini-provider.js';

describe('GeminiOAuthProvider', () => {
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
			expect(provider.ownsModel('gemini-2.0-flash')).toBe(true);
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

			// All models should have correct provider
			for (const model of models) {
				expect(model.provider).toBe('google-gemini-oauth');
				expect(model.family).toBe('gemini');
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
			const provider = new GeminiOAuthProvider();
			const status = await provider.getAuthStatus();

			expect(status.isAuthenticated).toBe(false);
			expect(status.method).toBe('oauth');
			expect(status.error).toContain('No Google accounts');
		});
	});

	describe('startOAuthFlow', () => {
		it('returns an auth URL', async () => {
			const provider = new GeminiOAuthProvider();
			const flow = await provider.startOAuthFlow();

			expect(flow.type).toBe('redirect');
			expect(flow.authUrl).toContain('accounts.google.com');
			expect(flow.authUrl).toContain('client_id=');
			expect(flow.message).toContain('authorize');
		});
	});

	describe('shutdown', () => {
		it('can be called without error', async () => {
			const provider = new GeminiOAuthProvider();
			await expect(provider.shutdown()).resolves.toBeUndefined();
		});
	});
});
