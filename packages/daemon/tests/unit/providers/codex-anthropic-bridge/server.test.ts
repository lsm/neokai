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
// Inject a scripted event sequence into the bridge via mock
// ---------------------------------------------------------------------------

type ScriptedSession = {
	events: BridgeEvent[];
	toolProviders: Map<string, (text: string) => void>;
};

/**
 * Patches createBridgeServer so that AppServerConn.create and BridgeSession
 * constructor use a factory that returns a scripted session.
 *
 * Returns a function to set the next script and capture provideResult callbacks.
 */

// ---------------------------------------------------------------------------
// Mock createBridgeServer with injected BridgeSession factory
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
				// Capture provideResult so tests can call it
				const capturedProvide = event.provideResult;
				this.capturedProviders.set(event.callId, capturedProvide);
			}
			yield event;
		}
	}
}

// ---------------------------------------------------------------------------
// Create a bridge server that delegates to MockBridgeSession factory
// ---------------------------------------------------------------------------

let mockSessionFactory: (() => MockBridgeSession) | null = null;

function createMockBridgeServer(): BridgeServer {
	return Bun.serve({
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
			} = await import('../../../../src/lib/providers/codex-anthropic-bridge/translator');

			const body =
				(await req.json()) as import('../../../../src/lib/providers/codex-anthropic-bridge/translator').AnthropicRequest;
			const model = body.model;

			const sseHeaders = {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				Connection: 'keep-alive',
			};

			// Reuse the real drainToSSE logic by importing it:
			// (We can't import it directly since it's unexported, so we build a minimal inline version)
			const {
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

			const enc = new TextEncoder();

			// Shared drain helper — uses gen.next() directly to avoid for-await-of
			// triggering gen.return() on early exit (which would close the generator).
			async function drainGen(
				genArg: AsyncGenerator<BridgeEvent>,
				sessionArg: MockBridgeSession | null,
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
						toolSessions.set(event.callId, {
							gen: genArg,
							session:
								sessionArg as unknown as import('../../../../src/lib/providers/codex-anthropic-bridge/process-manager').BridgeSession,
							provideResult: event.provideResult,
						});
						controller.close();
						return;
					} else if (event.type === 'turn_done' || event.type === 'error') {
						if (textOpen) {
							controller.enqueue(enc.encode(contentBlockStopSSE(blockIndex)));
							textOpen = false;
						}
						controller.enqueue(enc.encode(messageDeltaSSE('end_turn', outputTokens)));
						controller.enqueue(enc.encode(messageStopSSE()));
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
				stored.provideResult(tr.text);
				const stream = new ReadableStream<Uint8Array>({
					async start(controller) {
						controller.enqueue(enc.encode(messageStartSSE(`msg_${Date.now()}`, model, 0)));
						await drainGen(stored.gen, null, controller);
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
					await drainGen(gen, mock, controller);
				},
			});
			return new Response(stream, { headers: sseHeaders });
		},
	}) as unknown as BridgeServer;
}

// Shared tool session map for mock server
const toolSessions = new Map<
	string,
	{
		gen: AsyncGenerator<BridgeEvent>;
		session: import('../../../../src/lib/providers/codex-anthropic-bridge/process-manager').BridgeSession;
		provideResult: (text: string) => void;
	}
>();

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
			// Capture the provideResult function once startTurn runs
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
		// The mock generator yields events in order. When the server stores the
		// suspended generator at tool_call and then resumes it on the next HTTP
		// request, the remaining events (text_delta, turn_done) are produced.
		// provideResult is a no-op in the mock since we don't block the generator.
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
				// These events are yielded when gen.next() is called after the tool_call
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
});
