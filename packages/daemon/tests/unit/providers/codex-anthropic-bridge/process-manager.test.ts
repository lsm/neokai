/**
 * Unit tests for the Codex Anthropic Bridge — BridgeSession
 *
 * Tests the BridgeSession class in isolation without a real `codex` subprocess.
 */

import { describe, expect, it } from 'bun:test';
import {
	BridgeSession,
	AppServerConn,
} from '../../../../src/lib/providers/codex-anthropic-bridge/process-manager';

// ---------------------------------------------------------------------------
// Minimal stub for AppServerConn — only the methods BridgeSession needs
// ---------------------------------------------------------------------------

function makeStubConn(): AppServerConn {
	return {
		closed: new Promise<void>(() => {}),
		kill: () => {},
		request: async (method: string) => {
			// codex 0.114+: thread/start returns { thread: { id } }
			if (method === 'thread/start') return { thread: { id: 'thread-1' } };
			// codex 0.114+: turn/start returns { turn: { id } }
			if (method === 'turn/start') return { turn: { id: 'turn-1' } };
			return {};
		},
		notify: () => {},
		onNotification: () => {},
		onServerRequest: () => {},
	} as unknown as AppServerConn;
}

// ---------------------------------------------------------------------------
// BridgeSession.initialize() — protocol shape regression guard
// ---------------------------------------------------------------------------

describe('BridgeSession.initialize()', () => {
	it('extracts threadId from codex 0.114+ result.thread.id shape', async () => {
		const conn = makeStubConn();
		const session = new BridgeSession(conn, 'test-model', [], '/tmp');
		await session.initialize();
		// Access private field via type cast — this is a regression guard for the
		// codex 0.114+ response shape change (result.thread.id vs result.threadId).
		const sessionState = session as unknown as { threadId: string | null };
		expect(sessionState.threadId).toBe('thread-1');
	});
});

// ---------------------------------------------------------------------------
// item/agentMessage/delta — output_text protocol (codex 0.114+)
// ---------------------------------------------------------------------------

/**
 * A stub conn that records notification/serverRequest handlers and exposes
 * helpers to fire them manually from tests.
 */
function makeEventableStubConn() {
	const notificationHandlers = new Map<string, (params: unknown) => void>();
	const serverRequestHandlers = new Map<string, (params: unknown) => Promise<unknown>>();

	const conn: AppServerConn = {
		closed: new Promise<void>(() => {}),
		kill: () => {},
		request: async (method: string) => {
			if (method === 'thread/start') return { thread: { id: 'thread-1' } };
			if (method === 'turn/start') return { turn: { id: 'turn-1' } };
			return {};
		},
		notify: () => {},
		onNotification: (method: string, handler: (params: unknown) => void) => {
			notificationHandlers.set(method, handler);
		},
		onServerRequest: (method: string, handler: (params: unknown) => Promise<unknown>) => {
			serverRequestHandlers.set(method, handler);
		},
	} as unknown as AppServerConn;

	return {
		conn,
		fireNotification: (method: string, params: unknown) => {
			notificationHandlers.get(method)?.(params);
		},
	};
}

describe('BridgeSession item/agentMessage/delta', () => {
	it('emits text_delta BridgeEvent for codex 0.114+ output_text format', async () => {
		const { conn, fireNotification } = makeEventableStubConn();
		const session = new BridgeSession(conn, 'test-model', [], '/tmp');
		await session.initialize();

		// Schedule notifications after the generator starts waiting
		setTimeout(() => {
			// codex 0.114+ sends type='output_text'
			fireNotification('item/agentMessage/delta', {
				delta: { type: 'output_text', text: 'hello' },
			});
			fireNotification('item/agentMessage/delta', {
				delta: { type: 'output_text', text: ' world' },
			});
			fireNotification('turn/completed', { usage: { inputTokens: 10, outputTokens: 5 } });
		}, 5);

		const gen = session.startTurn('test');
		const events: import('../../../../src/lib/providers/codex-anthropic-bridge/process-manager').BridgeEvent[] =
			[];
		for await (const event of gen) {
			events.push(event);
		}

		const textEvents = events.filter((e) => e.type === 'text_delta');
		expect(textEvents).toHaveLength(2);
		expect((textEvents[0] as { type: 'text_delta'; text: string }).text).toBe('hello');
		expect((textEvents[1] as { type: 'text_delta'; text: string }).text).toBe(' world');

		const doneEvents = events.filter((e) => e.type === 'turn_done');
		expect(doneEvents).toHaveLength(1);
	});

	it('does NOT emit a text_delta event for a delta with no text field', async () => {
		const { conn, fireNotification } = makeEventableStubConn();
		const session = new BridgeSession(conn, 'test-model', [], '/tmp');
		await session.initialize();

		setTimeout(() => {
			// Delta with no text — should be ignored
			fireNotification('item/agentMessage/delta', { delta: { type: 'input_json_delta' } });
			fireNotification('turn/completed', {});
		}, 5);

		const gen = session.startTurn('test');
		const events: import('../../../../src/lib/providers/codex-anthropic-bridge/process-manager').BridgeEvent[] =
			[];
		for await (const event of gen) {
			events.push(event);
		}

		const textEvents = events.filter((e) => e.type === 'text_delta');
		expect(textEvents).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// BridgeSession single-use guard (regression: P1 fix)
// ---------------------------------------------------------------------------

describe('BridgeSession.startTurn()', () => {
	it('throws if called a second time on the same instance', async () => {
		const conn = makeStubConn();
		const session = new BridgeSession(conn, 'test-model', [], '/tmp');
		await session.initialize();

		// Kick off gen1.next() without awaiting — the generator will run past the
		// turnStarted guard (setting the flag to true), then block on queue.next().
		const gen1 = session.startTurn('first');
		const firstNextPromise = gen1.next();

		// Yield to the event loop several times so the async generator body has a
		// chance to advance past `await conn.request('turn/start')` and set the flag.
		await new Promise((res) => setTimeout(res, 10));

		// Second startTurn() call: its first next() should throw synchronously.
		const gen2 = session.startTurn('second');
		await expect(gen2.next()).rejects.toThrow('startTurn() called more than once');

		// Suppress unhandled-rejection noise from the first generator that is
		// blocked indefinitely on queue.next().
		firstNextPromise.catch(() => {});
	});
});
