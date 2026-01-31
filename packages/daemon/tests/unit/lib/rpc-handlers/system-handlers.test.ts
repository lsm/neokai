/**
 * System Handlers Tests
 *
 * Tests for system RPC handlers.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { setupSystemHandlers } from '../../../../src/lib/rpc-handlers/system-handlers';
import type { MessageHub, HealthStatus, DaemonConfig, AuthStatus } from '@neokai/shared';
import type { SessionManager } from '../../../../src/lib/session-manager';
import type { AuthManager } from '../../../../src/lib/auth-manager';
import type { Config } from '../../../../src/config';

describe('System Handlers', () => {
	let mockMessageHub: MessageHub;
	let mockSessionManager: SessionManager;
	let mockAuthManager: AuthManager;
	let mockConfig: Config;
	let handlers: Map<string, (data: unknown) => Promise<unknown>>;

	beforeEach(() => {
		handlers = new Map();

		// Mock MessageHub
		mockMessageHub = {
			handle: mock((name: string, handler: (data: unknown) => Promise<unknown>) => {
				handlers.set(name, handler);
			}),
			publish: mock(async () => {}),
		} as unknown as MessageHub;

		// Mock SessionManager
		mockSessionManager = {
			getActiveSessions: mock(() => 3),
			getTotalSessions: mock(() => 10),
		} as unknown as SessionManager;

		// Mock AuthManager
		const mockAuthStatus: AuthStatus = {
			isAuthenticated: true,
			method: 'api_key',
		};
		mockAuthManager = {
			getAuthStatus: mock(async () => mockAuthStatus),
		} as unknown as AuthManager;

		// Mock Config
		mockConfig = {
			defaultModel: 'claude-sonnet-4-20250514',
			maxSessions: 10,
			dbPath: '/path/to/db.sqlite',
		} as Config;

		// Setup handlers
		setupSystemHandlers(mockMessageHub, mockSessionManager, mockAuthManager, mockConfig);
	});

	async function callHandler(name: string, data?: unknown): Promise<unknown> {
		const handler = handlers.get(name);
		if (!handler) throw new Error(`Handler ${name} not found`);
		return handler(data);
	}

	describe('setup', () => {
		it('should register all system handlers', () => {
			expect(handlers.has('system.health')).toBe(true);
			expect(handlers.has('system.config')).toBe(true);
			expect(handlers.has('test.echo')).toBe(true);
		});
	});

	describe('system.health', () => {
		it('should return health status', async () => {
			const result = (await callHandler('system.health')) as HealthStatus;

			expect(result.status).toBe('ok');
			expect(result.version).toBe('0.1.1');
			expect(result.uptime).toBeGreaterThanOrEqual(0);
			expect(result.sessions).toEqual({
				active: 3,
				total: 10,
			});
		});

		it('should call sessionManager methods', async () => {
			await callHandler('system.health');

			expect(mockSessionManager.getActiveSessions).toHaveBeenCalled();
			expect(mockSessionManager.getTotalSessions).toHaveBeenCalled();
		});
	});

	describe('system.config', () => {
		it('should return daemon config', async () => {
			const result = (await callHandler('system.config')) as DaemonConfig;

			expect(result.version).toBe('0.1.1');
			expect(result.claudeSDKVersion).toBeDefined();
			expect(result.defaultModel).toBe('claude-sonnet-4-20250514');
			expect(result.maxSessions).toBe(10);
			expect(result.storageLocation).toBe('/path/to/db.sqlite');
			expect(result.authMethod).toBe('api_key');
			expect(result.authStatus).toEqual({
				isAuthenticated: true,
				method: 'api_key',
			});
		});

		it('should call authManager.getAuthStatus', async () => {
			await callHandler('system.config');

			expect(mockAuthManager.getAuthStatus).toHaveBeenCalled();
		});

		it('should handle different auth methods', async () => {
			const oauthStatus: AuthStatus = {
				isAuthenticated: true,
				method: 'oauth',
				expiresAt: Date.now() + 3600000,
			};
			(mockAuthManager.getAuthStatus as ReturnType<typeof mock>).mockResolvedValue(oauthStatus);

			const result = (await callHandler('system.config')) as DaemonConfig;

			expect(result.authMethod).toBe('oauth');
			expect(result.authStatus).toEqual(oauthStatus);
		});

		it('should handle unauthenticated state', async () => {
			const unauthStatus: AuthStatus = {
				isAuthenticated: false,
				method: 'none',
			};
			(mockAuthManager.getAuthStatus as ReturnType<typeof mock>).mockResolvedValue(unauthStatus);

			const result = (await callHandler('system.config')) as DaemonConfig;

			expect(result.authMethod).toBe('none');
			expect(result.authStatus.isAuthenticated).toBe(false);
		});
	});

	describe('test.echo', () => {
		it('should echo the message', async () => {
			const result = (await callHandler('test.echo', { message: 'hello' })) as { echoed: string };

			expect(result.echoed).toBe('hello');
		});

		it('should default to "echo" if no message provided', async () => {
			const result = (await callHandler('test.echo', {})) as { echoed: string };

			expect(result.echoed).toBe('echo');
		});

		it('should publish echo event to global session', async () => {
			await callHandler('test.echo', { message: 'test-message' });

			expect(mockMessageHub.publish).toHaveBeenCalledWith(
				'test.echo',
				{ echo: 'test-message' },
				{ sessionId: 'global' }
			);
		});
	});
});
