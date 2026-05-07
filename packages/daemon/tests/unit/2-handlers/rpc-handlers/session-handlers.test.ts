/**
 * Unit tests for Session RPC Handlers — models.list empty-cache fallback
 *
 * These tests mock model-service imports to avoid requiring live providers.
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { DaemonHub } from '../../../../src/lib/daemon-hub';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager';

// Type for captured request handlers
type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

const mockGetAvailableModels = mock(
	(): Array<{
		id: string;
		name: string;
		alias: string;
		family: string;
		provider: string;
		contextWindow: number;
		description: string;
		releaseDate: string;
		available: boolean;
	}> => []
);

const mockRefreshModels = mock(async () => {});

mock.module('../../../../src/lib/model-service', () => ({
	getAvailableModels: mockGetAvailableModels,
	refreshModels: mockRefreshModels,
	clearModelsCache: mock(() => {}),
}));

// Helper to create a minimal mock MessageHub that captures handlers
function createMockMessageHub(): {
	hub: MessageHub;
	handlers: Map<string, RequestHandler>;
} {
	const handlers = new Map<string, RequestHandler>();

	const hub = {
		onRequest: mock((method: string, handler: RequestHandler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		}),
		onEvent: mock(() => () => {}),
		request: mock(async () => {}),
		event: mock(() => {}),
		joinChannel: mock(async () => {}),
		leaveChannel: mock(async () => {}),
		isConnected: mock(() => true),
		getState: mock(() => 'connected' as const),
		onConnection: mock(() => () => {}),
		onMessage: mock(() => () => {}),
		cleanup: mock(() => {}),
		registerTransport: mock(() => () => {}),
		registerRouter: mock(() => {}),
		getRouter: mock(() => null),
		getPendingCallCount: mock(() => 0),
	} as unknown as MessageHub;

	return { hub, handlers };
}

describe('Session RPC Handlers — models.list', () => {
	let messageHubData: ReturnType<typeof createMockMessageHub>;

	beforeEach(async () => {
		messageHubData = createMockMessageHub();

		mockGetAvailableModels.mockClear();
		mockRefreshModels.mockClear();

		// Import and set up handlers after mock is in place
		const { setupSessionHandlers } = await import(
			'../../../../src/lib/rpc-handlers/session-handlers'
		);
		setupSessionHandlers(
			messageHubData.hub,
			{} as SessionManager,
			{} as DaemonHub,
			{} as SpaceManager
		);
	});

	afterEach(() => {
		mock.restore();
	});

	it('returns cached models when cache is populated', async () => {
		const cachedModels = [
			{
				id: 'sonnet',
				name: 'Claude Sonnet',
				alias: 'default',
				family: 'sonnet',
				provider: 'anthropic',
				contextWindow: 200000,
				description: 'Fast model',
				releaseDate: '2025-01-01',
				available: true,
			},
		];
		mockGetAvailableModels.mockReturnValue(cachedModels);

		const handler = messageHubData.handlers.get('models.list');
		expect(handler).toBeDefined();

		const result = (await handler!({ useCache: true }, {})) as {
			models: Array<{ id: string; display_name: string }>;
			cached: boolean;
		};

		expect(result.models).toHaveLength(1);
		expect(result.models[0].id).toBe('sonnet');
		expect(result.cached).toBe(true);
		expect(mockRefreshModels).not.toHaveBeenCalled();
	});

	it('triggers refreshModels when cache is empty and useCache is true', async () => {
		// First call returns empty (cache cleared), second call returns models after refresh
		mockGetAvailableModels.mockReturnValueOnce([]).mockReturnValueOnce([
			{
				id: 'gemini-pro',
				name: 'Gemini Pro',
				alias: 'gemini-pro',
				family: 'gemini',
				provider: 'google-gemini-oauth',
				contextWindow: 128000,
				description: 'Gemini model',
				releaseDate: '2025-01-01',
				available: true,
			},
		]);

		const handler = messageHubData.handlers.get('models.list');

		const result = (await handler!({ useCache: true }, {})) as {
			models: Array<{ id: string; display_name: string }>;
			cached: boolean;
		};

		expect(mockRefreshModels).toHaveBeenCalledTimes(1);
		expect(result.models).toHaveLength(1);
		expect(result.models[0].id).toBe('gemini-pro');
		expect(result.cached).toBe(false);
	});

	it('does NOT trigger fallback refresh when forceRefresh is already true', async () => {
		mockGetAvailableModels.mockReturnValue([
			{
				id: 'sonnet',
				name: 'Claude Sonnet',
				alias: 'default',
				family: 'sonnet',
				provider: 'anthropic',
				contextWindow: 200000,
				description: 'Fast model',
				releaseDate: '2025-01-01',
				available: true,
			},
		]);

		const handler = messageHubData.handlers.get('models.list');

		const result = (await handler!({ forceRefresh: true }, {})) as {
			models: Array<{ id: string; display_name: string }>;
			cached: boolean;
		};

		// refreshModels is called once for the explicit forceRefresh, NOT twice
		expect(mockRefreshModels).toHaveBeenCalledTimes(1);
		expect(result.models).toHaveLength(1);
		expect(result.cached).toBe(false);
	});

	it('does NOT trigger fallback refresh when useCache is false', async () => {
		mockGetAvailableModels.mockReturnValue([
			{
				id: 'sonnet',
				name: 'Claude Sonnet',
				alias: 'default',
				family: 'sonnet',
				provider: 'anthropic',
				contextWindow: 200000,
				description: 'Fast model',
				releaseDate: '2025-01-01',
				available: true,
			},
		]);

		const handler = messageHubData.handlers.get('models.list');

		const result = (await handler!({ useCache: false }, {})) as {
			models: Array<{ id: string; display_name: string }>;
			cached: boolean;
		};

		// refreshModels is called once for useCache: false, NOT twice
		expect(mockRefreshModels).toHaveBeenCalledTimes(1);
		expect(result.models).toHaveLength(1);
		expect(result.cached).toBe(false);
	});

	it('returns empty array when cache stays empty after refresh', async () => {
		// Cache empty and refresh does not produce models
		mockGetAvailableModels.mockReturnValue([]);

		const handler = messageHubData.handlers.get('models.list');

		const result = (await handler!({ useCache: true }, {})) as {
			models: Array<unknown>;
			cached: boolean;
		};

		expect(mockRefreshModels).toHaveBeenCalledTimes(1);
		expect(result.models).toEqual([]);
		expect(result.cached).toBe(false);
	});
});
