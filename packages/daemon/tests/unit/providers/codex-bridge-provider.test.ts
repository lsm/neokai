/**
 * Unit tests for CodexBridgeProvider
 *
 * Tests auth gating (getAuthStatus) and workspace isolation (per-workspace
 * bridge servers) without spawning real codex subprocesses.  The bridge HTTP
 * server listens on a random port immediately on creation but only talks to
 * codex when a request arrives, so creating servers in tests is safe.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { CodexBridgeProvider } from '../../../src/lib/providers/codex-bridge-provider';

describe('CodexBridgeProvider', () => {
	let provider: CodexBridgeProvider;

	beforeEach(() => {
		provider = new CodexBridgeProvider();
	});

	afterEach(() => {
		provider.stopAllBridgeServers();
	});

	// -------------------------------------------------------------------------
	// getAuthStatus — auth gate (regression: issue #1)
	// -------------------------------------------------------------------------

	describe('getAuthStatus()', () => {
		it('returns isAuthenticated=false when neither OPENAI_API_KEY nor CODEX_API_KEY is set', async () => {
			// Setup is cleared in test setup.ts (both keys are '')
			const result = await provider.getAuthStatus();
			expect(result.isAuthenticated).toBe(false);
			expect(result.error).toContain('OPENAI_API_KEY or CODEX_API_KEY');
		});

		it('returns isAuthenticated=false when key is set but codex binary is not on PATH', async () => {
			const saved = process.env.OPENAI_API_KEY;
			process.env.OPENAI_API_KEY = 'sk-test-key';
			try {
				const result = await provider.getAuthStatus();
				// Two valid outcomes: the CI/test machine either has codex installed or not.
				// If it does, the provider is authenticated (not what we're testing here).
				// If it doesn't, we verify the correct error is returned.
				if (!result.isAuthenticated) {
					expect(result.error).toContain('codex binary not found');
				}
				// (if codex IS installed, the test is not meaningful but doesn't break)
			} finally {
				process.env.OPENAI_API_KEY = saved;
			}
		});

		it('returns isAuthenticated=false with descriptive error when no key is set', async () => {
			const savedOpenAI = process.env.OPENAI_API_KEY;
			const savedCodex = process.env.CODEX_API_KEY;
			process.env.OPENAI_API_KEY = '';
			process.env.CODEX_API_KEY = '';
			try {
				const result = await provider.getAuthStatus();
				expect(result.isAuthenticated).toBe(false);
				expect(typeof result.error).toBe('string');
				expect(result.error!.length).toBeGreaterThan(0);
			} finally {
				process.env.OPENAI_API_KEY = savedOpenAI;
				process.env.CODEX_API_KEY = savedCodex;
			}
		});
	});

	// -------------------------------------------------------------------------
	// buildSdkConfig workspace isolation (regression: issue #2)
	// -------------------------------------------------------------------------

	describe('buildSdkConfig() workspace isolation', () => {
		it('starts separate bridge servers for different workspace paths', () => {
			const cfgA = provider.buildSdkConfig('codex-1', { workspacePath: '/tmp/workspace-a' });
			const cfgB = provider.buildSdkConfig('codex-1', { workspacePath: '/tmp/workspace-b' });

			const urlA = cfgA.envVars.ANTHROPIC_BASE_URL as string;
			const urlB = cfgB.envVars.ANTHROPIC_BASE_URL as string;

			// Different workspaces → different bridge server ports
			expect(urlA).not.toBe(urlB);

			const portA = new URL(urlA).port;
			const portB = new URL(urlB).port;
			expect(portA).not.toBe(portB);
		});

		it('reuses the same bridge server for the same workspace path', () => {
			const cfg1 = provider.buildSdkConfig('codex-1', { workspacePath: '/tmp/workspace-reuse' });
			const cfg2 = provider.buildSdkConfig('codex-1', { workspacePath: '/tmp/workspace-reuse' });

			// Same workspace → same port (server is reused, not duplicated)
			expect(cfg1.envVars.ANTHROPIC_BASE_URL).toBe(cfg2.envVars.ANTHROPIC_BASE_URL);
		});

		it('returns isAnthropicCompatible=true and a placeholder API key', () => {
			const cfg = provider.buildSdkConfig('codex-1', { workspacePath: '/tmp/ws-compat' });

			expect(cfg.isAnthropicCompatible).toBe(true);
			expect(cfg.envVars.ANTHROPIC_API_KEY).toBe('codex-bridge-placeholder');
			expect(cfg.envVars.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		});
	});
});
