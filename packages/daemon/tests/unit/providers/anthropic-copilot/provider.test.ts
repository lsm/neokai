/**
 * Unit tests for AnthropicCopilotProvider
 *
 * Tests cover:
 * - Provider properties (id, capabilities, ownsModel, getModelForTier)
 * - Availability checks (credential discovery chain)
 * - buildSdkConfig env-var shape (requires pre-warmed serverCache)
 * - getModels() pre-warms the embedded server
 * - shutdown() stops the embedded server and CopilotClient
 * - ensureServerStarted() retry-after-failure
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { AnthropicCopilotProvider } from '../../../../src/lib/providers/anthropic-copilot/index';
import { initializeProviders, resetProviderFactory } from '../../../../src/lib/providers/factory';
import { getProviderRegistry, resetProviderRegistry } from '../../../../src/lib/providers/registry';

// ---------------------------------------------------------------------------
// AnthropicCopilotProvider — unit tests
// ---------------------------------------------------------------------------

describe('AnthropicCopilotProvider', () => {
	let provider: AnthropicCopilotProvider;

	beforeEach(() => {
		provider = new AnthropicCopilotProvider('/tmp', {});
	});

	describe('basic properties', () => {
		it('has correct id', () => {
			expect(provider.id).toBe('anthropic-copilot');
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

		it('owns all bare model IDs in the model list', () => {
			// Since GitHubCopilotProvider is removed, no collision — bare IDs are owned
			expect(provider.ownsModel('claude-opus-4.6')).toBe(true);
			expect(provider.ownsModel('claude-sonnet-4.6')).toBe(true);
			expect(provider.ownsModel('gpt-5.3-codex')).toBe(true);
			expect(provider.ownsModel('gpt-5-mini')).toBe(true);
		});

		it('owns gemini-3-pro-preview bare ID', () => {
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
		it('returns false when no token source resolves', async () => {
			const p = new AnthropicCopilotProvider('/tmp', {});
			spyOn(
				p as unknown as Record<string, unknown>,
				'discoverGitHubToken' as never
			).mockResolvedValue(undefined as never);
			expect(await p.isAvailable()).toBe(false);
		});

		it('returns true when COPILOT_GITHUB_TOKEN is set', async () => {
			const p = new AnthropicCopilotProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'tok' });
			expect(await p.isAvailable()).toBe(true);
		});

		it('returns true when GH_TOKEN is set', async () => {
			const p = new AnthropicCopilotProvider('/tmp', { GH_TOKEN: 'tok' });
			expect(await p.isAvailable()).toBe(true);
		});

		it('does NOT treat GITHUB_TOKEN as a valid Copilot credential', async () => {
			// GITHUB_TOKEN is the GitHub Actions token — it lacks Copilot access.
			// Use a non-existent authDir so no ~/.neokai/auth.json is found.
			const p = new AnthropicCopilotProvider(
				'/tmp',
				{ GITHUB_TOKEN: 'gha-tok' },
				'/tmp/no-auth-dir-' + Date.now()
			);
			// Mock gh CLI and hosts.yml sources so only env vars are tested
			spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
				undefined as never
			);
			spyOn(p as unknown as Record<string, unknown>, 'tryGhHostsToken' as never).mockResolvedValue(
				undefined as never
			);
			expect(await p.isAvailable()).toBe(false);
		});
	});

	describe('getAuthStatus', () => {
		it('reports not authenticated when no token source resolves', async () => {
			const p = new AnthropicCopilotProvider('/tmp', {});
			spyOn(
				p as unknown as Record<string, unknown>,
				'discoverGitHubToken' as never
			).mockResolvedValue(undefined as never);
			const status = await p.getAuthStatus();
			expect(status.isAuthenticated).toBe(false);
			expect(status.error).toContain('COPILOT_GITHUB_TOKEN');
		});

		it('reports authenticated when COPILOT_GITHUB_TOKEN env var is set', async () => {
			const p = new AnthropicCopilotProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'tok' });
			const status = await p.getAuthStatus();
			expect(status.isAuthenticated).toBe(true);
			expect(status.needsRefresh).toBe(false);
		});

		it('does NOT report authenticated for GITHUB_TOKEN alone', async () => {
			const p = new AnthropicCopilotProvider(
				'/tmp',
				{ GITHUB_TOKEN: 'gha-tok' },
				'/tmp/no-auth-dir-' + Date.now()
			);
			spyOn(p as unknown as Record<string, unknown>, 'tryGhCliToken' as never).mockResolvedValue(
				undefined as never
			);
			spyOn(p as unknown as Record<string, unknown>, 'tryGhHostsToken' as never).mockResolvedValue(
				undefined as never
			);
			const status = await p.getAuthStatus();
			expect(status.isAuthenticated).toBe(false);
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
			const p = new AnthropicCopilotProvider('/tmp', {});
			expect(() => p.buildSdkConfig('copilot-anthropic-sonnet')).toThrow(
				'embedded server not started'
			);
		});

		it('returns isAnthropicCompatible=true', () => {
			const cfg = provider.buildSdkConfig('copilot-anthropic-sonnet');
			expect(cfg.isAnthropicCompatible).toBe(true);
		});

		it('sets ANTHROPIC_AUTH_TOKEN', () => {
			const cfg = provider.buildSdkConfig('copilot-anthropic-sonnet');
			expect(cfg.envVars['ANTHROPIC_AUTH_TOKEN']).toBeDefined();
		});

		it('encodes workspacePath in ANTHROPIC_AUTH_TOKEN with anthropic-copilot-proxy prefix', () => {
			const cfg = provider.buildSdkConfig('copilot-anthropic-sonnet', {
				workspacePath: '/my/workspace',
			});
			expect(cfg.envVars['ANTHROPIC_AUTH_TOKEN']).toBe('anthropic-copilot-proxy:/my/workspace');
		});

		it('falls back to provider cwd when workspacePath is absent', () => {
			const cfg = provider.buildSdkConfig('copilot-anthropic-sonnet');
			const token = cfg.envVars['ANTHROPIC_AUTH_TOKEN'] as string;
			expect(token.startsWith('anthropic-copilot-proxy:')).toBe(true);
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
			const p = new AnthropicCopilotProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'tok' });
			const ensureSpy = spyOn(p, 'ensureServerStarted').mockResolvedValue(
				'http://127.0.0.1:9999' as never
			);
			await p.getModels();
			expect(ensureSpy).toHaveBeenCalledTimes(1);
		});

		it('returns empty array when ensureServerStarted fails', async () => {
			const p = new AnthropicCopilotProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'tok' });
			spyOn(p, 'ensureServerStarted').mockImplementation(() =>
				Promise.reject(new Error('port in use'))
			);
			const models = await p.getModels();
			expect(models).toEqual([]);
		});

		it('returns empty array when provider is not available', async () => {
			const p = new AnthropicCopilotProvider('/tmp', {});
			spyOn(
				p as unknown as Record<string, unknown>,
				'discoverGitHubToken' as never
			).mockResolvedValue(undefined as never);
			const models = await p.getModels();
			expect(models).toEqual([]);
		});
	});

	describe('ensureServerStarted() retry-after-failure', () => {
		it('clears serverStarting on rejection so the next call can retry', async () => {
			const p = new AnthropicCopilotProvider('/tmp', { COPILOT_GITHUB_TOKEN: 'tok' });
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

	it('registers AnthropicCopilotProvider with id anthropic-copilot', () => {
		initializeProviders();
		const registry = getProviderRegistry();
		const p = registry.get('anthropic-copilot');
		expect(p).toBeDefined();
		expect(p?.id).toBe('anthropic-copilot');
	});
});
