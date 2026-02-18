/**
 * RoomAgentService - Room agent lifecycle management
 *
 * THE CRITICAL PIECE for self-building automation.
 *
 * Responsibilities:
 * 1. Subscribe to room.message events (from GitHub integration)
 * 2. Parse GitHub events and create tasks
 * 3. Spawn Manager-Worker session pairs to execute work
 * 4. Monitor progress and report status
 * 5. Proactive scheduling (check for incomplete goals when idle)
 *
 * Lifecycle States:
 * - idle: No active work, waiting for events
 * - planning: Analyzing events/goals, deciding next actions
 * - executing: Work in progress (session pairs active)
 * - waiting: Waiting for external input (review, user response)
 * - reviewing: Reviewing completed work
 * - error: Error state, needs intervention
 * - paused: Manually paused
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import type { DaemonHub } from '../daemon-hub';
import type { MessageHub } from '@neokai/shared';
import { RoomAgentStateRepository } from '../../storage/repositories/room-agent-state-repository';
import { TaskRepository } from '../../storage/repositories/task-repository';
import { GoalRepository } from '../../storage/repositories/goal-repository';
import { SessionPairManager } from './session-pair-manager';
import { TaskManager } from './task-manager';
import { GoalManager } from './goal-manager';
import type {
	Room,
	RoomAgentState,
	RoomAgentLifecycleState,
	NeoTask,
	SessionPair,
} from '@neokai/shared';
import { Logger } from '../logger';

const log = new Logger('room-agent-service');

/**
 * Context passed to RoomAgentService
 */
export interface RoomAgentContext {
	room: Room;
	db: BunDatabase;
	daemonHub: DaemonHub;
	messageHub: MessageHub;
	sessionPairManager: SessionPairManager;
}

/**
 * Configuration for room agent behavior
 */
export interface RoomAgentConfig {
	/** Maximum concurrent session pairs per room */
	maxConcurrentPairs: number;
	/** Interval for idle check (ms) */
	idleCheckIntervalMs: number;
	/** Maximum error count before pausing */
	maxErrorCount: number;
	/** Auto-retry on task failure */
	autoRetryTasks: boolean;
}

const DEFAULT_CONFIG: RoomAgentConfig = {
	maxConcurrentPairs: 3,
	idleCheckIntervalMs: 60000, // 1 minute
	maxErrorCount: 5,
	autoRetryTasks: true,
};

/**
 * Room Agent Service
 *
 * Manages the lifecycle of a room's automation agent.
 */
export class RoomAgentService {
	private stateRepo: RoomAgentStateRepository;
	private taskRepo: TaskRepository;
	private goalRepo: GoalRepository;
	private taskManager: TaskManager;
	private goalManager: GoalManager;
	private state: RoomAgentState;
	private idleCheckTimer: Timer | null = null;
	private unsubscribers: Array<() => void> = [];
	private config: RoomAgentConfig;

	constructor(
		private ctx: RoomAgentContext,
		config?: Partial<RoomAgentConfig>
	) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.stateRepo = new RoomAgentStateRepository(ctx.db);
		this.taskRepo = new TaskRepository(ctx.db);
		this.goalRepo = new GoalRepository(ctx.db);
		this.taskManager = new TaskManager(ctx.db, ctx.room.id);
		this.goalManager = new GoalManager(ctx.db, ctx.room.id, ctx.daemonHub);

		// Get or create initial state
		this.state = this.stateRepo.getOrCreateState(ctx.room.id);
	}

	/**
	 * Start the room agent
	 */
	async start(): Promise<void> {
		log.info(`Starting room agent for room: ${this.ctx.room.name} (${this.ctx.room.id})`);

		// Subscribe to room.message events
		const unsubRoomMessage = this.ctx.daemonHub.on(
			'room.message',
			async (event) => {
				if (event.roomId === this.ctx.room.id) {
					await this.handleRoomMessage(event);
				}
			},
			{ sessionId: `room:${this.ctx.room.id}` }
		);
		this.unsubscribers.push(unsubRoomMessage);

		// Subscribe to task completion events
		const unsubTaskComplete = this.ctx.daemonHub.on(
			'pair.task_completed',
			async (event) => {
				const pair = this.ctx.sessionPairManager.getPair(event.pairId);
				if (pair && pair.roomId === this.ctx.room.id) {
					await this.handleTaskCompleted(event.taskId, event.summary);
				}
			},
			{ sessionId: `room:${this.ctx.room.id}` }
		);
		this.unsubscribers.push(unsubTaskComplete);

		// Start idle check timer
		this.startIdleCheck();

		// Transition to appropriate state
		if (this.state.lifecycleState === 'error') {
			// Clear error state on restart
			await this.transitionTo('idle', 'Agent restarted');
		}

		log.info(`Room agent started in state: ${this.state.lifecycleState}`);
	}

	/**
	 * Stop the room agent
	 */
	async stop(): Promise<void> {
		log.info(`Stopping room agent for room: ${this.ctx.room.id}`);

		// Stop idle check
		this.stopIdleCheck();

		// Unsubscribe from events
		for (const unsubscribe of this.unsubscribers) {
			unsubscribe();
		}
		this.unsubscribers = [];

		// Transition to paused
		await this.transitionTo('paused', 'Agent stopped');

		log.info(`Room agent stopped`);
	}

	/**
	 * Get current agent state
	 */
	getState(): RoomAgentState {
		return this.state;
	}

	/**
	 * Pause the agent
	 */
	async pause(): Promise<void> {
		await this.transitionTo('paused', 'Manually paused');
		this.stopIdleCheck();
	}

	/**
	 * Resume the agent
	 */
	async resume(): Promise<void> {
		await this.transitionTo('idle', 'Manually resumed');
		this.startIdleCheck();
	}

	/**
	 * Transition to a new lifecycle state
	 */
	private async transitionTo(newState: RoomAgentLifecycleState, reason?: string): Promise<void> {
		const previousState = this.state.lifecycleState;

		if (previousState === newState) {
			return;
		}

		log.info(`Room agent transitioning: ${previousState} -> ${newState}`, { reason });

		// Update state in database
		this.state = this.stateRepo.transitionTo(this.ctx.room.id, newState) ?? this.state;

		// Emit state change event
		await this.ctx.daemonHub.emit('roomAgent.stateChanged', {
			sessionId: `room:${this.ctx.room.id}`,
			roomId: this.ctx.room.id,
			previousState,
			newState,
			reason,
		});
	}

	/**
	 * Handle incoming room message (from GitHub, user, etc.)
	 */
	private async handleRoomMessage(event: {
		roomId: string;
		message: { id: string; role: string; content: string; timestamp: number };
		sender?: string;
	}): Promise<void> {
		log.debug(`Room message received:`, event.message.role);

		// Don't process if paused
		if (this.state.lifecycleState === 'paused') {
			log.debug(`Ignoring message - agent is paused`);
			return;
		}

		// Transition to planning
		await this.transitionTo('planning', `Processing ${event.message.role} message`);

		try {
			// Parse message based on role
			if (event.message.role === 'github_event') {
				await this.handleGitHubEvent(event.message.content);
			} else if (event.message.role === 'user') {
				await this.handleUserMessage(event.message.content, event.sender);
			}

			// Transition to executing or idle based on whether we spawned work
			const activePairs = this.state.activeSessionPairIds.length;
			if (activePairs > 0) {
				await this.transitionTo('executing', `Working on ${activePairs} tasks`);
			} else {
				await this.transitionTo('idle', 'No tasks to execute');
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			await this.recordError(errorMessage);
		}
	}

	/**
	 * Handle GitHub event (issue, PR, comment, etc.)
	 */
	private async handleGitHubEvent(content: string): Promise<void> {
		log.info(`Processing GitHub event`);

		// Parse GitHub event content
		// Format: "**{event_type} {action}**\nRepository: {repo}\nIssue #{number}: {title}\n..."
		const lines = content.split('\n');
		let eventType = '';
		let issueNumber = '';
		let issueTitle = '';
		let body = '';

		for (const line of lines) {
			if (line.startsWith('**') && line.endsWith('**')) {
				eventType = line.slice(2, -2);
			} else if (line.startsWith('Issue #')) {
				const match = line.match(/Issue #(\d+): (.+)/);
				if (match) {
					issueNumber = match[1];
					issueTitle = match[2];
				}
			} else if (line.startsWith('Body: ') || line.startsWith('Comment: ')) {
				body = line.slice(line.indexOf(': ') + 2);
			}
		}

		// Create task from GitHub event
		const task = await this.taskManager.createTask({
			title: issueTitle || `GitHub ${eventType}`,
			description: `GitHub Event: ${eventType}\n\nIssue #${issueNumber}\n\n${body}`,
			priority: eventType.includes('opened') ? 'high' : 'normal',
		});

		log.info(`Created task ${task.id} from GitHub event`);

		// Spawn worker if capacity available
		await this.maybeSpawnWorker(task);
	}

	/**
	 * Handle user message (from room chat)
	 */
	private async handleUserMessage(content: string, sender?: string): Promise<void> {
		log.info(`Processing user message from ${sender ?? 'unknown'}`);

		// Check if this is a command
		if (content.startsWith('/')) {
			await this.handleCommand(content);
			return;
		}

		// Create task from user message
		const task = await this.taskManager.createTask({
			title: content.slice(0, 100),
			description: `User request from ${sender ?? 'unknown'}:\n\n${content}`,
			priority: 'normal',
		});

		log.info(`Created task ${task.id} from user message`);

		// Spawn worker if capacity available
		await this.maybeSpawnWorker(task);
	}

	/**
	 * Handle slash commands
	 */
	private async handleCommand(content: string): Promise<void> {
		const command = content.split(' ')[0].toLowerCase();

		switch (command) {
			case '/status':
				// Report current status (emit as room message)
				await this.ctx.daemonHub.emit('room.message', {
					sessionId: `room:${this.ctx.room.id}`,
					roomId: this.ctx.room.id,
					message: {
						id: `status-${Date.now()}`,
						role: 'assistant',
						content: `Agent Status: ${this.state.lifecycleState}\nActive pairs: ${this.state.activeSessionPairIds.length}\nErrors: ${this.state.errorCount}`,
						timestamp: Date.now(),
					},
					sender: 'Neo',
				});
				break;

			case '/pause':
				await this.pause();
				break;

			case '/resume':
				await this.resume();
				break;

			case '/goals':
				const goals = await this.goalManager.listGoals();
				const goalSummary = goals
					.map((g) => `- ${g.title} (${g.status}, ${g.progress}%)`)
					.join('\n');
				await this.ctx.daemonHub.emit('room.message', {
					sessionId: `room:${this.ctx.room.id}`,
					roomId: this.ctx.room.id,
					message: {
						id: `goals-${Date.now()}`,
						role: 'assistant',
						content: `Goals:\n${goalSummary || 'No goals defined'}`,
						timestamp: Date.now(),
					},
					sender: 'Neo',
				});
				break;

			default:
				log.warn(`Unknown command: ${command}`);
		}
	}

	/**
	 * Maybe spawn a worker for a task
	 */
	private async maybeSpawnWorker(task: NeoTask): Promise<SessionPair | null> {
		// Check capacity
		if (this.state.activeSessionPairIds.length >= this.config.maxConcurrentPairs) {
			log.info(
				`At capacity (${this.state.activeSessionPairIds.length}/${this.config.maxConcurrentPairs}), queuing task ${task.id}`
			);
			return null;
		}

		// Check if we have a room session to create pairs from
		// For now, we need to create a room session first
		// This will be enhanced when we have the Neo room session
		log.info(`Spawning worker for task ${task.id}`);

		try {
			// Create session pair with task
			const result = await this.ctx.sessionPairManager.createPair({
				roomId: this.ctx.room.id,
				roomSessionId: `room:${this.ctx.room.id}`, // Placeholder
				taskTitle: task.title,
				taskDescription: task.description,
				workspacePath: this.ctx.room.defaultPath ?? this.ctx.room.allowedPaths[0],
			});

			// Update agent state with active pair
			this.state =
				this.stateRepo.addActiveSessionPair(this.ctx.room.id, result.pair.id) ?? this.state;

			// Start the task
			await this.taskManager.startTask(task.id, result.pair.workerSessionId);

			// Update pair with task ID
			// Note: SessionPairManager.createPair already creates a task
			// We should link our task to the pair instead

			log.info(`Spawned session pair ${result.pair.id} for task ${task.id}`);
			return result.pair;
		} catch (error) {
			log.error(`Failed to spawn worker for task ${task.id}:`, error);
			return null;
		}
	}

	/**
	 * Handle task completion
	 */
	private async handleTaskCompleted(taskId: string, summary: string): Promise<void> {
		log.info(`Task ${taskId} completed: ${summary.slice(0, 100)}...`);

		// Complete the task
		await this.taskManager.completeTask(taskId, summary);

		// Update goals linked to this task
		await this.goalManager.updateGoalsForTask(taskId);

		// Remove from active pairs
		// Note: We need to find which pair was working on this task
		const pairs = this.ctx.sessionPairManager.getPairsByRoom(this.ctx.room.id);
		const completedPair = pairs.find((p) => p.currentTaskId === taskId);
		if (completedPair) {
			this.state =
				this.stateRepo.removeActiveSessionPair(this.ctx.room.id, completedPair.id) ?? this.state;
		}

		// Check if we should transition to idle
		if (this.state.activeSessionPairIds.length === 0) {
			await this.transitionTo('idle', 'All tasks completed');
		}
	}

	/**
	 * Record an error
	 */
	private async recordError(error: string): Promise<void> {
		this.state = this.stateRepo.recordError(this.ctx.room.id, error) ?? this.state;

		// Emit error event
		await this.ctx.daemonHub.emit('roomAgent.error', {
			sessionId: `room:${this.ctx.room.id}`,
			roomId: this.ctx.room.id,
			error,
			errorCount: this.state.errorCount,
		});

		// Transition to error if too many errors
		if (this.state.errorCount >= this.config.maxErrorCount) {
			await this.transitionTo('error', `Max errors reached (${this.state.errorCount})`);
			this.stopIdleCheck();
		}
	}

	/**
	 * Start idle check timer
	 */
	private startIdleCheck(): void {
		if (this.idleCheckTimer) {
			clearInterval(this.idleCheckTimer);
		}

		this.idleCheckTimer = setInterval(() => {
			this.checkIdleState().catch((error) => {
				log.error('Error in idle check:', error);
			});
		}, this.config.idleCheckIntervalMs);
	}

	/**
	 * Stop idle check timer
	 */
	private stopIdleCheck(): void {
		if (this.idleCheckTimer) {
			clearInterval(this.idleCheckTimer);
			this.idleCheckTimer = null;
		}
	}

	/**
	 * Check idle state and take action if needed
	 */
	private async checkIdleState(): Promise<void> {
		// Only check if idle and not paused
		if (this.state.lifecycleState !== 'idle') {
			return;
		}

		log.debug('Checking idle state...');

		// Check for pending tasks
		const pendingTasks = await this.taskManager.listTasks({ status: 'pending' });
		const inProgressTasks = await this.taskManager.listTasks({ status: 'in_progress' });

		// Check for incomplete goals
		const activeGoals = await this.goalManager.getActiveGoals();

		// Emit idle event with status
		await this.ctx.daemonHub.emit('roomAgent.idle', {
			sessionId: `room:${this.ctx.room.id}`,
			roomId: this.ctx.room.id,
			hasPendingTasks: pendingTasks.length > 0,
			hasIncompleteGoals: activeGoals.length > 0,
		});

		// If there are pending tasks, try to spawn workers
		if (pendingTasks.length > 0 && inProgressTasks.length < this.config.maxConcurrentPairs) {
			log.info(`Found ${pendingTasks.length} pending tasks, attempting to spawn workers`);
			const nextTask = await this.taskManager.getNextPendingTask();
			if (nextTask) {
				await this.maybeSpawnWorker(nextTask);
			}
		}
	}

	/**
	 * Force a specific state (for debugging/testing)
	 */
	async forceState(newState: RoomAgentLifecycleState): Promise<void> {
		await this.transitionTo(newState, 'Forced state change');
	}
}
