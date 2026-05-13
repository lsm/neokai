/**
 * AgentSession — Process Tracking Tests
 *
 * Tests for trackAgentProcess PID tracking, exit promises, and
 * processExitedPromise aggregation behavior.
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import type { Session, MessageHub } from '@neokai/shared';
import type { Database } from '../../../../src/storage/database';
import type { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import { AgentSession } from '../../../../src/lib/agent/agent-session';
import type { TrackedAgentProcess } from '../../../../src/lib/agent/query-runner';
import { EventEmitter } from 'node:events';

function createMockProcess(pid: number | undefined): TrackedAgentProcess {
	const ee = new EventEmitter() as TrackedAgentProcess;
	ee.pid = pid;
	ee.kill = mock(() => true);
	ee.once = ee.once.bind(ee);
	ee.emit = ee.emit.bind(ee);
	return ee;
}

function createBaseSession(): Session {
	return {
		id: 'test-process-tracking',
		title: 'Test',
		workspacePath: '/test',
		createdAt: new Date().toISOString(),
		lastActiveAt: new Date().toISOString(),
		status: 'active',
		config: { model: 'default', maxTokens: 8192, temperature: 1.0 },
		metadata: {
			messageCount: 0,
			totalTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalCost: 0,
			toolCallCount: 0,
		},
	};
}

function createAgentSession(): AgentSession {
	const session = createBaseSession();
	const db = {
		updateSession: mock(() => {}),
		getSession: mock(() => session),
		getSDKMessages: mock(() => ({ messages: [], hasMore: false })),
		getSDKMessageCount: mock(() => 0),
		getMessagesByStatus: mock(() => []),
		saveSDKMessage: mock(() => {}),
		saveNeokaiActionMessage: mock(() => {}),
		mcpEnablement: { getEnablementForScope: mock(() => ({})) } as any,
	} as unknown as Database;

	const messageHub = {
		event: mock(async () => {}),
		onRequest: mock(() => () => {}),
		query: mock(async () => ({})),
		command: mock(async () => {}),
	} as unknown as MessageHub;

	const internalEventBus = {
		publish: mock(async () => {}),
		publishAsync: mock(async () => {}),
		subscribe: mock(() => () => {}),
	} as unknown as InternalEventBus<any>;

	const getApiKey = mock(async () => 'test-key');

	return new AgentSession(session, db, messageHub, internalEventBus, getApiKey);
}

describe('AgentSession — process tracking', () => {
	describe('trackAgentProcess', () => {
		it('sets processExitedPromise for numeric PID', () => {
			const sut = createAgentSession();
			const proc = createMockProcess(1234);

			sut.trackAgentProcess(proc);

			expect(sut.processExitedPromise).not.toBeNull();
		});

		it('aggregates exit promises across multiple tracked processes', () => {
			const sut = createAgentSession();
			const proc1 = createMockProcess(100);
			const proc2 = createMockProcess(200);

			sut.trackAgentProcess(proc1);
			sut.trackAgentProcess(proc2);

			expect(sut.processExitedPromise).not.toBeNull();
		});

		it('preserves existing processExitedPromise when no-PID process is tracked', async () => {
			const sut = createAgentSession();

			// Track a real process first
			const realProc = createMockProcess(100);
			sut.trackAgentProcess(realProc);
			const firstPromise = sut.processExitedPromise;
			expect(firstPromise).not.toBeNull();

			// Track a no-PID process (spawn failure path)
			const noPidProc = createMockProcess(undefined);
			sut.trackAgentProcess(noPidProc);

			// processExitedPromise should be a NEW promise that aggregates both,
			// not a replacement that drops the first.
			expect(sut.processExitedPromise).not.toBe(firstPromise);
			expect(sut.processExitedPromise).not.toBeNull();

			// The new promise should resolve only when BOTH exit promises resolve.
			// Emit exit for the no-PID process — the aggregated promise should NOT resolve yet
			// because the real process hasn't exited.
			let resolved = false;
			sut.processExitedPromise!.then(() => {
				resolved = true;
			});

			(noPidProc as unknown as EventEmitter).emit('exit');
			// Give microtask queue a tick
			await new Promise((r) => setTimeout(r, 5));
			expect(resolved).toBe(false);

			// Now emit exit for the real process
			(realProc as unknown as EventEmitter).emit('exit');
			await new Promise((r) => setTimeout(r, 5));
			expect(resolved).toBe(true);
		});

		it('handles no-PID process when processExitedPromise is null', async () => {
			const sut = createAgentSession();
			expect(sut.processExitedPromise).toBeNull();

			const noPidProc = createMockProcess(undefined);
			sut.trackAgentProcess(noPidProc);

			expect(sut.processExitedPromise).not.toBeNull();

			let resolved = false;
			sut.processExitedPromise!.then(() => {
				resolved = true;
			});

			(noPidProc as unknown as EventEmitter).emit('exit');
			await new Promise((r) => setTimeout(r, 5));
			expect(resolved).toBe(true);
		});
	});

	describe('getTrackedAgentRootPidsSplit', () => {
		it('returns live and exited PIDs', async () => {
			const sut = createAgentSession();
			const proc1 = createMockProcess(100);
			const proc2 = createMockProcess(200);

			sut.trackAgentProcess(proc1);
			sut.trackAgentProcess(proc2);

			let split = sut.getTrackedAgentRootPidsSplit();
			expect(split.live).toEqual([100, 200]);
			expect(split.exited).toEqual([]);

			// Simulate exit of proc1
			(proc1 as unknown as EventEmitter).emit('exit');
			await new Promise((r) => setTimeout(r, 5));

			split = sut.getTrackedAgentRootPidsSplit();
			expect(split.live).toEqual([200]);
			expect(split.exited).toEqual([100]);
		});
	});

	describe('terminateTrackedAgentProcesses', () => {
		it('signals process groups on terminate', () => {
			const sut = createAgentSession();
			const proc = createMockProcess(100);
			sut.trackAgentProcess(proc);

			// Access the internal state via snapshot
			const snapshot = sut.snapshotTrackedAgentProcesses();
			expect(snapshot.length).toBe(1);

			sut.terminateTrackedAgentProcesses({ processes: snapshot, forceDelayMs: 99999 });

			// kill should have been called
			expect((proc.kill as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThanOrEqual(1);
		});
	});
});
