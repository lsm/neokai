/**
 * Authentication Integration Tests
 *
 * Tests authentication management and RPC handlers.
 * Verifies auth status reporting and credential management.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../../test-utils';
import { createTestApp, callRPCHandler, hasApiKey, hasOAuthToken } from '../../../test-utils';

// Use temp directory for test workspaces
const TMP_DIR = process.env.TMPDIR || '/tmp';

describe('Authentication Integration', () => {
	let ctx: TestContext;

	beforeEach(async () => {
		ctx = await createTestApp();
	});

	afterEach(async () => {
		await ctx.cleanup();
	});

	describe('auth.status', () => {
		test('should return auth status', async () => {
			const result = await callRPCHandler(ctx.messageHub, 'auth.status', {});

			expect(result.authStatus).toBeDefined();
			expect(result.authStatus.isAuthenticated).toBeBoolean();
			expect(result.authStatus.method).toBeString();
			expect(result.authStatus.source).toBeString();
		});

		test('should indicate authentication method', async () => {
			const result = await callRPCHandler(ctx.messageHub, 'auth.status', {});

			if (hasApiKey()) {
				expect(result.authStatus.isAuthenticated).toBe(true);
				expect(result.authStatus.method).toBe('api_key');
				expect(result.authStatus.source).toBe('env');
			} else if (hasOAuthToken()) {
				expect(result.authStatus.isAuthenticated).toBe(true);
				expect(result.authStatus.method).toBe('oauth_token');
				expect(result.authStatus.source).toBe('env');
			} else {
				expect(result.authStatus.isAuthenticated).toBe(false);
				expect(result.authStatus.method).toBe('none');
			}
		});

		test('should expose auth status in system state', async () => {
			const result = await callRPCHandler(ctx.messageHub, 'state.system', {});

			expect(result.auth).toBeDefined();
			expect(result.auth.isAuthenticated).toBeBoolean();
			expect(result.auth.method).toBeString();
		});
	});

	describe('AuthManager', () => {
		test('should initialize auth manager', async () => {
			expect(ctx.authManager).toBeDefined();

			const status = await ctx.authManager.getAuthStatus();
			expect(status).toBeDefined();
			expect(status.isAuthenticated).toBeBoolean();
		});

		test('should get current API key if authenticated', async () => {
			const apiKey = await ctx.authManager.getCurrentApiKey();

			if (hasApiKey() || hasOAuthToken()) {
				expect(apiKey).toBeString();
				expect(apiKey.length).toBeGreaterThan(0);
			} else {
				// If not authenticated, this will throw or return null
				expect(apiKey === null || apiKey === undefined).toBe(true);
			}
		});
	});

	describe('Auth Configuration', () => {
		test('should require environment variable credentials', async () => {
			const status = await ctx.authManager.getAuthStatus();

			// Auth credentials must come from environment variables
			if (status.isAuthenticated) {
				expect(status.source).toBe('env');
			}
		});

		test('should prioritize API key over OAuth token', async () => {
			const status = await ctx.authManager.getAuthStatus();

			// If both are set, API key should be preferred
			if (hasApiKey() && hasOAuthToken()) {
				expect(status.method).toBe('api_key');
			}
		});
	});

	describe('Auth Events', () => {
		test('should broadcast auth change via EventBus', async () => {
			let eventReceived = false;
			const eventPromise = new Promise((resolve) => {
				ctx.stateManager.eventBus.on('auth:changed', () => {
					eventReceived = true;
					resolve(true);
				});
			});

			// Trigger auth change (would normally happen on credential update)
			ctx.stateManager.eventBus.emit('auth:changed', {});

			await eventPromise;
			expect(eventReceived).toBe(true);
		});
	});

	describe('Session Creation with Auth', () => {
		test.skipIf(!hasApiKey() && !hasOAuthToken())(
			'should create session only if authenticated',
			async () => {
				const result = await callRPCHandler(ctx.messageHub, 'session.create', {
					workspacePath: `${TMP_DIR}/test-auth`,
				});

				expect(result.sessionId).toBeString();

				// Verify session was created
				const session = ctx.db.getSession(result.sessionId);
				expect(session).toBeDefined();
			}
		);

		test('should expose auth method in system state', async () => {
			const system = await callRPCHandler(ctx.messageHub, 'state.system', {});

			expect(system.auth.method).toBeString();
			expect(['api_key', 'oauth_token', 'none']).toContain(system.auth.method);
		});
	});
});
