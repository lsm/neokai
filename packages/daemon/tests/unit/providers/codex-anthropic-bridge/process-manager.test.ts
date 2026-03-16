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
