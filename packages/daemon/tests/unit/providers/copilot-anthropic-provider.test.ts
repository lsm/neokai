/**
 * Unit tests for CopilotAnthropicProvider and the embedded Anthropic server
 *
 * Tests cover:
 * - Provider properties (id, capabilities, ownsModel, getModelForTier)
 * - Availability checks (binary + auth)
 * - buildSdkConfig env-var shape
 * - Embedded server: prompt formatting, SSE streaming, conversation reuse,
 *   error handling, and system-message extraction
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { CopilotAnthropicProvider } from '../../../src/lib/providers/copilot-anthropic-provider';
import { startEmbeddedServer } from '../../../src/lib/providers/copilot-anthropic-server';
import type { CopilotClient, CopilotSession } from '@github/copilot-sdk';
import { initializeProviders, resetProviderFactory } from '../../../src/lib/providers/factory';
import { getProviderRegistry, resetProviderRegistry } from '../../../src/lib/providers/registry';

// ---------------------------------------------------------------------------
// Mock CopilotSession
// ---------------------------------------------------------------------------

type AnyEventHandler = (event: { type: string; data: Record<string, unknown> }) => void;

class MockCopilotSession {
	readonly sessionId = 'mock-anthropic-session';
	private subscriptions: AnyEventHandler[] = [];
	capturedPrompt: string | undefined = undefined;
	shouldError = false;

	on(handler: AnyEventHandler): () => void {
		this.subscriptions.push(handler);
		return () => {
			this.subscriptions = this.subscriptions.filter((h) => h !== handler);
		};
	}

	emit(type: string, data: Record<string, unknown> = {}): void {
		for (const h of this.subscriptions) {
			h({ type, data });
		}
	}

	async send(opts: { prompt: string }): Promise<string> {
		this.capturedPrompt = opts.prompt;
		if (this.shouldError) {
			// Simulate error after microtask
			Promise.resolve().then(() => {
				this.emit('session.error', { message: 'mock error', errorType: 'internal' });
			});
		} else {
			Promise.resolve().then(() => {
				this.emit('assistant.message_delta', { deltaContent: 'Hello' });
				this.emit('assistant.message_delta', { deltaContent: ' world' });
				this.emit('assistant.message', { content: 'Hello world' });
				this.emit('session.idle', {});
			});
		}
		return 'send-result';
	}

	async abort(): Promise<void> {}
	async disconnect(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Mock CopilotClient
// ---------------------------------------------------------------------------

function makeMockClient(
	sessionFactory?: () => MockCopilotSession
): CopilotClient & { lastSession?: MockCopilotSession } {
	const mock = {
		lastSession: undefined as MockCopilotSession | undefined,
		async createSession(_cfg: unknown): Promise<CopilotSession> {
			const session = sessionFactory ? sessionFactory() : new MockCopilotSession();
			mock.lastSession = session;
			return session as unknown as CopilotSession;
		},
		async resumeSession(_id: string, _cfg: unknown): Promise<CopilotSession> {
			const session = sessionFactory ? sessionFactory() : new MockCopilotSession();
			mock.lastSession = session;
			return session as unknown as CopilotSession;
		},
	};
	return mock as unknown as CopilotClient & { lastSession?: MockCopilotSession };
}

// ---------------------------------------------------------------------------
// HTTP helper: POST /v1/messages and collect SSE
// ---------------------------------------------------------------------------

async function postMessages(
	url: string,
	body: object
): Promise<{ status: number; events: Array<{ type: string; data: unknown }>; rawBody?: string }> {
	const resp = await fetch(`${url}/v1/messages`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});

	const text = await resp.text();

	if (!resp.ok || !resp.headers.get('content-type')?.includes('text/event-stream')) {
		return { status: resp.status, events: [], rawBody: text };
	}

	const events: Array<{ type: string; data: unknown }> = [];
	const lines = text.split('\n');
	let currentType = '';

	for (const line of lines) {
		if (line.startsWith('event: ')) {
			currentType = line.slice(7).trim();
		} else if (line.startsWith('data: ')) {
			try {
				const parsed = JSON.parse(line.slice(6));
				events.push({ type: currentType, data: parsed });
			} catch {
				events.push({ type: currentType, data: line.slice(6) });
			}
			currentType = '';
		}
	}

	return { status: resp.status, events };
}

// ---------------------------------------------------------------------------
// CopilotAnthropicProvider — unit tests
// ---------------------------------------------------------------------------

describe('CopilotAnthropicProvider', () => {
	let provider: CopilotAnthropicProvider;

	beforeEach(() => {
		provider = new CopilotAnthropicProvider({});
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

		it('has functionCalling=true (SDK handles tools natively)', () => {
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
			// Claude IDs: also claimed by GitHubCopilotProvider and CopilotCliProvider
			expect(provider.ownsModel('claude-opus-4.6')).toBe(false);
			expect(provider.ownsModel('claude-sonnet-4.6')).toBe(false);
			// gpt-5.3-codex/gpt-5-mini: also claimed by GitHubCopilotProvider
			expect(provider.ownsModel('gpt-5.3-codex')).toBe(false);
			expect(provider.ownsModel('gpt-5-mini')).toBe(false);
			// gemini-3-pro-preview: also claimed by CopilotCliProvider
			expect(provider.ownsModel('gemini-3-pro-preview')).toBe(false);
		});

		it('does not own copilot-sdk-* aliases', () => {
			expect(provider.ownsModel('copilot-sdk-sonnet')).toBe(false);
		});

		it('does not own copilot-cli-* aliases', () => {
			expect(provider.ownsModel('copilot-cli-sonnet')).toBe(false);
		});

		it('does not own unknown models', () => {
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
		it('returns false when copilot binary not found and no token', async () => {
			const p = new CopilotAnthropicProvider({});
			spyOn(p as unknown as Record<string, unknown>, 'findCopilotCli' as never).mockResolvedValue(
				null as never
			);
			expect(await p.isAvailable()).toBe(false);
		});

		it('returns true when COPILOT_GITHUB_TOKEN is set and binary found', async () => {
			const p = new CopilotAnthropicProvider({ COPILOT_GITHUB_TOKEN: 'tok' });
			spyOn(p as unknown as Record<string, unknown>, 'findCopilotCli' as never).mockResolvedValue(
				'/usr/local/bin/copilot' as never
			);
			expect(await p.isAvailable()).toBe(true);
		});

		it('returns true when GH_TOKEN is set and binary found', async () => {
			const p = new CopilotAnthropicProvider({ GH_TOKEN: 'tok' });
			spyOn(p as unknown as Record<string, unknown>, 'findCopilotCli' as never).mockResolvedValue(
				'/usr/local/bin/copilot' as never
			);
			expect(await p.isAvailable()).toBe(true);
		});
	});

	describe('getAuthStatus', () => {
		it('reports not authenticated when binary not found', async () => {
			const p = new CopilotAnthropicProvider({});
			spyOn(p as unknown as Record<string, unknown>, 'findCopilotCli' as never).mockResolvedValue(
				null as never
			);
			const status = await p.getAuthStatus();
			expect(status.isAuthenticated).toBe(false);
			expect(status.error).toContain('not installed');
		});

		it('reports authenticated when token env var is set', async () => {
			const p = new CopilotAnthropicProvider({ GITHUB_TOKEN: 'tok' });
			spyOn(p as unknown as Record<string, unknown>, 'findCopilotCli' as never).mockResolvedValue(
				'/usr/local/bin/copilot' as never
			);
			const status = await p.getAuthStatus();
			expect(status.isAuthenticated).toBe(true);
			expect(status.needsRefresh).toBe(false);
		});
	});

	describe('buildSdkConfig', () => {
		it('returns isAnthropicCompatible=true', () => {
			const cfg = provider.buildSdkConfig('copilot-anthropic-sonnet');
			expect(cfg.isAnthropicCompatible).toBe(true);
		});

		it('sets ANTHROPIC_AUTH_TOKEN dummy key', () => {
			const cfg = provider.buildSdkConfig('copilot-anthropic-sonnet');
			expect(cfg.envVars['ANTHROPIC_AUTH_TOKEN']).toBeDefined();
		});

		it('sets ANTHROPIC_BASE_URL', () => {
			const cfg = provider.buildSdkConfig('copilot-anthropic-sonnet');
			expect(cfg.envVars['ANTHROPIC_BASE_URL']).toMatch(/^http:\/\/127\.0\.0\.1/);
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
});

// ---------------------------------------------------------------------------
// startEmbeddedServer — HTTP server integration tests
// ---------------------------------------------------------------------------

describe('startEmbeddedServer', () => {
	let client: CopilotClient & { lastSession?: MockCopilotSession };
	let session: MockCopilotSession;
	let serverUrl: string;
	let stopServer: () => Promise<void>;

	beforeEach(async () => {
		session = new MockCopilotSession();
		client = makeMockClient(() => session);
		const server = await startEmbeddedServer(client, '/tmp');
		serverUrl = server.url;
		stopServer = server.stop;
	});

	afterEach(async () => {
		await stopServer();
	});

	it('health endpoint returns ok', async () => {
		const resp = await fetch(`${serverUrl}/health`);
		expect(resp.status).toBe(200);
		const body = (await resp.json()) as Record<string, unknown>;
		expect(body['ok']).toBe(true);
	});

	it('returns 404 for unknown paths', async () => {
		const resp = await fetch(`${serverUrl}/unknown`);
		expect(resp.status).toBe(404);
	});

	it('returns 400 for missing required fields', async () => {
		const result = await postMessages(serverUrl, { model: 'claude-sonnet-4.6' });
		expect(result.status).toBe(400);
	});

	it('returns 400 for stream=false', async () => {
		const result = await postMessages(serverUrl, {
			model: 'claude-sonnet-4.6',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'hi' }],
			stream: false,
		});
		expect(result.status).toBe(400);
	});

	it('streams Anthropic SSE events for a simple message', async () => {
		const result = await postMessages(serverUrl, {
			model: 'claude-sonnet-4.6',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'hello' }],
		});

		expect(result.status).toBe(200);

		const types = result.events.map((e) => e.type);
		expect(types).toContain('message_start');
		expect(types).toContain('content_block_start');
		expect(types).toContain('content_block_delta');
		expect(types).toContain('content_block_stop');
		expect(types).toContain('message_delta');
		expect(types).toContain('message_stop');
	});

	it('streams concatenated text deltas', async () => {
		const result = await postMessages(serverUrl, {
			model: 'claude-sonnet-4.6',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'hello' }],
		});

		const deltaEvents = result.events.filter((e) => e.type === 'content_block_delta');
		const texts = deltaEvents.map(
			(e) => (e.data as Record<string, unknown>)['delta'] as Record<string, unknown>
		);
		const combined = texts.map((d) => d['text'] as string).join('');
		expect(combined).toBe('Hello world');
	});

	it('formats plain string user message as [User]: prefix', async () => {
		await postMessages(serverUrl, {
			model: 'claude-sonnet-4.6',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'test message' }],
		});

		expect(session.capturedPrompt).toContain('[User]: test message');
	});

	it('formats assistant message as [Assistant]: prefix', async () => {
		await postMessages(serverUrl, {
			model: 'claude-sonnet-4.6',
			max_tokens: 100,
			messages: [
				{ role: 'user', content: 'first' },
				{ role: 'assistant', content: 'reply' },
				{ role: 'user', content: 'follow up' },
			],
		});

		expect(session.capturedPrompt).toContain('[Assistant]: reply');
	});

	it('formats tool_use content block inline', async () => {
		await postMessages(serverUrl, {
			model: 'claude-sonnet-4.6',
			max_tokens: 100,
			messages: [
				{
					role: 'assistant',
					content: [
						{
							type: 'tool_use',
							id: 'tu_1',
							name: 'bash',
							input: { command: 'ls' },
						},
					],
				},
				{ role: 'user', content: 'ok' },
			],
		});

		expect(session.capturedPrompt).toContain('[Assistant called tool bash with args:');
	});

	it('formats tool_result content block inline', async () => {
		await postMessages(serverUrl, {
			model: 'claude-sonnet-4.6',
			max_tokens: 100,
			messages: [
				{
					role: 'user',
					content: [
						{
							type: 'tool_result',
							tool_use_id: 'tu_1',
							content: 'file.txt',
						},
					],
				},
			],
		});

		expect(session.capturedPrompt).toContain('[Tool result for tu_1]: file.txt');
	});

	it('sends complete SSE epilogue on session error', async () => {
		session.shouldError = true;

		const result = await postMessages(serverUrl, {
			model: 'claude-sonnet-4.6',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'trigger error' }],
		});

		expect(result.status).toBe(200);
		const types = result.events.map((e) => e.type);
		expect(types).toContain('message_start');
		expect(types).toContain('message_stop');
	});

	it('message_start event contains correct model', async () => {
		const result = await postMessages(serverUrl, {
			model: 'claude-sonnet-4.6',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'hi' }],
		});

		const startEvent = result.events.find((e) => e.type === 'message_start');
		expect(startEvent).toBeDefined();
		const msg = (startEvent!.data as Record<string, unknown>)['message'] as Record<string, unknown>;
		expect(msg['model']).toBe('claude-sonnet-4.6');
	});

	it('extracts string system message and passes to session config', async () => {
		let capturedConfig: unknown;
		const capturingClient = makeMockClient(() => {
			return session;
		});
		spyOn(capturingClient, 'createSession').mockImplementation(async (cfg: unknown) => {
			capturedConfig = cfg;
			return session as unknown as CopilotSession;
		});

		const s2 = await startEmbeddedServer(capturingClient, '/tmp');
		try {
			await postMessages(s2.url, {
				model: 'claude-sonnet-4.6',
				max_tokens: 100,
				system: 'be concise',
				messages: [{ role: 'user', content: 'hi' }],
			});

			const cfg = capturedConfig as Record<string, unknown>;
			expect(cfg['systemMessage']).toEqual({ mode: 'replace', content: 'be concise' });
		} finally {
			await s2.stop();
		}
	});

	it('extracts text-block array system message', async () => {
		let capturedConfig: unknown;
		const capturingClient = makeMockClient(() => session);
		spyOn(capturingClient, 'createSession').mockImplementation(async (cfg: unknown) => {
			capturedConfig = cfg;
			return session as unknown as CopilotSession;
		});

		const s2 = await startEmbeddedServer(capturingClient, '/tmp');
		try {
			await postMessages(s2.url, {
				model: 'claude-sonnet-4.6',
				max_tokens: 100,
				system: [
					{ type: 'text', text: 'line one' },
					{ type: 'text', text: 'line two' },
				],
				messages: [{ role: 'user', content: 'hi' }],
			});

			const cfg = capturedConfig as Record<string, unknown>;
			expect(cfg['systemMessage']).toEqual({
				mode: 'replace',
				content: 'line one\n\nline two',
			});
		} finally {
			await s2.stop();
		}
	});
});

// ---------------------------------------------------------------------------
// Factory registration
// ---------------------------------------------------------------------------

describe('factory registration', () => {
	beforeEach(() => {
		resetProviderRegistry();
		resetProviderFactory();
	});

	it('registers CopilotAnthropicProvider with id github-copilot-anthropic', () => {
		initializeProviders();
		const registry = getProviderRegistry();
		const provider = registry.get('github-copilot-anthropic');
		expect(provider).toBeDefined();
		expect(provider?.id).toBe('github-copilot-anthropic');
	});
});
