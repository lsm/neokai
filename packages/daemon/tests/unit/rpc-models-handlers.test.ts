/**
 * Models RPC Handlers Tests
 *
 * Tests for models.list and models.clearCache RPC handlers with mocked fetch.
 * These tests don't require an actual API key.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { MessageHub, EventBus, clearModelCache } from '@liuboer/shared';
import { setupRPCHandlers } from '../../src/lib/rpc-handlers';
import { getConfig } from '../../src/config';
import { Database } from '../../src/storage/database';
import { AuthManager } from '../../src/lib/auth-manager';
import { SessionManager } from '../../src/lib/session-manager';

// Mock response data
const mockModels = [
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

const mockResponse = {
	data: mockModels,
	first_id: 'claude-opus-4-20250514',
	last_id: 'claude-sonnet-4-5-20250929',
	has_more: false,
};

describe('Models RPC Handlers', () => {
	let db: Database;
	let messageHub: MessageHub;
	let authManager: AuthManager;
	let sessionManager: SessionManager;
	let eventBus: EventBus;
	let originalFetch: typeof globalThis.fetch;
	let originalApiKey: string | undefined;

	beforeEach(async () => {
		// Store originals
		originalFetch = globalThis.fetch;
		originalApiKey = process.env.ANTHROPIC_API_KEY;

		// Set a test API key so the models-api doesn't throw
		process.env.ANTHROPIC_API_KEY = 'test-api-key';

		// Clear model cache
		clearModelCache();

		// Mock fetch
		globalThis.fetch = async () => {
			return new Response(JSON.stringify(mockResponse), { status: 200 });
		};

		// Setup dependencies
		const config = getConfig();
		db = new Database(':memory:');
		await db.initialize();

		authManager = new AuthManager(db, config);
		await authManager.initialize();

		eventBus = new EventBus();
		messageHub = new MessageHub({ defaultSessionId: 'global', debug: false });

		sessionManager = new SessionManager(db, messageHub, authManager, eventBus, {
			defaultModel: config.defaultModel,
			maxTokens: config.maxTokens,
			temperature: config.temperature,
			workspaceRoot: config.workspaceRoot,
		});

		// Setup RPC handlers
		setupRPCHandlers({
			messageHub,
			sessionManager,
			authManager,
			config,
		});
	});

	afterEach(async () => {
		// Restore fetch
		globalThis.fetch = originalFetch;

		// Restore API key
		if (originalApiKey !== undefined) {
			process.env.ANTHROPIC_API_KEY = originalApiKey;
		} else {
			delete process.env.ANTHROPIC_API_KEY;
		}

		// Clear model cache
		clearModelCache();

		// Cleanup
		await sessionManager.cleanup();
		db.close();
	});

	describe('models.list', () => {
		test('returns list of models with cache enabled', async () => {
			const handler = (messageHub as unknown).rpcHandlers.get('models.list');
			expect(handler).toBeDefined();

			const result = await handler({ useCache: true, forceRefresh: false });

			expect(result.models).toBeArray();
			expect(result.models.length).toBe(2);
			expect(result.cached).toBe(true);
		});

		test('returns list of models with cache disabled', async () => {
			const handler = (messageHub as unknown).rpcHandlers.get('models.list');

			const result = await handler({ useCache: false });

			expect(result.models).toBeArray();
			expect(result.models.length).toBe(2);
			expect(result.cached).toBe(false);
			expect(result.hasMore).toBe(false);
		});

		test('force refreshes cache when requested', async () => {
			const handler = (messageHub as unknown).rpcHandlers.get('models.list');

			// First call to populate cache
			await handler({ useCache: true, forceRefresh: false });

			// Force refresh
			const result = await handler({ useCache: true, forceRefresh: true });

			expect(result.models).toBeArray();
			expect(result.cached).toBe(false);
		});

		test('uses default values when no parameters provided', async () => {
			const handler = (messageHub as unknown).rpcHandlers.get('models.list');

			const result = await handler({});

			expect(result.models).toBeArray();
			expect(result.cached).toBe(true); // Default is useCache: true
		});

		test('throws error when API call fails', async () => {
			// Clear cache and mock a failed fetch
			clearModelCache();
			globalThis.fetch = async () => {
				throw new Error('Network error');
			};

			const handler = (messageHub as unknown).rpcHandlers.get('models.list');

			await expect(handler({ useCache: true, forceRefresh: true })).rejects.toThrow(
				'Failed to list models: Network error'
			);
		});

		test('throws error when API returns non-OK response', async () => {
			// Clear cache and mock a failed fetch
			clearModelCache();
			globalThis.fetch = async () => {
				return new Response(JSON.stringify({ error: 'Unauthorized' }), {
					status: 401,
					statusText: 'Unauthorized',
				});
			};

			const handler = (messageHub as unknown).rpcHandlers.get('models.list');

			await expect(handler({ useCache: true, forceRefresh: true })).rejects.toThrow(
				'Failed to list models'
			);
		});
	});

	describe('models.clearCache', () => {
		test('clears the model cache successfully', async () => {
			const handler = (messageHub as unknown).rpcHandlers.get('models.clearCache');
			expect(handler).toBeDefined();

			const result = await handler({});

			expect(result.success).toBe(true);
		});

		test('cleared cache causes fresh fetch on next request', async () => {
			const listHandler = (messageHub as unknown).rpcHandlers.get('models.list');
			const clearHandler = (messageHub as unknown).rpcHandlers.get('models.clearCache');

			let fetchCallCount = 0;
			globalThis.fetch = async () => {
				fetchCallCount++;
				return new Response(JSON.stringify(mockResponse), { status: 200 });
			};

			// First call - should fetch
			await listHandler({ useCache: true });
			expect(fetchCallCount).toBe(1);

			// Second call - should use cache
			await listHandler({ useCache: true });
			expect(fetchCallCount).toBe(1);

			// Clear cache
			await clearHandler({});

			// Third call - should fetch again
			await listHandler({ useCache: true });
			expect(fetchCallCount).toBe(2);
		});
	});
});
