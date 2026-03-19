/**
 * Unit tests for AnthropicToCodexBridgeProvider
 *
 * Covers:
 *  - getAuthStatus(): NeoKai OAuth only (env vars → unauthenticated), file-based auth, missing credentials, missing binary
 *  - getApiKey(): full discovery chain (env → ~/.neokai/auth.json → ~/.codex/auth.json)
 *  - importFromCodexAuth(): one-time migration scenarios (API key, OAuth with/without refresh)
 *  - buildSdkConfig(): per-workspace bridge server isolation and reuse
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { AnthropicToCodexBridgeProvider } from '../../../src/lib/providers/anthropic-to-codex-bridge-provider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a provider instance pointing at isolated temp auth dirs. */
function makeProvider(
	env: Record<string, string | undefined> = {},
	authDir?: string,
	codexAuthDir?: string,
	codexFinder?: () => string | null
): AnthropicToCodexBridgeProvider {
	return new AnthropicToCodexBridgeProvider(env, authDir, codexAuthDir, codexFinder);
}

/** A codexFinder that always returns a fake binary path — avoids `which codex` subprocess in tests. */
const fakeCodexFound = () => '/usr/local/bin/codex';
/** A codexFinder that always returns null — simulates codex not installed. */
const fakeCodexMissing = () => null;

/** Write a NeoKai auth.json with an openai entry to a temp dir. */
async function writeNeokaiAuth(dir: string, credentials: Record<string, unknown>): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, 'auth.json'), JSON.stringify({ openai: credentials }), {
		mode: 0o600,
	});
}

/** Write a ~/.codex/auth.json format file to a temp dir. */
async function writeCodexAuth(
	dir: string,
	data: {
		OPENAI_API_KEY?: string | null;
		tokens?: { access_token?: string; refresh_token?: string; account_id?: string };
	}
): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(path.join(dir, 'auth.json'), JSON.stringify(data), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// getAuthStatus() — auth gate
// ---------------------------------------------------------------------------

describe('AnthropicToCodexBridgeProvider', () => {
	let provider: AnthropicToCodexBridgeProvider;

	afterEach(() => {
		provider?.stopAllBridgeServers();
	});

	describe('getAuthStatus()', () => {
		let emptyDir: string;

		beforeEach(async () => {
			// Use isolated empty dirs so file-based auth doesn't interfere
			emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neokai-auth-test-'));
		});

		afterEach(async () => {
			await fs.rm(emptyDir, { recursive: true, force: true });
		});

		it('returns isAuthenticated=false when no credentials', async () => {
			provider = makeProvider({}, emptyDir, emptyDir);
			const result = await provider.getAuthStatus();
			expect(result.isAuthenticated).toBe(false);
			expect(result.error).toBeTruthy();
		});

		it('returns isAuthenticated=false when only OPENAI_API_KEY env var is set (env vars are daemon/test only)', async () => {
			provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, emptyDir, emptyDir, fakeCodexFound);
			const result = await provider.getAuthStatus();
			expect(result.isAuthenticated).toBe(false);
		});

		it('returns isAuthenticated=false when only CODEX_API_KEY env var is set (env vars are daemon/test only)', async () => {
			provider = makeProvider(
				{ CODEX_API_KEY: 'codex-env-key' },
				emptyDir,
				emptyDir,
				fakeCodexFound
			);
			const result = await provider.getAuthStatus();
			expect(result.isAuthenticated).toBe(false);
		});

		it('returns isAuthenticated=false with descriptive error when env vars are empty', async () => {
			provider = makeProvider({ OPENAI_API_KEY: '', CODEX_API_KEY: '' }, emptyDir, emptyDir);
			const result = await provider.getAuthStatus();
			expect(result.isAuthenticated).toBe(false);
			expect(result.error).toBeTruthy();
		});

		it('returns isAuthenticated=false with binary-not-found error when NeoKai OAuth stored but codex missing', async () => {
			const neokaiDir = path.join(emptyDir, 'neokai');
			const codexDir = path.join(emptyDir, 'codex');
			await writeNeokaiAuth(neokaiDir, {
				type: 'oauth',
				access: 'oauth-access-token',
				refresh: 'oauth-refresh-token',
				expires: Date.now() + 3600_000,
			});
			provider = makeProvider({}, neokaiDir, codexDir, fakeCodexMissing);
			const result = await provider.getAuthStatus();
			expect(result.isAuthenticated).toBe(false);
			expect(result.error).toContain('codex binary not found');
		});

		it('returns isAuthenticated=true when NeoKai OAuth credentials in auth.json and codex found', async () => {
			const neokaiDir = path.join(emptyDir, 'neokai');
			const codexDir = path.join(emptyDir, 'codex');
			await writeNeokaiAuth(neokaiDir, {
				type: 'oauth',
				access: 'oauth-access-token',
				refresh: 'oauth-refresh-token',
				expires: Date.now() + 3600_000,
				accountId: 'user_abc123',
			});
			provider = makeProvider({}, neokaiDir, codexDir, fakeCodexFound);
			const result = await provider.getAuthStatus();
			expect(result.isAuthenticated).toBe(true);
			expect(result.method).toBe('oauth');
		});

		it('returns isAuthenticated=false for api_key type in auth.json (not NeoKai OAuth)', async () => {
			const neokaiDir = path.join(emptyDir, 'neokai');
			const codexDir = path.join(emptyDir, 'codex');
			await writeNeokaiAuth(neokaiDir, { type: 'api_key', access: 'sk-imported-key' });
			provider = makeProvider({}, neokaiDir, codexDir, fakeCodexFound);
			const result = await provider.getAuthStatus();
			expect(result.isAuthenticated).toBe(false);
		});

		it('sets needsRefresh when NeoKai OAuth token is expired', async () => {
			const neokaiDir = path.join(emptyDir, 'neokai');
			const codexDir = path.join(emptyDir, 'codex');
			await writeNeokaiAuth(neokaiDir, {
				type: 'oauth',
				access: 'oauth-access-token',
				refresh: 'oauth-refresh-token',
				// expires 1 minute ago (past the 5-min buffer)
				expires: Date.now() - 60_000,
			});
			provider = makeProvider({}, neokaiDir, codexDir, fakeCodexFound);
			const result = await provider.getAuthStatus();
			expect(result.isAuthenticated).toBe(true);
			expect(result.needsRefresh).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// getApiKey() — credential discovery chain
	// -------------------------------------------------------------------------

	describe('getApiKey() credential discovery chain', () => {
		let tmpDir: string;

		beforeEach(async () => {
			tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neokai-codex-test-'));
		});

		afterEach(async () => {
			await fs.rm(tmpDir, { recursive: true, force: true });
		});

		it('Priority 1: returns OPENAI_API_KEY env var immediately', async () => {
			const neokaiDir = path.join(tmpDir, 'neokai');
			const codexDir = path.join(tmpDir, 'codex');
			await writeNeokaiAuth(neokaiDir, { type: 'oauth', access: 'neokai-token' });
			await writeCodexAuth(codexDir, { tokens: { access_token: 'codex-token' } });

			provider = makeProvider({ OPENAI_API_KEY: 'env-api-key' }, neokaiDir, codexDir);
			expect(await provider.getApiKey()).toBe('env-api-key');
		});

		it('Priority 2: returns CODEX_API_KEY env var when OPENAI_API_KEY is absent', async () => {
			provider = makeProvider({ CODEX_API_KEY: 'codex-env-key' });
			expect(await provider.getApiKey()).toBe('codex-env-key');
		});

		it('Priority 3: returns access token from ~/.neokai/auth.json when no env var', async () => {
			const neokaiDir = path.join(tmpDir, 'neokai');
			const codexDir = path.join(tmpDir, 'codex');
			await writeNeokaiAuth(neokaiDir, { type: 'oauth', access: 'neokai-access-token' });
			await writeCodexAuth(codexDir, { tokens: { access_token: 'should-not-be-used' } });

			provider = makeProvider({}, neokaiDir, codexDir);
			expect(await provider.getApiKey()).toBe('neokai-access-token');
		});

		it('Priority 4a: returns OPENAI_API_KEY from ~/.codex/auth.json when no higher source', async () => {
			const neokaiDir = path.join(tmpDir, 'neokai'); // no file written
			const codexDir = path.join(tmpDir, 'codex');
			await writeCodexAuth(codexDir, { OPENAI_API_KEY: 'codex-file-api-key' });

			provider = makeProvider({}, neokaiDir, codexDir);
			expect(await provider.getApiKey()).toBe('codex-file-api-key');
		});

		it('Priority 4b: returns access_token from ~/.codex/auth.json when OPENAI_API_KEY is null', async () => {
			const neokaiDir = path.join(tmpDir, 'neokai'); // no file written
			const codexDir = path.join(tmpDir, 'codex');
			await writeCodexAuth(codexDir, {
				OPENAI_API_KEY: null,
				tokens: { access_token: 'codex-oauth-token' },
			});

			provider = makeProvider({}, neokaiDir, codexDir);
			expect(await provider.getApiKey()).toBe('codex-oauth-token');
		});

		it('returns undefined when all sources are absent', async () => {
			const neokaiDir = path.join(tmpDir, 'neokai'); // no file
			const codexDir = path.join(tmpDir, 'codex'); // no file

			provider = makeProvider({}, neokaiDir, codexDir);
			expect(await provider.getApiKey()).toBeUndefined();
		});

		it('empty-string env var falls through to file-based auth', async () => {
			const neokaiDir = path.join(tmpDir, 'neokai');
			const codexDir = path.join(tmpDir, 'codex');
			await writeNeokaiAuth(neokaiDir, { type: 'oauth', access: 'neokai-fallback-token' });

			// OPENAI_API_KEY='' is falsy — should not block file-based lookup
			provider = makeProvider({ OPENAI_API_KEY: '' }, neokaiDir, codexDir);
			expect(await provider.getApiKey()).toBe('neokai-fallback-token');
		});

		it('env var takes priority over both auth files', async () => {
			const neokaiDir = path.join(tmpDir, 'neokai');
			const codexDir = path.join(tmpDir, 'codex');
			await writeNeokaiAuth(neokaiDir, { type: 'oauth', access: 'neokai-token' });
			await writeCodexAuth(codexDir, {
				OPENAI_API_KEY: 'codex-api-key',
				tokens: { access_token: 'codex-bearer' },
			});

			provider = makeProvider({ OPENAI_API_KEY: 'env-wins' }, neokaiDir, codexDir);
			expect(await provider.getApiKey()).toBe('env-wins');
		});
	});

	// -------------------------------------------------------------------------
	// buildSdkConfig() — workspace isolation
	// -------------------------------------------------------------------------

	describe('buildSdkConfig() workspace isolation', () => {
		beforeEach(() => {
			provider = makeProvider({ OPENAI_API_KEY: 'sk-placeholder' });
		});

		it('starts separate bridge servers for different workspace paths', () => {
			const cfgA = provider.buildSdkConfig('codex-1', { workspacePath: '/tmp/workspace-a' });
			const cfgB = provider.buildSdkConfig('codex-1', { workspacePath: '/tmp/workspace-b' });

			const urlA = cfgA.envVars.ANTHROPIC_BASE_URL as string;
			const urlB = cfgB.envVars.ANTHROPIC_BASE_URL as string;
			expect(urlA).not.toBe(urlB);
			expect(new URL(urlA).port).not.toBe(new URL(urlB).port);
		});

		it('reuses the same bridge server for the same workspace path', () => {
			const cfg1 = provider.buildSdkConfig('codex-1', {
				workspacePath: '/tmp/workspace-reuse',
			});
			const cfg2 = provider.buildSdkConfig('codex-1', {
				workspacePath: '/tmp/workspace-reuse',
			});
			expect(cfg1.envVars.ANTHROPIC_BASE_URL).toBe(cfg2.envVars.ANTHROPIC_BASE_URL);
		});

		it('returns isAnthropicCompatible=true and a placeholder API key', () => {
			const cfg = provider.buildSdkConfig('codex-1', { workspacePath: '/tmp/ws-compat' });
			expect(cfg.isAnthropicCompatible).toBe(true);
			expect(cfg.envVars.ANTHROPIC_API_KEY).toBe('codex-bridge-default');
			expect(cfg.envVars.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		});

		it('buildSdkConfig() uses cached API key resolved by prior getApiKey() call', async () => {
			// Set up a provider with only file-based auth (no env var)
			const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neokai-build-cfg-test-'));
			try {
				const neokaiDir = path.join(tmpDir, 'neokai');
				await writeNeokaiAuth(neokaiDir, { type: 'oauth', access: 'file-based-token' });
				const p = makeProvider({}, neokaiDir, path.join(tmpDir, 'codex'));
				// Warm the cache as isAvailable() / getAuthStatus() would in QueryRunner
				await p.getApiKey();
				// buildSdkConfig() is synchronous but should use the cached key
				const cfg = p.buildSdkConfig('codex-1', { workspacePath: '/tmp/file-auth-ws' });
				expect(cfg.isAnthropicCompatible).toBe(true);
				expect(cfg.envVars.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
				p.stopAllBridgeServers();
			} finally {
				await fs.rm(tmpDir, { recursive: true, force: true });
			}
		});

		it('buildSdkConfig() uses cached key even when OPENAI_API_KEY is empty string', async () => {
			// Empty-string env var must not block the cached file-based key
			const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neokai-build-cfg-empty-'));
			try {
				const neokaiDir = path.join(tmpDir, 'neokai');
				await writeNeokaiAuth(neokaiDir, { type: 'oauth', access: 'file-token-not-empty' });
				const p = makeProvider({ OPENAI_API_KEY: '' }, neokaiDir, path.join(tmpDir, 'codex'));
				await p.getApiKey(); // populates cachedApiKey
				const cfg = p.buildSdkConfig('codex-1', { workspacePath: '/tmp/empty-env-ws' });
				expect(cfg.isAnthropicCompatible).toBe(true);
				expect(cfg.envVars.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
				p.stopAllBridgeServers();
			} finally {
				await fs.rm(tmpDir, { recursive: true, force: true });
			}
		});

		it('sets ANTHROPIC_DEFAULT_*_MODEL env vars to prevent SDK fallback to Anthropic models', () => {
			// Regression test: without these env vars the Claude Agent SDK subprocess
			// defaults to Anthropic model names (e.g. 'claude-haiku-4-5-20251001') which
			// the Codex bridge does not recognise, producing "model does not exist" errors.
			const cfg = provider.buildSdkConfig('gpt-5.3-codex', { workspacePath: '/tmp/ws-model' });
			expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.3-codex');
			expect(cfg.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('gpt-5.1-codex-mini');
			expect(cfg.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('gpt-5.4');
		});

		it('resolves model alias to canonical ID in ANTHROPIC_DEFAULT_SONNET_MODEL', () => {
			const cfg = provider.buildSdkConfig('codex', { workspacePath: '/tmp/ws-alias' });
			// 'codex' is an alias for 'gpt-5.3-codex'
			expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.3-codex');
		});

		it('resolves codex-mini alias correctly', () => {
			const cfg = provider.buildSdkConfig('codex-mini', { workspacePath: '/tmp/ws-mini' });
			// 'codex-mini' is an alias for 'gpt-5.1-codex-mini'
			expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.1-codex-mini');
		});

		it('resolves codex-latest alias correctly', () => {
			const cfg = provider.buildSdkConfig('codex-latest', { workspacePath: '/tmp/ws-latest' });
			// 'codex-latest' is an alias for 'gpt-5.4'
			expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.4');
		});

		it('falls back to gpt-5.3-codex for unknown model IDs', () => {
			const cfg = provider.buildSdkConfig('unknown-model', { workspacePath: '/tmp/ws-unk' });
			expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.3-codex');
		});

		it('no claude-* model name leaks through ANTHROPIC_DEFAULT_*_MODEL env vars', () => {
			// Regression guard for the original bug: without these env vars being set to
			// Codex model IDs, the Claude Agent SDK subprocess falls back to its built-in
			// defaults (e.g. claude-haiku-4-5-20251001) for background calls such as
			// summarisation and compaction. The Codex bridge rejects those names with
			// "model does not exist". All three tier slots must be non-Anthropic model IDs.
			const cfg = provider.buildSdkConfig('gpt-5.3-codex', {
				workspacePath: '/tmp/ws-no-leak',
			});
			expect(cfg.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).not.toMatch(/^claude-/);
			expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).not.toMatch(/^claude-/);
			expect(cfg.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).not.toMatch(/^claude-/);
		});
	});

	// -------------------------------------------------------------------------
	// ownsModel()
	// -------------------------------------------------------------------------

	describe('ownsModel()', () => {
		beforeEach(() => {
			provider = makeProvider({});
		});

		it('owns models explicitly listed in the catalogue', () => {
			expect(provider.ownsModel('gpt-5.3-codex')).toBe(true);
			expect(provider.ownsModel('gpt-5.4')).toBe(true);
			expect(provider.ownsModel('gpt-5.1-codex-mini')).toBe(true);
			// Aliases also owned
			expect(provider.ownsModel('codex')).toBe(true);
			expect(provider.ownsModel('codex-mini')).toBe(true);
			expect(provider.ownsModel('codex-latest')).toBe(true);
		});

		it('does not own models not in the catalogue', () => {
			// Old models removed from catalogue
			expect(provider.ownsModel('codex-1')).toBe(false);
			expect(provider.ownsModel('o4-mini')).toBe(false);
			expect(provider.ownsModel('o1-preview')).toBe(false);
			expect(provider.ownsModel('o3-mini')).toBe(false);
			expect(provider.ownsModel('gpt-5-mini')).toBe(false);
			// GPT-4 models the bridge cannot serve
			expect(provider.ownsModel('gpt-4o')).toBe(false);
			expect(provider.ownsModel('gpt-4')).toBe(false);
			expect(provider.ownsModel('gpt-3.5-turbo')).toBe(false);
		});

		it('does not own claude- models', () => {
			expect(provider.ownsModel('claude-3-opus')).toBe(false);
		});

		it('does not own arbitrary unrecognised model IDs', () => {
			expect(provider.ownsModel('unknown-model-xyz')).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// importFromCodexAuth() — one-time migration from ~/.codex/auth.json
	// -------------------------------------------------------------------------

	describe('importFromCodexAuth() — one-time migration', () => {
		let tmpDir: string;
		let fetchSpy: ReturnType<typeof spyOn>;

		beforeEach(async () => {
			tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neokai-import-test-'));
			// Spy on global fetch to intercept token refresh calls.
			// Default: simulate a network error so tests that don't set up a mock fail clearly.
			fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(
				new Error('fetch not mocked for this test')
			);
		});

		afterEach(async () => {
			fetchSpy.mockRestore();
			await fs.rm(tmpDir, { recursive: true, force: true });
		});

		it('Test 1: imports API key directly from ~/.codex/auth.json into ~/.neokai/auth.json', async () => {
			const neokaiDir = path.join(tmpDir, 'neokai');
			const codexDir = path.join(tmpDir, 'codex');
			await writeCodexAuth(codexDir, { OPENAI_API_KEY: 'sk-codex-api-key' });

			const p = makeProvider({}, neokaiDir, codexDir);
			const key = await p.getApiKey();

			expect(key).toBe('sk-codex-api-key');

			// Credentials should now be written to ~/.neokai/auth.json
			const neokaiAuth = JSON.parse(
				await fs.readFile(path.join(neokaiDir, 'auth.json'), 'utf-8')
			) as { openai: { type: string; access: string } };
			expect(neokaiAuth.openai.type).toBe('api_key');
			expect(neokaiAuth.openai.access).toBe('sk-codex-api-key');

			// fetch should NOT have been called (API key import needs no refresh)
			expect(fetchSpy).not.toHaveBeenCalled();
			p.stopAllBridgeServers();
		});

		it('Test 2: refreshes expired token + imports into ~/.neokai/auth.json', async () => {
			const neokaiDir = path.join(tmpDir, 'neokai');
			const codexDir = path.join(tmpDir, 'codex');
			await writeCodexAuth(codexDir, {
				tokens: { access_token: 'old-expired-token', refresh_token: 'valid-refresh-token' },
			});

			// Mock a successful token refresh response
			fetchSpy.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						access_token: 'new-fresh-token',
						refresh_token: 'new-refresh-token',
						expires_in: 3600,
						token_type: 'Bearer',
					}),
					{ status: 200, headers: { 'Content-Type': 'application/json' } }
				)
			);

			const p = makeProvider({}, neokaiDir, codexDir);
			const key = await p.getApiKey();

			expect(key).toBe('new-fresh-token');
			expect(fetchSpy).toHaveBeenCalledTimes(1);

			// Verify the refreshed token was written to ~/.neokai/auth.json
			const neokaiAuth = JSON.parse(
				await fs.readFile(path.join(neokaiDir, 'auth.json'), 'utf-8')
			) as { openai: { type: string; access: string; refresh: string } };
			expect(neokaiAuth.openai.type).toBe('oauth');
			expect(neokaiAuth.openai.access).toBe('new-fresh-token');
			expect(neokaiAuth.openai.refresh).toBe('new-refresh-token');
			p.stopAllBridgeServers();
		});

		it('Test 3: falls back to importing existing token when refresh fails', async () => {
			const neokaiDir = path.join(tmpDir, 'neokai');
			const codexDir = path.join(tmpDir, 'codex');
			await writeCodexAuth(codexDir, {
				tokens: { access_token: 'expired-token', refresh_token: 'invalid-refresh' },
			});

			// Mock a failed token refresh response (401)
			fetchSpy.mockResolvedValueOnce(
				new Response('{"error":"invalid_grant"}', {
					status: 401,
					headers: { 'Content-Type': 'application/json' },
				})
			);

			const p = makeProvider({}, neokaiDir, codexDir);
			const key = await p.getApiKey();

			// Refresh failure should still import existing codex token into ~/.neokai/auth.json
			expect(key).toBe('expired-token');
			expect(fetchSpy).toHaveBeenCalledTimes(1);

			const neokaiAuth = JSON.parse(
				await fs.readFile(path.join(neokaiDir, 'auth.json'), 'utf-8')
			) as {
				openai: { type: string; access: string; refresh?: string };
			};
			expect(neokaiAuth.openai.type).toBe('oauth');
			expect(neokaiAuth.openai.access).toBe('expired-token');
			expect(neokaiAuth.openai.refresh).toBe('invalid-refresh');
			p.stopAllBridgeServers();
		});

		it('Test 4: second call uses in-memory cachedApiKey (no further file I/O)', async () => {
			const neokaiDir = path.join(tmpDir, 'neokai');
			const codexDir = path.join(tmpDir, 'codex');

			// Pre-populate ~/.neokai/auth.json (simulates already-imported state)
			await writeNeokaiAuth(neokaiDir, { type: 'oauth', access: 'already-imported-token' });

			const p = makeProvider({}, neokaiDir, codexDir);

			// First call — reads from ~/.neokai/auth.json and populates cachedApiKey
			const key1 = await p.getApiKey();
			expect(key1).toBe('already-imported-token');

			// Delete the neokai auth file; no codex file exists either.
			// Any further disk read would find nothing and return undefined.
			await fs.unlink(path.join(neokaiDir, 'auth.json'));

			// Second call — must return the key from in-memory cache, not from disk.
			const key2 = await p.getApiKey();
			expect(key2).toBe('already-imported-token');

			// fetch should NOT have been called at any point (no migration attempt)
			expect(fetchSpy).not.toHaveBeenCalled();
			p.stopAllBridgeServers();
		});
	});
});
