/**
 * ProcessingStateManager Tests
 *
 * Tests state machine transitions, phase tracking,
 * and EventBus integration.
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager';
import { EventBus } from '@liuboer/shared';
import { generateUUID } from '@liuboer/shared';
import { Database } from '../../../../src/storage/database';
import type { Session } from '@liuboer/shared';

async function createTestDb(): Promise<Database> {
	const db = new Database(':memory:');
	await db.initialize();
	return db;
}

function createTestSession(id: string): Session {
	return {
		id,
		title: `Test Session ${id}`,
		workspacePath: '/test/workspace',
		createdAt: new Date().toISOString(),
		lastActiveAt: new Date().toISOString(),
		status: 'active',
		config: {
			model: 'claude-sonnet-4-5-20250929',
			maxTokens: 8192,
			temperature: 1.0,
		},
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

describe('ProcessingStateManager', () => {
	let stateManager: ProcessingStateManager;
	let mockEventBus: EventBus;
	let emitSpy: ReturnType<typeof mock>;
	const testSessionId = generateUUID();

	beforeEach(() => {
		// Create mock EventBus
		emitSpy = mock(async () => {});
		mockEventBus = {
			emit: emitSpy,
		} as unknown as EventBus;

		// Create mock Database
		const mockDb = {
			getSession: mock(() => null),
			updateSession: mock(() => {}),
		} as unknown as Database;

		stateManager = new ProcessingStateManager(testSessionId, mockEventBus, mockDb);
	});

	describe('initial state', () => {
		it('should start in idle state', () => {
			const state = stateManager.getState();
			expect(state.status).toBe('idle');
		});

		it('should report isIdle as true', () => {
			expect(stateManager.isIdle()).toBe(true);
		});

		it('should report isProcessing as false', () => {
			expect(stateManager.isProcessing()).toBe(false);
		});
	});

	describe('state transitions', () => {
		it('should transition from idle to queued', async () => {
			await stateManager.setQueued('msg-123');

			const state = stateManager.getState();
			expect(state.status).toBe('queued');
			expect(state.messageId).toBe('msg-123');
			expect(stateManager.isIdle()).toBe(false);

			// Should emit event with processingState included (event-sourced architecture)
			expect(emitSpy).toHaveBeenCalledWith('session:updated', {
				sessionId: testSessionId,
				source: 'processing-state',
				processingState: { status: 'queued', messageId: 'msg-123' },
			});
		});

		it('should transition from queued to processing', async () => {
			await stateManager.setQueued('msg-123');
			await stateManager.setProcessing('msg-123', 'initializing');

			const state = stateManager.getState();
			expect(state.status).toBe('processing');
			expect(state.messageId).toBe('msg-123');
			expect(state.phase).toBe('initializing');
			expect(stateManager.isProcessing()).toBe(true);
		});

		it('should transition from processing to idle', async () => {
			await stateManager.setProcessing('msg-123', 'initializing');
			await stateManager.setIdle();

			const state = stateManager.getState();
			expect(state.status).toBe('idle');
			expect(stateManager.isIdle()).toBe(true);
			expect(stateManager.isProcessing()).toBe(false);
		});

		it('should transition to interrupted state', async () => {
			await stateManager.setProcessing('msg-123', 'streaming');
			await stateManager.setInterrupted();

			const state = stateManager.getState();
			expect(state.status).toBe('interrupted');
		});
	});

	describe('phase tracking', () => {
		beforeEach(async () => {
			await stateManager.setProcessing('msg-123', 'initializing');
		});

		it('should update phase during processing', async () => {
			await stateManager.updatePhase('thinking');

			const state = stateManager.getState();
			expect(state.phase).toBe('thinking');
		});

		it('should track all phases: initializing -> thinking -> streaming -> finalizing', async () => {
			await stateManager.updatePhase('thinking');
			expect(stateManager.getState().phase).toBe('thinking');

			await stateManager.updatePhase('streaming');
			expect(stateManager.getState().phase).toBe('streaming');

			await stateManager.updatePhase('finalizing');
			expect(stateManager.getState().phase).toBe('finalizing');
		});

		it('should track streamingStartedAt when entering streaming phase', async () => {
			const beforeTime = Date.now();

			await stateManager.updatePhase('streaming');

			const state = stateManager.getState();
			expect(state.streamingStartedAt).toBeDefined();
			expect(state.streamingStartedAt).toBeGreaterThanOrEqual(beforeTime);
		});

		it('should not update phase when not processing', async () => {
			await stateManager.setIdle();

			// Attempt to update phase
			await stateManager.updatePhase('streaming');

			// Should still be idle
			const state = stateManager.getState();
			expect(state.status).toBe('idle');
			expect(state.phase).toBeUndefined();
		});
	});

	describe('phase detection from messages', () => {
		beforeEach(async () => {
			await stateManager.setProcessing('msg-123', 'initializing');
		});

		it('should detect streaming phase from stream_event message', async () => {
			const streamEvent = { type: 'stream_event', event: {} };

			await stateManager.detectPhaseFromMessage(streamEvent);

			expect(stateManager.getState().phase).toBe('streaming');
		});

		it('should detect thinking phase from assistant message with tool use', async () => {
			const assistantMsg = {
				type: 'assistant',
				message: {
					content: [{ type: 'tool_use', id: 'tool-1', name: 'bash', input: {} }],
				},
			};

			await stateManager.detectPhaseFromMessage(assistantMsg);

			expect(stateManager.getState().phase).toBe('thinking');
		});

		it('should detect finalizing phase from result message', async () => {
			const resultMsg = { type: 'result', subtype: 'success' };

			await stateManager.detectPhaseFromMessage(resultMsg);

			expect(stateManager.getState().phase).toBe('finalizing');
		});

		it('should not detect phase when not processing', async () => {
			await stateManager.setIdle();

			const streamEvent = { type: 'stream_event', event: {} };
			await stateManager.detectPhaseFromMessage(streamEvent);

			// Should remain idle with no phase
			expect(stateManager.getState().status).toBe('idle');
			expect(stateManager.getState().phase).toBeUndefined();
		});
	});

	describe('EventBus integration', () => {
		it('should emit event on every state change', async () => {
			emitSpy.mockClear();

			await stateManager.setQueued('msg-123');
			expect(emitSpy).toHaveBeenCalledTimes(1);

			await stateManager.setProcessing('msg-123', 'initializing');
			expect(emitSpy).toHaveBeenCalledTimes(2);

			await stateManager.updatePhase('streaming');
			expect(emitSpy).toHaveBeenCalledTimes(3);

			await stateManager.setIdle();
			expect(emitSpy).toHaveBeenCalledTimes(4);
		});

		it('should include sessionId, source, and processingState in event payload', async () => {
			emitSpy.mockClear();

			await stateManager.setProcessing('msg-123', 'streaming');

			// Verify event was emitted with correct structure
			expect(emitSpy).toHaveBeenCalledTimes(1);
			const [eventName, payload] = emitSpy.mock.calls[0];
			expect(eventName).toBe('session:updated');
			expect(payload.sessionId).toBe(testSessionId);
			expect(payload.source).toBe('processing-state');
			// processingState included for event-sourced architecture
			expect(payload.processingState).toBeDefined();
			expect(payload.processingState.status).toBe('processing');
			expect(payload.processingState.messageId).toBe('msg-123');
			expect(payload.processingState.phase).toBe('streaming');
			expect(payload.processingState.streamingStartedAt).toBeDefined();
		});
	});

	describe('state reset', () => {
		it('should reset phase tracking when transitioning to idle', async () => {
			await stateManager.setProcessing('msg-123', 'streaming');
			await stateManager.updatePhase('streaming');

			// Verify we're in streaming phase
			expect(stateManager.getState().phase).toBe('streaming');
			expect(stateManager.getState().streamingStartedAt).toBeDefined();

			// Transition to idle
			await stateManager.setIdle();

			// Phase tracking should be reset
			const state = stateManager.getState();
			expect(state.phase).toBeUndefined();
			expect(state.streamingStartedAt).toBeUndefined();
		});

		it('should reset phase tracking when interrupted', async () => {
			await stateManager.setProcessing('msg-123', 'thinking');

			await stateManager.setInterrupted();

			// Phase tracking should be reset (will be reflected in next processing state)
			await stateManager.setProcessing('msg-456', 'initializing');
			expect(stateManager.getState().phase).toBe('initializing');
		});
	});

	describe('state persistence', () => {
		let db: Database;
		let eventBus: EventBus;
		const sessionId = 'test-session-persist';

		beforeEach(async () => {
			db = await createTestDb();
			eventBus = new EventBus({ debug: false });

			// Create a test session
			const session = createTestSession(sessionId);
			db.createSession(session);
		});

		it('should persist idle state to database', async () => {
			const manager = new ProcessingStateManager(sessionId, eventBus, db);

			await manager.setIdle();

			// Verify persisted to database
			const session = db.getSession(sessionId);
			expect(session).toBeDefined();
			expect(session!.processingState).toBeDefined();

			const persistedState = JSON.parse(session!.processingState as string);
			expect(persistedState.status).toBe('idle');
		});

		it('should persist queued state to database', async () => {
			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			const messageId = 'msg-123';

			await manager.setQueued(messageId);

			// Verify persisted to database
			const session = db.getSession(sessionId);
			const persistedState = JSON.parse(session!.processingState as string);
			expect(persistedState.status).toBe('queued');
			expect(persistedState.messageId).toBe(messageId);
		});

		it('should persist processing state to database', async () => {
			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			const messageId = 'msg-456';

			await manager.setProcessing(messageId, 'thinking');

			// Verify persisted to database
			const session = db.getSession(sessionId);
			const persistedState = JSON.parse(session!.processingState as string);
			expect(persistedState.status).toBe('processing');
			expect(persistedState.messageId).toBe(messageId);
			expect(persistedState.phase).toBe('thinking');
		});

		it('should persist interrupted state to database', async () => {
			const manager = new ProcessingStateManager(sessionId, eventBus, db);

			await manager.setInterrupted();

			// Verify persisted to database
			const session = db.getSession(sessionId);
			const persistedState = JSON.parse(session!.processingState as string);
			expect(persistedState.status).toBe('interrupted');
		});

		it('should persist phase updates to database', async () => {
			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			const messageId = 'msg-789';

			// Start processing
			await manager.setProcessing(messageId, 'initializing');

			// Update phase
			await manager.updatePhase('streaming');

			// Verify persisted to database
			const session = db.getSession(sessionId);
			const persistedState = JSON.parse(session!.processingState as string);
			expect(persistedState.status).toBe('processing');
			expect(persistedState.phase).toBe('streaming');
			expect(persistedState.streamingStartedAt).toBeDefined();
		});

		it('should persist state changes through full lifecycle', async () => {
			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			const messageId = 'msg-lifecycle';

			// Start with idle
			await manager.setIdle();
			let session = db.getSession(sessionId);
			expect(JSON.parse(session!.processingState as string).status).toBe('idle');

			// Move to queued
			await manager.setQueued(messageId);
			session = db.getSession(sessionId);
			expect(JSON.parse(session!.processingState as string).status).toBe('queued');

			// Move to processing
			await manager.setProcessing(messageId, 'initializing');
			session = db.getSession(sessionId);
			let persistedState = JSON.parse(session!.processingState as string);
			expect(persistedState.status).toBe('processing');
			expect(persistedState.phase).toBe('initializing');

			// Update to streaming phase
			await manager.updatePhase('streaming');
			session = db.getSession(sessionId);
			persistedState = JSON.parse(session!.processingState as string);
			expect(persistedState.phase).toBe('streaming');

			// Back to idle
			await manager.setIdle();
			session = db.getSession(sessionId);
			expect(JSON.parse(session!.processingState as string).status).toBe('idle');
		});
	});

	describe('state restoration', () => {
		let db: Database;
		let eventBus: EventBus;
		const sessionId = 'test-session-restore';

		beforeEach(async () => {
			db = await createTestDb();
			eventBus = new EventBus({ debug: false });

			// Create a test session
			const session = createTestSession(sessionId);
			db.createSession(session);
		});

		it('should restore idle state from database', async () => {
			// Set up persisted state
			db.updateSession(sessionId, {
				processingState: JSON.stringify({ status: 'idle' }),
			});

			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			manager.restoreFromDatabase();

			const state = manager.getState();
			expect(state.status).toBe('idle');
		});

		it('should reset processing state to idle after restart (safety logic)', async () => {
			// Set up persisted processing state (simulating a crash during processing)
			db.updateSession(sessionId, {
				processingState: JSON.stringify({
					status: 'processing',
					messageId: 'msg-old',
					phase: 'streaming',
				}),
			});

			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			manager.restoreFromDatabase();

			// After restart, processing should be reset to idle for safety
			const state = manager.getState();
			expect(state.status).toBe('idle');
		});

		it('should reset queued state to idle after restart (safety logic)', async () => {
			// Set up persisted queued state (simulating a crash during queued)
			db.updateSession(sessionId, {
				processingState: JSON.stringify({
					status: 'queued',
					messageId: 'msg-old',
				}),
			});

			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			manager.restoreFromDatabase();

			// After restart, queued should be reset to idle for safety
			const state = manager.getState();
			expect(state.status).toBe('idle');
		});

		it('should restore interrupted state from database', async () => {
			// Set up persisted interrupted state
			db.updateSession(sessionId, {
				processingState: JSON.stringify({ status: 'interrupted' }),
			});

			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			manager.restoreFromDatabase();

			const state = manager.getState();
			expect(state.status).toBe('interrupted');
		});

		it('should handle missing persisted state gracefully', async () => {
			// No persisted state in database
			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			manager.restoreFromDatabase();

			// Should default to idle
			const state = manager.getState();
			expect(state.status).toBe('idle');
		});

		it('should handle invalid JSON in persisted state gracefully', async () => {
			// Set up invalid JSON in database
			db.updateSession(sessionId, {
				processingState: 'invalid-json-{',
			});

			const manager = new ProcessingStateManager(sessionId, eventBus, db);
			manager.restoreFromDatabase();

			// Should default to idle when parsing fails
			const state = manager.getState();
			expect(state.status).toBe('idle');
		});
	});
});
