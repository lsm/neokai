import { describe, expect, it } from 'bun:test';
import {
	CustomEndpointProvider,
	customProviderIdFor,
	isCustomEndpointProviderId,
	resolveModelCapabilities,
} from '../../../../src/lib/providers/custom-endpoint-provider';
import type { CustomEndpointConfig } from '@neokai/shared';
import type {
	OpenAIChatBridgeConfig,
	OpenAIChatBridgeServer,
} from '../../../../src/lib/providers/openai-chat-bridge/server';

/**
 * Fake bridge factory — records every config passed in so tests can assert
 * which baseUrl/apiKey/capability flags were forwarded without spinning up a
 * real Bun.serve listener per test.
 */
function makeFakeBridge(): {
	factory: (config: OpenAIChatBridgeConfig) => OpenAIChatBridgeServer;
	configs: OpenAIChatBridgeConfig[];
	stoppedPorts: number[];
} {
	const configs: OpenAIChatBridgeConfig[] = [];
	const stoppedPorts: number[] = [];
	let nextPort = 40000;
	const factory = (config: OpenAIChatBridgeConfig): OpenAIChatBridgeServer => {
		configs.push(config);
		const port = nextPort++;
		return {
			port,
			stop: () => stoppedPorts.push(port),
		};
	};
	return { factory, configs, stoppedPorts };
}

const baseConfig: CustomEndpointConfig = {
	id: 'lmstudio',
	name: 'LM Studio Local',
	baseUrl: 'http://localhost:1234/v1',
	models: [
		{
			id: 'qwen2.5-7b',
			capabilities: { toolUse: true, vision: false, maxContextTokens: 32000 },
		},
		{
			id: 'qwen2.5-vl-7b',
			capabilities: { toolUse: false, vision: true, maxContextTokens: 32000 },
		},
	],
	defaultModelId: 'qwen2.5-7b',
};

describe('CustomEndpointProvider', () => {
	it('exposes a `custom:<id>` provider id', () => {
		const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: makeFakeBridge().factory });
		expect(p.id).toBe('custom:lmstudio');
		expect(p.displayName).toBe('LM Studio Local');
		expect(customProviderIdFor('lmstudio')).toBe('custom:lmstudio');
		expect(isCustomEndpointProviderId(p.id)).toBe(true);
		expect(isCustomEndpointProviderId('anthropic')).toBe(false);
	});

	it('rejects configs that are missing required fields', () => {
		expect(
			() =>
				new CustomEndpointProvider(
					{ ...baseConfig, id: '' },
					{
						bridgeFactory: makeFakeBridge().factory,
					}
				)
		).toThrow(/endpoint id is required/);
		expect(
			() =>
				new CustomEndpointProvider(
					{ ...baseConfig, baseUrl: '' },
					{
						bridgeFactory: makeFakeBridge().factory,
					}
				)
		).toThrow(/baseUrl is required/);
		expect(
			() =>
				new CustomEndpointProvider(
					{ ...baseConfig, models: [] },
					{
						bridgeFactory: makeFakeBridge().factory,
					}
				)
		).toThrow(/at least one model is required/);
	});

	it('reports aggregated capabilities across models', () => {
		const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: makeFakeBridge().factory });
		expect(p.capabilities.functionCalling).toBe(true);
		expect(p.capabilities.vision).toBe(true); // one model supports vision
		expect(p.capabilities.streaming).toBe(true);
		expect(p.capabilities.maxContextWindow).toBe(32000);
	});

	it('lists models with provider id, family, and context window', async () => {
		const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: makeFakeBridge().factory });
		const models = await p.getModels();
		expect(models).toHaveLength(2);
		expect(models[0]).toMatchObject({
			id: 'qwen2.5-7b',
			provider: 'custom:lmstudio',
			family: 'lmstudio',
			contextWindow: 32000,
		});
	});

	it('owns its own model ids and nothing else', () => {
		const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: makeFakeBridge().factory });
		expect(p.ownsModel('qwen2.5-7b')).toBe(true);
		expect(p.ownsModel('qwen2.5-vl-7b')).toBe(true);
		expect(p.ownsModel('claude-sonnet-4-5')).toBe(false);
	});

	it('returns defaultModelId for getModelForTier when set', () => {
		const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: makeFakeBridge().factory });
		expect(p.getModelForTier('default')).toBe('qwen2.5-7b');
		expect(p.getModelForTier('sonnet')).toBe('qwen2.5-7b');
	});

	it('builds SDK config that routes through the bridge with model capabilities', () => {
		const fake = makeFakeBridge();
		const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: fake.factory });
		const cfg = p.buildSdkConfig('qwen2.5-7b');
		expect(cfg.isAnthropicCompatible).toBe(true);
		expect(cfg.envVars.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('qwen2.5-7b');
		expect(fake.configs).toHaveLength(1);
		expect(fake.configs[0]).toMatchObject({
			baseUrl: 'http://localhost:1234/v1',
			toolUseSupported: true,
			visionSupported: false,
			modelContextWindow: 32000,
		});
	});

	it('forwards per-model capability flags into the bridge', () => {
		const fake = makeFakeBridge();
		const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: fake.factory });
		p.buildSdkConfig('qwen2.5-vl-7b');
		expect(fake.configs[0]).toMatchObject({
			toolUseSupported: false,
			visionSupported: true,
		});
	});

	it('reuses the bridge for the same (baseUrl, apiKey, model) tuple', () => {
		const fake = makeFakeBridge();
		const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: fake.factory });
		const first = p.buildSdkConfig('qwen2.5-7b');
		const second = p.buildSdkConfig('qwen2.5-7b');
		expect(first.envVars.ANTHROPIC_BASE_URL).toBe(second.envVars.ANTHROPIC_BASE_URL);
		expect(fake.configs).toHaveLength(1);
	});

	it('uses providerModelId override for the upstream model string', () => {
		const fake = makeFakeBridge();
		const p = new CustomEndpointProvider(
			{
				...baseConfig,
				models: [
					{
						id: 'fast',
						providerModelId: 'qwen2.5-coder:14b',
						capabilities: { toolUse: true },
					},
				],
				defaultModelId: 'fast',
			},
			{ bridgeFactory: fake.factory }
		);
		const cfg = p.buildSdkConfig('fast');
		expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('qwen2.5-coder:14b');
	});

	it('shutdown stops every active bridge', async () => {
		const fake = makeFakeBridge();
		const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: fake.factory });
		p.buildSdkConfig('qwen2.5-7b');
		p.buildSdkConfig('qwen2.5-vl-7b');
		expect(fake.configs).toHaveLength(2);
		await p.shutdown();
		expect(fake.stoppedPorts).toHaveLength(2);
	});

	it('resolveModelCapabilities fills in defaults', () => {
		const caps = resolveModelCapabilities({ id: 'x' });
		expect(caps).toEqual({
			streaming: true,
			toolUse: true,
			vision: false,
			thinking: false,
			caching: false,
			maxContextTokens: 128000,
		});
	});

	it('isAvailable returns true when baseUrl is set', async () => {
		const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: makeFakeBridge().factory });
		expect(await p.isAvailable()).toBe(true);
	});

	it('getAuthStatus reports authenticated with api_key method', async () => {
		const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: makeFakeBridge().factory });
		const status = await p.getAuthStatus();
		expect(status.isAuthenticated).toBe(true);
		expect(status.method).toBe('api_key');
	});

	it('translateModelIdForSdk always returns "default" (SDK tier alias)', () => {
		const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: makeFakeBridge().factory });
		expect(p.translateModelIdForSdk('qwen2.5-7b')).toBe('default');
		expect(p.translateModelIdForSdk('anything')).toBe('default');
	});

	it('forwards custom headers into the bridge', () => {
		const fake = makeFakeBridge();
		const p = new CustomEndpointProvider(
			{
				...baseConfig,
				headers: { 'X-Org': 'acme', Authorization: 'Bearer override' },
			},
			{ bridgeFactory: fake.factory }
		);
		p.buildSdkConfig('qwen2.5-7b');
		expect(fake.configs[0].headers).toEqual({
			'X-Org': 'acme',
			Authorization: 'Bearer override',
		});
	});

	it('falls back to the first model when modelId is unknown', () => {
		const fake = makeFakeBridge();
		const p = new CustomEndpointProvider(
			{
				...baseConfig,
				defaultModelId: undefined,
			},
			{ bridgeFactory: fake.factory }
		);
		const cfg = p.buildSdkConfig('not-a-real-model');
		// First model id wins when no defaultModelId is configured.
		expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('qwen2.5-7b');
	});

	it('honours sessionConfig overrides for baseUrl and apiKey', () => {
		const fake = makeFakeBridge();
		const p = new CustomEndpointProvider(baseConfig, { bridgeFactory: fake.factory });
		p.buildSdkConfig('qwen2.5-7b', {
			baseUrl: 'http://override.test/v1',
			apiKey: 'session-key',
		});
		expect(fake.configs[0]).toMatchObject({
			baseUrl: 'http://override.test/v1',
			apiKey: 'session-key',
		});
	});
});
