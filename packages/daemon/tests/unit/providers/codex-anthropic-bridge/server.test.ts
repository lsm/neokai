/**
 * Integration tests for the Codex Anthropic Bridge — HTTP server
 *
 * These tests spin up a real Bun HTTP server backed by a MOCK BridgeSession.
 * The mock injects pre-scripted BridgeEvents so no real `codex` binary is needed.
 *
 * Why a mock server instead of the production `createBridgeServer`?
 * `createBridgeServer` spawns a real `codex` subprocess via `AppServerConn.create()`.
 * There is no session-factory injection point in the current API, so the production
 * server cannot be exercised with a mock `BridgeSession` without starting a real process.
 * The `createMockBridgeServer` helper below reimplements the same HTTP routing + SSE
 * drain logic using `MockBridgeSession`, keeping all test coverage in-process and fast.
 * Type drift between the mock and the production server is kept in check by importing
 * the exported `ToolSession` type from `server.ts` — both share the same named type.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	createBridgeServer,
	createAnthropicError,
	drainToSSE,
	type BridgeServer,
	type ToolSession,
} from '../../../../src/lib/providers/codex-anthropic-bridge/server';
import type { BridgeEvent } from '../../../../src/lib/providers/codex-anthropic-bridge/process-manager';

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
	/** Simulates the token usage captured from thread/tokenUsage/updated. */
	private usage:
		| import('../../../../src/lib/providers/codex-anthropic-bridge/process-manager').TokenUsage
		| null = null;

	constructor(
		events: BridgeEvent[],
		opts?: {
			usage?: import('../../../../src/lib/providers/codex-anthropic-bridge/process-manager').TokenUsage;
		}
	) {
		this.events = [...events];
		this.usage = opts?.usage ?? null;
	}

	async initialize(): Promise<void> {}

	kill(): void {}

	getUsage():
		| import('../../../../src/lib/providers/codex-anthropic-bridge/process-manager').TokenUsage
		| null {
		return this.usage;
	}

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
const toolSessions = new Map<string, ToolSession>();

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
				errorSSE,
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
						// Mirror real server: prefer actual token count from getUsage(), fall back to heuristic.
						const toolUseOutputTokens = sessionArg?.getUsage()?.outputTokens ?? outputTokens;
						controller.enqueue(
							enc.encode(messageDeltaSSE('tool_use', { outputTokens: toolUseOutputTokens }))
						);
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
						// Mirror real server: prefer actual token count from turn_done, fall back to heuristic.
						const endOutputTokens = event.outputTokens > 0 ? event.outputTokens : outputTokens;
						controller.enqueue(
							enc.encode(messageDeltaSSE('end_turn', { outputTokens: endOutputTokens }))
						);
						controller.enqueue(enc.encode(messageStopSSE()));
						sessionArg?.kill();
						controller.close();
						return;
					} else if (event.type === 'error') {
						if (textOpen) {
							controller.enqueue(enc.encode(contentBlockStopSSE(blockIndex)));
							textOpen = false;
						}
						controller.enqueue(
							enc.encode(messageDeltaSSE('end_turn', { outputTokens: outputTokens }))
						);
						controller.enqueue(enc.encode(messageStopSSE()));
						sessionArg?.kill();
						controller.close();
						return;
					} else if (event.type === 'error') {
						if (textOpen) {
							controller.enqueue(enc.encode(contentBlockStopSSE(blockIndex)));
							textOpen = false;
						}
						controller.enqueue(enc.encode(errorSSE('api_error', event.message)));
						sessionArg?.kill();
						controller.close();
						return;
					}
				}
				if (textOpen) controller.enqueue(enc.encode(contentBlockStopSSE(blockIndex)));
				controller.enqueue(enc.encode(messageDeltaSSE('end_turn', { outputTokens: outputTokens })));
				controller.enqueue(enc.encode(messageStopSSE()));
				sessionArg?.kill();
				controller.close();
			}

			if (isToolResultContinuation(body.messages)) {
				const toolResults = extractToolResults(body.messages);
				// Mirror production logic: iterate all tool results, warn on unmatched
				let primaryStored: ToolSession | null = null;
				for (const tr of toolResults) {
					const stored = toolSessions.get(tr.toolUseId);
					if (!stored) {
						// warn — mirrors production logger.warn for orphaned results
						continue;
					}
					toolSessions.delete(tr.toolUseId);
					clearTimeout(stored.cleanupTimer);
					stored.provideResult(tr.text);
					if (!primaryStored) primaryStored = stored;
				}
				if (!primaryStored) return new Response('Session not found', { status: 404 });
				const resumeModel = primaryStored.model;
				const primaryGen = primaryStored.gen;
				const stream = new ReadableStream<Uint8Array>({
					async start(controller) {
						controller.enqueue(enc.encode(messageStartSSE(`msg_${Date.now()}`, resumeModel, 0)));
						await drainGen(primaryGen, null, resumeModel, controller);
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
	// Multiple tool results — all matched sessions resolved
	// -------------------------------------------------------------------------

	it('resolves all matched tool results when multiple tool_use_ids are sent', async () => {
		const resolvedIds: string[] = [];

		// The mock generator only emits one tool_call (call-multi-1) then turn_done.
		// This reflects the real Codex constraint: Codex emits one tool call at a time
		// because each item/tool/call RPC handler blocks until its result is provided.
		//
		// To test the multi-result server loop, a second ToolSession (call-multi-2)
		// is injected directly into the toolSessions map after the first HTTP request.
		// This simulates a hypothetical future scenario where the client sends two
		// tool_result blocks in a single continuation (e.g. from parallel tool calls
		// in a different upstream model). The server loop must resolve both Deferreds
		// and treat the first matched entry as the primary gen to drain.
		mockSessionFactory = () => {
			const sess = new MockBridgeSession([
				{
					type: 'tool_call',
					callId: 'call-multi-1',
					toolName: 'bash',
					toolInput: { command: 'ls' },
					provideResult: (_text: string) => {
						resolvedIds.push('call-multi-1');
					},
				},
				{ type: 'turn_done', inputTokens: 5, outputTokens: 5 },
			]);
			return sess;
		};

		// First request — suspends on call-multi-1
		const resp1 = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'codex-1',
				messages: [{ role: 'user', content: 'run' }],
				stream: true,
			}),
		});
		await readSSEEvents(resp1.body);
		expect(toolSessions.has('call-multi-1')).toBe(true);

		// Inject a second ToolSession sharing the same gen, representing a hypothetical
		// parallel tool call from the same turn (see comment above for rationale).
		const secondResolved: string[] = [];
		const stored1 = toolSessions.get('call-multi-1')!;
		toolSessions.set('call-multi-2', {
			gen: stored1.gen,
			session: stored1.session,
			provideResult: (_text: string) => {
				secondResolved.push('call-multi-2');
			},
			model: stored1.model,
			cleanupTimer: setTimeout(() => {}, 60_000),
		});

		// Send a continuation with BOTH tool results
		const resp2 = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'codex-1',
				messages: [
					{ role: 'user', content: 'run' },
					{
						role: 'assistant',
						content: [
							{ type: 'tool_use', id: 'call-multi-1', name: 'bash', input: {} },
							{ type: 'tool_use', id: 'call-multi-2', name: 'bash', input: {} },
						],
					},
					{
						role: 'user',
						content: [
							{ type: 'tool_result', tool_use_id: 'call-multi-1', content: 'result-1' },
							{ type: 'tool_result', tool_use_id: 'call-multi-2', content: 'result-2' },
						],
					},
				],
				stream: true,
			}),
		});

		expect(resp2.ok).toBe(true);
		await readSSEEvents(resp2.body);

		// Both provideResult callbacks must have been called
		expect(resolvedIds).toContain('call-multi-1');
		expect(secondResolved).toContain('call-multi-2');

		// Both sessions must be removed from the map
		expect(toolSessions.has('call-multi-1')).toBe(false);
		expect(toolSessions.has('call-multi-2')).toBe(false);
	});

	// -------------------------------------------------------------------------
	// Multiple tool results — some unmatched (orphaned) — warn, not crash
	// -------------------------------------------------------------------------

	it('warns on unmatched tool_use_ids and still resumes the matched session', async () => {
		const resolvedIds: string[] = [];

		mockSessionFactory = () =>
			new MockBridgeSession([
				{
					type: 'tool_call',
					callId: 'call-orphan-match',
					toolName: 'bash',
					toolInput: { command: 'pwd' },
					provideResult: (_text: string) => {
						resolvedIds.push('call-orphan-match');
					},
				},
				{ type: 'text_delta', text: 'resumed' },
				{ type: 'turn_done', inputTokens: 1, outputTokens: 1 },
			]);

		// First request — suspends on call-orphan-match
		const resp1 = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'codex-1',
				messages: [{ role: 'user', content: 'pwd' }],
				stream: true,
			}),
		});
		await readSSEEvents(resp1.body);
		expect(toolSessions.has('call-orphan-match')).toBe(true);

		// Send continuation with the real call-id AND a nonexistent call-id
		const resp2 = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'codex-1',
				messages: [
					{ role: 'user', content: 'pwd' },
					{
						role: 'assistant',
						content: [
							{ type: 'tool_use', id: 'call-orphan-match', name: 'bash', input: {} },
							{ type: 'tool_use', id: 'call-orphan-no-session', name: 'bash', input: {} },
						],
					},
					{
						role: 'user',
						content: [
							{ type: 'tool_result', tool_use_id: 'call-orphan-match', content: 'dir' },
							{ type: 'tool_result', tool_use_id: 'call-orphan-no-session', content: 'dir' },
						],
					},
				],
				stream: true,
			}),
		});

		// Must succeed (not 404) — the matched session is resumed normally
		expect(resp2.ok).toBe(true);
		const events2 = await readSSEEvents(resp2.body);

		// The matched session resolved its Deferred
		expect(resolvedIds).toContain('call-orphan-match');

		// Resumed turn text should appear
		const text = events2
			.filter((e) => e.event === 'content_block_delta')
			.map((e) => (e.data as { delta: { type: string; text?: string } }).delta)
			.filter((d) => d.type === 'text_delta')
			.map((d) => d.text ?? '')
			.join('');
		expect(text).toBe('resumed');
	});

	// -------------------------------------------------------------------------
	// Multiple tool results — ALL unmatched — 404
	// -------------------------------------------------------------------------

	it('returns 404 when all tool_use_ids in the continuation are unmatched', async () => {
		const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'codex-1',
				messages: [
					{ role: 'user', content: 'x' },
					{
						role: 'assistant',
						content: [{ type: 'tool_use', id: 'bad-id-1', name: 'bash', input: {} }],
					},
					{
						role: 'user',
						content: [
							{ type: 'tool_result', tool_use_id: 'bad-id-1', content: 'r1' },
							{ type: 'tool_result', tool_use_id: 'bad-id-2', content: 'r2' },
						],
					},
				],
				stream: true,
			}),
		});
		expect(resp.status).toBe(404);
	});

	// -------------------------------------------------------------------------
	// Streaming error — drainToSSE emits Anthropic error SSE event (tests real code path)
	// -------------------------------------------------------------------------

	it('drainToSSE emits an Anthropic error SSE event on BridgeSession error', async () => {
		async function* errorGen(): AsyncGenerator<BridgeEvent> {
			yield { type: 'text_delta', text: 'partial' };
			yield { type: 'error', message: 'codex subprocess crashed' };
		}

		let killCalled = false;
		const mockSession = {
			kill: () => {
				killCalled = true;
			},
		} as unknown as import('../../../../src/lib/providers/codex-anthropic-bridge/process-manager').BridgeSession;

		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				void drainToSSE(errorGen(), mockSession, 'test-model', new Map(), controller, 5000);
			},
		});

		const events = await readSSEEvents(stream);

		// Must have exactly one error SSE event
		const errorEvents = events.filter((e) => e.event === 'error');
		expect(errorEvents).toHaveLength(1);
		const data = errorEvents[0].data as { type: string; error: { type: string; message: string } };
		expect(data.type).toBe('error');
		expect(data.error.type).toBe('api_error');
		expect(data.error.message).toBe('codex subprocess crashed');

		// Must NOT contain [Codex error: ...] plain-text blocks
		const textDeltas = events.filter((e) => e.event === 'content_block_delta');
		const hasLegacyErrorText = textDeltas.some((e) =>
			String((e.data as { delta?: { text?: string } }).delta?.text ?? '').includes('[Codex error:')
		);
		expect(hasLegacyErrorText).toBe(false);

		// Session must be killed
		expect(killCalled).toBe(true);
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

	// -------------------------------------------------------------------------
	// Token usage wiring — actual counts from turn_done
	// -------------------------------------------------------------------------

	it('message_delta uses actual outputTokens from turn_done when > 0', async () => {
		// Simulate v2 protocol: thread/tokenUsage/updated populated turn_done with real counts
		mockSessionFactory = () =>
			new MockBridgeSession(
				[
					{ type: 'text_delta', text: 'Hi' },
					{ type: 'turn_done', inputTokens: 120, outputTokens: 55 },
				],
				{ usage: { inputTokens: 120, outputTokens: 55 } }
			);

		const resp = await fetch(`http://127.0.0.1:${server.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'codex-1',
				messages: [{ role: 'user', content: 'hi' }],
				stream: true,
			}),
		});

		expect(resp.ok).toBe(true);
		const events = await readSSEEvents(resp.body);

		const msgDelta = events.find((e) => e.event === 'message_delta');
		expect(msgDelta).toBeDefined();
		const usageOutputTokens = (msgDelta?.data as { usage?: { output_tokens?: number } })?.usage
			?.output_tokens;
		// Should use actual count (55), not heuristic (which would be 1 for "Hi")
		expect(usageOutputTokens).toBe(55);
	});

	it('message_delta falls back to heuristic outputTokens when turn_done has 0 tokens', async () => {
		// Simulate no thread/tokenUsage/updated notification — turn_done carries 0 tokens
		mockSessionFactory = () =>
			new MockBridgeSession([
				{ type: 'text_delta', text: 'Hello' },
				{ type: 'text_delta', text: ' world' },
				{ type: 'turn_done', inputTokens: 0, outputTokens: 0 },
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
		const events = await readSSEEvents(resp.body);

		const msgDelta = events.find((e) => e.event === 'message_delta');
		expect(msgDelta).toBeDefined();
		const usageOutputTokens = (msgDelta?.data as { usage?: { output_tokens?: number } })?.usage
			?.output_tokens;
		// Should fall back to heuristic (2 text_delta events → 2 token count in mock)
		expect(usageOutputTokens).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// createAnthropicError helper unit tests
// ---------------------------------------------------------------------------

describe('createAnthropicError', () => {
	it('returns the correct HTTP status and JSON envelope for 400', async () => {
		const resp = createAnthropicError(400, 'invalid_request_error', 'bad input');
		expect(resp.status).toBe(400);
		expect(resp.headers.get('content-type')).toContain('application/json');
		const body = (await resp.json()) as { type: string; error: { type: string; message: string } };
		expect(body.type).toBe('error');
		expect(body.error.type).toBe('invalid_request_error');
		expect(body.error.message).toBe('bad input');
	});

	it('returns the correct HTTP status and JSON envelope for 404', async () => {
		const resp = createAnthropicError(404, 'not_found_error', 'not here');
		expect(resp.status).toBe(404);
		const body = (await resp.json()) as { type: string; error: { type: string; message: string } };
		expect(body.type).toBe('error');
		expect(body.error.type).toBe('not_found_error');
		expect(body.error.message).toBe('not here');
	});

	it('returns the correct HTTP status and JSON envelope for 500', async () => {
		const resp = createAnthropicError(500, 'api_error', 'something exploded');
		expect(resp.status).toBe(500);
		const body = (await resp.json()) as { type: string; error: { type: string; message: string } };
		expect(body.type).toBe('error');
		expect(body.error.type).toBe('api_error');
		expect(body.error.message).toBe('something exploded');
	});
});

// ---------------------------------------------------------------------------
// Real createBridgeServer — HTTP error envelope integration tests
// ---------------------------------------------------------------------------

describe('Bridge HTTP server — Anthropic JSON error envelopes', () => {
	let realServer: BridgeServer & { port: number };

	beforeEach(() => {
		// Use a nonexistent binary path; these tests only exercise paths that
		// don't require a real Codex subprocess.
		realServer = createBridgeServer({
			codexBinaryPath: '/nonexistent/codex',
			cwd: '/tmp',
		}) as BridgeServer & { port: number };
	});

	afterEach(() => {
		realServer.stop();
	});

	it('returns 404 JSON envelope for unknown URL paths', async () => {
		const resp = await fetch(`http://127.0.0.1:${realServer.port}/unknown/path`, {
			method: 'GET',
		});
		expect(resp.status).toBe(404);
		expect(resp.headers.get('content-type')).toContain('application/json');
		const body = (await resp.json()) as { type: string; error: { type: string; message: string } };
		expect(body.type).toBe('error');
		expect(body.error.type).toBe('not_found_error');
	});

	it('returns 400 JSON envelope for invalid JSON body', async () => {
		const resp = await fetch(`http://127.0.0.1:${realServer.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: 'this is not json{{{',
		});
		expect(resp.status).toBe(400);
		expect(resp.headers.get('content-type')).toContain('application/json');
		const body = (await resp.json()) as { type: string; error: { type: string; message: string } };
		expect(body.type).toBe('error');
		expect(body.error.type).toBe('invalid_request_error');
	});

	it('returns 404 JSON envelope when tool_use_id has no active session', async () => {
		const resp = await fetch(`http://127.0.0.1:${realServer.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'codex-1',
				messages: [
					{
						role: 'user',
						content: [{ type: 'tool_result', tool_use_id: 'nonexistent-id', content: 'result' }],
					},
				],
			}),
		});
		expect(resp.status).toBe(404);
		expect(resp.headers.get('content-type')).toContain('application/json');
		const body = (await resp.json()) as { type: string; error: { type: string; message: string } };
		expect(body.type).toBe('error');
		expect(body.error.type).toBe('not_found_error');
	});

	it('returns 500 JSON envelope when BridgeSession fails to initialize', async () => {
		const resp = await fetch(`http://127.0.0.1:${realServer.port}/v1/messages`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				model: 'codex-1',
				messages: [{ role: 'user', content: 'hello' }],
				stream: true,
			}),
		});
		expect(resp.status).toBe(500);
		expect(resp.headers.get('content-type')).toContain('application/json');
		const body = (await resp.json()) as { type: string; error: { type: string; message: string } };
		expect(body.type).toBe('error');
		expect(body.error.type).toBe('api_error');
	});
});
