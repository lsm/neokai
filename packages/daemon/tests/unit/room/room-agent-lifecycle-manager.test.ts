/**
 * RoomAgentLifecycleManager Tests
 *
 * Tests for room agent lifecycle state management:
 * - Initialization and state restoration
 * - State transitions with validation
 * - State guard methods
 * - Error tracking
 * - Session pair tracking
 * - Event emission
 */

import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTables } from '../../../src/storage/schema';
import { RoomAgentLifecycleManager } from '../../../src/lib/room/room-agent-lifecycle-manager';
import { RoomManager } from '../../../src/lib/room/room-manager';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { RoomAgentState, RoomAgentLifecycleState } from '@neokai/shared';

describe('RoomAgentLifecycleManager', () => {
	let db: Database;
	let lifecycleManager: RoomAgentLifecycleManager;
	let roomManager: RoomManager;
	let roomId: string;
	let mockDaemonHub: DaemonHub;
	let trackedEvents: Array<{ event: string; data: unknown }>;

	beforeEach(() => {
		// Use an anonymous in-memory database for each test
		db = new Database(':memory:');
		createTables(db);

		// Create room_agent_states table (migration 20)
		db.exec(`
			CREATE TABLE IF NOT EXISTS room_agent_states (
				room_id TEXT PRIMARY KEY,
				lifecycle_state TEXT NOT NULL DEFAULT 'idle'
					CHECK(lifecycle_state IN ('idle', 'planning', 'executing', 'waiting', 'reviewing', 'error', 'paused')),
				current_goal_id TEXT,
				current_task_id TEXT,
				active_session_pair_ids TEXT DEFAULT '[]',
				last_activity_at INTEGER NOT NULL,
				error_count INTEGER DEFAULT 0,
				last_error TEXT,
				pending_actions TEXT DEFAULT '[]',
				FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
			);
		`);

		// Create room manager and a room
		roomManager = new RoomManager(db);
		const room = roomManager.createRoom({
			name: 'Test Room',
			allowedPaths: ['/workspace/test'],
			defaultPath: '/workspace/test',
		});
		roomId = room.id;

		// Track events emitted by the daemon hub
		trackedEvents = [];
		mockDaemonHub = {
			emit: mock(async (event: string, data: unknown) => {
				trackedEvents.push({ event, data });
			}),
		} as unknown as DaemonHub;

		// Create lifecycle manager
		lifecycleManager = new RoomAgentLifecycleManager(roomId, db, mockDaemonHub);
	});

	afterEach(() => {
		db.close();
	});

	describe('initialization', () => {
		it('should initialize in idle state', () => {
			const state = lifecycleManager.initialize();

			expect(state).toBeDefined();
			expect(state.roomId).toBe(roomId);
			expect(state.lifecycleState).toBe('idle');
			expect(state.activeSessionPairIds).toEqual([]);
			expect(state.errorCount).toBe(0);
			expect(state.pendingActions).toEqual([]);
		});

		it('should restore existing state from database', () => {
			// Initialize first time
			const initialState = lifecycleManager.initialize();
			expect(initialState.lifecycleState).toBe('idle');

			// Create a new manager instance to test restoration
			const newManager = new RoomAgentLifecycleManager(roomId, db, mockDaemonHub);
			const restoredState = newManager.initialize();

			// Should restore the same state
			expect(restoredState.lifecycleState).toBe('idle');
			expect(restoredState.roomId).toBe(roomId);
		});

		it('should create new state if none exists', () => {
			// Create manager for a room that doesn't have state yet
			const newRoom = roomManager.createRoom({ name: 'Another Room' });
			const newManager = new RoomAgentLifecycleManager(newRoom.id, db, mockDaemonHub);

			const state = newManager.initialize();

			expect(state).toBeDefined();
			expect(state.roomId).toBe(newRoom.id);
			expect(state.lifecycleState).toBe('idle');
		});
	});

	describe('state transitions', () => {
		beforeEach(() => {
			lifecycleManager.initialize();
			trackedEvents.length = 0; // Clear initialization events
		});

		it('should transition from idle to planning', async () => {
			const result = await lifecycleManager.transitionTo('planning', 'Event received');

			expect(result).not.toBeNull();
			expect(result?.lifecycleState).toBe('planning');
			expect(lifecycleManager.getLifecycleState()).toBe('planning');
		});

		it('should transition from planning to executing', async () => {
			await lifecycleManager.transitionTo('planning');
			trackedEvents.length = 0;

			const result = await lifecycleManager.transitionTo('executing', 'Tasks spawned');

			expect(result).not.toBeNull();
			expect(result?.lifecycleState).toBe('executing');
		});

		it('should transition from executing to reviewing', async () => {
			await lifecycleManager.transitionTo('planning');
			await lifecycleManager.transitionTo('executing');
			trackedEvents.length = 0;

			const result = await lifecycleManager.transitionTo('reviewing', 'All tasks completed');

			expect(result).not.toBeNull();
			expect(result?.lifecycleState).toBe('reviewing');
		});

		it('should transition from reviewing to idle', async () => {
			await lifecycleManager.transitionTo('planning');
			await lifecycleManager.transitionTo('executing');
			await lifecycleManager.transitionTo('reviewing');
			trackedEvents.length = 0;

			const result = await lifecycleManager.transitionTo('idle', 'Review complete');

			expect(result).not.toBeNull();
			expect(result?.lifecycleState).toBe('idle');
		});

		it('should transition to waiting from planning and executing', async () => {
			// Test from planning
			await lifecycleManager.transitionTo('planning');
			let result = await lifecycleManager.transitionTo('waiting', 'Need input');
			expect(result?.lifecycleState).toBe('waiting');

			// Reset and test from executing
			lifecycleManager.forceState('idle');
			await lifecycleManager.transitionTo('planning');
			await lifecycleManager.transitionTo('executing');
			result = await lifecycleManager.transitionTo('waiting', 'Blocked');
			expect(result?.lifecycleState).toBe('waiting');
		});

		it('should transition from waiting to planning', async () => {
			await lifecycleManager.transitionTo('waiting', 'Waiting for input');
			trackedEvents.length = 0;

			const result = await lifecycleManager.transitionTo('planning', 'Input received');

			expect(result).not.toBeNull();
			expect(result?.lifecycleState).toBe('planning');
		});

		it('should transition to paused from any state', async () => {
			// Test from idle
			let result = await lifecycleManager.transitionTo('paused', 'Manual pause');
			expect(result?.lifecycleState).toBe('paused');

			// Reset and test from planning
			lifecycleManager.forceState('idle');
			await lifecycleManager.transitionTo('planning');
			result = await lifecycleManager.transitionTo('paused');
			expect(result?.lifecycleState).toBe('paused');

			// Reset and test from executing
			lifecycleManager.forceState('idle');
			await lifecycleManager.transitionTo('planning');
			await lifecycleManager.transitionTo('executing');
			result = await lifecycleManager.transitionTo('paused');
			expect(result?.lifecycleState).toBe('paused');

			// Reset and test from waiting
			lifecycleManager.forceState('idle');
			await lifecycleManager.transitionTo('waiting');
			result = await lifecycleManager.transitionTo('paused');
			expect(result?.lifecycleState).toBe('paused');
		});

		it('should transition from paused to idle on resume', async () => {
			await lifecycleManager.transitionTo('paused');
			trackedEvents.length = 0;

			const result = await lifecycleManager.resume();

			expect(result).not.toBeNull();
			expect(result?.lifecycleState).toBe('idle');
		});

		it('should transition to error from any state', async () => {
			// Test from idle
			let result = await lifecycleManager.transitionTo('error', 'Something went wrong');
			expect(result?.lifecycleState).toBe('error');

			// Reset and test from planning
			lifecycleManager.forceState('idle');
			await lifecycleManager.transitionTo('planning');
			result = await lifecycleManager.transitionTo('error');
			expect(result?.lifecycleState).toBe('error');

			// Reset and test from executing
			lifecycleManager.forceState('idle');
			await lifecycleManager.transitionTo('planning');
			await lifecycleManager.transitionTo('executing');
			result = await lifecycleManager.transitionTo('error');
			expect(result?.lifecycleState).toBe('error');
		});

		it('should reject invalid transitions', async () => {
			// Cannot go directly from idle to executing
			const result = await lifecycleManager.transitionTo('executing', 'Invalid');

			expect(result).toBeNull();
			expect(lifecycleManager.getLifecycleState()).toBe('idle');
		});

		it('should reject transition from idle to reviewing', async () => {
			const result = await lifecycleManager.transitionTo('reviewing', 'Invalid');

			expect(result).toBeNull();
			expect(lifecycleManager.getLifecycleState()).toBe('idle');
		});

		it('should reject transition from waiting to executing', async () => {
			await lifecycleManager.transitionTo('planning');
			await lifecycleManager.transitionTo('waiting');
			trackedEvents.length = 0;

			const result = await lifecycleManager.transitionTo('executing', 'Invalid');

			expect(result).toBeNull();
			expect(lifecycleManager.getLifecycleState()).toBe('waiting');
		});

		it('should reject transition from paused to planning', async () => {
			await lifecycleManager.transitionTo('paused');
			trackedEvents.length = 0;

			const result = await lifecycleManager.transitionTo('planning', 'Invalid');

			expect(result).toBeNull();
			expect(lifecycleManager.getLifecycleState()).toBe('paused');
		});
	});

	describe('state guards', () => {
		beforeEach(() => {
			lifecycleManager.initialize();
		});

		it('canProcessEvent returns true for idle/planning/executing', async () => {
			// Idle
			expect(lifecycleManager.canProcessEvent()).toBe(true);

			// Planning
			await lifecycleManager.transitionTo('planning');
			expect(lifecycleManager.canProcessEvent()).toBe(true);

			// Executing
			await lifecycleManager.transitionTo('executing');
			expect(lifecycleManager.canProcessEvent()).toBe(true);
		});

		it('canProcessEvent returns false for waiting/paused/error', async () => {
			// Waiting (can only reach from planning or executing)
			lifecycleManager.forceState('idle');
			await lifecycleManager.transitionTo('planning');
			await lifecycleManager.transitionTo('waiting');
			expect(lifecycleManager.canProcessEvent()).toBe(false);

			// Paused
			lifecycleManager.forceState('idle');
			await lifecycleManager.transitionTo('paused');
			expect(lifecycleManager.canProcessEvent()).toBe(false);

			// Error
			lifecycleManager.forceState('idle');
			await lifecycleManager.transitionTo('error');
			expect(lifecycleManager.canProcessEvent()).toBe(false);
		});

		it('canProcessEvent returns false for reviewing state', async () => {
			lifecycleManager.forceState('idle');
			await lifecycleManager.transitionTo('planning');
			await lifecycleManager.transitionTo('executing');
			await lifecycleManager.transitionTo('reviewing');
			expect(lifecycleManager.canProcessEvent()).toBe(false);
		});

		it('canStartPlanning returns true for idle/reviewing', async () => {
			// Idle
			expect(lifecycleManager.canStartPlanning()).toBe(true);

			// Reviewing
			lifecycleManager.forceState('idle');
			await lifecycleManager.transitionTo('planning');
			await lifecycleManager.transitionTo('executing');
			await lifecycleManager.transitionTo('reviewing');
			expect(lifecycleManager.canStartPlanning()).toBe(true);
		});

		it('canStartPlanning returns false for other states', async () => {
			// Planning
			lifecycleManager.forceState('idle');
			await lifecycleManager.transitionTo('planning');
			expect(lifecycleManager.canStartPlanning()).toBe(false);

			// Executing
			lifecycleManager.forceState('idle');
			await lifecycleManager.transitionTo('planning');
			await lifecycleManager.transitionTo('executing');
			expect(lifecycleManager.canStartPlanning()).toBe(false);

			// Waiting (can only reach from planning or executing)
			lifecycleManager.forceState('idle');
			await lifecycleManager.transitionTo('planning');
			await lifecycleManager.transitionTo('waiting');
			expect(lifecycleManager.canStartPlanning()).toBe(false);

			// Paused
			lifecycleManager.forceState('idle');
			await lifecycleManager.transitionTo('paused');
			expect(lifecycleManager.canStartPlanning()).toBe(false);
		});

		it('canSpawnWorker returns true for planning/executing', async () => {
			// Planning
			lifecycleManager.forceState('idle');
			await lifecycleManager.transitionTo('planning');
			expect(lifecycleManager.canSpawnWorker()).toBe(true);

			// Executing
			await lifecycleManager.transitionTo('executing');
			expect(lifecycleManager.canSpawnWorker()).toBe(true);
		});

		it('canSpawnWorker returns false for other states', async () => {
			// Idle
			lifecycleManager.forceState('idle');
			expect(lifecycleManager.canSpawnWorker()).toBe(false);

			// Waiting (can only reach from planning or executing)
			lifecycleManager.forceState('idle');
			await lifecycleManager.transitionTo('planning');
			await lifecycleManager.transitionTo('waiting');
			expect(lifecycleManager.canSpawnWorker()).toBe(false);

			// Reviewing
			lifecycleManager.forceState('idle');
			await lifecycleManager.transitionTo('planning');
			await lifecycleManager.transitionTo('executing');
			await lifecycleManager.transitionTo('reviewing');
			expect(lifecycleManager.canSpawnWorker()).toBe(false);

			// Paused
			lifecycleManager.forceState('idle');
			await lifecycleManager.transitionTo('paused');
			expect(lifecycleManager.canSpawnWorker()).toBe(false);
		});

		it('isWaitingForInput returns true only for waiting state', async () => {
			expect(lifecycleManager.isWaitingForInput()).toBe(false);

			await lifecycleManager.transitionTo('planning');
			await lifecycleManager.transitionTo('waiting');
			expect(lifecycleManager.isWaitingForInput()).toBe(true);

			await lifecycleManager.transitionTo('planning');
			expect(lifecycleManager.isWaitingForInput()).toBe(false);
		});

		it('isInErrorState returns true only for error state', async () => {
			expect(lifecycleManager.isInErrorState()).toBe(false);

			await lifecycleManager.transitionTo('error');
			expect(lifecycleManager.isInErrorState()).toBe(true);

			lifecycleManager.forceState('idle');
			expect(lifecycleManager.isInErrorState()).toBe(false);
		});

		it('isPaused returns true only for paused state', async () => {
			expect(lifecycleManager.isPaused()).toBe(false);

			await lifecycleManager.transitionTo('paused');
			expect(lifecycleManager.isPaused()).toBe(true);

			lifecycleManager.forceState('idle');
			expect(lifecycleManager.isPaused()).toBe(false);
		});

		it('isIdle returns true only for idle state', async () => {
			expect(lifecycleManager.isIdle()).toBe(true);

			await lifecycleManager.transitionTo('planning');
			expect(lifecycleManager.isIdle()).toBe(false);

			lifecycleManager.forceState('idle');
			expect(lifecycleManager.isIdle()).toBe(true);
		});

		it('isExecuting returns true only for executing state', async () => {
			expect(lifecycleManager.isExecuting()).toBe(false);

			await lifecycleManager.transitionTo('planning');
			await lifecycleManager.transitionTo('executing');
			expect(lifecycleManager.isExecuting()).toBe(true);

			lifecycleManager.forceState('idle');
			expect(lifecycleManager.isExecuting()).toBe(false);
		});
	});

	describe('error tracking', () => {
		beforeEach(() => {
			lifecycleManager.initialize();
			trackedEvents.length = 0;
		});

		it('should record errors', async () => {
			await lifecycleManager.recordError(new Error('Test error'), false);

			const state = lifecycleManager.getState();
			expect(state.errorCount).toBe(1);
			expect(state.lastError).toBe('Test error');
		});

		it('should emit error event when recording error', async () => {
			await lifecycleManager.recordError(new Error('Test error'), false);

			expect(trackedEvents).toHaveLength(1);
			expect(trackedEvents[0].event).toBe('roomAgent.error');
			expect(trackedEvents[0].data).toEqual({
				sessionId: `room:${roomId}`,
				roomId,
				error: 'Test error',
				errorCount: 1,
			});
		});

		it('should transition to error state after max errors', async () => {
			// Record multiple errors
			await lifecycleManager.recordError(new Error('Error 1'), false);
			await lifecycleManager.recordError(new Error('Error 2'), false);
			await lifecycleManager.recordError(new Error('Error 3'), true);

			expect(lifecycleManager.isInErrorState()).toBe(true);
			expect(lifecycleManager.getState().errorCount).toBe(3);
		});

		it('should not transition to error state when transitionToError is false', async () => {
			await lifecycleManager.recordError(new Error('Test error'), false);

			expect(lifecycleManager.getLifecycleState()).toBe('idle');
		});

		it('should clear error count on clearError', async () => {
			await lifecycleManager.transitionTo('error', 'Initial error');

			await lifecycleManager.clearError();

			const state = lifecycleManager.getState();
			expect(state.errorCount).toBe(0);
			expect(state.lastError).toBeNull();
			expect(state.lifecycleState).toBe('idle');
		});

		it('should not clear error when not in error state', async () => {
			const result = await lifecycleManager.clearError();

			expect(result).toBeNull();
		});
	});

	describe('session pair tracking', () => {
		beforeEach(() => {
			lifecycleManager.initialize();
		});

		it('should add active session pair', () => {
			lifecycleManager.addActiveSessionPair('pair-1');

			const state = lifecycleManager.getState();
			expect(state.activeSessionPairIds).toContain('pair-1');
		});

		it('should remove active session pair', () => {
			lifecycleManager.addActiveSessionPair('pair-1');
			lifecycleManager.addActiveSessionPair('pair-2');

			lifecycleManager.removeActiveSessionPair('pair-1');

			const state = lifecycleManager.getState();
			expect(state.activeSessionPairIds).not.toContain('pair-1');
			expect(state.activeSessionPairIds).toContain('pair-2');
		});

		it('should track active pair count', () => {
			expect(lifecycleManager.getState().activeSessionPairIds).toHaveLength(0);

			lifecycleManager.addActiveSessionPair('pair-1');
			expect(lifecycleManager.getState().activeSessionPairIds).toHaveLength(1);

			lifecycleManager.addActiveSessionPair('pair-2');
			expect(lifecycleManager.getState().activeSessionPairIds).toHaveLength(2);

			lifecycleManager.removeActiveSessionPair('pair-1');
			expect(lifecycleManager.getState().activeSessionPairIds).toHaveLength(1);
		});

		it('should not duplicate pair IDs', () => {
			lifecycleManager.addActiveSessionPair('pair-1');
			lifecycleManager.addActiveSessionPair('pair-1');

			const state = lifecycleManager.getState();
			expect(state.activeSessionPairIds).toHaveLength(1);
		});

		it('should handle removing non-existent pair', () => {
			lifecycleManager.addActiveSessionPair('pair-1');
			lifecycleManager.removeActiveSessionPair('non-existent');

			const state = lifecycleManager.getState();
			expect(state.activeSessionPairIds).toHaveLength(1);
		});
	});

	describe('event emission', () => {
		beforeEach(() => {
			lifecycleManager.initialize();
			trackedEvents.length = 0;
		});

		it('should emit stateChanged event on transition', async () => {
			await lifecycleManager.transitionTo('planning', 'Test reason');

			expect(trackedEvents).toHaveLength(1);
			expect(trackedEvents[0].event).toBe('roomAgent.stateChanged');
			expect(trackedEvents[0].data).toEqual({
				sessionId: `room:${roomId}`,
				roomId,
				previousState: 'idle',
				newState: 'planning',
				reason: 'Test reason',
			});
		});

		it('should emit idle event when entering idle', async () => {
			await lifecycleManager.transitionTo('planning');
			trackedEvents.length = 0;

			await lifecycleManager.transitionTo('idle', 'Tasks completed');

			// Should emit both stateChanged and idle events
			expect(trackedEvents).toHaveLength(2);
			const events = trackedEvents.map((e) => e.event);
			expect(events).toContain('roomAgent.stateChanged');
			expect(events).toContain('roomAgent.idle');
		});

		it('should emit error event when entering error', async () => {
			await lifecycleManager.recordError(new Error('Critical error'), true);

			const errorEvents = trackedEvents.filter((e) => e.event === 'roomAgent.error');
			const stateChangedEvents = trackedEvents.filter((e) => e.event === 'roomAgent.stateChanged');

			expect(errorEvents).toHaveLength(1);
			expect(stateChangedEvents).toHaveLength(1);
			expect(stateChangedEvents[0].data).toMatchObject({
				previousState: 'idle',
				newState: 'error',
			});
		});

		it('should include previous and new state in stateChanged event', async () => {
			await lifecycleManager.transitionTo('planning');
			await lifecycleManager.transitionTo('executing');
			trackedEvents.length = 0;

			await lifecycleManager.transitionTo('reviewing', 'All done');

			expect(trackedEvents[0].data).toMatchObject({
				previousState: 'executing',
				newState: 'reviewing',
				reason: 'All done',
			});
		});

		it('should emit idle event with pending work context', async () => {
			// Set up some pending work
			lifecycleManager.addPendingAction('action-1');
			lifecycleManager.setCurrentGoal('goal-1');

			await lifecycleManager.transitionTo('planning');
			await lifecycleManager.transitionTo('executing');
			trackedEvents.length = 0;

			await lifecycleManager.transitionTo('idle');

			const idleEvent = trackedEvents.find((e) => e.event === 'roomAgent.idle');
			expect(idleEvent).toBeDefined();
			expect(idleEvent?.data).toMatchObject({
				sessionId: `room:${roomId}`,
				roomId,
				hasPendingTasks: true,
				hasIncompleteGoals: true,
			});
		});
	});

	describe('convenience methods', () => {
		beforeEach(() => {
			lifecycleManager.initialize();
			trackedEvents.length = 0;
		});

		describe('pause', () => {
			it('should transition to paused state', async () => {
				const result = await lifecycleManager.pause();

				expect(result).not.toBeNull();
				expect(result?.lifecycleState).toBe('paused');
			});

			it('should return current state if already paused', async () => {
				await lifecycleManager.transitionTo('paused');
				trackedEvents.length = 0;

				const result = await lifecycleManager.pause();

				expect(result?.lifecycleState).toBe('paused');
				// Should not emit additional events
				expect(trackedEvents).toHaveLength(0);
			});
		});

		describe('resume', () => {
			it('should transition from paused to idle', async () => {
				await lifecycleManager.transitionTo('paused');
				trackedEvents.length = 0;

				const result = await lifecycleManager.resume();

				expect(result).not.toBeNull();
				expect(result?.lifecycleState).toBe('idle');
			});

			it('should return null if not paused', async () => {
				const result = await lifecycleManager.resume();

				expect(result).toBeNull();
			});
		});

		describe('startPlanning', () => {
			it('should transition to planning from idle', async () => {
				const result = await lifecycleManager.startPlanning('Event received');

				expect(result).not.toBeNull();
				expect(result?.lifecycleState).toBe('planning');
			});

			it('should return null if cannot start planning', async () => {
				await lifecycleManager.transitionTo('paused');
				trackedEvents.length = 0;

				const result = await lifecycleManager.startPlanning();

				expect(result).toBeNull();
			});
		});

		describe('startExecuting', () => {
			it('should transition to executing from planning', async () => {
				await lifecycleManager.transitionTo('planning');
				trackedEvents.length = 0;

				const result = await lifecycleManager.startExecuting();

				expect(result).not.toBeNull();
				expect(result?.lifecycleState).toBe('executing');
			});

			it('should return null if not in planning state', async () => {
				const result = await lifecycleManager.startExecuting();

				expect(result).toBeNull();
			});
		});

		describe('waitForInput', () => {
			it('should transition to waiting state from planning', async () => {
				await lifecycleManager.transitionTo('planning');
				trackedEvents.length = 0;

				const result = await lifecycleManager.waitForInput('Review needed');

				expect(result).not.toBeNull();
				expect(result?.lifecycleState).toBe('waiting');
			});

			it('should return null if paused', async () => {
				await lifecycleManager.transitionTo('paused');
				trackedEvents.length = 0;

				const result = await lifecycleManager.waitForInput('Cannot wait');

				expect(result).toBeNull();
			});
		});

		describe('receiveInput', () => {
			it('should transition from waiting to planning', async () => {
				await lifecycleManager.transitionTo('planning');
				await lifecycleManager.transitionTo('waiting');
				trackedEvents.length = 0;

				const result = await lifecycleManager.receiveInput();

				expect(result).not.toBeNull();
				expect(result?.lifecycleState).toBe('planning');
			});

			it('should return null if not in waiting state', async () => {
				const result = await lifecycleManager.receiveInput();

				expect(result).toBeNull();
			});
		});

		describe('startReviewing', () => {
			it('should transition to reviewing from executing', async () => {
				await lifecycleManager.transitionTo('planning');
				await lifecycleManager.transitionTo('executing');
				trackedEvents.length = 0;

				const result = await lifecycleManager.startReviewing();

				expect(result).not.toBeNull();
				expect(result?.lifecycleState).toBe('reviewing');
			});

			it('should return null if not in executing state', async () => {
				const result = await lifecycleManager.startReviewing();

				expect(result).toBeNull();
			});
		});

		describe('completeReviewing', () => {
			it('should transition to planning when has more work', async () => {
				await lifecycleManager.transitionTo('planning');
				await lifecycleManager.transitionTo('executing');
				await lifecycleManager.transitionTo('reviewing');
				trackedEvents.length = 0;

				const result = await lifecycleManager.completeReviewing(true);

				expect(result?.lifecycleState).toBe('planning');
			});

			it('should transition to idle when no more work', async () => {
				await lifecycleManager.transitionTo('planning');
				await lifecycleManager.transitionTo('executing');
				await lifecycleManager.transitionTo('reviewing');
				trackedEvents.length = 0;

				const result = await lifecycleManager.completeReviewing(false);

				expect(result?.lifecycleState).toBe('idle');
			});
		});

		describe('finishExecution', () => {
			it('should transition to idle from executing', async () => {
				await lifecycleManager.transitionTo('planning');
				await lifecycleManager.transitionTo('executing');
				trackedEvents.length = 0;

				const result = await lifecycleManager.finishExecution();

				expect(result).not.toBeNull();
				expect(result?.lifecycleState).toBe('idle');
			});

			it('should return null if not in executing state', async () => {
				const result = await lifecycleManager.finishExecution();

				expect(result).toBeNull();
			});
		});
	});

	describe('goal and task tracking', () => {
		beforeEach(() => {
			lifecycleManager.initialize();
		});

		it('should set current goal', () => {
			lifecycleManager.setCurrentGoal('goal-123');

			const state = lifecycleManager.getState();
			expect(state.currentGoalId).toBe('goal-123');
		});

		it('should clear current goal', () => {
			lifecycleManager.setCurrentGoal('goal-123');
			lifecycleManager.setCurrentGoal(null);

			const state = lifecycleManager.getState();
			expect(state.currentGoalId).toBeNull();
		});

		it('should set current task', () => {
			lifecycleManager.setCurrentTask('task-456');

			const state = lifecycleManager.getState();
			expect(state.currentTaskId).toBe('task-456');
		});

		it('should clear current task', () => {
			lifecycleManager.setCurrentTask('task-456');
			lifecycleManager.setCurrentTask(null);

			const state = lifecycleManager.getState();
			expect(state.currentTaskId).toBeNull();
		});
	});

	describe('pending actions', () => {
		beforeEach(() => {
			lifecycleManager.initialize();
		});

		it('should add pending action', () => {
			lifecycleManager.addPendingAction('action-1');

			const state = lifecycleManager.getState();
			expect(state.pendingActions).toContain('action-1');
		});

		it('should remove pending action', () => {
			lifecycleManager.addPendingAction('action-1');
			lifecycleManager.addPendingAction('action-2');

			lifecycleManager.removePendingAction('action-1');

			const state = lifecycleManager.getState();
			expect(state.pendingActions).not.toContain('action-1');
			expect(state.pendingActions).toContain('action-2');
		});

		it('should clear all pending actions', () => {
			lifecycleManager.addPendingAction('action-1');
			lifecycleManager.addPendingAction('action-2');

			lifecycleManager.clearPendingActions();

			const state = lifecycleManager.getState();
			expect(state.pendingActions).toEqual([]);
		});
	});

	describe('forceState', () => {
		beforeEach(() => {
			lifecycleManager.initialize();
		});

		it('should force state without validation', () => {
			// This is normally an invalid transition (idle -> executing)
			const result = lifecycleManager.forceState('executing');

			expect(result.lifecycleState).toBe('executing');
			expect(lifecycleManager.getLifecycleState()).toBe('executing');
		});

		it('should not emit events', () => {
			trackedEvents.length = 0;

			lifecycleManager.forceState('error');

			// forceState should not emit events
			expect(trackedEvents).toHaveLength(0);
		});
	});

	describe('getState', () => {
		it('should return current state', () => {
			lifecycleManager.initialize();

			const state = lifecycleManager.getState();

			expect(state).toBeDefined();
			expect(state.roomId).toBe(roomId);
		});

		it('should create state if not initialized', () => {
			// Create manager without calling initialize
			const newManager = new RoomAgentLifecycleManager(roomId, db, mockDaemonHub);

			const state = newManager.getState();

			expect(state).toBeDefined();
			expect(state.lifecycleState).toBe('idle');
		});
	});

	describe('multiple rooms', () => {
		it('should isolate state between rooms', async () => {
			// Create another room and manager
			const room2 = roomManager.createRoom({ name: 'Room 2' });
			const manager2 = new RoomAgentLifecycleManager(room2.id, db, mockDaemonHub);

			lifecycleManager.initialize();
			manager2.initialize();

			// Transition first room to planning
			await lifecycleManager.transitionTo('planning');

			// Second room should still be idle
			expect(manager2.getLifecycleState()).toBe('idle');

			// Transition second room to paused
			await manager2.transitionTo('paused');

			// First room should still be planning
			expect(lifecycleManager.getLifecycleState()).toBe('planning');
		});
	});
});
