/**
 * Google OAuth Client for Gemini Provider
 *
 * Handles the OAuth flow for Google Pro subscription accounts.
 * Extracted and adapted from the Gemini CLI's oauth2.ts (Apache 2.0).
 *
 * Flow:
 * 1. User visits auth URL in browser → copies auth code → pastes into NeoKai UI
 * 2. Auth code is exchanged for access_token + refresh_token
 * 3. Access tokens are automatically refreshed when expired (~1 hour)
 * 4. Refresh tokens are stored persistently for each Google account
 */

import { createLogger } from '@neokai/shared/logger';

const log = createLogger('kai:providers:gemini:oauth');

// ---------------------------------------------------------------------------
// OAuth Configuration (Google's public Desktop app credentials)
// ---------------------------------------------------------------------------

/**
 * Google OAuth client ID.
 *
 * Must be set via GOOGLE_GEMINI_CLIENT_ID env var. These are Google's own
 * Desktop app OAuth credentials from the Gemini CLI (Apache 2.0).
 * Google's documentation states that client secrets for installed/desktop
 * apps are not treated as secrets:
 * https://developers.google.com/identity/protocols/oauth2#installed
 *
 * The default values match those used by the official Gemini CLI.
 */
export function getOAuthClientId(): string {
	const val = process.env.GOOGLE_GEMINI_CLIENT_ID;
	if (!val) {
		throw new Error(
			'GOOGLE_GEMINI_CLIENT_ID env var is required. ' +
				'Set it to the Google OAuth client ID (see Gemini CLI source for default).'
		);
	}
	return val;
}

/**
 * Google OAuth client secret.
 *
 * Must be set via GOOGLE_GEMINI_CLIENT_SECRET env var.
 */
export function getOAuthClientSecret(): string {
	const val = process.env.GOOGLE_GEMINI_CLIENT_SECRET;
	if (!val) {
		throw new Error(
			'GOOGLE_GEMINI_CLIENT_SECRET env var is required. ' +
				'Set it to the Google OAuth client secret (see Gemini CLI source for default).'
		);
	}
	return val;
}

/** OAuth scopes for Cloud Code authorization. */
export const OAUTH_SCOPES = [
	'https://www.googleapis.com/auth/cloud-platform',
	'https://www.googleapis.com/auth/userinfo.email',
	'https://www.googleapis.com/auth/userinfo.profile',
];

/** Redirect URI for headless/code-entry auth flow. */
export const REDIRECT_URI = 'https://codeassist.google.com/authcode';

/** Google token endpoint. */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Google userinfo endpoint. */
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** OAuth token response from Google. */
export interface GoogleTokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	token_type: string;
	scope?: string;
}

/** Google user info response. */
export interface GoogleUserInfo {
	email: string;
	name?: string;
	picture?: string;
	sub?: string;
}

/** Stored account credentials. */
export interface GoogleOAuthAccount {
	id: string;
	email: string;
	refresh_token: string;
	added_at: number;
	last_used_at: number;
	last_token_refresh_at?: number;
	daily_request_count: number;
	daily_limit: number;
	status: 'active' | 'exhausted' | 'invalid';
	/** Cooldown until timestamp (Unix ms). 0 = no cooldown. */
	cooldown_until: number;
}

/** OAuth client dependencies — injectable for testing. */
export interface OAuthClientDeps {
	fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

/** Generate a code verifier for PKCE (RFC 7636). */
export function generateCodeVerifier(): string {
	const array = new Uint8Array(32);
	crypto.getRandomValues(array);
	return base64URLEncode(array);
}

/** Generate a code challenge from a code verifier. */
export async function generateCodeChallenge(verifier: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hash = await crypto.subtle.digest('SHA-256', data);
	return base64URLEncode(new Uint8Array(hash));
}

function base64URLEncode(buffer: Uint8Array): string {
	return btoa(String.fromCharCode(...buffer))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// OAuth client
// ---------------------------------------------------------------------------

/**
 * Build the Google OAuth authorization URL for headless code-entry flow.
 *
 * Returns the URL the user should visit in their browser, plus the
 * code_verifier needed to complete the token exchange.
 */
export async function buildAuthUrl(): Promise<{ authUrl: string; codeVerifier: string }> {
	const codeVerifier = generateCodeVerifier();
	const codeChallenge = await generateCodeChallenge(codeVerifier);

	const params = new URLSearchParams({
		client_id: getOAuthClientId(),
		redirect_uri: REDIRECT_URI,
		response_type: 'code',
		scope: OAUTH_SCOPES.join(' '),
		access_type: 'offline',
		prompt: 'consent',
		code_challenge: codeChallenge,
		code_challenge_method: 'S256',
	});

	const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
	return { authUrl, codeVerifier };
}

/**
 * Exchange an authorization code for tokens.
 *
 * @param code - The authorization code from the user
 * @param codeVerifier - The PKCE code verifier from buildAuthUrl()
 * @param deps - Injectable dependencies for testing
 */
export async function exchangeAuthCode(
	code: string,
	codeVerifier: string,
	deps?: OAuthClientDeps
): Promise<GoogleTokenResponse> {
	const fetchFn = deps?.fetchImpl ?? fetch;

	const response = await fetchFn(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			code,
			client_id: getOAuthClientId(),
			client_secret: getOAuthClientSecret(),
			redirect_uri: REDIRECT_URI,
			grant_type: 'authorization_code',
			code_verifier: codeVerifier,
		}).toString(),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`Token exchange failed (${response.status}): ${errorText}`);
	}

	return response.json() as Promise<GoogleTokenResponse>;
}

/**
 * Refresh an access token using a refresh token.
 *
 * @param refreshToken - The stored refresh token
 * @param deps - Injectable dependencies for testing
 */
export async function refreshAccessToken(
	refreshToken: string,
	deps?: OAuthClientDeps
): Promise<GoogleTokenResponse> {
	const fetchFn = deps?.fetchImpl ?? fetch;

	const response = await fetchFn(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			refresh_token: refreshToken,
			client_id: getOAuthClientId(),
			client_secret: getOAuthClientSecret(),
			grant_type: 'refresh_token',
		}).toString(),
	});

	if (!response.ok) {
		const errorText = await response.text();

		// If the refresh token is invalid/revoked, throw a specific error
		if (response.status === 400 && errorText.includes('invalid_grant')) {
			throw new InvalidTokenError(`Refresh token is invalid or revoked: ${errorText}`);
		}

		throw new Error(`Token refresh failed (${response.status}): ${errorText}`);
	}

	return response.json() as Promise<GoogleTokenResponse>;
}

/**
 * Fetch user info from Google using an access token.
 *
 * @param accessToken - A valid Google access token
 * @param deps - Injectable dependencies for testing
 */
export async function fetchUserInfo(
	accessToken: string,
	deps?: OAuthClientDeps
): Promise<GoogleUserInfo> {
	const fetchFn = deps?.fetchImpl ?? fetch;

	const response = await fetchFn(USERINFO_URL, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch user info (${response.status})`);
	}

	return response.json() as Promise<GoogleUserInfo>;
}

/**
 * Check if a refresh token is still valid by attempting a token refresh.
 *
 * @param refreshToken - The refresh token to validate
 * @param deps - Injectable dependencies for testing
 * @returns true if valid, false if invalid/revoked
 */
export async function validateRefreshToken(
	refreshToken: string,
	deps?: OAuthClientDeps
): Promise<boolean> {
	try {
		await refreshAccessToken(refreshToken, deps);
		return true;
	} catch (error) {
		if (error instanceof InvalidTokenError) {
			log.warn(`Refresh token is invalid: ${error.message}`);
			return false;
		}
		// Network errors etc — don't mark as invalid, just unreachable
		log.warn(`Could not validate refresh token: ${error}`);
		return true; // Assume valid if we can't reach Google
	}
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when a refresh token is invalid or has been revoked. */
export class InvalidTokenError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidTokenError';
	}
}

// ---------------------------------------------------------------------------
// Credential file storage
// ---------------------------------------------------------------------------

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/** Get the path to the Gemini OAuth accounts storage file. */
export function getAccountsFilePath(): string {
	return path.join(os.homedir(), '.neokai', 'gemini-oauth-accounts.json');
}

/** Load all stored Google OAuth accounts. */
export async function loadAccounts(): Promise<GoogleOAuthAccount[]> {
	try {
		const filePath = getAccountsFilePath();
		const data = await fs.readFile(filePath, 'utf-8');
		return JSON.parse(data) as GoogleOAuthAccount[];
	} catch {
		return [];
	}
}

/** Save all Google OAuth accounts. */
export async function saveAccounts(accounts: GoogleOAuthAccount[]): Promise<void> {
	const filePath = getAccountsFilePath();
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(accounts, null, 2), { mode: 0o600 });
}

/** Add a new Google OAuth account and persist. */
export async function addAccount(account: GoogleOAuthAccount): Promise<void> {
	const accounts = await loadAccounts();
	// Check for duplicate email
	if (accounts.some((a) => a.email === account.email)) {
		throw new Error(`Account ${account.email} already exists`);
	}
	accounts.push(account);
	await saveAccounts(accounts);
}

/** Remove a Google OAuth account by ID and persist. */
export async function removeAccount(accountId: string): Promise<void> {
	const accounts = await loadAccounts();
	const filtered = accounts.filter((a) => a.id !== accountId);
	if (filtered.length === accounts.length) {
		throw new Error(`Account ${accountId} not found`);
	}
	await saveAccounts(filtered);
}

/** Update a Google OAuth account and persist. */
export async function updateAccount(
	accountId: string,
	updates: Partial<GoogleOAuthAccount>
): Promise<void> {
	const accounts = await loadAccounts();
	const index = accounts.findIndex((a) => a.id === accountId);
	if (index === -1) {
		throw new Error(`Account ${accountId} not found`);
	}
	accounts[index] = { ...accounts[index], ...updates };
	await saveAccounts(accounts);
}

/** Create a new GoogleOAuthAccount with defaults. */
export function createAccount(
	email: string,
	refreshToken: string,
	dailyLimit: number = 1500
): GoogleOAuthAccount {
	return {
		id: crypto.randomUUID(),
		email,
		refresh_token: refreshToken,
		added_at: Date.now(),
		last_used_at: 0,
		daily_request_count: 0,
		daily_limit: dailyLimit,
		status: 'active',
		cooldown_until: 0,
	};
}
