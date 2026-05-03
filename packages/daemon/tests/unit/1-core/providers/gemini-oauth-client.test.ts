/**
 * Tests for Google Gemini OAuth Client
 */

import { describe, expect, it, mock, beforeEach, afterEach } from 'bun:test';
import {
	buildAuthUrl,
	exchangeAuthCode,
	refreshAccessToken,
	fetchUserInfo,
	validateRefreshToken,
	createAccount,
	type GoogleTokenResponse,
	type GoogleUserInfo,
	type OAuthClientDeps,
	InvalidTokenError,
} from '../../../../src/lib/providers/gemini/oauth-client.js';

// ---------------------------------------------------------------------------
// Mock fetch for testing
// ---------------------------------------------------------------------------

function createMockFetch(responses: Array<{ status: number; body: string }>): typeof fetch {
	let callIndex = 0;
	return mock(async (url: string | URL | Request, _init?: RequestInit) => {
		const response = responses[callIndex] ?? responses[responses.length - 1];
		callIndex++;
		return new Response(response.body, { status: response.status });
	}) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Google Gemini OAuth Client', () => {
	const originalClientId = process.env.GOOGLE_GEMINI_CLIENT_ID;
	const originalClientSecret = process.env.GOOGLE_GEMINI_CLIENT_SECRET;

	beforeEach(() => {
		process.env.GOOGLE_GEMINI_CLIENT_ID = 'test-client-id';
		process.env.GOOGLE_GEMINI_CLIENT_SECRET = 'test-client-secret';
	});

	afterEach(() => {
		if (originalClientId !== undefined) {
			process.env.GOOGLE_GEMINI_CLIENT_ID = originalClientId;
		} else {
			delete process.env.GOOGLE_GEMINI_CLIENT_ID;
		}
		if (originalClientSecret !== undefined) {
			process.env.GOOGLE_GEMINI_CLIENT_SECRET = originalClientSecret;
		} else {
			delete process.env.GOOGLE_GEMINI_CLIENT_SECRET;
		}
	});

	describe('buildAuthUrl', () => {
		it('returns an auth URL with the correct parameters', async () => {
			const { authUrl, codeVerifier } = await buildAuthUrl();

			expect(authUrl).toContain('accounts.google.com/o/oauth2/v2/auth');
			expect(authUrl).toContain('client_id=');
			expect(authUrl).toContain('redirect_uri=');
			expect(authUrl).toContain('code_challenge=');
			expect(authUrl).toContain('code_challenge_method=S256');
			expect(authUrl).toContain('access_type=offline');
			expect(codeVerifier).toBeTruthy();
			expect(codeVerifier.length).toBeGreaterThan(20);
		});

		it('generates different code verifiers on each call', async () => {
			const { codeVerifier: v1 } = await buildAuthUrl();
			const { codeVerifier: v2 } = await buildAuthUrl();
			expect(v1).not.toBe(v2);
		});
	});

	describe('exchangeAuthCode', () => {
		it('exchanges an auth code for tokens', async () => {
			const mockResponse: GoogleTokenResponse = {
				access_token: 'ya29.test-access-token',
				refresh_token: '1//test-refresh-token',
				expires_in: 3600,
				token_type: 'Bearer',
			};

			const fetchMock = createMockFetch([{ status: 200, body: JSON.stringify(mockResponse) }]);

			const result = await exchangeAuthCode('test-auth-code', 'test-verifier', {
				fetchImpl: fetchMock,
			});

			expect(result.access_token).toBe('ya29.test-access-token');
			expect(result.refresh_token).toBe('1//test-refresh-token');
			expect(result.expires_in).toBe(3600);
		});

		it('throws on error response', async () => {
			const fetchMock = createMockFetch([{ status: 400, body: '{"error":"invalid_grant"}' }]);

			await expect(
				exchangeAuthCode('bad-code', 'verifier', { fetchImpl: fetchMock })
			).rejects.toThrow('Token exchange failed (400)');
		});
	});

	describe('refreshAccessToken', () => {
		it('refreshes an access token', async () => {
			const mockResponse: GoogleTokenResponse = {
				access_token: 'ya29.new-access-token',
				expires_in: 3600,
				token_type: 'Bearer',
			};

			const fetchMock = createMockFetch([{ status: 200, body: JSON.stringify(mockResponse) }]);

			const result = await refreshAccessToken('1//test-refresh-token', {
				fetchImpl: fetchMock,
			});

			expect(result.access_token).toBe('ya29.new-access-token');
		});

		it('throws InvalidTokenError on invalid_grant', async () => {
			const fetchMock = createMockFetch([
				{
					status: 400,
					body: '{"error":"invalid_grant","error_description":"Token has been expired or revoked."}',
				},
			]);

			await expect(
				refreshAccessToken('bad-refresh-token', { fetchImpl: fetchMock })
			).rejects.toThrow(InvalidTokenError);
		});

		it('throws generic error on other failures', async () => {
			const fetchMock = createMockFetch([{ status: 500, body: 'Internal Server Error' }]);

			await expect(refreshAccessToken('some-token', { fetchImpl: fetchMock })).rejects.toThrow(
				'Token refresh failed (500)'
			);
		});
	});

	describe('fetchUserInfo', () => {
		it('fetches user info from Google', async () => {
			const mockUserInfo: GoogleUserInfo = {
				email: 'test@gmail.com',
				name: 'Test User',
				picture: 'https://example.com/photo.jpg',
				sub: '12345',
			};

			const fetchMock = createMockFetch([{ status: 200, body: JSON.stringify(mockUserInfo) }]);

			const result = await fetchUserInfo('ya29.test-token', { fetchImpl: fetchMock });

			expect(result.email).toBe('test@gmail.com');
			expect(result.name).toBe('Test User');
		});

		it('throws on error response', async () => {
			const fetchMock = createMockFetch([{ status: 401, body: 'Unauthorized' }]);

			await expect(fetchUserInfo('bad-token', { fetchImpl: fetchMock })).rejects.toThrow(
				'Failed to fetch user info (401)'
			);
		});
	});

	describe('validateRefreshToken', () => {
		it('returns true for valid tokens', async () => {
			const mockResponse: GoogleTokenResponse = {
				access_token: 'ya29.fresh-token',
				expires_in: 3600,
				token_type: 'Bearer',
			};

			const fetchMock = createMockFetch([{ status: 200, body: JSON.stringify(mockResponse) }]);

			const result = await validateRefreshToken('valid-token', { fetchImpl: fetchMock });
			expect(result).toBe(true);
		});

		it('returns false for invalid tokens', async () => {
			const fetchMock = createMockFetch([
				{
					status: 400,
					body: '{"error":"invalid_grant"}',
				},
			]);

			const result = await validateRefreshToken('invalid-token', { fetchImpl: fetchMock });
			expect(result).toBe(false);
		});

		it('returns true on network errors (assumes valid)', async () => {
			const fetchMock = mock(async () => {
				throw new Error('Network error');
			}) as unknown as typeof fetch;

			const result = await validateRefreshToken('some-token', { fetchImpl: fetchMock });
			expect(result).toBe(true);
		});
	});

	describe('createAccount', () => {
		it('creates an account with default values', () => {
			const account = createAccount('test@gmail.com', '1//refresh-token');

			expect(account.email).toBe('test@gmail.com');
			expect(account.refresh_token).toBe('1//refresh-token');
			expect(account.status).toBe('active');
			expect(account.daily_limit).toBe(1500);
			expect(account.daily_request_count).toBe(0);
			expect(account.cooldown_until).toBe(0);
			expect(account.id).toBeTruthy();
		});

		it('creates an account with custom daily limit', () => {
			const account = createAccount('test@gmail.com', '1//refresh-token', 2000);
			expect(account.daily_limit).toBe(2000);
		});
	});
});
