/**
 * Tests for Gemini Model Discovery
 */

import { describe, expect, it } from 'bun:test';
import {
	fetchAvailableModels,
	getFallbackModels,
} from '../../../../src/lib/providers/gemini/model-discovery.js';
import type { ModelInfo } from '@neokai/shared';

describe('Gemini Model Discovery', () => {
	describe('fetchAvailableModels', () => {
		it('returns null when all endpoints fail', async () => {
			const fetchImpl = () => Promise.resolve(new Response('error', { status: 500 }));
			const result = await fetchAvailableModels({
				token: 'test-token',
				fetchImpl: fetchImpl as typeof fetch,
			});
			expect(result).toBeNull();
		});

		it('returns null on network error', async () => {
			const fetchImpl = () => Promise.reject(new Error('network error'));
			const result = await fetchAvailableModels({
				token: 'test-token',
				fetchImpl: fetchImpl as typeof fetch,
			});
			expect(result).toBeNull();
		});

		it('parses discovery response and returns models', async () => {
			const mockResponse = {
				models: {
					'gemini-3-pro-preview': {
						displayName: 'Gemini 3 Pro Preview',
						supportsThinking: true,
						supportsImages: true,
						maxTokens: 1_000_000,
						maxOutputTokens: 64_000,
					},
					'gemini-3-flash-preview': {
						displayName: 'Gemini 3 Flash Preview',
						supportsThinking: false,
						maxTokens: 1_000_000,
					},
				},
			};

			const fetchImpl = () =>
				Promise.resolve(
					new Response(JSON.stringify(mockResponse), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					})
				);

			const result = await fetchAvailableModels({
				token: 'test-token',
				fetchImpl: fetchImpl as typeof fetch,
			});

			expect(result).not.toBeNull();
			expect(result).toHaveLength(2);

			const pro = result!.find((m) => m.id === 'gemini-3-pro-preview');
			expect(pro).toBeDefined();
			expect(pro!.name).toBe('Gemini 3 Pro Preview');
			expect(pro!.family).toBe('gemini');
			expect(pro!.contextWindow).toBe(1_000_000);
			expect(pro!.thinkingModes).toBe('on');

			const flash = result!.find((m) => m.id === 'gemini-3-flash-preview');
			expect(flash).toBeDefined();
			expect(flash!.thinkingModes).toBe('off');
		});

		it('filters denylisted models', async () => {
			const mockResponse = {
				models: {
					'gemini-3-pro-preview': { displayName: 'Gemini 3 Pro' },
					chat_20706: { displayName: 'Hidden Model' },
					'gemini-2.5-flash-thinking': { displayName: 'Thinking Model' },
				},
			};

			const fetchImpl = () =>
				Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }));

			const result = await fetchAvailableModels({
				token: 'test-token',
				fetchImpl: fetchImpl as typeof fetch,
			});

			expect(result).not.toBeNull();
			expect(result).toHaveLength(1);
			expect(result![0].id).toBe('gemini-3-pro-preview');
		});

		it('filters internal models', async () => {
			const mockResponse = {
				models: {
					'gemini-3-pro-preview': { displayName: 'Gemini 3 Pro' },
					'internal-model': { displayName: 'Internal', isInternal: true },
				},
			};

			const fetchImpl = () =>
				Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }));

			const result = await fetchAvailableModels({
				token: 'test-token',
				fetchImpl: fetchImpl as typeof fetch,
			});

			expect(result).not.toBeNull();
			expect(result).toHaveLength(1);
			expect(result![0].id).toBe('gemini-3-pro-preview');
		});

		it('assigns gemma family for gemma models', async () => {
			const mockResponse = {
				models: {
					'gemma-4-31b-it': { displayName: 'Gemma 4 31B' },
				},
			};

			const fetchImpl = () =>
				Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }));

			const result = await fetchAvailableModels({
				token: 'test-token',
				fetchImpl: fetchImpl as typeof fetch,
			});

			expect(result).not.toBeNull();
			expect(result![0].family).toBe('gemma');
		});

		it('falls back to default context window when maxTokens is missing', async () => {
			const mockResponse = {
				models: {
					'gemini-3-pro-preview': { displayName: 'Gemini 3 Pro' },
				},
			};

			const fetchImpl = () =>
				Promise.resolve(new Response(JSON.stringify(mockResponse), { status: 200 }));

			const result = await fetchAvailableModels({
				token: 'test-token',
				fetchImpl: fetchImpl as typeof fetch,
			});

			expect(result).not.toBeNull();
			expect(result![0].contextWindow).toBe(1_000_000);
		});

		it('uses custom endpoint when provided', async () => {
			let calledUrl = '';
			const fetchImpl = (url: string) => {
				calledUrl = url;
				return Promise.resolve(new Response(JSON.stringify({ models: {} }), { status: 200 }));
			};

			await fetchAvailableModels({
				token: 'test-token',
				endpoint: 'https://custom.example.com/',
				fetchImpl: fetchImpl as typeof fetch,
			});

			expect(calledUrl).toBe('https://custom.example.com/v1internal:fetchAvailableModels');
		});
	});

	describe('getFallbackModels', () => {
		it('returns a non-empty list of fallback models', () => {
			const models = getFallbackModels();
			expect(models.length).toBeGreaterThan(0);
			expect(models.some((m) => m.id === 'gemini-2.5-pro')).toBe(true);
		});

		it('returns a copy of the fallback list', () => {
			const models1 = getFallbackModels();
			const models2 = getFallbackModels();
			expect(models1).toEqual(models2);
			expect(models1).not.toBe(models2);
		});
	});
});
