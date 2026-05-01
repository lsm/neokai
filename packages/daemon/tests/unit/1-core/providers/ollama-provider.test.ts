import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { OllamaProvider } from '../../../../src/lib/providers/ollama-provider';

describe('OllamaProvider', () => {
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		delete process.env.OLLAMA_API_KEY;
		delete process.env.OLLAMA_BASE_URL;
		delete process.env.OLLAMA_CLOUD_API_KEY;
		delete process.env.OLLAMA_CLOUD_BASE_URL;
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it('exposes local and cloud identities', () => {
		const local = new OllamaProvider({ kind: 'local' });
		const cloud = new OllamaProvider({ kind: 'cloud' });

		expect(local.id).toBe('ollama');
		expect(local.displayName).toBe('Ollama (Local)');
		expect(local.isAvailable()).toBe(true);
		expect(cloud.id).toBe('ollama-cloud');
		expect(cloud.displayName).toBe('Ollama Cloud');
		expect(cloud.isAvailable()).toBe(false);
		expect(local.capabilities.streaming).toBe(true);
	});

	it('loads models from /api/tags for local Ollama', async () => {
		process.env.OLLAMA_BASE_URL = 'http://ollama.test/';
		const fetchMock = mock(
			async () =>
				new Response(
					JSON.stringify({
						models: [
							{
								name: 'llama3.2:latest',
								model: 'llama3.2:latest',
								modified_at: '2026-04-20T00:00:00Z',
								details: { family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M' },
							},
						],
					}),
					{ status: 200 }
				)
		);
		const provider = new OllamaProvider({
			kind: 'local',
			env: process.env,
			fetchImpl: fetchMock as typeof fetch,
		});

		const models = await provider.getModels();

		expect(fetchMock).toHaveBeenCalledWith('http://ollama.test/api/tags', { headers: undefined });
		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({
			id: 'llama3.2:latest',
			provider: 'ollama',
			family: 'llama',
			releaseDate: '2026-04-20',
		});
	});

	it('uses bearer auth and cloud base URL for Ollama Cloud model listing', async () => {
		process.env.OLLAMA_CLOUD_API_KEY = 'ollama-key';
		const fetchMock = mock(
			async () => new Response(JSON.stringify({ models: [] }), { status: 200 })
		);
		const provider = new OllamaProvider({
			kind: 'cloud',
			env: process.env,
			fetchImpl: fetchMock as typeof fetch,
		});

		await provider.getModels();

		expect(fetchMock).toHaveBeenCalledWith('https://ollama.com/api/tags', {
			headers: { Authorization: 'Bearer ollama-key' },
		});
	});

	it('builds Anthropic-compatible routing through a local bridge', () => {
		const provider = new OllamaProvider({ kind: 'local' });

		const config = provider.buildSdkConfig('llama3.2:latest', {
			baseUrl: 'http://ollama.test',
		});

		expect(config.isAnthropicCompatible).toBe(true);
		expect(config.envVars.ANTHROPIC_BASE_URL).toStartWith('http://127.0.0.1:');
		expect(config.envVars.ANTHROPIC_AUTH_TOKEN).toBe('ollama-bridge');
		expect(config.envVars.ANTHROPIC_API_KEY).toBe('');
		expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('llama3.2:latest');
		void provider.shutdown();
	});

	it('requires an API key for cloud SDK routing', () => {
		const provider = new OllamaProvider({ kind: 'cloud' });

		expect(() => provider.buildSdkConfig('gpt-oss:120b-cloud')).toThrow(
			'Ollama Cloud API key not configured'
		);
	});

	it('uses session overrides for cloud API key and base URL', () => {
		const provider = new OllamaProvider({ kind: 'cloud' });

		const config = provider.buildSdkConfig('gpt-oss:120b-cloud', {
			apiKey: 'session-key',
			baseUrl: 'https://example.test',
		});

		expect(config.envVars.ANTHROPIC_BASE_URL).toStartWith('http://127.0.0.1:');
		expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-oss:120b-cloud');
		void provider.shutdown();
	});
});
