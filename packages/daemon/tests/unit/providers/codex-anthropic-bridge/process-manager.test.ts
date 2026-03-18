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
	it('emits text_delta BridgeEvent for codex 0.114+ plain-string delta format', async () => {
		const { conn, fireNotification } = makeEventableStubConn();
		const session = new BridgeSession(conn, 'test-model', [], '/tmp');
		await session.initialize();

		// Schedule notifications after the generator starts waiting
		setTimeout(() => {
			// codex 0.114.0+ v2 protocol: delta is a plain string
			// AgentMessageDeltaNotification = { threadId, turnId, itemId, delta: string }
			fireNotification('item/agentMessage/delta', {
				threadId: 'thread-1',
				turnId: 'turn-1',
				itemId: 'item-1',
				delta: 'hello',
			});
			fireNotification('item/agentMessage/delta', {
				threadId: 'thread-1',
				turnId: 'turn-1',
				itemId: 'item-1',
				delta: ' world',
			});
			fireNotification('turn/completed', {
				threadId: 'thread-1',
				turn: { id: 'turn-1', items: [], status: 'completed', error: null },
			});
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

	it('emits text_delta BridgeEvent for legacy object delta format (backward compat)', async () => {
		const { conn, fireNotification } = makeEventableStubConn();
		const session = new BridgeSession(conn, 'test-model', [], '/tmp');
		await session.initialize();

		// Schedule notifications after the generator starts waiting
		setTimeout(() => {
			// Legacy fallback: delta was { type: 'output_text', text: '...' }
			fireNotification('item/agentMessage/delta', {
				delta: { type: 'output_text', text: 'hello' },
			});
			fireNotification('item/agentMessage/delta', {
				delta: { type: 'output_text', text: ' world' },
			});
			fireNotification('turn/completed', {
				turn: { id: 'turn-1', items: [], status: 'completed', error: null },
			});
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

	it('does NOT emit a text_delta event for an empty delta string', async () => {
		const { conn, fireNotification } = makeEventableStubConn();
		const session = new BridgeSession(conn, 'test-model', [], '/tmp');
		await session.initialize();

		setTimeout(() => {
			// Empty string delta — should be ignored
			fireNotification('item/agentMessage/delta', { delta: '' });
			fireNotification('turn/completed', {
				turn: { id: 'turn-1', items: [], status: 'completed', error: null },
			});
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

	it('does NOT emit a text_delta event for a legacy delta with no text field', async () => {
		const { conn, fireNotification } = makeEventableStubConn();
		const session = new BridgeSession(conn, 'test-model', [], '/tmp');
		await session.initialize();

		setTimeout(() => {
			// Legacy delta with no text — should be ignored
			fireNotification('item/agentMessage/delta', { delta: { type: 'input_json_delta' } });
			fireNotification('turn/completed', {
				turn: { id: 'turn-1', items: [], status: 'completed', error: null },
			});
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

	it('emits error BridgeEvent when turn/completed status is "failed"', async () => {
		const { conn, fireNotification } = makeEventableStubConn();
		const session = new BridgeSession(conn, 'test-model', [], '/tmp');
		await session.initialize();

		setTimeout(() => {
			// Simulate a failed turn (e.g. invalid model)
			fireNotification('turn/completed', {
				threadId: 'thread-1',
				turn: {
					id: 'turn-1',
					items: [],
					status: 'failed',
					error: { message: 'Model not supported' },
				},
			});
		}, 5);

		const gen = session.startTurn('test');
		const events: import('../../../../src/lib/providers/codex-anthropic-bridge/process-manager').BridgeEvent[] =
			[];
		for await (const event of gen) {
			events.push(event);
		}

		const errorEvents = events.filter((e) => e.type === 'error');
		expect(errorEvents).toHaveLength(1);
		expect((errorEvents[0] as { type: 'error'; message: string }).message).toContain(
			'Model not supported'
		);
	});
});

// ---------------------------------------------------------------------------
// thread/tokenUsage/updated — token usage capture
// ---------------------------------------------------------------------------

// White-box helper to read the private latestUsage field (same pattern as threadId test above).
type SessionInternals = {
	latestUsage:
		| import('../../../../src/lib/providers/codex-anthropic-bridge/process-manager').TokenUsage
		| null;
};

describe('BridgeSession thread/tokenUsage/updated', () => {
	it('captures token usage from nested usage object shape', async () => {
		const { conn, fireNotification } = makeEventableStubConn();
		const session = new BridgeSession(conn, 'test-model', [], '/tmp');
		await session.initialize();

		// Before any notification, latestUsage is null
		expect((session as unknown as SessionInternals).latestUsage).toBeNull();

		setTimeout(() => {
			// Fire the token usage notification (nested usage object shape)
			fireNotification('thread/tokenUsage/updated', {
				threadId: 'thread-1',
				usage: { inputTokens: 150, outputTokens: 75 },
			});
			fireNotification('turn/completed', {
				threadId: 'thread-1',
				turn: { id: 'turn-1', items: [], status: 'completed', error: null },
			});
		}, 5);

		const gen = session.startTurn('test');
		const events: import('../../../../src/lib/providers/codex-anthropic-bridge/process-manager').BridgeEvent[] =
			[];
		for await (const event of gen) {
			events.push(event);
		}

		// latestUsage should reflect what arrived
		expect((session as unknown as SessionInternals).latestUsage).toEqual({
			inputTokens: 150,
			outputTokens: 75,
		});
	});

	it('captures token usage from flat params shape', async () => {
		const { conn, fireNotification } = makeEventableStubConn();
		const session = new BridgeSession(conn, 'test-model', [], '/tmp');
		await session.initialize();

		setTimeout(() => {
			// Fire the token usage notification (flat params shape)
			fireNotification('thread/tokenUsage/updated', {
				threadId: 'thread-1',
				inputTokens: 200,
				outputTokens: 100,
			});
			fireNotification('turn/completed', {
				threadId: 'thread-1',
				turn: { id: 'turn-1', items: [], status: 'completed', error: null },
			});
		}, 5);

		const gen = session.startTurn('test');
		for await (const _event of gen) {
			// drain
		}

		expect((session as unknown as SessionInternals).latestUsage).toEqual({
			inputTokens: 200,
			outputTokens: 100,
		});
	});

	it('populates turn_done with actual token counts from thread/tokenUsage/updated', async () => {
		const { conn, fireNotification } = makeEventableStubConn();
		const session = new BridgeSession(conn, 'test-model', [], '/tmp');
		await session.initialize();

		setTimeout(() => {
			// Usage notification arrives before turn/completed (normal ordering)
			fireNotification('thread/tokenUsage/updated', {
				threadId: 'thread-1',
				usage: { inputTokens: 300, outputTokens: 42 },
			});
			fireNotification('turn/completed', {
				threadId: 'thread-1',
				turn: { id: 'turn-1', items: [], status: 'completed', error: null },
			});
		}, 5);

		const gen = session.startTurn('test');
		const events: import('../../../../src/lib/providers/codex-anthropic-bridge/process-manager').BridgeEvent[] =
			[];
		for await (const event of gen) {
			events.push(event);
		}

		const doneEvents = events.filter((e) => e.type === 'turn_done');
		expect(doneEvents).toHaveLength(1);
		const done = doneEvents[0] as { type: 'turn_done'; inputTokens: number; outputTokens: number };
		expect(done.inputTokens).toBe(300);
		expect(done.outputTokens).toBe(42);
	});

	it('falls back to 0 tokens in turn_done when no tokenUsage notification arrives', async () => {
		const { conn, fireNotification } = makeEventableStubConn();
		const session = new BridgeSession(conn, 'test-model', [], '/tmp');
		await session.initialize();

		setTimeout(() => {
			// No thread/tokenUsage/updated — only turn/completed
			fireNotification('turn/completed', {
				threadId: 'thread-1',
				turn: { id: 'turn-1', items: [], status: 'completed', error: null },
			});
		}, 5);

		const gen = session.startTurn('test');
		const events: import('../../../../src/lib/providers/codex-anthropic-bridge/process-manager').BridgeEvent[] =
			[];
		for await (const event of gen) {
			events.push(event);
		}

		const doneEvents = events.filter((e) => e.type === 'turn_done');
		expect(doneEvents).toHaveLength(1);
		const done = doneEvents[0] as { type: 'turn_done'; inputTokens: number; outputTokens: number };
		expect(done.inputTokens).toBe(0);
		expect(done.outputTokens).toBe(0);
	});

	it('falls back to inline usage from turn/completed when no tokenUsage notification arrives (legacy protocol)', async () => {
		const { conn, fireNotification } = makeEventableStubConn();
		const session = new BridgeSession(conn, 'test-model', [], '/tmp');
		await session.initialize();

		setTimeout(() => {
			// Legacy protocol: usage is inline in turn/completed, no thread/tokenUsage/updated
			fireNotification('turn/completed', {
				threadId: 'thread-1',
				turn: { id: 'turn-1', items: [], status: 'completed', error: null },
				usage: { inputTokens: 50, outputTokens: 25 },
			});
		}, 5);

		const gen = session.startTurn('test');
		const events: import('../../../../src/lib/providers/codex-anthropic-bridge/process-manager').BridgeEvent[] =
			[];
		for await (const event of gen) {
			events.push(event);
		}

		const doneEvents = events.filter((e) => e.type === 'turn_done');
		expect(doneEvents).toHaveLength(1);
		const done = doneEvents[0] as { type: 'turn_done'; inputTokens: number; outputTokens: number };
		expect(done.inputTokens).toBe(50);
		expect(done.outputTokens).toBe(25);
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

		// The mock request() resolves immediately (no real async work), so a few
		// microtask yields are sufficient to advance the generator past
		// `await conn.request('turn/start')` and set turnStarted = true.
		// No wall-clock delay needed — using Promise.resolve() avoids a race on slow CI.
		for (let i = 0; i < 10; i++) await Promise.resolve();

		// Second startTurn() call: its first next() should throw synchronously.
		const gen2 = session.startTurn('second');
		await expect(gen2.next()).rejects.toThrow('startTurn() called more than once');

		// Suppress unhandled-rejection noise from the first generator that is
		// blocked indefinitely on queue.next().
		firstNextPromise.catch(() => {});
	});
});
