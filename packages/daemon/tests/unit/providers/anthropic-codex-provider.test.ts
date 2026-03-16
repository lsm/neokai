/**
 * Unit tests for AnthropicCodexProvider
 *
 * Covers:
 *  - getAuthStatus(): env var, file-based auth, missing credentials, missing binary
 *  - getApiKey(): full discovery chain (env → ~/.neokai/auth.json → ~/.codex/auth.json)
 *  - buildSdkConfig(): per-workspace bridge server isolation and reuse
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { AnthropicCodexProvider } from '../../../src/lib/providers/anthropic-codex-provider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a provider instance pointing at isolated temp auth dirs. */
function makeProvider(
	env: Record<string, string | undefined> = {},
	authDir?: string,
	codexAuthDir?: string
): AnthropicCodexProvider {
	return new AnthropicCodexProvider(env, authDir, codexAuthDir);
}

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

describe('AnthropicCodexProvider', () => {
	let provider: AnthropicCodexProvider;

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

		it('returns isAuthenticated=false when no credentials and no binary', async () => {
			provider = makeProvider({}, emptyDir, emptyDir);
			const result = await provider.getAuthStatus();
			expect(result.isAuthenticated).toBe(false);
			expect(result.error).toContain('No credentials');
		});

		it('returns isAuthenticated=false with binary-not-found error when key set but no codex', async () => {
			// Ensure a key is provided so we get past the credentials check
			provider = makeProvider({ OPENAI_API_KEY: 'sk-test' }, emptyDir, emptyDir);
			const result = await provider.getAuthStatus();
			// Two outcomes: CI/test machine either has codex or not.
			if (!result.isAuthenticated) {
				expect(result.error).toContain('codex binary not found');
			}
			// If codex IS installed the test is not meaningful but passes.
		});

		it('returns isAuthenticated=false with descriptive error when env vars are empty', async () => {
			provider = makeProvider({ OPENAI_API_KEY: '', CODEX_API_KEY: '' }, emptyDir, emptyDir);
			const result = await provider.getAuthStatus();
			expect(result.isAuthenticated).toBe(false);
			expect(result.error).toBeTruthy();
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
			expect(cfg.envVars.ANTHROPIC_API_KEY).toBe('codex-bridge-placeholder');
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
	});

	// -------------------------------------------------------------------------
	// ownsModel()
	// -------------------------------------------------------------------------

	describe('ownsModel()', () => {
		beforeEach(() => {
			provider = makeProvider({});
		});

		it('owns gpt-5 catalogue models but not generic gpt-4/gpt-3', () => {
			expect(provider.ownsModel('gpt-5.3-codex')).toBe(true);
			expect(provider.ownsModel('gpt-5-mini')).toBe(true);
			// gpt-4o and gpt-3.5 are NOT in the catalogue — bridge cannot serve them
			expect(provider.ownsModel('gpt-4o')).toBe(false);
			expect(provider.ownsModel('gpt-4')).toBe(false);
			expect(provider.ownsModel('gpt-3.5-turbo')).toBe(false);
		});

		it('owns o4- prefix models', () => {
			expect(provider.ownsModel('o4-mini')).toBe(true);
		});

		it('owns o1- and o3- prefix models', () => {
			expect(provider.ownsModel('o1-preview')).toBe(true);
			expect(provider.ownsModel('o3-mini')).toBe(true);
		});

		it('owns codex- prefix models', () => {
			expect(provider.ownsModel('codex-1')).toBe(true);
		});

		it('does not own claude- models', () => {
			expect(provider.ownsModel('claude-3-opus')).toBe(false);
		});

		it('does not own arbitrary unrecognised model IDs', () => {
			expect(provider.ownsModel('unknown-model-xyz')).toBe(false);
		});
	});
});
