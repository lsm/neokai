/**
 * Authentication Integration Tests
 *
 * Tests authentication management and RPC handlers.
 * Verifies auth status reporting and credential management.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { TestContext } from '../../test-utils';
import { createTestApp, callRPCHandler, hasApiKey, hasOAuthToken } from '../../test-utils';

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
		test('should broadcast auth change via DaemonHub', async () => {
			let eventReceived = false;
			const eventPromise = new Promise((resolve) => {
				ctx.stateManager.eventBus.on('auth.changed', () => {
					eventReceived = true;
					resolve(true);
				});
			});

			// Trigger auth change (would normally happen on credential update)
			ctx.stateManager.eventBus.emit('auth.changed', {
				sessionId: 'global',
				method: 'api_key',
				isAuthenticated: true,
			});

			await eventPromise;
			expect(eventReceived).toBe(true);
		});
	});

	describe('Session Creation with Auth', () => {
		// NOTE: The test 'should create session only if authenticated' has been moved to
		// tests/online/auth.test.ts because it requires API credentials to verify
		// that authenticated sessions can be created successfully.

		test('should expose auth method in system state', async () => {
			const system = await callRPCHandler(ctx.messageHub, 'state.system', {});

			expect(system.auth.method).toBeString();
			expect(['api_key', 'oauth_token', 'none']).toContain(system.auth.method);
		});
	});

	describe('Graceful Startup Without Credentials', () => {
		let unauthCtx: TestContext;
		let savedApiKey: string | undefined;
		let savedOAuthToken: string | undefined;
		let savedAuthToken: string | undefined;
		let savedGlmKey: string | undefined;

		beforeEach(async () => {
			// Save and clear ALL credential env vars
			savedApiKey = process.env.ANTHROPIC_API_KEY;
			savedOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
			savedAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
			savedGlmKey = process.env.GLM_API_KEY;

			delete process.env.ANTHROPIC_API_KEY;
			delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
			delete process.env.ANTHROPIC_AUTH_TOKEN;
			delete process.env.GLM_API_KEY;

			// Create app with no credentials - should NOT throw
			unauthCtx = await createTestApp();
		});

		afterEach(async () => {
			await unauthCtx.cleanup();

			// Restore env vars
			if (savedApiKey !== undefined) process.env.ANTHROPIC_API_KEY = savedApiKey;
			else delete process.env.ANTHROPIC_API_KEY;
			if (savedOAuthToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedOAuthToken;
			else delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
			if (savedAuthToken !== undefined) process.env.ANTHROPIC_AUTH_TOKEN = savedAuthToken;
			else delete process.env.ANTHROPIC_AUTH_TOKEN;
			if (savedGlmKey !== undefined) process.env.GLM_API_KEY = savedGlmKey;
			else delete process.env.GLM_API_KEY;
		});

		test('should start daemon without credentials', async () => {
			// If we got here, createTestApp() succeeded without throwing
			expect(unauthCtx.server).toBeDefined();
			expect(unauthCtx.authManager).toBeDefined();
			expect(unauthCtx.messageHub).toBeDefined();
		});

		test('should report unauthenticated status', async () => {
			const status = await unauthCtx.authManager.getAuthStatus();
			expect(status.isAuthenticated).toBe(false);
			expect(status.method).toBe('none');
		});

		test('should respond to auth.status RPC when unauthenticated', async () => {
			const result = await callRPCHandler(unauthCtx.messageHub, 'auth.status', {});
			expect(result.authStatus).toBeDefined();
			expect(result.authStatus.isAuthenticated).toBe(false);
			expect(result.authStatus.method).toBe('none');
		});

		test('should expose unauthenticated status in system state', async () => {
			const result = await callRPCHandler(unauthCtx.messageHub, 'state.system', {});
			expect(result.auth).toBeDefined();
			expect(result.auth.isAuthenticated).toBe(false);
			expect(result.auth.method).toBe('none');
		});

		test('should still serve mock models when unauthenticated', async () => {
			const result = await callRPCHandler(unauthCtx.messageHub, 'models.list', {});
			// createTestApp sets up mock models when unauthenticated
			expect(result.models).toBeDefined();
			expect(Array.isArray(result.models)).toBe(true);
			expect(result.models.length).toBeGreaterThan(0);
		});

		test('should return null for getCurrentApiKey when unauthenticated', async () => {
			const key = await unauthCtx.authManager.getCurrentApiKey();
			expect(key === null || key === undefined).toBe(true);
		});
	});
});
