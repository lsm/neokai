/**
 * System RPC Handlers Tests
 */

import { describe, expect, it, beforeAll, mock } from 'bun:test';
import { setupSystemHandlers } from '../../../src/lib/rpc-handlers/system-handlers';

describe('System RPC Handlers', () => {
	let handlers: Map<string, Function>;
	let mockMessageHub: {
		handle: ReturnType<typeof mock>;
	};
	let mockSessionManager: {
		getActiveSessions: ReturnType<typeof mock>;
		getTotalSessions: ReturnType<typeof mock>;
	};
	let mockAuthManager: {
		getAuthStatus: ReturnType<typeof mock>;
	};
	let mockConfig: {
		defaultModel: string;
		maxSessions: number;
		dbPath: string;
	};

	beforeAll(() => {
		handlers = new Map();
		mockMessageHub = {
			handle: mock((method: string, handler: Function) => {
				handlers.set(method, handler);
			}),
		};

		mockSessionManager = {
			getActiveSessions: mock(() => 2),
			getTotalSessions: mock(() => 5),
		};

		mockAuthManager = {
			getAuthStatus: mock(async () => ({
				method: 'api_key',
				isAuthenticated: true,
				source: 'env',
			})),
		};

		mockConfig = {
			defaultModel: 'claude-sonnet-4-5-20241022',
			maxSessions: 10,
			dbPath: './test.db',
		};

		setupSystemHandlers(mockMessageHub, mockSessionManager, mockAuthManager, mockConfig);
	});

	describe('system.health', () => {
		it('should register handler', () => {
			expect(handlers.has('system.health')).toBe(true);
		});

		it('should return health status', async () => {
			const handler = handlers.get('system.health')!;
			const result = await handler();

			expect(result.status).toBe('ok');
			expect(result.version).toBeDefined();
			expect(result.uptime).toBeGreaterThanOrEqual(0);
			expect(result.sessions).toBeDefined();
			expect(result.sessions.active).toBe(2);
			expect(result.sessions.total).toBe(5);
		});

		it('should have increasing uptime', async () => {
			const handler = handlers.get('system.health')!;
			const result1 = await handler();
			await new Promise((resolve) => setTimeout(resolve, 10));
			const result2 = await handler();

			expect(result2.uptime).toBeGreaterThan(result1.uptime);
		});
	});

	describe('system.config', () => {
		it('should register handler', () => {
			expect(handlers.has('system.config')).toBe(true);
		});

		it('should return daemon configuration', async () => {
			const handler = handlers.get('system.config')!;
			const result = await handler();

			expect(result.version).toBeDefined();
			expect(result.claudeSDKVersion).toBeDefined();
			expect(result.defaultModel).toBe('claude-sonnet-4-5-20241022');
			expect(result.maxSessions).toBe(10);
			expect(result.storageLocation).toBe('./test.db');
			expect(result.authMethod).toBe('api_key');
			expect(result.authStatus).toBeDefined();
		});

		it('should include auth status from AuthManager', async () => {
			const handler = handlers.get('system.config')!;
			const result = await handler();

			expect(result.authStatus.isAuthenticated).toBe(true);
			expect(result.authStatus.method).toBe('api_key');
			expect(result.authStatus.source).toBe('env');
		});

		it('should call AuthManager.getAuthStatus', async () => {
			const handler = handlers.get('system.config')!;
			await handler();

			expect(mockAuthManager.getAuthStatus).toHaveBeenCalled();
		});
	});
});
