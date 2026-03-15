/**
 * Integration tests for the embedded Anthropic HTTP server.
 *
 * Tests cover:
 *  - Basic HTTP routing (health, 404, 400/413 errors)
 *  - SSE streaming (event sequence, text deltas, system message)
 *  - Session lifecycle (disconnect after success/error/send-rejection)
 *  - Client disconnect (req.on close path via runSessionStreaming mock)
 *  - Tool-use bridge (tool_use SSE block emitted, tool_result routed back)
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { CopilotClient, CopilotSession } from '@github/copilot-sdk';
import {
	startEmbeddedServer,
	runSessionStreaming,
} from '../../../../src/lib/providers/copilot-anthropic/index';
import { initializeProviders, resetProviderFactory } from '../../../../src/lib/providers/factory';
import { getProviderRegistry, resetProviderRegistry } from '../../../../src/lib/providers/registry';

// ---------------------------------------------------------------------------
// Mock CopilotSession
// ---------------------------------------------------------------------------

type AnyHandler = (event: { type: string; data: Record<string, unknown> }) => void;

class MockCopilotSession {
	readonly sessionId = 'mock-session';
	private subs: AnyHandler[] = [];
	capturedPrompt: string | undefined = undefined;
	capturedConfig: unknown = undefined;
	shouldError = false;
	shouldRejectSend = false;
	shouldHang = false;
	disconnectCalled = false;
	abortCalled = false;

	/** Tool handler registered via SessionConfig.tools (for tool-use tests). */
	registeredTools: Array<{ name: string; handler: (...a: unknown[]) => unknown }> = [];

	on(handler: AnyHandler): () => void {
		this.subs.push(handler);
		return () => {
			this.subs = this.subs.filter((h) => h !== handler);
		};
	}

	emit(type: string, data: Record<string, unknown> = {}): void {
		for (const h of [...this.subs]) h({ type, data });
	}

	async send(opts: { prompt: string }): Promise<string> {
		this.capturedPrompt = opts.prompt;
		if (this.shouldRejectSend) throw new Error('connection lost');
		if (this.shouldHang) {
			Promise.resolve().then(() => {
				this.emit('assistant.message_delta', { deltaContent: 'Hanging...' });
				this.emit('assistant.message', {});
			});
			return 'send-result';
		}
		if (this.shouldError) {
			Promise.resolve().then(() =>
				this.emit('session.error', { message: 'mock error', errorType: 'internal' })
			);
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

	async abort(): Promise<void> {
		this.abortCalled = true;
	}
	async disconnect(): Promise<void> {
		this.disconnectCalled = true;
	}
}

// ---------------------------------------------------------------------------
// Mock CopilotClient
// ---------------------------------------------------------------------------

function makeMockClient(
	factory?: () => MockCopilotSession
): CopilotClient & { lastSession?: MockCopilotSession } {
	const mock = {
		lastSession: undefined as MockCopilotSession | undefined,
		async createSession(cfg: unknown): Promise<CopilotSession> {
			const s = factory ? factory() : new MockCopilotSession();
			s.capturedConfig = cfg;
			// Register tools from config
			const tools = (cfg as Record<string, unknown>)?.['tools'] as
				| Array<{ name: string; handler: (...a: unknown[]) => unknown }>
				| undefined;
			if (tools) s.registeredTools = tools;
			mock.lastSession = s;
			return s as unknown as CopilotSession;
		},
	};
	return mock as unknown as CopilotClient & { lastSession?: MockCopilotSession };
}

// ---------------------------------------------------------------------------
// HTTP helper
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
	let currentType = '';
	for (const line of text.split('\n')) {
		if (line.startsWith('event: ')) {
			currentType = line.slice(7).trim();
		} else if (line.startsWith('data: ')) {
			try {
				events.push({ type: currentType, data: JSON.parse(line.slice(6)) });
			} catch {
				events.push({ type: currentType, data: line.slice(6) });
			}
			currentType = '';
		}
	}
	return { status: resp.status, events };
}

// ---------------------------------------------------------------------------
// startEmbeddedServer — integration tests
// ---------------------------------------------------------------------------

describe('startEmbeddedServer', () => {
	let session: MockCopilotSession;
	let client: CopilotClient & { lastSession?: MockCopilotSession };
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

	// -------------------------------------------------------------------------
	// Routing
	// -------------------------------------------------------------------------

	it('binds to a real port (> 0)', () => {
		expect(Number(new URL(serverUrl).port)).toBeGreaterThan(0);
	});

	it('health endpoint returns ok', async () => {
		const resp = await fetch(`${serverUrl}/health`);
		expect(resp.status).toBe(200);
		expect(((await resp.json()) as Record<string, unknown>)['ok']).toBe(true);
	});

	it('returns 404 for unknown paths', async () => {
		expect((await fetch(`${serverUrl}/unknown`)).status).toBe(404);
	});

	it('returns 400 for missing required fields', async () => {
		const r = await postMessages(serverUrl, { model: 'x' });
		expect(r.status).toBe(400);
	});

	it('returns 400 for stream=false', async () => {
		const r = await postMessages(serverUrl, {
			model: 'x',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'hi' }],
			stream: false,
		});
		expect(r.status).toBe(400);
	});

	it('returns 413 when body exceeds 10 MB', async () => {
		const resp = await fetch(`${serverUrl}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'x',
				max_tokens: 100,
				messages: [{ role: 'user', content: 'x'.repeat(11 * 1024 * 1024) }],
			}),
		});
		expect(resp.status).toBe(413);
	});

	// -------------------------------------------------------------------------
	// SSE streaming
	// -------------------------------------------------------------------------

	it('streams complete SSE event sequence', async () => {
		const r = await postMessages(serverUrl, {
			model: 'claude-sonnet-4.6',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'hello' }],
		});
		expect(r.status).toBe(200);
		const types = r.events.map((e) => e.type);
		expect(types).toContain('message_start');
		expect(types).toContain('content_block_start');
		expect(types).toContain('content_block_delta');
		expect(types).toContain('content_block_stop');
		expect(types).toContain('message_delta');
		expect(types).toContain('message_stop');
	});

	it('streams concatenated text', async () => {
		const r = await postMessages(serverUrl, {
			model: 'claude-sonnet-4.6',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'hello' }],
		});
		const texts = r.events
			.filter((e) => e.type === 'content_block_delta')
			.map(
				(e) =>
					((e.data as Record<string, unknown>)['delta'] as Record<string, unknown>)[
						'text'
					] as string
			);
		expect(texts.join('')).toBe('Hello world');
	});

	it('formats user message with [User]: prefix', async () => {
		await postMessages(serverUrl, {
			model: 'claude-sonnet-4.6',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'test' }],
		});
		expect(session.capturedPrompt).toContain('[User]: test');
	});

	it('formats assistant message with [Assistant]: prefix', async () => {
		await postMessages(serverUrl, {
			model: 'claude-sonnet-4.6',
			max_tokens: 100,
			messages: [
				{ role: 'user', content: 'first' },
				{ role: 'assistant', content: 'reply' },
				{ role: 'user', content: 'next' },
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
					content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } }],
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
					content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file.txt' }],
				},
			],
		});
		expect(session.capturedPrompt).toContain('[Tool result for tu_1]: file.txt');
	});

	it('message_start contains correct model id', async () => {
		const r = await postMessages(serverUrl, {
			model: 'claude-sonnet-4.6',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'hi' }],
		});
		const start = r.events.find((e) => e.type === 'message_start');
		const msg = (start!.data as Record<string, unknown>)['message'] as Record<string, unknown>;
		expect(msg['model']).toBe('claude-sonnet-4.6');
	});

	it('extracts string system message and passes to session config', async () => {
		let captured: unknown;
		const cap = makeMockClient(() => session);
		spyOn(cap, 'createSession').mockImplementation(async (cfg: unknown) => {
			captured = cfg;
			return session as unknown as CopilotSession;
		});
		const s2 = await startEmbeddedServer(cap, '/tmp');
		try {
			await postMessages(s2.url, {
				model: 'x',
				max_tokens: 100,
				system: 'be concise',
				messages: [{ role: 'user', content: 'hi' }],
			});
			expect((captured as Record<string, unknown>)['systemMessage']).toEqual({
				mode: 'replace',
				content: 'be concise',
			});
		} finally {
			await s2.stop();
		}
	});

	it('extracts text-block array system message', async () => {
		let captured: unknown;
		const cap = makeMockClient(() => session);
		spyOn(cap, 'createSession').mockImplementation(async (cfg: unknown) => {
			captured = cfg;
			return session as unknown as CopilotSession;
		});
		const s2 = await startEmbeddedServer(cap, '/tmp');
		try {
			await postMessages(s2.url, {
				model: 'x',
				max_tokens: 100,
				system: [
					{ type: 'text', text: 'line one' },
					{ type: 'text', text: 'line two' },
				],
				messages: [{ role: 'user', content: 'hi' }],
			});
			expect((captured as Record<string, unknown>)['systemMessage']).toEqual({
				mode: 'replace',
				content: 'line one\n\nline two',
			});
		} finally {
			await s2.stop();
		}
	});

	// -------------------------------------------------------------------------
	// Error paths
	// -------------------------------------------------------------------------

	it('sends complete SSE epilogue on session error', async () => {
		session.shouldError = true;
		const r = await postMessages(serverUrl, {
			model: 'x',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'err' }],
		});
		expect(r.status).toBe(200);
		expect(r.events.map((e) => e.type)).toContain('message_stop');
	});

	it('sends complete SSE epilogue when session.send() rejects', async () => {
		session.shouldRejectSend = true;
		const r = await postMessages(serverUrl, {
			model: 'x',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'err' }],
		});
		expect(r.status).toBe(200);
		expect(r.events.map((e) => e.type)).toContain('message_stop');
	});

	// -------------------------------------------------------------------------
	// Session lifecycle
	// -------------------------------------------------------------------------

	it('calls session.disconnect() after successful request', async () => {
		await postMessages(serverUrl, {
			model: 'x',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'hi' }],
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(session.disconnectCalled).toBe(true);
	});

	it('calls session.disconnect() after session error', async () => {
		session.shouldError = true;
		await postMessages(serverUrl, {
			model: 'x',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'err' }],
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(session.disconnectCalled).toBe(true);
	});

	it('calls session.disconnect() when send() rejects', async () => {
		session.shouldRejectSend = true;
		await postMessages(serverUrl, {
			model: 'x',
			max_tokens: 100,
			messages: [{ role: 'user', content: 'err' }],
		});
		await new Promise((r) => setTimeout(r, 10));
		expect(session.disconnectCalled).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Client disconnect (req.on close path — tested directly via mock)
	// -------------------------------------------------------------------------

	it('calls session.disconnect() when req emits close mid-stream', async () => {
		const hangSession = new MockCopilotSession();
		hangSession.shouldHang = true;

		const mockReq = new EventEmitter() as unknown as import('node:http').IncomingMessage;
		const written: string[] = [];
		const mockRes = {
			headersSent: true,
			writeHead: () => {},
			write: (c: string) => {
				written.push(c);
				return true;
			},
			end: () => {},
		} as unknown as import('node:http').ServerResponse;

		const streamPromise = runSessionStreaming(
			hangSession as unknown as CopilotSession,
			'test',
			'claude-sonnet-4.6',
			mockReq,
			mockRes
		);

		await new Promise((r) => setTimeout(r, 20));
		expect(written.some((c) => c.includes('content_block_delta'))).toBe(true);

		mockReq.emit('close');
		await streamPromise;
		expect(hangSession.disconnectCalled).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Concurrent requests
	// -------------------------------------------------------------------------

	it('handles concurrent requests independently', async () => {
		const sessions: MockCopilotSession[] = [];
		const cc = makeMockClient(() => {
			const s = new MockCopilotSession();
			sessions.push(s);
			return s;
		});
		const cs = await startEmbeddedServer(cc, '/tmp');
		try {
			const [r1, r2] = await Promise.all([
				postMessages(cs.url, {
					model: 'x',
					max_tokens: 100,
					messages: [{ role: 'user', content: 'A' }],
				}),
				postMessages(cs.url, {
					model: 'x',
					max_tokens: 100,
					messages: [{ role: 'user', content: 'B' }],
				}),
			]);
			expect(r1.status).toBe(200);
			expect(r2.status).toBe(200);
			expect(sessions.length).toBe(2);
			const prompts = sessions.map((s) => s.capturedPrompt ?? '');
			expect(prompts.some((p) => p.includes('A'))).toBe(true);
			expect(prompts.some((p) => p.includes('B'))).toBe(true);
		} finally {
			await cs.stop();
		}
	});

	// -------------------------------------------------------------------------
	// Tool-use: SSE emits tool_use block when request has tools
	// -------------------------------------------------------------------------

	// Helper: wait until session has at least one registered tool
	async function waitForTools(s: MockCopilotSession): Promise<void> {
		await new Promise<void>((resolve) => {
			const id = setInterval(() => {
				if (s.registeredTools.length > 0) {
					clearInterval(id);
					resolve();
				}
			}, 5);
		});
	}

	it('emits tool_use SSE block when model calls a registered tool', async () => {
		// Create a session that simulates a tool call via external_tool.requested
		// when tools are registered in SessionConfig.
		let toolHandler: ((args: unknown, inv: unknown) => unknown) | undefined;
		const toolSession = new MockCopilotSession();

		const toolClient = makeMockClient(() => toolSession);
		spyOn(toolClient, 'createSession').mockImplementation(async (cfg: unknown) => {
			toolSession.capturedConfig = cfg;
			// Capture the tool handler
			const tools = (cfg as Record<string, unknown>)?.['tools'] as
				| Array<{ name: string; handler: (args: unknown, inv: unknown) => unknown }>
				| undefined;
			if (tools?.[0]) toolHandler = tools[0].handler;
			return toolSession as unknown as CopilotSession;
		});

		// Override send() to simulate the model calling our registered tool
		const originalSend = toolSession.send.bind(toolSession);
		toolSession.send = async function (opts) {
			this.capturedPrompt = opts.prompt;
			Promise.resolve().then(async () => {
				// Simulate external_tool.requested: call the tool handler
				if (toolHandler) {
					// The handler suspends waiting for tool_result.
					// Suppress rejection (e.g. when server shuts down without a result).
					toolHandler(
						{ command: 'ls' },
						{
							sessionId: 's1',
							toolCallId: 'tc_test',
							toolName: 'bash',
							arguments: { command: 'ls' },
						}
					).catch(() => {});
				}
			});
			return 'send-result';
		};

		const ts = await startEmbeddedServer(toolClient, '/tmp');
		try {
			const requestBody = {
				model: 'claude-sonnet-4.6',
				max_tokens: 100,
				messages: [{ role: 'user', content: 'run ls' }],
				tools: [{ name: 'bash', description: 'Run bash', input_schema: { type: 'object' } }],
			};

			// The response should contain a tool_use SSE block.
			const r = await postMessages(ts.url, requestBody);
			expect(r.status).toBe(200);

			const types = r.events.map((e) => e.type);
			expect(types).toContain('message_start');
			// Must end with tool_use stop reason
			const msgDelta = r.events.find((e) => e.type === 'message_delta');
			expect(msgDelta).toBeDefined();
			const stopReason = (
				(msgDelta!.data as Record<string, unknown>)['delta'] as Record<string, unknown>
			)['stop_reason'];
			expect(stopReason).toBe('tool_use');

			// tool_use content block
			const toolUseStart = r.events.find(
				(e) =>
					e.type === 'content_block_start' &&
					((e.data as Record<string, unknown>)['content_block'] as Record<string, unknown>)?.[
						'type'
					] === 'tool_use'
			);
			expect(toolUseStart).toBeDefined();
			const cb = (toolUseStart!.data as Record<string, unknown>)['content_block'] as Record<
				string,
				unknown
			>;
			expect(cb['name']).toBe('bash');
			expect(cb['id']).toBe('tc_test');
		} finally {
			await ts.stop();
		}
	});

	it('routes tool_result continuation to suspended session (round-trip)', async () => {
		let toolHandler: ((args: unknown, inv: unknown) => Promise<unknown>) | undefined;
		const toolSession = new MockCopilotSession();
		const toolClient = makeMockClient(() => toolSession);

		spyOn(toolClient, 'createSession').mockImplementation(async (cfg: unknown) => {
			toolSession.capturedConfig = cfg;
			const tools = (cfg as Record<string, unknown>)?.['tools'] as
				| Array<{ name: string; handler: (args: unknown, inv: unknown) => Promise<unknown> }>
				| undefined;
			if (tools?.[0]) toolHandler = tools[0].handler;
			return toolSession as unknown as CopilotSession;
		});

		// send() simulates the model calling the tool then hanging (no session.idle).
		toolSession.send = async function (opts) {
			this.capturedPrompt = opts.prompt;
			Promise.resolve().then(async () => {
				if (toolHandler) {
					// Kick off the tool handler.  It suspends until resolveToolResult is
					// called.  After it resolves, emit session.idle to complete the turn.
					// Suppress rejection for the case where server shuts down first.
					toolHandler(
						{ command: 'ls' },
						{
							sessionId: 's1',
							toolCallId: 'tc_round',
							toolName: 'bash',
							arguments: { command: 'ls' },
						}
					)
						.then(() => {
							toolSession.emit('assistant.message_delta', { deltaContent: 'Done.' });
							toolSession.emit('assistant.message', { content: 'Done.' });
							toolSession.emit('session.idle', {});
						})
						.catch(() => {});
				}
			});
			return 'send-result';
		};

		const ts = await startEmbeddedServer(toolClient, '/tmp');
		try {
			const toolsDef = [
				{ name: 'bash', description: 'Run bash', input_schema: { type: 'object' } },
			];

			// --- Request 1: model calls tool → tool_use response ---
			const r1 = await postMessages(ts.url, {
				model: 'x',
				max_tokens: 100,
				messages: [{ role: 'user', content: 'run ls' }],
				tools: toolsDef,
			});

			expect(r1.status).toBe(200);
			const toolUseStart = r1.events.find(
				(e) =>
					e.type === 'content_block_start' &&
					((e.data as Record<string, unknown>)['content_block'] as Record<string, unknown>)?.[
						'type'
					] === 'tool_use'
			);
			expect(toolUseStart).toBeDefined();
			const toolCallId = (
				(toolUseStart!.data as Record<string, unknown>)['content_block'] as Record<string, unknown>
			)['id'] as string;
			expect(toolCallId).toBe('tc_round');

			// stop_reason must be tool_use
			const msgDelta1 = r1.events.find((e) => e.type === 'message_delta');
			expect(
				((msgDelta1!.data as Record<string, unknown>)['delta'] as Record<string, unknown>)[
					'stop_reason'
				]
			).toBe('tool_use');

			// --- Request 2: tool_result continuation → end_turn response ---
			const r2 = await postMessages(ts.url, {
				model: 'x',
				max_tokens: 100,
				// Note: tools omitted to verify routing works without re-sending tools array.
				messages: [
					{ role: 'user', content: 'run ls' },
					{
						role: 'assistant',
						content: [{ type: 'tool_use', id: toolCallId, name: 'bash', input: { command: 'ls' } }],
					},
					{
						role: 'user',
						content: [{ type: 'tool_result', tool_use_id: toolCallId, content: 'file.txt\ndir/' }],
					},
				],
			});

			expect(r2.status).toBe(200);
			// Second response should have end_turn (continuation resumed and completed)
			const msgDelta2 = r2.events.find((e) => e.type === 'message_delta');
			expect(msgDelta2).toBeDefined();
			expect(
				((msgDelta2!.data as Record<string, unknown>)['delta'] as Record<string, unknown>)[
					'stop_reason'
				]
			).toBe('end_turn');
		} finally {
			await ts.stop();
		}
	});

	it('routes tool_result continuation even when tools array is omitted from follow-up', async () => {
		// Verifies P1/3 fix: hasToolResults check must not require hasTools=true.
		let toolHandler: ((args: unknown, inv: unknown) => Promise<unknown>) | undefined;
		const ts2Session = new MockCopilotSession();
		const ts2Client = makeMockClient(() => ts2Session);

		spyOn(ts2Client, 'createSession').mockImplementation(async (cfg: unknown) => {
			ts2Session.capturedConfig = cfg;
			const tools = (cfg as Record<string, unknown>)?.['tools'] as
				| Array<{ name: string; handler: (args: unknown, inv: unknown) => Promise<unknown> }>
				| undefined;
			if (tools?.[0]) toolHandler = tools[0].handler;
			return ts2Session as unknown as CopilotSession;
		});

		ts2Session.send = async function (opts) {
			this.capturedPrompt = opts.prompt;
			Promise.resolve().then(() => {
				if (toolHandler) {
					toolHandler(
						{ q: 1 },
						{
							sessionId: 's2',
							toolCallId: 'tc_notools',
							toolName: 'read',
							arguments: { q: 1 },
						}
					)
						.then(() => {
							ts2Session.emit('session.idle', {});
						})
						.catch(() => {});
				}
			});
			return 'send-result';
		};

		const ts2 = await startEmbeddedServer(ts2Client, '/tmp');
		try {
			// First request with tools
			const r1 = await postMessages(ts2.url, {
				model: 'x',
				max_tokens: 100,
				messages: [{ role: 'user', content: 'q' }],
				tools: [{ name: 'read', description: 'read file', input_schema: {} }],
			});
			expect(r1.status).toBe(200);
			const delta1 = r1.events.find((e) => e.type === 'message_delta');
			expect(
				((delta1!.data as Record<string, unknown>)['delta'] as Record<string, unknown>)[
					'stop_reason'
				]
			).toBe('tool_use');

			// Second request WITHOUT tools array — must still route to suspended session
			const r2 = await postMessages(ts2.url, {
				model: 'x',
				max_tokens: 100,
				// tools intentionally omitted
				messages: [
					{ role: 'user', content: 'q' },
					{
						role: 'assistant',
						content: [{ type: 'tool_use', id: 'tc_notools', name: 'read', input: { q: 1 } }],
					},
					{
						role: 'user',
						content: [{ type: 'tool_result', tool_use_id: 'tc_notools', content: 'ok' }],
					},
				],
			});

			expect(r2.status).toBe(200);
			const delta2 = r2.events.find((e) => e.type === 'message_delta');
			expect(
				((delta2!.data as Record<string, unknown>)['delta'] as Record<string, unknown>)[
					'stop_reason'
				]
			).toBe('end_turn');
		} finally {
			await ts2.stop();
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
