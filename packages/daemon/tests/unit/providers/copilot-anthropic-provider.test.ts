/**
 * Unit tests for CopilotAnthropicProvider and the embedded Anthropic server
 *
 * Tests cover:
 * - Provider properties (id, capabilities, ownsModel, getModelForTier)
 * - Availability checks (binary + auth)
 * - buildSdkConfig env-var shape (requires pre-warmed serverCache)
 * - Embedded server: prompt formatting, SSE streaming,
 *   error handling, system-message extraction, concurrent requests
 * - getModels() pre-warms the embedded server
 * - shutdown() stops the embedded server
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { EventEmitter } from 'node:events';
import { CopilotAnthropicProvider } from '../../../src/lib/providers/copilot-anthropic-provider';
import {
	startEmbeddedServer,
	runSessionStreaming,
} from '../../../src/lib/providers/copilot-anthropic-server';
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
	/** When true, send() rejects immediately (simulates connection failure). */
	shouldRejectSend = false;
	/** When true, send() emits one delta but never emits session.idle (hangs). */
	shouldHang = false;
	disconnectCalled = false;

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
		if (this.shouldRejectSend) {
			return Promise.reject(new Error('connection lost'));
		}
		if (this.shouldHang) {
			// Emit delta + message to flush SSE data to the client, then hang
			// (never emit session.idle) so the server keeps the stream open.
			Promise.resolve().then(() => {
				this.emit('assistant.message_delta', { deltaContent: 'Hanging...' });
				this.emit('assistant.message', {});
			});
			return 'send-result';
		}
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
	async disconnect(): Promise<void> {
		this.disconnectCalled = true;
	}
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
		/** Inject a fake server URL so buildSdkConfig doesn't throw. */
		const fakeServerUrl = 'http://127.0.0.1:54321';

		beforeEach(() => {
			(provider as unknown as Record<string, unknown>)['serverCache'] = {
				url: fakeServerUrl,
				stop: async () => {},
			};
		});

		it('throws when embedded server has not been started', () => {
			const p = new CopilotAnthropicProvider({});
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

		it('ANTHROPIC_BASE_URL uses the injected server URL with port > 0', () => {
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
			const p = new CopilotAnthropicProvider({ COPILOT_GITHUB_TOKEN: 'tok' });
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
			const p = new CopilotAnthropicProvider({ COPILOT_GITHUB_TOKEN: 'tok' });
			spyOn(p as unknown as Record<string, unknown>, 'findCopilotCli' as never).mockResolvedValue(
				'/usr/local/bin/copilot' as never
			);
			spyOn(p, 'ensureServerStarted').mockRejectedValue(new Error('port in use') as never);
			const models = await p.getModels();
			expect(models).toEqual([]);
		});

		it('returns empty array when provider is not available', async () => {
			const p = new CopilotAnthropicProvider({});
			spyOn(p as unknown as Record<string, unknown>, 'findCopilotCli' as never).mockResolvedValue(
				null as never
			);
			const models = await p.getModels();
			expect(models).toEqual([]);
		});
	});

	describe('ensureServerStarted() retry-after-failure', () => {
		it('clears serverStarting on rejection so the next call can retry', async () => {
			const p = new CopilotAnthropicProvider({ COPILOT_GITHUB_TOKEN: 'tok' });
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
			// Should not throw
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

	it('binds to a real port (port > 0)', () => {
		const parsedUrl = new URL(serverUrl);
		expect(parsedUrl.hostname).toBe('127.0.0.1');
		expect(Number(parsedUrl.port)).toBeGreaterThan(0);
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

	it('returns 413 when body exceeds 10 MB', async () => {
		// Build a JSON payload just over the 10 MB limit
		const oversized = 'x'.repeat(11 * 1024 * 1024);
		const resp = await fetch(`${serverUrl}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'claude-sonnet-4.6',
				max_tokens: 100,
				messages: [{ role: 'user', content: oversized }],
			}),
		});
		expect(resp.status).toBe(413);
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

	it('sends complete SSE epilogue when session.send() rejects', async () => {
		session.shouldRejectSend = true;

		const result = await postMessages(serverUrl, {
			model: 'claude-sonnet-4.6',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'trigger send rejection' }],
		});

		// The SSE stream was started (200) before the send rejection is discovered
		expect(result.status).toBe(200);
		const types = result.events.map((e) => e.type);
		// Must have a well-formed epilogue even when send() rejects
		expect(types).toContain('message_start');
		expect(types).toContain('message_stop');
	});

	it('calls session.disconnect() after a successful request', async () => {
		await postMessages(serverUrl, {
			model: 'claude-sonnet-4.6',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'hi' }],
		});

		// Allow the async disconnect() to complete
		await new Promise((r) => setTimeout(r, 10));
		expect(session.disconnectCalled).toBe(true);
	});

	it('calls session.disconnect() after a session error', async () => {
		session.shouldError = true;

		await postMessages(serverUrl, {
			model: 'claude-sonnet-4.6',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'trigger error' }],
		});

		await new Promise((r) => setTimeout(r, 10));
		expect(session.disconnectCalled).toBe(true);
	});

	it('calls session.disconnect() when send() rejects', async () => {
		session.shouldRejectSend = true;

		await postMessages(serverUrl, {
			model: 'claude-sonnet-4.6',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'trigger send rejection' }],
		});

		await new Promise((r) => setTimeout(r, 10));
		expect(session.disconnectCalled).toBe(true);
	});

	it('calls session.disconnect() when req emits close mid-stream (req.on close path)', async () => {
		// Bun's node:http does not propagate client-disconnect events to the
		// IncomingMessage after the request body has been consumed, so we test
		// the req.on('close') handler directly via runSessionStreaming() with a
		// mock IncomingMessage that we can emit events on.
		const hangSession = new MockCopilotSession();
		hangSession.shouldHang = true;

		// Minimal mock IncomingMessage — just needs to be an EventEmitter.
		const mockReq = new EventEmitter() as unknown as import('node:http').IncomingMessage;

		// Minimal mock ServerResponse — records writes and absorbs calls.
		const writtenChunks: string[] = [];
		const mockRes = {
			headersSent: true,
			writeHead: () => {},
			write: (chunk: string) => {
				writtenChunks.push(chunk);
				return true;
			},
			end: () => {},
		} as unknown as import('node:http').ServerResponse;

		// Start the streaming promise (doesn't await — it hangs until close fires).
		const streamPromise = runSessionStreaming(
			hangSession as unknown as CopilotSession,
			'test prompt',
			'claude-sonnet-4.6',
			mockReq,
			mockRes
		);

		// Wait for the first SSE delta to be flushed (proof that streaming started).
		await new Promise((r) => setTimeout(r, 20));
		expect(writtenChunks.some((c) => c.includes('content_block_delta'))).toBe(true);

		// Simulate client disconnect by emitting close on the mock req.
		mockReq.emit('close');

		// The stream should resolve and disconnect should be called.
		await streamPromise;
		expect(hangSession.disconnectCalled).toBe(true);
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

	it('handles concurrent requests independently (no cross-session contamination)', async () => {
		// Each concurrent request creates its own session — responses must not bleed.
		const sessions: MockCopilotSession[] = [];
		const concurrentClient = makeMockClient(() => {
			const s = new MockCopilotSession();
			sessions.push(s);
			return s;
		});

		const concurrentServer = await startEmbeddedServer(concurrentClient, '/tmp');
		try {
			const [r1, r2] = await Promise.all([
				postMessages(concurrentServer.url, {
					model: 'claude-sonnet-4.6',
					max_tokens: 100,
					messages: [{ role: 'user', content: 'request-A' }],
				}),
				postMessages(concurrentServer.url, {
					model: 'claude-sonnet-4.6',
					max_tokens: 100,
					messages: [{ role: 'user', content: 'request-B' }],
				}),
			]);

			// Both requests must succeed and carry an independent stream
			expect(r1.status).toBe(200);
			expect(r2.status).toBe(200);

			// Two separate sessions were created
			expect(sessions.length).toBe(2);

			// Each session received only its own prompt
			const prompts = sessions.map((s) => s.capturedPrompt ?? '');
			expect(prompts.some((p) => p.includes('request-A'))).toBe(true);
			expect(prompts.some((p) => p.includes('request-B'))).toBe(true);
			// Neither session captured both prompts
			expect(prompts.every((p) => !(p.includes('request-A') && p.includes('request-B')))).toBe(
				true
			);
		} finally {
			await concurrentServer.stop();
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
		const p = registry.get('github-copilot-anthropic');
		expect(p).toBeDefined();
		expect(p?.id).toBe('github-copilot-anthropic');
	});
});
