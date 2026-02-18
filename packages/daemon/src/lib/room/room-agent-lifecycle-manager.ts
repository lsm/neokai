/**
 * RoomAgentLifecycleManager - Manages room-level agent lifecycle
 *
 * States:
 * - idle: No active work, waiting for events
 * - planning: Analyzing goals/events, deciding actions
 * - executing: Session pairs active, work in progress
 * - waiting: Waiting for human input (review, approval)
 * - reviewing: Reviewing completed work
 * - error: Error state, needs intervention
 * - paused: Manually paused
 *
 * State Transitions:
 * - idle -> planning: Event received or proactive check
 * - planning -> executing: Tasks spawned
 * - planning -> idle: No tasks to execute
 * - executing -> reviewing: All tasks completed
 * - executing -> idle: Tasks completed, nothing more
 * - * -> waiting: Review/escalation requested
 * - waiting -> planning: Human input received
 * - * -> error: Error occurred
 * - * -> paused: stop() called
 * - paused -> idle: resume() called
 * - error -> idle: restart
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type { RoomAgentState, RoomAgentLifecycleState } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { Database } from '../../storage/index';
import { RoomAgentStateRepository } from '../../storage/repositories/room-agent-state-repository';
import { Logger } from '../logger';

/**
 * Valid state transitions map
 * Defines which states can transition to which other states
 */
const VALID_TRANSITIONS: Record<RoomAgentLifecycleState, Set<RoomAgentLifecycleState>> = {
	idle: new Set(['planning', 'error', 'paused']),
	planning: new Set(['executing', 'idle', 'waiting', 'error', 'paused']),
	executing: new Set(['reviewing', 'idle', 'waiting', 'error', 'paused']),
	waiting: new Set(['planning', 'error', 'paused']),
	reviewing: new Set(['planning', 'idle', 'error', 'paused']),
	error: new Set(['idle', 'paused']),
	paused: new Set(['idle']),
};

/**
 * States where event processing is allowed
 */
const EVENT_PROCESSING_STATES: Set<RoomAgentLifecycleState> = new Set([
	'idle',
	'planning',
	'executing',
]);

/**
 * States where planning can be started
 */
const PLANNING_ALLOWED_STATES: Set<RoomAgentLifecycleState> = new Set(['idle', 'reviewing']);

/**
 * States where worker spawning is allowed
 */
const WORKER_SPAWN_STATES: Set<RoomAgentLifecycleState> = new Set(['planning', 'executing']);

export class RoomAgentLifecycleManager {
	private logger: Logger;
	private currentState: RoomAgentState | null = null;
	private stateRepository: RoomAgentStateRepository;

	constructor(
		private roomId: string,
		db: Database | BunDatabase,
		private daemonHub: DaemonHub
	) {
		this.logger = new Logger(`RoomAgentLifecycle ${roomId}`);
		// Handle both Database wrapper and raw BunDatabase
		const rawDb = 'getDatabase' in db ? db.getDatabase() : db;
		this.stateRepository = new RoomAgentStateRepository(rawDb);
	}

	/**
	 * Initialize or restore state from database
	 * Should be called when the room agent starts
	 */
	initialize(): RoomAgentState {
		this.currentState = this.stateRepository.getOrCreateState(this.roomId);
		this.logger.info(`Initialized with state: ${this.currentState.lifecycleState}`);
		return this.currentState;
	}

	/**
	 * Get current state
	 */
	getState(): RoomAgentState {
		if (!this.currentState) {
			this.currentState = this.stateRepository.getOrCreateState(this.roomId);
		}
		return this.currentState;
	}

	/**
	 * Get current lifecycle state
	 */
	getLifecycleState(): RoomAgentLifecycleState {
		return this.getState().lifecycleState;
	}

	/**
	 * Transition to a new state with validation
	 * @param newState The target state
	 * @param reason Optional reason for the transition
	 * @returns The new state, or null if transition was invalid
	 */
	async transitionTo(
		newState: RoomAgentLifecycleState,
		reason?: string
	): Promise<RoomAgentState | null> {
		const current = this.getState();
		const previousState = current.lifecycleState;

		// Validate transition
		if (!this.isValidTransition(previousState, newState)) {
			this.logger.warn(
				`Invalid transition from ${previousState} to ${newState}. Reason: ${reason ?? 'none'}`
			);
			return null;
		}

		// Perform transition
		this.currentState = this.stateRepository.transitionTo(this.roomId, newState);

		if (!this.currentState) {
			this.logger.error(`Failed to persist state transition to ${newState}`);
			return null;
		}

		this.logger.info(
			`Transitioned: ${previousState} -> ${newState}${reason ? ` (${reason})` : ''}`
		);

		// Emit state change event
		await this.daemonHub.emit('roomAgent.stateChanged', {
			sessionId: `room:${this.roomId}`,
			roomId: this.roomId,
			previousState,
			newState,
			reason,
		});

		// Emit idle event if transitioning to idle
		if (newState === 'idle') {
			await this.emitIdleEvent();
		}

		return this.currentState;
	}

	/**
	 * Check if can process events
	 * Returns true for idle, planning, and executing states
	 */
	canProcessEvent(): boolean {
		return EVENT_PROCESSING_STATES.has(this.getLifecycleState());
	}

	/**
	 * Check if can start planning
	 * Returns true for idle and reviewing states
	 */
	canStartPlanning(): boolean {
		return PLANNING_ALLOWED_STATES.has(this.getLifecycleState());
	}

	/**
	 * Check if can spawn workers
	 * Returns true for planning and executing states
	 */
	canSpawnWorker(): boolean {
		return WORKER_SPAWN_STATES.has(this.getLifecycleState());
	}

	/**
	 * Check if in waiting state
	 */
	isWaitingForInput(): boolean {
		return this.getLifecycleState() === 'waiting';
	}

	/**
	 * Check if in error state
	 */
	isInErrorState(): boolean {
		return this.getLifecycleState() === 'error';
	}

	/**
	 * Check if paused
	 */
	isPaused(): boolean {
		return this.getLifecycleState() === 'paused';
	}

	/**
	 * Check if idle
	 */
	isIdle(): boolean {
		return this.getLifecycleState() === 'idle';
	}

	/**
	 * Check if executing
	 */
	isExecuting(): boolean {
		return this.getLifecycleState() === 'executing';
	}

	/**
	 * Record an error and potentially transition to error state
	 * @param error The error that occurred
	 * @param transitionToError Whether to transition to error state (default: true)
	 */
	async recordError(error: Error, transitionToError: boolean = true): Promise<void> {
		const errorMessage = error.message;
		this.logger.error(`Recording error: ${errorMessage}`);

		// Update error state in repository
		this.currentState = this.stateRepository.recordError(this.roomId, errorMessage);

		// Emit error event
		await this.daemonHub.emit('roomAgent.error', {
			sessionId: `room:${this.roomId}`,
			roomId: this.roomId,
			error: errorMessage,
			errorCount: this.currentState?.errorCount ?? 1,
		});

		// Transition to error state if requested and not already in error/paused
		if (
			transitionToError &&
			this.getLifecycleState() !== 'error' &&
			this.getLifecycleState() !== 'paused'
		) {
			await this.transitionTo('error', errorMessage);
		}
	}

	/**
	 * Clear error state and return to idle
	 */
	async clearError(): Promise<RoomAgentState | null> {
		if (this.getLifecycleState() !== 'error') {
			this.logger.warn('clearError called but not in error state');
			return null;
		}

		this.currentState = this.stateRepository.clearError(this.roomId);
		return this.transitionTo('idle', 'Error cleared');
	}

	/**
	 * Pause the agent
	 * Can be called from any state
	 */
	async pause(): Promise<RoomAgentState | null> {
		const current = this.getLifecycleState();
		if (current === 'paused') {
			this.logger.warn('pause called but already paused');
			return this.getState();
		}

		return this.transitionTo('paused', 'Manual pause');
	}

	/**
	 * Resume from paused state
	 */
	async resume(): Promise<RoomAgentState | null> {
		if (this.getLifecycleState() !== 'paused') {
			this.logger.warn('resume called but not in paused state');
			return null;
		}

		return this.transitionTo('idle', 'Manual resume');
	}

	/**
	 * Start planning phase
	 */
	async startPlanning(reason?: string): Promise<RoomAgentState | null> {
		if (!this.canStartPlanning()) {
			this.logger.warn(`Cannot start planning from state: ${this.getLifecycleState()}`);
			return null;
		}

		return this.transitionTo('planning', reason ?? 'Planning started');
	}

	/**
	 * Start executing phase
	 */
	async startExecuting(): Promise<RoomAgentState | null> {
		const current = this.getLifecycleState();
		if (current !== 'planning') {
			this.logger.warn(`Cannot start executing from state: ${current}`);
			return null;
		}

		return this.transitionTo('executing', 'Tasks spawned');
	}

	/**
	 * Transition to waiting state
	 */
	async waitForInput(reason?: string): Promise<RoomAgentState | null> {
		const current = this.getLifecycleState();
		if (current === 'paused') {
			this.logger.warn('Cannot wait for input while paused');
			return null;
		}

		return this.transitionTo('waiting', reason ?? 'Waiting for input');
	}

	/**
	 * Resume from waiting after receiving input
	 */
	async receiveInput(): Promise<RoomAgentState | null> {
		if (!this.isWaitingForInput()) {
			this.logger.warn('receiveInput called but not in waiting state');
			return null;
		}

		return this.transitionTo('planning', 'Human input received');
	}

	/**
	 * Start reviewing phase
	 */
	async startReviewing(): Promise<RoomAgentState | null> {
		const current = this.getLifecycleState();
		if (current !== 'executing') {
			this.logger.warn(`Cannot start reviewing from state: ${current}`);
			return null;
		}

		return this.transitionTo('reviewing', 'All tasks completed');
	}

	/**
	 * Complete reviewing and return to appropriate state
	 */
	async completeReviewing(hasMoreWork: boolean): Promise<RoomAgentState | null> {
		const current = this.getLifecycleState();
		if (current !== 'reviewing') {
			this.logger.warn(`Cannot complete reviewing from state: ${current}`);
			return null;
		}

		if (hasMoreWork) {
			return this.transitionTo('planning', 'Review complete, more work pending');
		}
		return this.transitionTo('idle', 'Review complete');
	}

	/**
	 * Finish execution and return to idle
	 */
	async finishExecution(): Promise<RoomAgentState | null> {
		const current = this.getLifecycleState();
		if (current !== 'executing') {
			this.logger.warn(`Cannot finish execution from state: ${current}`);
			return null;
		}

		return this.transitionTo('idle', 'Tasks completed');
	}

	/**
	 * Validate if a state transition is allowed
	 */
	private isValidTransition(from: RoomAgentLifecycleState, to: RoomAgentLifecycleState): boolean {
		// Same state is always valid (no-op)
		if (from === to) {
			return true;
		}

		const allowedTargets = VALID_TRANSITIONS[from];
		return allowedTargets ? allowedTargets.has(to) : false;
	}

	/**
	 * Emit idle event with context about pending work
	 */
	private async emitIdleEvent(): Promise<void> {
		const state = this.getState();

		// Check for pending tasks and incomplete goals
		const hasPendingTasks = state.pendingActions.length > 0;
		const hasIncompleteGoals = state.currentGoalId !== undefined;

		await this.daemonHub.emit('roomAgent.idle', {
			sessionId: `room:${this.roomId}`,
			roomId: this.roomId,
			hasPendingTasks,
			hasIncompleteGoals,
		});
	}

	/**
	 * Update current goal
	 */
	setCurrentGoal(goalId: string | null): void {
		this.currentState = this.stateRepository.updateState(this.roomId, {
			currentGoalId: goalId,
			lastActivityAt: Date.now(),
		});
	}

	/**
	 * Update current task
	 */
	setCurrentTask(taskId: string | null): void {
		this.currentState = this.stateRepository.updateState(this.roomId, {
			currentTaskId: taskId,
			lastActivityAt: Date.now(),
		});
	}

	/**
	 * Add an active session pair
	 */
	addActiveSessionPair(pairId: string): void {
		this.currentState = this.stateRepository.addActiveSessionPair(this.roomId, pairId);
	}

	/**
	 * Remove an active session pair
	 */
	removeActiveSessionPair(pairId: string): void {
		this.currentState = this.stateRepository.removeActiveSessionPair(this.roomId, pairId);
	}

	/**
	 * Add a pending action
	 */
	addPendingAction(action: string): void {
		this.stateRepository.addPendingAction(this.roomId, action);
		this.currentState = this.stateRepository.getState(this.roomId);
	}

	/**
	 * Remove a pending action
	 */
	removePendingAction(action: string): void {
		this.stateRepository.removePendingAction(this.roomId, action);
		this.currentState = this.stateRepository.getState(this.roomId);
	}

	/**
	 * Clear all pending actions
	 */
	clearPendingActions(): void {
		this.stateRepository.clearPendingActions(this.roomId);
		this.currentState = this.stateRepository.getState(this.roomId);
	}

	/**
	 * Force state without validation (for testing)
	 */
	forceState(newState: RoomAgentLifecycleState): RoomAgentState {
		this.currentState = this.stateRepository.transitionTo(this.roomId, newState);
		return this.getState();
	}
}
