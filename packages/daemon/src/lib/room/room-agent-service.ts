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

import type { DaemonHub } from '../daemon-hub';
import type { MessageHub } from '@neokai/shared';
import type { Database as BunDatabase } from 'bun:sqlite';
import type { Database } from '../../storage/index';
import { RoomAgentStateRepository } from '../../storage/repositories/room-agent-state-repository';
import { TaskRepository } from '../../storage/repositories/task-repository';
import { GoalRepository } from '../../storage/repositories/goal-repository';
import { SessionPairManager } from './session-pair-manager';
import { TaskManager } from './task-manager';
import { GoalManager } from './goal-manager';
import { RecurringJobScheduler } from './recurring-job-scheduler';
import {
	RoomAgentSession,
	type RoomAgentSessionContext,
	type RoomAgentHumanInput as SessionHumanInput,
} from './room-agent-session';
import { RoomAgentLifecycleManager } from './room-agent-lifecycle-manager';
import { QARoundManager, type QARoundManagerContext } from './qa-round-manager';
import type { PromptTemplateManager } from '../prompts/prompt-template-manager';
import type {
	Room,
	RoomAgentState,
	RoomAgentLifecycleState,
	RoomAgentHumanInput,
	RoomAgentWaitingContext,
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
	db: Database | BunDatabase;
	daemonHub: DaemonHub;
	messageHub: MessageHub;
	sessionPairManager: SessionPairManager;
	/** API key provider function */
	getApiKey: () => Promise<string | null>;
	/** Prompt template manager */
	promptTemplateManager: PromptTemplateManager;
	/** Recurring job scheduler */
	recurringJobScheduler: RecurringJobScheduler;
	/** Model to use for the agent */
	model?: string;
	/** Maximum concurrent workers */
	maxConcurrentWorkers?: number;
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
 * Integrates RoomAgentSession for AI orchestration and
 * RoomAgentLifecycleManager for state transitions.
 */
export class RoomAgentService {
	private stateRepo: RoomAgentStateRepository;
	private taskRepo: TaskRepository;
	private goalRepo: GoalRepository;
	private taskManager: TaskManager;
	private goalManager: GoalManager;
	private state: RoomAgentState;
	private waitingContext: RoomAgentWaitingContext | null = null;
	private idleCheckTimer: Timer | null = null;
	private unsubscribers: Array<() => void> = [];
	private config: RoomAgentConfig;

	// New components for AI-driven orchestration
	private lifecycleManager: RoomAgentLifecycleManager | null = null;
	private agentSession: RoomAgentSession | null = null;
	private qaRoundManager: QARoundManager | null = null;

	constructor(
		private ctx: RoomAgentContext,
		config?: Partial<RoomAgentConfig>
	) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		// Handle both Database wrapper and raw BunDatabase
		const rawDb = 'getDatabase' in ctx.db ? ctx.db.getDatabase() : ctx.db;
		this.stateRepo = new RoomAgentStateRepository(rawDb);
		this.taskRepo = new TaskRepository(rawDb);
		this.goalRepo = new GoalRepository(rawDb);
		this.taskManager = new TaskManager(rawDb, ctx.room.id);
		this.goalManager = new GoalManager(rawDb, ctx.room.id, ctx.daemonHub);

		// Get or create initial state
		this.state = this.stateRepo.getOrCreateState(ctx.room.id);

		// Initialize Q&A round manager
		const qaContext: QARoundManagerContext = {
			room: ctx.room,
			db: rawDb,
			daemonHub: ctx.daemonHub,
			messageHub: ctx.messageHub,
		};
		this.qaRoundManager = new QARoundManager(qaContext);
	}

	/**
	 * Start the room agent
	 */
	async start(): Promise<void> {
		log.info(`Starting room agent for room: ${this.ctx.room.name} (${this.ctx.room.id})`);

		// Initialize lifecycle manager
		this.lifecycleManager = new RoomAgentLifecycleManager(
			this.ctx.room.id,
			this.ctx.db,
			this.ctx.daemonHub
		);
		this.state = this.lifecycleManager.initialize();

		// Create and start the active agent session only if we have the Database wrapper
		// (raw BunDatabase is not sufficient for RoomAgentSession)
		const dbWrapper = 'getDatabase' in this.ctx.db ? this.ctx.db : null;
		if (
			dbWrapper &&
			this.ctx.getApiKey &&
			this.ctx.promptTemplateManager &&
			this.ctx.recurringJobScheduler
		) {
			const sessionContext: RoomAgentSessionContext = {
				room: this.ctx.room,
				db: dbWrapper,
				daemonHub: this.ctx.daemonHub,
				messageHub: this.ctx.messageHub,
				getApiKey: this.ctx.getApiKey,
				taskManager: this.taskManager,
				goalManager: this.goalManager,
				sessionPairManager: this.ctx.sessionPairManager,
				recurringJobScheduler: this.ctx.recurringJobScheduler,
				promptTemplateManager: this.ctx.promptTemplateManager,
				qaRoundManager: this.qaRoundManager ?? undefined,
				model: this.ctx.model,
				maxConcurrentWorkers: this.ctx.maxConcurrentWorkers ?? this.config.maxConcurrentPairs,
			};

			this.agentSession = new RoomAgentSession(sessionContext);
			await this.agentSession.start();
			log.info('Room agent session started with AI orchestration');
		} else {
			log.info('Room agent running in legacy mode (no AI session)');
		}

		// Subscribe to events (keep existing subscriptions for backward compatibility)
		this.subscribeToEvents();

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

		// Stop the agent session first
		if (this.agentSession) {
			await this.agentSession.stop();
			this.agentSession = null;
		}

		// Stop idle check
		this.stopIdleCheck();

		// Unsubscribe from events
		for (const unsubscribe of this.unsubscribers) {
			unsubscribe();
		}
		this.unsubscribers = [];

		// Transition to paused via lifecycle manager
		if (this.lifecycleManager) {
			await this.lifecycleManager.pause();
			this.state = this.lifecycleManager.getState();
		} else {
			await this.transitionTo('paused', 'Agent stopped');
		}

		log.info(`Room agent stopped`);
	}

	/**
	 * Subscribe to events (backward compatible with existing subscriptions)
	 */
	private subscribeToEvents(): void {
		// Subscribe to room.message events
		const unsubRoomMessage = this.ctx.daemonHub.on(
			'room.message',
			async (event) => {
				if (event.roomId === this.ctx.room.id) {
					// Inject into agent session if available
					if (this.agentSession && this.lifecycleManager?.canProcessEvent()) {
						await this.agentSession.injectEventMessage({
							type: event.message.role,
							source: event.sender ?? 'unknown',
							content: event.message.content,
							timestamp: event.message.timestamp,
						});
					} else {
						// Fall back to legacy handler
						await this.handleRoomMessage(event);
					}
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
					// The agent session handles task completion via its own subscription
					// This is a fallback for legacy handling
					if (!this.agentSession) {
						await this.handleTaskCompleted(event.taskId, event.summary);
					}
				}
			},
			{ sessionId: `room:${this.ctx.room.id}` }
		);
		this.unsubscribers.push(unsubTaskComplete);

		// Subscribe to recurring job triggers (legacy handling when no agent session)
		const unsubRecurringJob = this.ctx.daemonHub.on(
			'recurringJob.triggered',
			async (event: { roomId: string; jobId: string; taskId: string; timestamp: number }) => {
				if (event.roomId !== this.ctx.room.id) return;

				// Agent session handles this via its own subscription
				if (this.agentSession) return;

				// Legacy: spawn worker for the triggered task
				await this.handleRecurringJobTriggered(event.taskId, event.jobId);
			},
			{ sessionId: `room:${this.ctx.room.id}` }
		);
		this.unsubscribers.push(unsubRecurringJob);

		// Subscribe to room context updated events to trigger Q&A rounds
		const unsubContextUpdated = this.ctx.daemonHub.on(
			'room.contextUpdated',
			async (event: {
				roomId: string;
				changes: { background?: string; instructions?: string };
			}) => {
				if (event.roomId !== this.ctx.room.id) return;

				// Trigger Q&A round on context update if configured
				if (this.qaRoundManager?.shouldAutoTriggerOnContextUpdate()) {
					await this.triggerQARound('context_updated');
				}
			},
			{ sessionId: `room:${this.ctx.room.id}` }
		);
		this.unsubscribers.push(unsubContextUpdated);

		// Subscribe to Q&A round question answered events
		const unsubQuestionAnswered = this.ctx.daemonHub.on(
			'qa.questionAnswered',
			async (event) => {
				if (event.roomId !== this.ctx.room.id) return;

				// Inject the answer into agent session for processing
				if (this.agentSession) {
					await this.agentSession.injectEventMessage({
						type: 'qa_answer',
						source: 'human',
						content: `Q&A Answer: ${event.answer}`,
						timestamp: Date.now(),
					});
				}
			},
			{ sessionId: `room:${this.ctx.room.id}` }
		);
		this.unsubscribers.push(unsubQuestionAnswered);
	}

	/**
	 * Get current agent state
	 */
	getState(): RoomAgentState {
		if (this.lifecycleManager) {
			return this.lifecycleManager.getState();
		}
		return this.state;
	}

	/**
	 * Pause the agent
	 */
	async pause(): Promise<void> {
		if (this.lifecycleManager) {
			await this.lifecycleManager.pause();
			this.state = this.lifecycleManager.getState();
		} else {
			await this.transitionTo('paused', 'Manually paused');
		}
		this.stopIdleCheck();
	}

	/**
	 * Resume the agent
	 */
	async resume(): Promise<void> {
		if (this.lifecycleManager) {
			await this.lifecycleManager.resume();
			this.state = this.lifecycleManager.getState();
		} else {
			await this.transitionTo('idle', 'Manually resumed');
		}
		this.startIdleCheck();
	}

	/**
	 * Transition to a new lifecycle state (legacy method)
	 */
	private async transitionTo(newState: RoomAgentLifecycleState, reason?: string): Promise<void> {
		const previousState = this.state.lifecycleState;

		if (previousState === newState) {
			return;
		}

		log.info(`Room agent transitioning: ${previousState} -> ${newState}`, { reason });

		// Update state in database and sync with lifecycle manager
		if (this.lifecycleManager) {
			const result = await this.lifecycleManager.transitionTo(newState, reason);
			if (result) {
				this.state = result;
			}
		} else {
			this.state = this.stateRepo.transitionTo(this.ctx.room.id, newState) ?? this.state;
		}

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
	 * Handle incoming room message (from GitHub, user, etc.) - Legacy handler
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
	 * Handle GitHub event (issue, PR, comment, etc.) - Legacy handler
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
	 * Handle user message (from room chat) - Legacy handler
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

		// Check if lifecycle manager allows spawning
		if (this.lifecycleManager && !this.lifecycleManager.canSpawnWorker()) {
			log.info(
				`Cannot spawn worker in current state: ${this.lifecycleManager.getLifecycleState()}`
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
			if (this.lifecycleManager) {
				this.lifecycleManager.addActiveSessionPair(result.pair.id);
				this.state = this.lifecycleManager.getState();
			} else {
				this.state =
					this.stateRepo.addActiveSessionPair(this.ctx.room.id, result.pair.id) ?? this.state;
			}

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
	 * Handle task completion - Legacy handler
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
			if (this.lifecycleManager) {
				this.lifecycleManager.removeActiveSessionPair(completedPair.id);
				this.state = this.lifecycleManager.getState();
			} else {
				this.state =
					this.stateRepo.removeActiveSessionPair(this.ctx.room.id, completedPair.id) ?? this.state;
			}
		}

		// Check if we should transition to idle
		if (this.state.activeSessionPairIds.length === 0) {
			if (this.lifecycleManager) {
				await this.lifecycleManager.finishExecution();
				this.state = this.lifecycleManager.getState();
			} else {
				await this.transitionTo('idle', 'All tasks completed');
			}
		}
	}

	/**
	 * Handle recurring job triggered - Legacy handler
	 */
	private async handleRecurringJobTriggered(taskId: string, jobId: string): Promise<void> {
		log.info(`Recurring job ${jobId} triggered, created task ${taskId}`);

		// Don't process if paused
		if (this.state.lifecycleState === 'paused') {
			log.debug(`Ignoring job trigger - agent is paused`);
			return;
		}

		// Get the task
		const task = await this.taskManager.getTask(taskId);
		if (!task) {
			log.warn(`Task ${taskId} not found for triggered job ${jobId}`);
			return;
		}

		// Spawn worker if capacity available
		await this.maybeSpawnWorker(task);
	}

	/**
	 * Record an error
	 */
	private async recordError(error: string): Promise<void> {
		if (this.lifecycleManager) {
			await this.lifecycleManager.recordError(new Error(error), false);
			this.state = this.lifecycleManager.getState();

			// Transition to error if too many errors
			if (this.state.errorCount >= this.config.maxErrorCount) {
				await this.lifecycleManager.recordError(
					new Error(`Max errors reached (${this.state.errorCount})`),
					true
				);
				this.state = this.lifecycleManager.getState();
				this.stopIdleCheck();
			}
		} else {
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

		// If agent session is available, inject planning message
		if (this.agentSession && this.lifecycleManager?.canStartPlanning()) {
			if (activeGoals.length > 0 || pendingTasks.length > 0) {
				const availableCapacity =
					(this.ctx.maxConcurrentWorkers ?? this.config.maxConcurrentPairs) -
					inProgressTasks.length;

				await this.agentSession.injectPlanningMessage({
					activeGoals,
					pendingTasks,
					inProgressTasks,
					recentEvents: [],
					availableCapacity,
				});
				return;
			}
		}

		// Legacy: If there are pending tasks, try to spawn workers
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
	 * Bypasses lifecycle manager validation
	 */
	async forceState(newState: RoomAgentLifecycleState): Promise<void> {
		const previousState = this.state.lifecycleState;

		// Skip if already in the target state
		if (previousState === newState) {
			return;
		}

		// Use lifecycle manager's forceState if available, otherwise direct update
		if (this.lifecycleManager) {
			this.state = this.lifecycleManager.forceState(newState);
		} else {
			this.state = this.stateRepo.transitionTo(this.ctx.room.id, newState) ?? this.state;
			this.state =
				this.stateRepo.updateState(this.ctx.room.id, { lastActivityAt: Date.now() }) ?? this.state;
		}

		// Emit state change event
		await this.ctx.daemonHub.emit('roomAgent.stateChanged', {
			sessionId: `room:${this.ctx.room.id}`,
			roomId: this.ctx.room.id,
			previousState,
			newState,
			reason: 'Forced state change',
		});
	}

	/**
	 * Get the current waiting context (what the agent is waiting for)
	 */
	getWaitingContext(): RoomAgentWaitingContext | null {
		if (this.state.lifecycleState !== 'waiting') {
			return null;
		}
		return this.waitingContext;
	}

	/**
	 * Handle human input (review response, escalation, or message)
	 * Routes to the agent session if available, otherwise falls back to legacy handlers.
	 */
	async handleHumanInput(input: RoomAgentHumanInput): Promise<void> {
		log.info(`Handling human input: ${input.type}`);

		// If agent session is available, delegate to it
		if (this.agentSession) {
			// Convert shared type to session type
			const sessionInput: SessionHumanInput = {
				type:
					input.type === 'escalation_response'
						? 'review_response'
						: input.type === 'question_response'
							? 'review_response'
							: input.type,
				content:
					'response' in input
						? String((input as { response: unknown }).response)
						: input.type === 'message'
							? (input as { content: string }).content
							: '',
				taskId: 'taskId' in input ? (input as { taskId?: string }).taskId : undefined,
			};
			await this.agentSession.handleHumanInput(sessionInput);
			return;
		}

		// Legacy handling
		switch (input.type) {
			case 'review_response':
				await this.handleReviewResponse(input);
				break;
			case 'escalation_response':
				await this.handleEscalationResponse(input);
				break;
			case 'message':
				await this.handleUserMessage((input as { content: string }).content, 'human');
				break;
			case 'question_response':
				await this.handleQuestionResponse(input);
				break;
			default:
				log.warn(`Unknown input type: ${(input as { type: string }).type}`);
		}
	}

	/**
	 * Handle review response (approve/reject) - Legacy handler
	 */
	private async handleReviewResponse(
		input: Extract<RoomAgentHumanInput, { type: 'review_response' }>
	): Promise<void> {
		log.info(
			`Review response for task ${input.taskId}: ${input.approved ? 'approved' : 'rejected'}`
		);

		// Clear waiting context
		this.waitingContext = null;

		// Emit review received event
		await this.ctx.daemonHub.emit('roomAgent.reviewReceived', {
			sessionId: `room:${this.ctx.room.id}`,
			roomId: this.ctx.room.id,
			taskId: input.taskId,
			approved: input.approved,
			response: input.response,
		});

		if (input.approved) {
			// Mark task as approved - complete it
			await this.taskManager.completeTask(input.taskId, `Approved: ${input.response}`);
			await this.transitionTo('idle', 'Review approved');
		} else {
			// Task rejected - mark as blocked or create follow-up
			await this.taskManager.blockTask(input.taskId, `Rejected: ${input.response}`);
			await this.transitionTo('idle', 'Review rejected');
		}
	}

	/**
	 * Handle escalation response - Legacy handler
	 */
	private async handleEscalationResponse(
		input: Extract<RoomAgentHumanInput, { type: 'escalation_response' }>
	): Promise<void> {
		log.info(`Escalation response for ${input.escalationId}: ${input.response}`);

		// Clear waiting context
		this.waitingContext = null;

		// Emit escalation resolved event
		await this.ctx.daemonHub.emit('roomAgent.escalationResolved', {
			sessionId: `room:${this.ctx.room.id}`,
			roomId: this.ctx.room.id,
			escalationId: input.escalationId,
			response: input.response,
		});

		// Transition back to idle to continue
		await this.transitionTo('idle', 'Escalation resolved');
	}

	/**
	 * Handle question response - Legacy handler
	 */
	private async handleQuestionResponse(
		input: Extract<RoomAgentHumanInput, { type: 'question_response' }>
	): Promise<void> {
		log.info(`Question response for ${input.questionId}`);

		// Clear waiting context
		this.waitingContext = null;

		// Emit question answered event
		await this.ctx.daemonHub.emit('roomAgent.questionAnswered', {
			sessionId: `room:${this.ctx.room.id}`,
			roomId: this.ctx.room.id,
			questionId: input.questionId,
			responses: input.responses,
		});

		// Continue with the answer
		await this.transitionTo('planning', 'Processing question response');
	}

	/**
	 * Set waiting context and transition to waiting state
	 */
	async setWaiting(context: RoomAgentWaitingContext): Promise<void> {
		this.waitingContext = context;
		if (this.lifecycleManager) {
			await this.lifecycleManager.waitForInput(`Waiting for ${context.type}`);
			this.state = this.lifecycleManager.getState();
		} else {
			await this.transitionTo('waiting', `Waiting for ${context.type}`);
		}
	}

	/**
	 * Get the underlying agent session (for testing/debugging)
	 */
	getAgentSession(): RoomAgentSession | null {
		return this.agentSession;
	}

	/**
	 * Get the lifecycle manager (for testing/debugging)
	 */
	getLifecycleManager(): RoomAgentLifecycleManager | null {
		return this.lifecycleManager;
	}

	/**
	 * Get the Q&A round manager
	 */
	getQARoundManager(): QARoundManager | null {
		return this.qaRoundManager;
	}

	/**
	 * Trigger a Q&A round for context refinement
	 */
	async triggerQARound(
		trigger: 'room_created' | 'context_updated' | 'goal_created'
	): Promise<void> {
		if (!this.qaRoundManager) {
			log.warn('Q&A round manager not available');
			return;
		}

		// Don't start a new round if one is already active
		if (this.qaRoundManager.hasActiveRound()) {
			log.info(`Q&A round already active, skipping trigger: ${trigger}`);
			return;
		}

		log.info(`Triggering Q&A round for: ${trigger}`);

		try {
			const round = await this.qaRoundManager.startRound(trigger);

			// Inject a message into the agent session to ask clarifying questions
			if (this.agentSession) {
				await this.agentSession.injectEventMessage({
					type: 'qa_round_started',
					source: 'system',
					content: this.buildQARoundPrompt(round, trigger),
					timestamp: Date.now(),
				});
			}
		} catch (error) {
			log.error('Failed to trigger Q&A round:', error);
		}
	}

	/**
	 * Build the prompt for a Q&A round
	 */
	private buildQARoundPrompt(
		round: { id: string; trigger: string },
		trigger: 'room_created' | 'context_updated' | 'goal_created'
	): string {
		const parts: string[] = [];

		parts.push('# Q&A Round Started\n');
		parts.push(`A Q&A round has been started (ID: ${round.id}).`);
		parts.push(`Trigger: ${trigger}\n`);

		if (trigger === 'room_created') {
			parts.push('## Context');
			parts.push('This room was just created. Ask clarifying questions to better understand:');
			parts.push('- The project goals and priorities');
			parts.push('- Any constraints or preferences');
			parts.push('- What success looks like for this room');
		} else if (trigger === 'context_updated') {
			parts.push('## Context');
			parts.push('The room context (background/instructions) was updated.');
			parts.push('Ask clarifying questions if the changes are unclear or incomplete.');
		} else if (trigger === 'goal_created') {
			parts.push('## Context');
			parts.push('A new goal was created.');
			parts.push('Ask clarifying questions to better understand the goal requirements.');
		}

		parts.push('\n## Instructions');
		parts.push('Use the `askQuestion` tool to ask clarifying questions.');
		parts.push('The human will answer and you can then refine the room context accordingly.');

		return parts.join('\n');
	}
}
