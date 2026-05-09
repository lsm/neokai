/**
 * Tests for Gemini Model Discovery
 */

import { describe, expect, it } from 'bun:test';
import {
	fetchAvailableModels,
	getFallbackModels,
} from '../../../../src/lib/providers/gemini/model-discovery.js';

describe('Gemini Model Discovery', () => {
	describe('fetchAvailableModels', () => {
		it('returns null immediately when discovery is disabled', async () => {
			const result = await fetchAvailableModels({
				token: 'test-token',
			});
			expect(result).toBeNull();
		});

		it('ignores fetch implementation when discovery is disabled', async () => {
			const fetchImpl = () =>
				Promise.resolve(
					new Response(JSON.stringify({ models: { 'gemini-3-pro-preview': {} } }), { status: 200 })
				);

			const result = await fetchAvailableModels({
				token: 'test-token',
				fetchImpl: fetchImpl as typeof fetch,
			});

			expect(result).toBeNull();
		});

		it('ignores custom endpoint when discovery is disabled', async () => {
			const result = await fetchAvailableModels({
				token: 'test-token',
				endpoint: 'https://custom.example.com/',
			});

			expect(result).toBeNull();
		});
	});

	describe('getFallbackModels', () => {
		it('returns a non-empty list of fallback models', () => {
			const models = getFallbackModels();
			expect(models.length).toBeGreaterThan(0);
			expect(models.some((m) => m.id === 'gemini-2.5-pro')).toBe(true);
			expect(models.some((m) => m.id === 'gemini-2.5-flash')).toBe(true);
			expect(models.some((m) => m.id === 'gemini-2.0-flash')).toBe(true);
		});

		it('returns a copy of the fallback list', () => {
			const models1 = getFallbackModels();
			const models2 = getFallbackModels();
			expect(models1).toEqual(models2);
			expect(models1).not.toBe(models2);
		});

		it('assigns correct provider to all fallback models', () => {
			const models = getFallbackModels();
			for (const model of models) {
				expect(model.provider).toBe('google-gemini-oauth');
				expect(['gemini', 'gemma']).toContain(model.family);
			}
		});
	});
});
