/**
 * Models API Tests
 *
 * Tests for the Anthropic Models API client with mocked fetch.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
	fetchAvailableModels,
	getAllAvailableModels,
	isModelAvailable,
	getModelInfoFromAPI,
	getCachedAvailableModels,
	clearModelCache,
	type AnthropicModel,
	type ListModelsResponse,
} from '../src/models-api.ts';

// Mock response data
const mockModels: AnthropicModel[] = [
	{
		id: 'claude-opus-4-20250514',
		created_at: '2025-05-14T00:00:00Z',
		display_name: 'Claude Opus 4',
		type: 'model',
	},
	{
		id: 'claude-sonnet-4-5-20250929',
		created_at: '2025-09-29T00:00:00Z',
		display_name: 'Claude Sonnet 4.5',
		type: 'model',
	},
];

const mockResponse: ListModelsResponse = {
	data: mockModels,
	first_id: 'claude-opus-4-20250514',
	last_id: 'claude-sonnet-4-5-20250929',
	has_more: false,
};

// Store original fetch and env vars
let originalFetch: typeof globalThis.fetch;
let originalApiKey: string | undefined;
let originalOAuthToken: string | undefined;

describe('Models API', () => {
	beforeEach(() => {
		// Store originals
		originalFetch = globalThis.fetch;
		originalApiKey = process.env.ANTHROPIC_API_KEY;
		originalOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

		// Clear cache before each test
		clearModelCache();
	});

	afterEach(() => {
		// Restore originals
		globalThis.fetch = originalFetch;
		if (originalApiKey !== undefined) {
			process.env.ANTHROPIC_API_KEY = originalApiKey;
		} else {
			delete process.env.ANTHROPIC_API_KEY;
		}
		if (originalOAuthToken !== undefined) {
			process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOAuthToken;
		} else {
			delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
		}

		// Clear cache after each test
		clearModelCache();
	});

	describe('fetchAvailableModels', () => {
		test('throws error when no API key or OAuth token is set', async () => {
			delete process.env.ANTHROPIC_API_KEY;
			delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

			await expect(fetchAvailableModels()).rejects.toThrow(
				'API key required. Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN environment variable, or pass apiKey option.'
			);
		});

		test('uses apiKey option when provided', async () => {
			delete process.env.ANTHROPIC_API_KEY;
			delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

			let capturedHeaders: Record<string, string> = {};
			globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
				capturedHeaders = init?.headers as Record<string, string>;
				return new Response(JSON.stringify(mockResponse), { status: 200 });
			};

			await fetchAvailableModels({ apiKey: 'test-api-key' });

			expect(capturedHeaders['x-api-key']).toBe('test-api-key');
		});

		test('uses ANTHROPIC_API_KEY env var', async () => {
			process.env.ANTHROPIC_API_KEY = 'env-api-key';
			delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

			let capturedHeaders: Record<string, string> = {};
			globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
				capturedHeaders = init?.headers as Record<string, string>;
				return new Response(JSON.stringify(mockResponse), { status: 200 });
			};

			await fetchAvailableModels();

			expect(capturedHeaders['x-api-key']).toBe('env-api-key');
		});

		test('uses CLAUDE_CODE_OAUTH_TOKEN when API key not available', async () => {
			delete process.env.ANTHROPIC_API_KEY;
			process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-token';

			let capturedHeaders: Record<string, string> = {};
			globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
				capturedHeaders = init?.headers as Record<string, string>;
				return new Response(JSON.stringify(mockResponse), { status: 200 });
			};

			await fetchAvailableModels();

			expect(capturedHeaders['Authorization']).toBe('Bearer oauth-token');
		});

		test('includes pagination params in URL', async () => {
			process.env.ANTHROPIC_API_KEY = 'test-key';

			let capturedUrl = '';
			globalThis.fetch = async (url: string | URL | Request, _init?: RequestInit) => {
				capturedUrl = url.toString();
				return new Response(JSON.stringify(mockResponse), { status: 200 });
			};

			await fetchAvailableModels({
				after_id: 'model-1',
				before_id: 'model-10',
				limit: 50,
			});

			expect(capturedUrl).toContain('after_id=model-1');
			expect(capturedUrl).toContain('before_id=model-10');
			expect(capturedUrl).toContain('limit=50');
		});

		test('includes beta header when specified', async () => {
			process.env.ANTHROPIC_API_KEY = 'test-key';

			let capturedHeaders: Record<string, string> = {};
			globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
				capturedHeaders = init?.headers as Record<string, string>;
				return new Response(JSON.stringify(mockResponse), { status: 200 });
			};

			await fetchAvailableModels({ beta: 'max-tokens-3-5-sonnet-2024-07-15' });

			expect(capturedHeaders['anthropic-beta']).toBe('max-tokens-3-5-sonnet-2024-07-15');
		});

		test('throws error on non-OK response', async () => {
			process.env.ANTHROPIC_API_KEY = 'test-key';

			globalThis.fetch = async () => {
				return new Response(JSON.stringify({ error: 'Unauthorized' }), {
					status: 401,
					statusText: 'Unauthorized',
				});
			};

			await expect(fetchAvailableModels()).rejects.toThrow(
				'Failed to fetch models: 401 Unauthorized'
			);
		});

		test('handles non-JSON error response', async () => {
			process.env.ANTHROPIC_API_KEY = 'test-key';

			globalThis.fetch = async () => {
				return new Response('Internal Server Error', {
					status: 500,
					statusText: 'Internal Server Error',
				});
			};

			await expect(fetchAvailableModels()).rejects.toThrow(
				'Failed to fetch models: 500 Internal Server Error'
			);
		});

		test('returns parsed response on success', async () => {
			process.env.ANTHROPIC_API_KEY = 'test-key';

			globalThis.fetch = async () => {
				return new Response(JSON.stringify(mockResponse), { status: 200 });
			};

			const result = await fetchAvailableModels();

			expect(result.data).toHaveLength(2);
			expect(result.data[0].id).toBe('claude-opus-4-20250514');
			expect(result.has_more).toBe(false);
		});
	});

	describe('getAllAvailableModels', () => {
		test('fetches all models with pagination', async () => {
			process.env.ANTHROPIC_API_KEY = 'test-key';

			let callCount = 0;
			globalThis.fetch = async (url: string | URL | Request) => {
				callCount++;
				const urlStr = url.toString();

				if (!urlStr.includes('after_id')) {
					// First page
					return new Response(
						JSON.stringify({
							data: [mockModels[0]],
							first_id: mockModels[0].id,
							last_id: mockModels[0].id,
							has_more: true,
						}),
						{ status: 200 }
					);
				} else {
					// Second page
					return new Response(
						JSON.stringify({
							data: [mockModels[1]],
							first_id: mockModels[1].id,
							last_id: mockModels[1].id,
							has_more: false,
						}),
						{ status: 200 }
					);
				}
			};

			const models = await getAllAvailableModels();

			expect(callCount).toBe(2);
			expect(models).toHaveLength(2);
			expect(models[0].id).toBe('claude-opus-4-20250514');
			expect(models[1].id).toBe('claude-sonnet-4-5-20250929');
		});
	});

	describe('isModelAvailable', () => {
		test('returns true when model exists', async () => {
			process.env.ANTHROPIC_API_KEY = 'test-key';

			globalThis.fetch = async () => {
				return new Response(JSON.stringify(mockResponse), { status: 200 });
			};

			const result = await isModelAvailable('claude-opus-4-20250514');

			expect(result).toBe(true);
		});

		test('returns false when model does not exist', async () => {
			process.env.ANTHROPIC_API_KEY = 'test-key';

			globalThis.fetch = async () => {
				return new Response(JSON.stringify(mockResponse), { status: 200 });
			};

			const result = await isModelAvailable('non-existent-model');

			expect(result).toBe(false);
		});

		test('returns false when API call fails', async () => {
			process.env.ANTHROPIC_API_KEY = 'test-key';

			globalThis.fetch = async () => {
				throw new Error('Network error');
			};

			// Suppress console.error during test
			const originalConsoleError = console.error;
			console.error = () => {};

			const result = await isModelAvailable('claude-opus-4-20250514');

			console.error = originalConsoleError;

			expect(result).toBe(false);
		});
	});

	describe('getModelInfoFromAPI', () => {
		test('returns model info when found', async () => {
			process.env.ANTHROPIC_API_KEY = 'test-key';

			globalThis.fetch = async () => {
				return new Response(JSON.stringify(mockResponse), { status: 200 });
			};

			const result = await getModelInfoFromAPI('claude-opus-4-20250514');

			expect(result).not.toBeNull();
			expect(result?.id).toBe('claude-opus-4-20250514');
			expect(result?.display_name).toBe('Claude Opus 4');
		});

		test('returns null when model not found', async () => {
			process.env.ANTHROPIC_API_KEY = 'test-key';

			globalThis.fetch = async () => {
				return new Response(JSON.stringify(mockResponse), { status: 200 });
			};

			const result = await getModelInfoFromAPI('non-existent-model');

			expect(result).toBeNull();
		});

		test('returns null when API call fails', async () => {
			process.env.ANTHROPIC_API_KEY = 'test-key';

			globalThis.fetch = async () => {
				throw new Error('Network error');
			};

			// Suppress console.error during test
			const originalConsoleError = console.error;
			console.error = () => {};

			const result = await getModelInfoFromAPI('claude-opus-4-20250514');

			console.error = originalConsoleError;

			expect(result).toBeNull();
		});
	});

	describe('getCachedAvailableModels', () => {
		test('returns fresh data on first call', async () => {
			process.env.ANTHROPIC_API_KEY = 'test-key';

			let callCount = 0;
			globalThis.fetch = async () => {
				callCount++;
				return new Response(JSON.stringify(mockResponse), { status: 200 });
			};

			const models = await getCachedAvailableModels();

			expect(callCount).toBe(1);
			expect(models).toHaveLength(2);
		});

		test('returns cached data on subsequent calls', async () => {
			process.env.ANTHROPIC_API_KEY = 'test-key';

			let callCount = 0;
			globalThis.fetch = async () => {
				callCount++;
				return new Response(JSON.stringify(mockResponse), { status: 200 });
			};

			await getCachedAvailableModels();
			await getCachedAvailableModels();
			await getCachedAvailableModels();

			expect(callCount).toBe(1);
		});

		test('refreshes cache when forceRefresh is true', async () => {
			process.env.ANTHROPIC_API_KEY = 'test-key';

			let callCount = 0;
			globalThis.fetch = async () => {
				callCount++;
				return new Response(JSON.stringify(mockResponse), { status: 200 });
			};

			await getCachedAvailableModels();
			await getCachedAvailableModels({}, true); // Force refresh

			expect(callCount).toBe(2);
		});
	});

	describe('clearModelCache', () => {
		test('clears the cache forcing fresh fetch', async () => {
			process.env.ANTHROPIC_API_KEY = 'test-key';

			let callCount = 0;
			globalThis.fetch = async () => {
				callCount++;
				return new Response(JSON.stringify(mockResponse), { status: 200 });
			};

			await getCachedAvailableModels();
			clearModelCache();
			await getCachedAvailableModels();

			expect(callCount).toBe(2);
		});
	});
});
