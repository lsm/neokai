/**
 * Integration tests for the Codex Anthropic Bridge — HTTP server
 *
 * These tests spin up a real Bun HTTP server backed by a MOCK BridgeSession.
 * The mock injects pre-scripted BridgeEvents so no real `codex` binary is needed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	BridgeSession,
	AppServerConn,
} from '../../../../src/lib/providers/codex-anthropic-bridge/process-manager';
import {
	createBridgeServer,
	type BridgeServer,
} from '../../../../src/lib/providers/codex-anthropic-bridge/server';
import type { BridgeEvent } from '../../../../src/lib/providers/codex-anthropic-bridge/process-manager';
import { anthropicErrorSSELine } from '../../../../src/lib/providers/shared/error-envelope';

// ---------------------------------------------------------------------------
// Helper: parse SSE response body into an array of events
// ---------------------------------------------------------------------------

async function readSSEEvents(
	body: ReadableStream<Uint8Array> | null
): Promise<Array<{ event: string; data: unknown }>> {
	if (!body) return [];
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let raw = '';
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		raw += decoder.decode(value, { stream: true });
	}
	const events: Array<{ event: string; data: unknown }> = [];
	const blocks = raw.split('\n\n').filter((b) => b.trim());
	for (const block of blocks) {
		const lines = block.split('\n');
		const eventLine = lines.find((l) => l.startsWith('event:'));
		const dataLine = lines.find((l) => l.startsWith('data:'));
		if (eventLine && dataLine) {
			events.push({
				event: eventLine.replace('event: ', ''),
				data: JSON.parse(dataLine.replace('data: ', '')),
			});
		}
	}
	return events;
}

// ---------------------------------------------------------------------------
// Mock BridgeSession — pre-scripted events, no real subprocess
// ---------------------------------------------------------------------------

/** A simplified in-process mock of BridgeSession */
class MockBridgeSession {
	private events: BridgeEvent[];
	capturedProviders = new Map<string, (text: string) => void>();

	constructor(events: BridgeEvent[]) {
		this.events = [...events];
	}

	async initialize(): Promise<void> {}

	kill(): void {}

	async *startTurn(_text: string): AsyncGenerator<BridgeEvent> {
		for (const event of this.events) {
			if (event.type === 'tool_call') {
				const capturedProvide = event.provideResult;
				this.capturedProviders.set(event.callId, capturedProvide);
			}
			yield event;
		}
	}
}

// ---------------------------------------------------------------------------
// Mock bridge server — reimplements server logic with MockBridgeSession
// ---------------------------------------------------------------------------

let mockSessionFactory: (() => MockBridgeSession) | null = null;

/** Shared tool session map — reset in beforeEach. */
const toolSessions = new Map<
	string,
	{
		gen: AsyncGenerator<BridgeEvent>;
		session: import('../../../../src/lib/providers/codex-anthropic-bridge/process-manager').BridgeSession;
		provideResult: (text: string) => void;
		model: string;
		cleanupTimer: ReturnType<typeof setTimeout>;
	}
>();

function createMockBridgeServer(opts?: { ttlMs?: number }): BridgeServer {
	const bunServer = Bun.serve({
		port: 0,
		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url);
			if (url.pathname !== '/v1/messages' || req.method !== 'POST') {
				return new Response('Not Found', { status: 404 });
			}

			const {
				isToolResultContinuation,
				extractToolResults,
				buildConversationText,
				extractSystemText,
				buildDynamicTools,
				pingSSE,
				messageStartSSE,
				contentBlockStartTextSSE,
				contentBlockStartToolUseSSE,
				textDeltaSSE,
				inputJsonDeltaSSE,
				contentBlockStopSSE,
				messageDeltaSSE,
				messageStopSSE,
			} = await import('../../../../src/lib/providers/codex-anthropic-bridge/translator');

			const body =
				(await req.json()) as import('../../../../src/lib/providers/codex-anthropic-bridge/translator').AnthropicRequest;
			const model = body.model;

			const sseHeaders = {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			};

			const enc = new TextEncoder();
			const ttlMs = opts?.ttlMs ?? 5 * 60 * 1000;

			// Uses gen.next() manually — avoids for-await-of calling gen.return() on early exit.
			async function drainGen(
				genArg: AsyncGenerator<BridgeEvent>,
				sessionArg: MockBridgeSession | null,
				sessionModel: string,
				controller: ReadableStreamDefaultController<Uint8Array>
			): Promise<void> {
				let blockIndex = 0;
				let textOpen = false;
				let outputTokens = 0;
				while (true) {
					const { value: event, done } = await genArg.next();
					if (done) break;
					if (event.type === 'text_delta') {
						if (!textOpen) {
							controller.enqueue(enc.encode(contentBlockStartTextSSE(blockIndex)));
							textOpen = true;
						}
						controller.enqueue(enc.encode(textDeltaSSE(blockIndex, event.text)));
						outputTokens++;
					} else if (event.type === 'tool_call') {
						if (textOpen) {
							controller.enqueue(enc.encode(contentBlockStopSSE(blockIndex)));
							blockIndex++;
							textOpen = false;
						}
						controller.enqueue(
							enc.encode(contentBlockStartToolUseSSE(blockIndex, event.callId, event.toolName))
						);
						controller.enqueue(
							enc.encode(inputJsonDeltaSSE(blockIndex, JSON.stringify(event.toolInput)))
						);
						controller.enqueue(enc.encode(contentBlockStopSSE(blockIndex)));
						controller.enqueue(enc.encode(messageDeltaSSE('tool_use', outputTokens)));
						controller.enqueue(enc.encode(messageStopSSE()));
						const callId = event.callId;
						const cleanupTimer = setTimeout(() => {
							sessionArg?.kill();
							toolSessions.delete(callId);
						}, ttlMs);
						toolSessions.set(callId, {
							gen: genArg,
							session:
								sessionArg as unknown as import('../../../../src/lib/providers/codex-anthropic-bridge/process-manager').BridgeSession,
							provideResult: event.provideResult,
							model: sessionModel,
							cleanupTimer,
						});
						controller.close();
						return;
					} else if (event.type === 'turn_done') {
						if (textOpen) {
							controller.enqueue(enc.encode(contentBlockStopSSE(blockIndex)));
							textOpen = false;
						}
						controller.enqueue(enc.encode(messageDeltaSSE('end_turn', outputTokens)));
						controller.enqueue(enc.encode(messageStopSSE()));
						sessionArg?.kill();
						controller.close();
						return;
					} else if (event.type === 'error') {
						// Mirror production drainToSSE: close open text block then emit
						// Anthropic-format error SSE event (no message_stop epilogue).
						if (textOpen) {
							controller.enqueue(enc.encode(contentBlockStopSSE(blockIndex)));
							textOpen = false;
						}
						controller.enqueue(
							enc.encode(
								anthropicErrorSSELine('api_error', String(event.message) || 'Codex session error')
							)
						);
						sessionArg?.kill();
						controller.close();
						return;
					}
				}
				if (textOpen) controller.enqueue(enc.encode(contentBlockStopSSE(blockIndex)));
				controller.enqueue(enc.encode(messageDeltaSSE('end_turn', outputTokens)));
				controller.enqueue(enc.encode(messageStopSSE()));
				sessionArg?.kill();
				controller.close();
			}

			if (isToolResultContinuation(body.messages)) {
				const [tr] = extractToolResults(body.messages);
				const stored = toolSessions.get(tr.toolUseId);
				if (!stored) return new Response('Session not found', { status: 404 });
				toolSessions.delete(tr.toolUseId);
				clearTimeout(stored.cleanupTimer);
				stored.provideResult(tr.text);
				const resumeModel = stored.model; // preserve original model
				const stream = new ReadableStream<Uint8Array>({
					async start(controller) {
						controller.enqueue(enc.encode(messageStartSSE(`msg_${Date.now()}`, resumeModel, 0)));
						await drainGen(stored.gen, null, resumeModel, controller);
					},
				});
				return new Response(stream, { headers: sseHeaders });
			}

			const mock = mockSessionFactory!();
			const dynamicTools = buildDynamicTools(body.tools ?? []);
			const system = extractSystemText(body.system);
			const userText = buildConversationText(body.messages, system);
			void dynamicTools;
			const gen = mock.startTurn(userText);

			const stream = new ReadableStream<Uint8Array>({
				async start(controller) {
					controller.enqueue(enc.encode(messageStartSSE(`msg_${Date.now()}`, model, 0)));
					controller.enqueue(enc.encode(pingSSE()));
					await drainGen(gen, mock, model, controller);
				},
			});
			return new Response(stream, { headers: sseHeaders });
		},
	});

	// Return a proper BridgeServer whose stop() mirrors the production server:
	// clear TTL timers, kill suspended sessions, then stop the HTTP listener.
	return {
		port: bunServer.port,
		stop(): void {
			for (const [callId, stored] of toolSessions) {
				clearTimeout(stored.cleanupTimer);
				stored.session.kill();
				toolSessions.delete(callId);
			}
			bunServer.stop();
		},
	} as BridgeServer;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Bridge HTTP server', () => {
	let server: BridgeServer & { port: number };

	beforeEach(() => {
		toolSessions.clear();
		mockSessionFactory = null;
		server = createMockBridgeServer() as BridgeServer & { port: number };
	});

	afterEach(() => {
		server.stop();
	});

	// -------------------------------------------------------------------------
	// Plain text response
	// -------------------------------------------------------------------------

	it('streams a plain text turn as Anthropic SSE', async () => {
		mockSessionFactory = () =>
			new MockBridgeSession([
				{ type: 'text_delta', text: 'Hello ' },
				{ type: 'text_delta', text: 'world' },
				{ type: 'turn_done', inputTokens: 5, outputTokens: 10 },
			]);

		const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'codex-1',
				messages: [{ role: 'user', content: 'hello' }],
				stream: true,
			}),
		});

		expect(resp.ok).toBe(true);
		expect(resp.headers.get('content-type')).toContain('text/event-stream');

		const events = await readSSEEvents(resp.body);
		const types = events.map((e) => e.event);

		expect(types).toContain('message_start');
		expect(types).toContain('content_block_start');
		expect(types).toContain('content_block_delta');
		expect(types).toContain('content_block_stop');
		expect(types).toContain('message_delta');
		expect(types).toContain('message_stop');

		// Verify text is assembled correctly
		const deltas = events.filter((e) => e.event === 'content_block_delta');
		const text = deltas
			.map((e) => (e.data as { delta: { type: string; text?: string } }).delta)
			.filter((d) => d.type === 'text_delta')
			.map((d) => d.text ?? '')
			.join('');
		expect(text).toBe('Hello world');
	});

	// -------------------------------------------------------------------------
	// Tool use — first half
	// -------------------------------------------------------------------------

	it('emits tool_use SSE and pauses on tool_call event', async () => {
		const provideResultHolder: { fn: ((text: string) => void) | null } = { fn: null };

		mockSessionFactory = () => {
			const session = new MockBridgeSession([
				{
					type: 'tool_call',
					callId: 'call-abc',
					toolName: 'bash',
					toolInput: { command: 'ls' },
					provideResult: (text: string) => {
						provideResultHolder.fn?.(text);
					},
				},
			]);
			return session;
		};

		const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'codex-1',
				messages: [{ role: 'user', content: 'list files' }],
				tools: [
					{
						name: 'bash',
						description: 'Run shell',
						input_schema: { type: 'object', properties: { command: { type: 'string' } } },
					},
				],
				stream: true,
			}),
		});

		expect(resp.ok).toBe(true);
		const events = await readSSEEvents(resp.body);
		const types = events.map((e) => e.event);

		expect(types).toContain('content_block_start');
		expect(types).toContain('message_delta');
		expect(types).toContain('message_stop');

		// The tool_use block should have type 'tool_use'
		const blockStart = events.find((e) => e.event === 'content_block_start');
		const block = (blockStart?.data as { content_block: { type: string } })?.content_block;
		expect(block?.type).toBe('tool_use');

		// stop_reason must be 'tool_use'
		const msgDelta = events.find((e) => e.event === 'message_delta');
		const stopReason = (msgDelta?.data as { delta: { stop_reason: string } })?.delta?.stop_reason;
		expect(stopReason).toBe('tool_use');

		// Session should be stored
		expect(toolSessions.has('call-abc')).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Tool use — round-trip
	// -------------------------------------------------------------------------

	it('resumes after tool result and completes the turn', async () => {
		mockSessionFactory = () =>
			new MockBridgeSession([
				{
					type: 'tool_call',
					callId: 'call-xyz',
					toolName: 'bash',
					toolInput: { command: 'ls' },
					provideResult: (_text: string) => {
						// no-op in mock: the generator continues automatically
					},
				},
				{ type: 'text_delta', text: 'file1.ts' },
				{ type: 'turn_done', inputTokens: 10, outputTokens: 5 },
			]);

		// First request
		const resp1 = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'codex-1',
				messages: [{ role: 'user', content: 'list files' }],
				tools: [{ name: 'bash', description: 'sh', input_schema: { type: 'object' } }],
				stream: true,
			}),
		});
		await readSSEEvents(resp1.body); // drain
		expect(toolSessions.has('call-xyz')).toBe(true);

		// Second request: send tool result
		const resp2 = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'codex-1',
				messages: [
					{ role: 'user', content: 'list files' },
					{
						role: 'assistant',
						content: [{ type: 'tool_use', id: 'call-xyz', name: 'bash', input: {} }],
					},
					{
						role: 'user',
						content: [{ type: 'tool_result', tool_use_id: 'call-xyz', content: 'src/' }],
					},
				],
				stream: true,
			}),
		});

		expect(resp2.ok).toBe(true);
		const events2 = await readSSEEvents(resp2.body);
		const types2 = events2.map((e) => e.event);

		expect(types2).toContain('message_start');
		expect(types2).toContain('message_stop');

		const deltas = events2.filter((e) => e.event === 'content_block_delta');
		const text = deltas
			.map((e) => (e.data as { delta: { type: string; text?: string } }).delta)
			.filter((d) => d.type === 'text_delta')
			.map((d) => d.text ?? '')
			.join('');
		expect(text).toBe('file1.ts');
	});

	// -------------------------------------------------------------------------
	// BridgeSession error — emits Anthropic error SSE event
	// -------------------------------------------------------------------------

	it('emits Anthropic error SSE event when BridgeSession yields an error event', async () => {
		mockSessionFactory = () =>
			new MockBridgeSession([
				{ type: 'text_delta', text: 'partial' },
				{ type: 'error', message: 'boom' },
			]);

		const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'codex-1',
				messages: [{ role: 'user', content: 'fail me' }],
				stream: true,
			}),
		});

		expect(resp.ok).toBe(true);
		const events = await readSSEEvents(resp.body);
		const types = events.map((e) => e.event);

		// Must emit Anthropic error SSE event
		expect(types).toContain('error');
		// Must NOT emit message_stop after the error
		expect(types).not.toContain('message_stop');

		const errorEvent = events.find((e) => e.event === 'error');
		const data = errorEvent!.data as Record<string, unknown>;
		expect(data['type']).toBe('error');
		const err = data['error'] as Record<string, unknown>;
		expect(err['type']).toBe('api_error');
		expect(err['message']).toBe('boom');
	});

	// -------------------------------------------------------------------------
	// 404 for unknown tool_use_id
	// -------------------------------------------------------------------------

	it('returns 404 when tool_use_id has no active session', async () => {
		const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'codex-1',
				messages: [
					{
						role: 'user',
						content: [{ type: 'tool_result', tool_use_id: 'nonexistent-call', content: 'result' }],
					},
				],
				stream: true,
			}),
		});
		expect(resp.status).toBe(404);
	});

	// -------------------------------------------------------------------------
	// Model preservation across tool round-trips (regression: P1 fix)
	// -------------------------------------------------------------------------

	it('preserves the original model across tool continuation requests', async () => {
		mockSessionFactory = () =>
			new MockBridgeSession([
				{
					type: 'tool_call',
					callId: 'call-model-test',
					toolName: 'bash',
					toolInput: { command: 'echo hi' },
					provideResult: (_text: string) => {},
				},
				{ type: 'text_delta', text: 'done' },
				{ type: 'turn_done', inputTokens: 1, outputTokens: 1 },
			]);

		// First request: original-model
		const resp1 = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'original-model',
				messages: [{ role: 'user', content: 'echo' }],
				stream: true,
			}),
		});
		await readSSEEvents(resp1.body); // drain

		// Second request (tool continuation) with a DIFFERENT model name
		const resp2 = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'different-model', // must be ignored — original-model should be used
				messages: [
					{ role: 'user', content: 'echo' },
					{
						role: 'assistant',
						content: [
							{
								type: 'tool_use',
								id: 'call-model-test',
								name: 'bash',
								input: { command: 'echo hi' },
							},
						],
					},
					{
						role: 'user',
						content: [{ type: 'tool_result', tool_use_id: 'call-model-test', content: 'hi' }],
					},
				],
				stream: true,
			}),
		});

		expect(resp2.ok).toBe(true);
		const events2 = await readSSEEvents(resp2.body);

		const msgStart = events2.find((e) => e.event === 'message_start');
		const msgModel = (msgStart?.data as { message?: { model?: string } })?.message?.model;
		expect(msgModel).toBe('original-model');
	});

	// -------------------------------------------------------------------------
	// TTL cleanup — abandoned tool session kills subprocess (regression: P0 fix)
	// -------------------------------------------------------------------------

	it('TTL timer removes abandoned tool session and calls kill()', async () => {
		let killCalled = false;

		mockSessionFactory = () => {
			const sess = new MockBridgeSession([
				{
					type: 'tool_call',
					callId: 'call-ttl',
					toolName: 'bash',
					toolInput: { command: 'sleep 100' },
					provideResult: (_text: string) => {},
				},
			]);
			sess.kill = () => {
				killCalled = true;
			};
			return sess;
		};

		// Use a very short TTL (50 ms)
		const ttlServer = createMockBridgeServer({ ttlMs: 50 }) as BridgeServer & { port: number };

		try {
			const resp = await fetch(`http://127.0.0.1:${ttlServer.port}/v1/messages`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					model: 'codex-1',
					messages: [{ role: 'user', content: 'sleep' }],
					stream: true,
				}),
			});
			await readSSEEvents(resp.body); // drain first response
			expect(toolSessions.has('call-ttl')).toBe(true);

			// Wait for TTL to fire (100 ms > 50 ms TTL)
			await new Promise((res) => setTimeout(res, 120));

			expect(toolSessions.has('call-ttl')).toBe(false);
			expect(killCalled).toBe(true);
		} finally {
			ttlServer.stop();
		}
	});

	// -------------------------------------------------------------------------
	// stop() cleanup — suspended sessions killed (regression: issue #3b)
	// -------------------------------------------------------------------------

	it('stop() kills suspended tool sessions and clears their TTL timers', async () => {
		let killCalled = false;

		mockSessionFactory = () => {
			const sess = new MockBridgeSession([
				{
					type: 'tool_call',
					callId: 'call-stop-cleanup',
					toolName: 'bash',
					toolInput: { command: 'ls' },
					provideResult: (_text: string) => {},
				},
			]);
			sess.kill = () => {
				killCalled = true;
			};
			return sess;
		};

		// Send a request that suspends on a tool call
		const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'codex-1',
				messages: [{ role: 'user', content: 'ls' }],
				stream: true,
			}),
		});
		await readSSEEvents(resp.body);
		expect(toolSessions.has('call-stop-cleanup')).toBe(true);

		// stop() should clean up the suspended session immediately
		server.stop();

		expect(toolSessions.has('call-stop-cleanup')).toBe(false);
		expect(killCalled).toBe(true);

		// Prevent afterEach from calling stop() again on an already-stopped server
		// by replacing server with a no-op
		server = { port: 0, stop: () => {} } as BridgeServer & { port: number };
	});
});
