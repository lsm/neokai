/**
 * Unit tests for CopilotAnthropicProvider
 *
 * Tests cover:
 * - Provider properties (id, capabilities, ownsModel, getModelForTier)
 * - Availability checks (binary + auth)
 * - buildSdkConfig env-var shape (requires pre-warmed serverCache)
 * - getModels() pre-warms the embedded server
 * - shutdown() stops the embedded server and CopilotClient
 * - ensureServerStarted() retry-after-failure
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { CopilotAnthropicProvider } from '../../../../src/lib/providers/copilot-anthropic/index';
import { initializeProviders, resetProviderFactory } from '../../../../src/lib/providers/factory';
import { getProviderRegistry, resetProviderRegistry } from '../../../../src/lib/providers/registry';

// ---------------------------------------------------------------------------
// CopilotAnthropicProvider — unit tests
// ---------------------------------------------------------------------------

describe('CopilotAnthropicProvider', () => {
	let provider: CopilotAnthropicProvider;

	beforeEach(() => {
		provider = new CopilotAnthropicProvider('/tmp', {});
	});

	describe('basic properties', () => {
		it('has correct id', () => {
			expect(provider.id).toBe('github-copilot-anthropic');
		});

		it('has correct displayName', () => {
			expect(provider.displayName).toBe('GitHub Copilot (Anthropic API)');
		});

		it('has streaming=true', () => {
			expect(provider.capabilities.streaming).toBe(true);
		});

		it('has functionCalling=true (tool-use bridge via ConversationManager)', () => {
			expect(provider.capabilities.functionCalling).toBe(true);
		});

		it('has vision=false', () => {
			expect(provider.capabilities.vision).toBe(false);
		});

		it('has extendedThinking=false', () => {
			expect(provider.capabilities.extendedThinking).toBe(false);
		});
	});

	describe('ownsModel', () => {
		it('owns all copilot-anthropic-* aliases', () => {
			expect(provider.ownsModel('copilot-anthropic-opus')).toBe(true);
			expect(provider.ownsModel('copilot-anthropic-sonnet')).toBe(true);
			expect(provider.ownsModel('copilot-anthropic-codex')).toBe(true);
			expect(provider.ownsModel('copilot-anthropic-gemini')).toBe(true);
			expect(provider.ownsModel('copilot-anthropic-mini')).toBe(true);
		});

		it('does NOT own bare model IDs shared with other providers', () => {
			// Claude IDs: also claimed by GitHubCopilotProvider (registered before this)
			expect(provider.ownsModel('claude-opus-4.6')).toBe(false);
			expect(provider.ownsModel('claude-sonnet-4.6')).toBe(false);
			// gpt-5.3-codex/gpt-5-mini: also claimed by GitHubCopilotProvider
			expect(provider.ownsModel('gpt-5.3-codex')).toBe(false);
			expect(provider.ownsModel('gpt-5-mini')).toBe(false);
		});

		it('owns gemini-3-pro-preview bare ID (no collision partner)', () => {
			expect(provider.ownsModel('gemini-3-pro-preview')).toBe(true);
		});

		it('does not own unknown models', () => {
			expect(provider.ownsModel('copilot-sdk-sonnet')).toBe(false);
			expect(provider.ownsModel('llama-3')).toBe(false);
		});
	});

	describe('getModelForTier', () => {
		it('maps opus tier to claude-opus-4.6', () => {
			expect(provider.getModelForTier('opus')).toBe('claude-opus-4.6');
		});

		it('maps sonnet tier to claude-sonnet-4.6', () => {
			expect(provider.getModelForTier('sonnet')).toBe('claude-sonnet-4.6');
		});

		it('maps haiku tier to gpt-5-mini', () => {
			expect(provider.getModelForTier('haiku')).toBe('gpt-5-mini');
		});

		it('maps default tier to claude-sonnet-4.6', () => {
			expect(provider.getModelForTier('default')).toBe('claude-sonnet-4.6');
		});
	});

	describe('isAvailable', () => {
		it('returns false when no token and gh auth fails', async () => {
			const p = new CopilotAnthropicProvider('/tmp', {});
			spyOn(
				p as unknown as Record<string, unknown>,
				'isGhAuthenticated' as never
			).mockResolvedValue(false as never);
			expect(await p.isAvailable()).toBe(false);
		});

		it('returns true when COPILOT_GITHUB_TOKEN is set', async () => {
			const p = new CopilotAnthropicProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'tok' });
			expect(await p.isAvailable()).toBe(true);
		});

		it('returns true when GH_TOKEN is set', async () => {
			const p = new CopilotAnthropicProvider('/tmp', { GH_TOKEN: 'tok' });
			expect(await p.isAvailable()).toBe(true);
		});
	});

	describe('getAuthStatus', () => {
		it('reports not authenticated when no token and gh auth fails', async () => {
			const p = new CopilotAnthropicProvider('/tmp', {});
			spyOn(
				p as unknown as Record<string, unknown>,
				'isGhAuthenticated' as never
			).mockResolvedValue(false as never);
			const status = await p.getAuthStatus();
			expect(status.isAuthenticated).toBe(false);
			expect(status.error).toContain('COPILOT_GITHUB_TOKEN');
		});

		it('reports authenticated when token env var is set', async () => {
			const p = new CopilotAnthropicProvider('/tmp', { GITHUB_TOKEN: 'tok' });
			const status = await p.getAuthStatus();
			expect(status.isAuthenticated).toBe(true);
			expect(status.needsRefresh).toBe(false);
		});
	});

	describe('buildSdkConfig', () => {
		const fakeServerUrl = 'http://127.0.0.1:54321';

		beforeEach(() => {
			(provider as unknown as Record<string, unknown>)['serverCache'] = {
				url: fakeServerUrl,
				stop: async () => {},
			};
		});

		it('throws when embedded server has not been started', () => {
			const p = new CopilotAnthropicProvider('/tmp', {});
			expect(() => p.buildSdkConfig('copilot-anthropic-sonnet')).toThrow(
				'embedded server not started'
			);
		});

		it('returns isAnthropicCompatible=true', () => {
			const cfg = provider.buildSdkConfig('copilot-anthropic-sonnet');
			expect(cfg.isAnthropicCompatible).toBe(true);
		});

		it('sets ANTHROPIC_AUTH_TOKEN dummy key', () => {
			const cfg = provider.buildSdkConfig('copilot-anthropic-sonnet');
			expect(cfg.envVars['ANTHROPIC_AUTH_TOKEN']).toBeDefined();
		});

		it('ANTHROPIC_BASE_URL uses the injected server URL', () => {
			const cfg = provider.buildSdkConfig('copilot-anthropic-sonnet');
			const parsedUrl = new URL(cfg.envVars['ANTHROPIC_BASE_URL'] as string);
			expect(parsedUrl.hostname).toBe('127.0.0.1');
			expect(Number(parsedUrl.port)).toBeGreaterThan(0);
		});

		it('sets ANTHROPIC_DEFAULT_SONNET_MODEL to resolved model ID', () => {
			const cfg = provider.buildSdkConfig('copilot-anthropic-sonnet');
			expect(cfg.envVars['ANTHROPIC_DEFAULT_SONNET_MODEL']).toBe('claude-sonnet-4.6');
		});

		it('resolves copilot-anthropic-opus alias to claude-opus-4.6', () => {
			const cfg = provider.buildSdkConfig('copilot-anthropic-opus');
			expect(cfg.envVars['ANTHROPIC_DEFAULT_SONNET_MODEL']).toBe('claude-opus-4.6');
			expect(cfg.envVars['ANTHROPIC_DEFAULT_OPUS_MODEL']).toBe('claude-opus-4.6');
		});

		it('sets CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', () => {
			const cfg = provider.buildSdkConfig('copilot-anthropic-sonnet');
			expect(cfg.envVars['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC']).toBe('1');
		});
	});

	describe('getModels() pre-warms embedded server', () => {
		it('calls ensureServerStarted when provider is available', async () => {
			const p = new CopilotAnthropicProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'tok' });
			spyOn(p as unknown as Record<string, unknown>, 'findCopilotCli' as never).mockResolvedValue(
				'/usr/local/bin/copilot' as never
			);
			const ensureSpy = spyOn(p, 'ensureServerStarted').mockResolvedValue(
				'http://127.0.0.1:9999' as never
			);
			await p.getModels();
			expect(ensureSpy).toHaveBeenCalledTimes(1);
		});

		it('returns empty array when ensureServerStarted fails', async () => {
			const p = new CopilotAnthropicProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'tok' });
			spyOn(p as unknown as Record<string, unknown>, 'findCopilotCli' as never).mockResolvedValue(
				'/usr/local/bin/copilot' as never
			);
			spyOn(p, 'ensureServerStarted').mockImplementation(() =>
				Promise.reject(new Error('port in use'))
			);
			const models = await p.getModels();
			expect(models).toEqual([]);
		});

		it('returns empty array when provider is not available', async () => {
			const p = new CopilotAnthropicProvider('/tmp', {});
			spyOn(
				p as unknown as Record<string, unknown>,
				'isGhAuthenticated' as never
			).mockResolvedValue(false as never);
			const models = await p.getModels();
			expect(models).toEqual([]);
		});
	});

	describe('ensureServerStarted() retry-after-failure', () => {
		it('clears serverStarting on rejection so the next call can retry', async () => {
			const p = new CopilotAnthropicProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'tok' });
			let callCount = 0;
			spyOn(p as unknown as Record<string, unknown>, 'createServer' as never).mockImplementation(
				async () => {
					callCount++;
					if (callCount === 1) throw new Error('transient failure');
					return { url: 'http://127.0.0.1:9999', stop: async () => {} };
				}
			);

			// First call should reject
			await expect(p.ensureServerStarted()).rejects.toThrow('transient failure');
			// serverStarting must be cleared so the second attempt creates a new promise
			expect((p as unknown as Record<string, unknown>)['serverStarting']).toBeUndefined();

			// Second call should succeed
			const url = await p.ensureServerStarted();
			expect(url).toBe('http://127.0.0.1:9999');
		});
	});

	describe('shutdown()', () => {
		it('stops the embedded server and clears serverCache', async () => {
			let stopped = false;
			(provider as unknown as Record<string, unknown>)['serverCache'] = {
				url: 'http://127.0.0.1:12345',
				stop: async () => {
					stopped = true;
				},
			};
			await provider.shutdown();
			expect(stopped).toBe(true);
			expect((provider as unknown as Record<string, unknown>)['serverCache']).toBeUndefined();
		});

		it('stops the CopilotClient and clears clientCache', async () => {
			let clientStopped = false;
			(provider as unknown as Record<string, unknown>)['clientCache'] = {
				stop: async () => {
					clientStopped = true;
					return [];
				},
			};
			await provider.shutdown();
			expect(clientStopped).toBe(true);
			expect((provider as unknown as Record<string, unknown>)['clientCache']).toBeUndefined();
		});

		it('is safe to call when server was never started', async () => {
			await expect(provider.shutdown()).resolves.toBeUndefined();
		});

		it('is safe to call twice', async () => {
			(provider as unknown as Record<string, unknown>)['serverCache'] = {
				url: 'http://127.0.0.1:12345',
				stop: async () => {},
			};
			await provider.shutdown();
			await expect(provider.shutdown()).resolves.toBeUndefined();
		});
	});
});

// ---------------------------------------------------------------------------
// Factory registration
// ---------------------------------------------------------------------------

describe('factory registration', () => {
	afterEach(() => {
		resetProviderRegistry();
		resetProviderFactory();
	});

	it('registers CopilotAnthropicProvider with id github-copilot-anthropic', () => {
		initializeProviders();
		const registry = getProviderRegistry();
		const p = registry.get('github-copilot-anthropic');
		expect(p).toBeDefined();
		expect(p?.id).toBe('github-copilot-anthropic');
	});
});
