/**
 * Tests for Gemini OAuth Account Management RPC Handlers
 *
 * Tests the RPC handlers for Gemini account management:
 * - auth.gemini.accounts - List Gemini OAuth accounts
 * - auth.gemini.startOAuth - Start headless OAuth flow
 * - auth.gemini.completeOAuth - Complete OAuth with auth code
 * - auth.gemini.removeAccount - Remove an account
 */

import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import type { AuthManager } from '../../../../src/lib/auth-manager';
import { resetProviderRegistry, getProviderRegistry } from '../../../../src/lib/providers/registry';

// Type for captured request handlers
type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

// Mock oauth-client functions
const mockBuildAuthUrl = mock(async () => ({
	authUrl: 'https://accounts.google.com/o/oauth2/v2/auth?mock=1',
	codeVerifier: 'mock-code-verifier',
}));

const mockExchangeAuthCode = mock(async () => ({
	access_token: 'mock-access-token',
	refresh_token: 'mock-refresh-token',
	expires_in: 3600,
	token_type: 'Bearer',
}));

const mockFetchUserInfo = mock(async () => ({
	email: 'test@gmail.com',
	name: 'Test User',
}));

const mockLoadAccounts = mock(async () => [
	{
		id: 'acc-1',
		email: 'user1@gmail.com',
		refresh_token: 'rt-1',
		added_at: Date.now() - 86_400_000,
		last_used_at: Date.now() - 3600_000,
		daily_request_count: 342,
		daily_limit: 1500,
		status: 'active' as const,
		cooldown_until: 0,
	},
	{
		id: 'acc-2',
		email: 'user2@gmail.com',
		refresh_token: 'rt-2',
		added_at: Date.now() - 172_800_000,
		last_used_at: 0,
		daily_request_count: 0,
		daily_limit: 1500,
		status: 'invalid' as const,
		cooldown_until: 0,
	},
]);

const mockCreateAccount = mock((email: string, refreshToken: string) => ({
	id: 'new-acc-id',
	email,
	refresh_token: refreshToken,
	added_at: Date.now(),
	last_used_at: 0,
	daily_request_count: 0,
	daily_limit: 1500,
	status: 'active' as const,
	cooldown_until: 0,
}));

const mockPersistAddAccount = mock(async () => {});
const mockPersistRemoveAccount = mock(async () => {});
const mockUpdateAccount = mock(async () => {});

// Mock the module
mock.module('../../../../src/lib/providers/gemini/oauth-client.js', () => ({
	buildAuthUrl: mockBuildAuthUrl,
	exchangeAuthCode: mockExchangeAuthCode,
	fetchUserInfo: mockFetchUserInfo,
	loadAccounts: mockLoadAccounts,
	createAccount: mockCreateAccount,
	addAccount: mockPersistAddAccount,
	removeAccount: mockPersistRemoveAccount,
	updateAccount: mockUpdateAccount,
}));

// Mock AuthManager
const mockAuthManager = {
	getAuthStatus: mock(async () => ({
		isAuthenticated: true,
		method: 'api_key' as const,
	})),
};

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

describe('Gemini Auth RPC Handlers', () => {
	let messageHubData: ReturnType<typeof createMockMessageHub>;

	beforeEach(async () => {
		messageHubData = createMockMessageHub();

		// Reset provider registry
		resetProviderRegistry();

		// Clear all mocks
		mockBuildAuthUrl.mockClear();
		mockExchangeAuthCode.mockClear();
		mockFetchUserInfo.mockClear();
		mockLoadAccounts.mockClear();
		mockCreateAccount.mockClear();
		mockPersistAddAccount.mockClear();
		mockPersistRemoveAccount.mockClear();
		mockUpdateAccount.mockClear();
		mockAuthManager.getAuthStatus.mockClear();

		// Import handler setup after mock is in place
		const { setupAuthHandlers } = await import('../../../../src/lib/rpc-handlers/auth-handlers');
		setupAuthHandlers(messageHubData.hub, mockAuthManager as unknown as AuthManager);
	});

	afterEach(() => {
		mock.restore();
	});

	describe('auth.gemini.accounts', () => {
		it('returns account list without sensitive tokens', async () => {
			const handler = messageHubData.handlers.get('auth.gemini.accounts');
			expect(handler).toBeDefined();

			const result = (await handler!({}, {})) as {
				accounts: Array<{
					id: string;
					email: string;
					status: string;
					dailyRequestCount: number;
					dailyLimit: number;
				}>;
			};

			expect(result.accounts).toHaveLength(2);
			expect(result.accounts[0].id).toBe('acc-1');
			expect(result.accounts[0].email).toBe('user1@gmail.com');
			expect(result.accounts[0].status).toBe('active');
			expect(result.accounts[0].dailyRequestCount).toBe(342);
			expect(result.accounts[0].dailyLimit).toBe(1500);
			// Verify sensitive token is NOT included
			expect((result.accounts[0] as Record<string, unknown>).refresh_token).toBeUndefined();
		});

		it('returns empty list when loadAccounts throws', async () => {
			mockLoadAccounts.mockImplementationOnce(async () => {
				throw new Error('File not found');
			});

			const handler = messageHubData.handlers.get('auth.gemini.accounts');
			const result = (await handler!({}, {})) as { accounts: unknown[] };

			expect(result.accounts).toEqual([]);
		});
	});

	describe('auth.gemini.startOAuth', () => {
		it('starts OAuth flow and returns auth URL with flowId', async () => {
			const handler = messageHubData.handlers.get('auth.gemini.startOAuth');
			expect(handler).toBeDefined();

			const result = (await handler!({}, {})) as {
				success: boolean;
				authUrl?: string;
				flowId?: string;
				message?: string;
			};

			expect(result.success).toBe(true);
			expect(result.authUrl).toBe('https://accounts.google.com/o/oauth2/v2/auth?mock=1');
			expect(result.flowId).toBeDefined();
			expect(result.flowId!.length).toBeGreaterThan(0);
			expect(result.message).toBeDefined();
		});

		it('stores accountId for re-auth flows', async () => {
			const handler = messageHubData.handlers.get('auth.gemini.startOAuth');

			const result = (await handler!({ accountId: 'acc-to-reauth' }, {})) as {
				success: boolean;
				flowId?: string;
			};

			expect(result.success).toBe(true);
			expect(result.flowId).toBeDefined();
		});

		it('returns error when buildAuthUrl throws', async () => {
			mockBuildAuthUrl.mockImplementationOnce(async () => {
				throw new Error('GOOGLE_GEMINI_CLIENT_ID not set');
			});

			const handler = messageHubData.handlers.get('auth.gemini.startOAuth');

			const result = (await handler!({}, {})) as {
				success: boolean;
				error?: string;
			};

			expect(result.success).toBe(false);
			expect(result.error).toBe('GOOGLE_GEMINI_CLIENT_ID not set');
		});
	});

	describe('auth.gemini.completeOAuth', () => {
		it('returns error when authCode is missing', async () => {
			const handler = messageHubData.handlers.get('auth.gemini.completeOAuth');

			const result = (await handler!({ flowId: 'some-flow-id' }, {})) as {
				success: boolean;
				error?: string;
			};

			expect(result.success).toBe(false);
			expect(result.error).toContain('Authorization code is required');
		});

		it('returns error when flowId is missing', async () => {
			const handler = messageHubData.handlers.get('auth.gemini.completeOAuth');

			const result = (await handler!({ authCode: 'some-code' }, {})) as {
				success: boolean;
				error?: string;
			};

			expect(result.success).toBe(false);
			expect(result.error).toContain('Flow ID is required');
		});

		it('returns error when no pending flow found', async () => {
			const handler = messageHubData.handlers.get('auth.gemini.completeOAuth');

			const result = (await handler!({ authCode: 'code', flowId: 'non-existent-flow' }, {})) as {
				success: boolean;
				error?: string;
			};

			expect(result.success).toBe(false);
			expect(result.error).toContain('No pending OAuth flow found');
		});

		it('completes full OAuth flow: start → complete', async () => {
			const startHandler = messageHubData.handlers.get('auth.gemini.startOAuth');
			const completeHandler = messageHubData.handlers.get('auth.gemini.completeOAuth');

			// Start the flow
			const startResult = (await startHandler!({}, {})) as {
				success: boolean;
				authUrl?: string;
				flowId?: string;
			};

			expect(startResult.success).toBe(true);
			const flowId = startResult.flowId!;

			// Complete the flow
			const completeResult = (await completeHandler!(
				{ authCode: 'test-auth-code', flowId },
				{}
			)) as {
				success: boolean;
				account?: { email: string; status: string };
			};

			expect(completeResult.success).toBe(true);
			expect(completeResult.account).toBeDefined();
			expect(completeResult.account!.email).toBe('test@gmail.com');
			expect(completeResult.account!.status).toBe('active');

			// Verify exchange was called with the code verifier
			expect(mockExchangeAuthCode).toHaveBeenCalledWith('test-auth-code', 'mock-code-verifier');
			expect(mockFetchUserInfo).toHaveBeenCalledWith('mock-access-token');
			expect(mockCreateAccount).toHaveBeenCalledWith('test@gmail.com', 'mock-refresh-token');
			expect(mockPersistAddAccount).toHaveBeenCalled();
		});

		it('returns error when no refresh token in response', async () => {
			mockExchangeAuthCode.mockImplementationOnce(async () => ({
				access_token: 'mock-access-token',
				expires_in: 3600,
				token_type: 'Bearer',
			}));

			const startHandler = messageHubData.handlers.get('auth.gemini.startOAuth');
			const completeHandler = messageHubData.handlers.get('auth.gemini.completeOAuth');

			const startResult = (await startHandler!({}, {})) as {
				success: boolean;
				flowId?: string;
			};
			const flowId = startResult.flowId!;

			const completeResult = (await completeHandler!({ authCode: 'code', flowId }, {})) as {
				success: boolean;
				error?: string;
			};

			expect(completeResult.success).toBe(false);
			expect(completeResult.error).toContain('No refresh token received');
		});

		it('handles re-auth flow when accountId provided', async () => {
			// The re-auth path calls updateAccount, then loadAccounts to get updated record
			mockLoadAccounts.mockImplementationOnce(async () => [
				{
					id: 'acc-to-reauth',
					email: 'reauth@gmail.com',
					refresh_token: 'new-rt',
					added_at: Date.now() - 86_400_000,
					last_used_at: 0,
					daily_request_count: 0,
					daily_limit: 1500,
					status: 'active',
					cooldown_until: 0,
				},
			]);

			const startHandler = messageHubData.handlers.get('auth.gemini.startOAuth');
			const completeHandler = messageHubData.handlers.get('auth.gemini.completeOAuth');

			// Start with accountId for re-auth
			const startResult = (await startHandler!({ accountId: 'acc-to-reauth' }, {})) as {
				success: boolean;
				flowId?: string;
			};
			const flowId = startResult.flowId!;

			const completeResult = (await completeHandler!({ authCode: 'code', flowId }, {})) as {
				success: boolean;
				account?: { id: string; email: string; status: string };
			};

			expect(completeResult.success).toBe(true);
			expect(completeResult.account).toBeDefined();
			expect(completeResult.account!.status).toBe('active');
			// Should update existing account, not create new
			expect(mockUpdateAccount).toHaveBeenCalledWith('acc-to-reauth', {
				refresh_token: 'mock-refresh-token',
				status: 'active',
				cooldown_until: 0,
			});
			expect(mockPersistAddAccount).not.toHaveBeenCalled();
		});

		it('returns specific error for duplicate email', async () => {
			// loadAccounts returns an account with the same email the mock user info will return
			mockLoadAccounts.mockImplementationOnce(async () => [
				{
					id: 'existing-acc',
					email: 'test@gmail.com', // same as mockFetchUserInfo returns
					refresh_token: 'existing-rt',
					added_at: Date.now() - 86_400_000,
					last_used_at: 0,
					daily_request_count: 0,
					daily_limit: 1500,
					status: 'active',
					cooldown_until: 0,
				},
			]);

			const startHandler = messageHubData.handlers.get('auth.gemini.startOAuth');
			const completeHandler = messageHubData.handlers.get('auth.gemini.completeOAuth');

			const startResult = (await startHandler!({}, {})) as {
				success: boolean;
				flowId?: string;
			};
			const flowId = startResult.flowId!;

			const completeResult = (await completeHandler!({ authCode: 'code', flowId }, {})) as {
				success: boolean;
				error?: string;
			};

			expect(completeResult.success).toBe(false);
			expect(completeResult.error).toContain('already exists');
			expect(completeResult.error).toContain('test@gmail.com');
			// Should NOT have called persistAddAccount
			expect(mockPersistAddAccount).not.toHaveBeenCalled();
		});

		it('handles exchange errors gracefully', async () => {
			mockExchangeAuthCode.mockImplementationOnce(async () => {
				throw new Error('Token exchange failed (400): invalid_grant');
			});

			const startHandler = messageHubData.handlers.get('auth.gemini.startOAuth');
			const completeHandler = messageHubData.handlers.get('auth.gemini.completeOAuth');

			const startResult = (await startHandler!({}, {})) as {
				success: boolean;
				flowId?: string;
			};
			const flowId = startResult.flowId!;

			const completeResult = (await completeHandler!({ authCode: 'bad-code', flowId }, {})) as {
				success: boolean;
				error?: string;
			};

			expect(completeResult.success).toBe(false);
			expect(completeResult.error).toContain('invalid_grant');
		});
	});

	describe('auth.gemini.removeAccount', () => {
		it('removes account successfully', async () => {
			const handler = messageHubData.handlers.get('auth.gemini.removeAccount');
			expect(handler).toBeDefined();

			const result = (await handler!({ accountId: 'acc-1' }, {})) as {
				success: boolean;
			};

			expect(result.success).toBe(true);
			expect(mockPersistRemoveAccount).toHaveBeenCalledWith('acc-1');
		});

		it('returns error when account not found', async () => {
			mockPersistRemoveAccount.mockImplementationOnce(async () => {
				throw new Error('Account not-found not found');
			});

			const handler = messageHubData.handlers.get('auth.gemini.removeAccount');

			const result = (await handler!({ accountId: 'not-found' }, {})) as {
				success: boolean;
				error?: string;
			};

			expect(result.success).toBe(false);
			expect(result.error).toContain('Account not-found not found');
		});
	});
});
