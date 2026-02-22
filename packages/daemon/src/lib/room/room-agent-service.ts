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
 *
 * Unified Session Architecture:
 * - Uses AgentSession.fromInit() for AI orchestration
 * - Room sessions are persisted to sessions table with type='room'
 * - Session ID format: room:{roomId}
 * - Features are disabled (no rewind, worktree, coordinator, archive, sessionInfo)
 */

import type { DaemonHub } from '../daemon-hub';
import type { MessageHub, SessionFeatures, TaskPriority } from '@neokai/shared';
import type { Database as BunDatabase } from 'bun:sqlite';
import type { Database } from '../../storage/index';
import { RoomAgentStateRepository } from '../../storage/repositories/room-agent-state-repository';
import { TaskRepository } from '../../storage/repositories/task-repository';
import { GoalRepository } from '../../storage/repositories/goal-repository';
import { SessionPairManager } from './session-pair-manager';
import { TaskManager } from './task-manager';
import { GoalManager } from './goal-manager';
import { RecurringJobScheduler } from './recurring-job-scheduler';
import { RoomAgentLifecycleManager } from './room-agent-lifecycle-manager';
import { AgentSession, type AgentSessionInit } from '../agent/agent-session';
import {
	createRoomAgentMcpServer,
	type RoomAgentToolsConfig,
	type RoomCompleteGoalParams,
	type RoomCreateTaskParams,
	type RoomSpawnWorkerParams,
	type RoomUpdateGoalProgressParams,
	type RoomScheduleJobParams,
} from '../agent/room-agent-tools';
import type { PromptTemplateManager } from '../prompts/prompt-template-manager';
import type {
	Room,
	RoomAgentState,
	RoomAgentLifecycleState,
	RoomAgentHumanInput,
	RoomAgentWaitingContext,
	NeoTask,
	SessionPair,
	RoomGoal,
	McpServerConfig,
} from '@neokai/shared';
import { DEFAULT_ROOM_FEATURES, buildRoomAgentSystemPrompt } from '@neokai/shared';
import { Logger } from '../logger';

const log = new Logger('room-agent-service');

/**
 * Context for planning phase messages
 */
export interface RoomAgentPlanningContext {
	activeGoals: RoomGoal[];
	pendingTasks: NeoTask[];
	inProgressTasks: NeoTask[];
	recentEvents: Array<{ type: string; summary: string; timestamp: number }>;
	availableCapacity: number;
}

/**
 * Context for review phase messages
 */
export interface RoomAgentReviewContext {
	task: NeoTask;
	sessionPair?: SessionPair;
	summary: string;
	success: boolean;
	error?: string;
}

/**
 * Event message from external sources
 */
export interface RoomMessageEvent {
	type: string;
	source: string;
	content: string;
	metadata?: Record<string, unknown>;
	timestamp: number;
}

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
	/** Default workspace root from server config (fallback when room has no paths) */
	workspaceRoot?: string;
}

/**
 * Configuration for room agent behavior
 */
export interface RoomAgentConfig {
	maxConcurrentPairs: number;
	idleCheckIntervalMs: number;
	maxErrorCount: number;
	autoRetryTasks: boolean;
}

const DEFAULT_CONFIG: RoomAgentConfig = {
	maxConcurrentPairs: 3,
	idleCheckIntervalMs: 60000,
	maxErrorCount: 5,
	autoRetryTasks: true,
};

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';

/**
 * Room Agent Service
 *
 * Manages the lifecycle of a room's automation agent.
 * Uses AgentSession for AI orchestration with room-specific configuration.
 */
export class RoomAgentService {
	readonly sessionId: string;

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
	private lifecycleState: RoomAgentLifecycleState = 'idle';

	private lifecycleManager: RoomAgentLifecycleManager | null = null;
	private agentSession: AgentSession | null = null;
	private roomMcpServer: ReturnType<typeof createRoomAgentMcpServer> | null = null;

	constructor(
		private ctx: RoomAgentContext,
		config?: Partial<RoomAgentConfig>
	) {
		this.config = { ...DEFAULT_CONFIG, ...config };
		this.sessionId = `room:${ctx.room.id}`;

		const rawDb = 'getDatabase' in ctx.db ? ctx.db.getDatabase() : ctx.db;
		this.stateRepo = new RoomAgentStateRepository(rawDb);
		this.taskRepo = new TaskRepository(rawDb);
		this.goalRepo = new GoalRepository(rawDb);
		this.taskManager = new TaskManager(rawDb, ctx.room.id);
		this.goalManager = new GoalManager(rawDb, ctx.room.id, ctx.daemonHub);

		this.state = this.stateRepo.getOrCreateState(ctx.room.id);
	}

	async start(): Promise<void> {
		log.info(`Starting room agent for room: ${this.ctx.room.name} (${this.ctx.room.id})`);

		this.lifecycleManager = new RoomAgentLifecycleManager(
			this.ctx.room.id,
			this.ctx.db,
			this.ctx.daemonHub
		);
		this.state = this.lifecycleManager.initialize();

		const dbWrapper = 'getDatabase' in this.ctx.db ? this.ctx.db : null;
		if (dbWrapper && this.ctx.getApiKey && this.ctx.promptTemplateManager) {
			// Create the MCP server for room agent tools
			this.roomMcpServer = this.createRoomAgentMcp();

			// Get the system prompt
			const systemPrompt = await this.getSystemPrompt();

			// Build the AgentSessionInit
			const init: AgentSessionInit = {
				sessionId: this.sessionId,
				workspacePath:
					this.ctx.room.defaultPath ??
					this.ctx.room.allowedPaths[0]?.path ??
					this.ctx.workspaceRoot ??
					process.cwd(),
				systemPrompt,
				mcpServers: {
					'room-agent-tools': this.roomMcpServer as unknown as McpServerConfig,
				},
				features: DEFAULT_ROOM_FEATURES,
				context: { roomId: this.ctx.room.id },
				type: 'room',
				model: this.ctx.room.defaultModel ?? DEFAULT_MODEL,
			};

			// Create AgentSession using the factory method
			this.agentSession = AgentSession.fromInit(
				init,
				dbWrapper,
				this.ctx.messageHub,
				this.ctx.daemonHub,
				this.ctx.getApiKey,
				this.ctx.room.defaultModel ?? DEFAULT_MODEL
			);

			// Start the SDK streaming query loop so it's ready to consume injected messages.
			// Without this, messageQueue.enqueue() blocks until timeout because no
			// messageGenerator is iterating the queue.
			await this.agentSession.startStreamingQuery();

			log.info('Room agent session started with AgentSession');
		} else {
			log.info('Room agent running in legacy mode (no AgentSession)');
		}

		this.subscribeToEvents();
		this.startIdleCheck();

		// Trigger an immediate idle check instead of waiting for the first interval
		setTimeout(() => {
			this.checkIdleState().catch((error) => {
				log.error('Error in immediate idle check:', error);
			});
		}, 0);

		if (this.state.lifecycleState === 'error') {
			await this.transitionTo('idle', 'Agent restarted');
		}

		log.info(`Room agent started in state: ${this.state.lifecycleState}`);
	}

	async stop(): Promise<void> {
		log.info(`Stopping room agent for room: ${this.ctx.room.id}`);

		if (this.agentSession) {
			// Stop the SDK query loop cleanly before releasing the session
			this.agentSession.messageQueue.clear();
			this.agentSession.messageQueue.stop();
			this.agentSession = null;
		}

		this.stopIdleCheck();

		for (const unsubscribe of this.unsubscribers) {
			unsubscribe();
		}
		this.unsubscribers = [];

		if (this.lifecycleManager) {
			await this.lifecycleManager.pause();
			this.state = this.lifecycleManager.getState();
		} else {
			await this.transitionTo('paused', 'Agent stopped');
		}

		log.info('Room agent stopped');
	}

	getFeatures(): SessionFeatures {
		return DEFAULT_ROOM_FEATURES;
	}

	/**
	 * Inject a planning message to trigger agent reasoning
	 */
	async injectPlanningMessage(context: RoomAgentPlanningContext): Promise<void> {
		if (!this.agentSession) {
			log.warn('No agent session available for planning message');
			return;
		}

		log.debug('Injecting planning message');
		const prompt = this.buildPlanningPrompt(context);

		await this.setLifecycleState('planning');
		await this.agentSession.messageQueue.enqueue(prompt, true);
	}

	/**
	 * Inject a review message for completed work
	 */
	async injectReviewMessage(context: RoomAgentReviewContext): Promise<void> {
		if (!this.agentSession) {
			log.warn('No agent session available for review message');
			return;
		}

		log.debug(`Injecting review message for task ${context.task.id}`);
		const prompt = this.buildReviewPrompt(context);

		await this.setLifecycleState('reviewing');
		await this.agentSession.messageQueue.enqueue(prompt, true);
	}

	/**
	 * Inject an external event message
	 */
	async injectEventMessage(event: RoomMessageEvent): Promise<void> {
		if (!this.agentSession) {
			log.warn('No agent session available for event message');
			return;
		}

		log.debug(`Injecting event message: ${event.type}`);
		const prompt = this.buildEventPrompt(event);

		if (this.lifecycleState === 'idle') {
			await this.setLifecycleState('planning');
		}

		await this.agentSession.messageQueue.enqueue(prompt, true);
	}

	private subscribeToEvents(): void {
		const unsubRoomMessage = this.ctx.daemonHub.on(
			'room.message',
			async (event) => {
				if (event.roomId === this.ctx.room.id) {
					if (this.agentSession && this.lifecycleManager?.canProcessEvent()) {
						await this.injectEventMessage({
							type: event.message.role,
							source: event.sender ?? 'unknown',
							content: event.message.content,
							timestamp: event.message.timestamp,
						});
					} else {
						await this.handleRoomMessage(event);
					}
				}
			},
			{ sessionId: this.sessionId }
		);
		this.unsubscribers.push(unsubRoomMessage);

		const unsubContextUpdated = this.ctx.daemonHub.on(
			'room.contextUpdated',
			async (event: {
				roomId: string;
				changes: { background?: string; instructions?: string };
			}) => {
				if (event.roomId !== this.ctx.room.id) return;

				if (this.agentSession) {
					await this.injectEventMessage({
						type: 'context_update',
						source: 'system',
						content: this.buildContextUpdateMessage(event.changes),
						metadata: event.changes,
						timestamp: Date.now(),
					});
				}
			},
			{ sessionId: this.sessionId }
		);
		this.unsubscribers.push(unsubContextUpdated);

		const unsubTaskComplete = this.ctx.daemonHub.on(
			'pair.task_completed',
			async (event: { pairId: string; taskId: string; summary: string; error?: string }) => {
				const pair = this.ctx.sessionPairManager.getPair(event.pairId);
				if (pair && pair.roomId === this.ctx.room.id) {
					const task = await this.taskManager.getTask(event.taskId);
					if (task && this.agentSession) {
						await this.injectReviewMessage({
							task,
							sessionPair: pair,
							summary: event.summary,
							success: !event.error,
							error: event.error,
						});
					} else if (!this.agentSession) {
						await this.handleTaskCompleted(event.taskId, event.summary);
					}
				}
			},
			{ sessionId: this.sessionId }
		);
		this.unsubscribers.push(unsubTaskComplete);

		const unsubRecurringJob = this.ctx.daemonHub.on(
			'recurringJob.triggered',
			async (event: { roomId: string; jobId: string; taskId: string; timestamp: number }) => {
				if (event.roomId !== this.ctx.room.id) return;

				const task = await this.taskManager.getTask(event.taskId);
				if (!task) return;

				if (this.agentSession) {
					await this.injectPlanningMessage({
						activeGoals: [],
						pendingTasks: [task],
						inProgressTasks: [],
						recentEvents: [
							{
								type: 'job_triggered',
								summary: `Recurring job ${event.jobId} triggered, created task: ${task.title}`,
								timestamp: event.timestamp,
							},
						],
						availableCapacity: this.config.maxConcurrentPairs,
					});
				} else {
					await this.handleRecurringJobTriggered(event.taskId, event.jobId);
				}
			},
			{ sessionId: this.sessionId }
		);
		this.unsubscribers.push(unsubRecurringJob);
	}

	getState(): RoomAgentState {
		if (this.lifecycleManager) {
			return this.lifecycleManager.getState();
		}
		return this.state;
	}

	async pause(): Promise<void> {
		if (this.lifecycleManager) {
			await this.lifecycleManager.pause();
			this.state = this.lifecycleManager.getState();
		} else {
			await this.transitionTo('paused', 'Manually paused');
		}
		this.stopIdleCheck();
	}

	async resume(): Promise<void> {
		if (this.lifecycleManager) {
			await this.lifecycleManager.resume();
			this.state = this.lifecycleManager.getState();
		} else {
			await this.transitionTo('idle', 'Manually resumed');
		}
		this.startIdleCheck();
	}

	private async transitionTo(newState: RoomAgentLifecycleState, reason?: string): Promise<void> {
		const previousState = this.state.lifecycleState;
		if (previousState === newState) return;

		log.info(`Room agent transitioning: ${previousState} -> ${newState}`, { reason });

		if (this.lifecycleManager) {
			const result = await this.lifecycleManager.transitionTo(newState, reason);
			if (result) {
				this.state = result;
			}
		} else {
			this.state = this.stateRepo.transitionTo(this.ctx.room.id, newState) ?? this.state;
		}

		this.lifecycleState = newState;

		await this.ctx.daemonHub.emit('roomAgent.stateChanged', {
			sessionId: this.sessionId,
			roomId: this.ctx.room.id,
			previousState,
			newState,
			reason,
		});
	}

	private async setLifecycleState(state: RoomAgentLifecycleState): Promise<void> {
		const previousState = this.lifecycleState;
		if (previousState === state) return;

		this.lifecycleState = state;
		log.debug(`Lifecycle state: ${previousState} -> ${state}`);

		await this.ctx.daemonHub.emit('roomAgent.stateChanged', {
			sessionId: this.sessionId,
			roomId: this.ctx.room.id,
			previousState,
			newState: state,
		});
	}

	private async handleRoomMessage(event: {
		roomId: string;
		message: { id: string; role: string; content: string; timestamp: number };
		sender?: string;
	}): Promise<void> {
		log.debug(`Room message received:`, event.message.role);

		if (this.state.lifecycleState === 'paused') {
			log.debug('Ignoring message - agent is paused');
			return;
		}

		await this.transitionTo('planning', `Processing ${event.message.role} message`);

		try {
			if (event.message.role === 'github_event') {
				await this.handleGitHubEvent(event.message.content);
			} else if (event.message.role === 'user') {
				await this.handleUserMessage(event.message.content, event.sender);
			}

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

	private async handleGitHubEvent(content: string): Promise<void> {
		log.info('Processing GitHub event');

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

		const task = await this.taskManager.createTask({
			title: issueTitle || `GitHub ${eventType}`,
			description: `GitHub Event: ${eventType}\n\nIssue #${issueNumber}\n\n${body}`,
			priority: eventType.includes('opened') ? 'high' : 'normal',
		});

		log.info(`Created task ${task.id} from GitHub event`);
		await this.maybeSpawnWorker(task);
	}

	private async handleUserMessage(content: string, sender?: string): Promise<void> {
		log.info(`Processing user message from ${sender ?? 'unknown'}`);

		if (content.startsWith('/')) {
			await this.handleCommand(content);
			return;
		}

		const task = await this.taskManager.createTask({
			title: content.slice(0, 100),
			description: `User request from ${sender ?? 'unknown'}:\n\n${content}`,
			priority: 'normal',
		});

		log.info(`Created task ${task.id} from user message`);
		await this.maybeSpawnWorker(task);
	}

	private async handleCommand(content: string): Promise<void> {
		const command = content.split(' ')[0].toLowerCase();

		switch (command) {
			case '/status':
				await this.ctx.daemonHub.emit('room.message', {
					sessionId: this.sessionId,
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
					sessionId: this.sessionId,
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

	private async maybeSpawnWorker(task: NeoTask): Promise<SessionPair | null> {
		if (this.state.activeSessionPairIds.length >= this.config.maxConcurrentPairs) {
			log.info(`At capacity, queuing task ${task.id}`);
			return null;
		}

		if (this.lifecycleManager && !this.lifecycleManager.canSpawnWorker()) {
			log.info(
				`Cannot spawn worker in current state: ${this.lifecycleManager.getLifecycleState()}`
			);
			return null;
		}

		log.info(`Spawning worker for task ${task.id}`);

		try {
			const result = await this.ctx.sessionPairManager.createPair({
				roomId: this.ctx.room.id,
				roomSessionId: this.sessionId,
				taskTitle: task.title,
				taskDescription: task.description,
				workspacePath:
					this.ctx.room.defaultPath ??
					this.ctx.room.allowedPaths[0]?.path ??
					this.ctx.workspaceRoot,
			});

			if (this.lifecycleManager) {
				this.lifecycleManager.addActiveSessionPair(result.pair.id);
				this.state = this.lifecycleManager.getState();
			} else {
				this.state =
					this.stateRepo.addActiveSessionPair(this.ctx.room.id, result.pair.id) ?? this.state;
			}

			await this.taskManager.startTask(task.id, result.pair.workerSessionId);

			log.info(`Spawned session pair ${result.pair.id} for task ${task.id}`);
			return result.pair;
		} catch (error) {
			log.error(`Failed to spawn worker for task ${task.id}:`, error);
			return null;
		}
	}

	private async handleTaskCompleted(taskId: string, summary: string): Promise<void> {
		log.info(`Task ${taskId} completed`);

		await this.taskManager.completeTask(taskId, summary);
		await this.goalManager.updateGoalsForTask(taskId);

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

		if (this.state.activeSessionPairIds.length === 0) {
			if (this.lifecycleManager) {
				await this.lifecycleManager.finishExecution();
				this.state = this.lifecycleManager.getState();
			} else {
				await this.transitionTo('idle', 'All tasks completed');
			}
		}
	}

	private async handleRecurringJobTriggered(taskId: string, jobId: string): Promise<void> {
		log.info(`Recurring job ${jobId} triggered, created task ${taskId}`);

		if (this.state.lifecycleState === 'paused') {
			log.debug('Ignoring job trigger - agent is paused');
			return;
		}

		const task = await this.taskManager.getTask(taskId);
		if (!task) {
			log.warn(`Task ${taskId} not found for triggered job ${jobId}`);
			return;
		}

		await this.maybeSpawnWorker(task);
	}

	private async recordError(error: string): Promise<void> {
		if (this.lifecycleManager) {
			await this.lifecycleManager.recordError(new Error(error), false);
			this.state = this.lifecycleManager.getState();

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

			await this.ctx.daemonHub.emit('roomAgent.error', {
				sessionId: this.sessionId,
				roomId: this.ctx.room.id,
				error,
				errorCount: this.state.errorCount,
			});

			if (this.state.errorCount >= this.config.maxErrorCount) {
				await this.transitionTo('error', `Max errors reached (${this.state.errorCount})`);
				this.stopIdleCheck();
			}
		}
	}

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

	private stopIdleCheck(): void {
		if (this.idleCheckTimer) {
			clearInterval(this.idleCheckTimer);
			this.idleCheckTimer = null;
		}
	}

	private async checkIdleState(): Promise<void> {
		if (this.state.lifecycleState !== 'idle') return;

		log.debug('Checking idle state...');

		const pendingTasks = await this.taskManager.listTasks({ status: 'pending' });
		const inProgressTasks = await this.taskManager.listTasks({ status: 'in_progress' });
		const activeGoals = await this.goalManager.getActiveGoals();

		await this.ctx.daemonHub.emit('roomAgent.idle', {
			sessionId: this.sessionId,
			roomId: this.ctx.room.id,
			hasPendingTasks: pendingTasks.length > 0,
			hasIncompleteGoals: activeGoals.length > 0,
		});

		if (this.agentSession && this.lifecycleManager?.canStartPlanning()) {
			if (activeGoals.length > 0 || pendingTasks.length > 0) {
				const availableCapacity = this.config.maxConcurrentPairs - inProgressTasks.length;

				await this.injectPlanningMessage({
					activeGoals,
					pendingTasks,
					inProgressTasks,
					recentEvents: [],
					availableCapacity,
				});
				return;
			}
		}

		if (pendingTasks.length > 0 && inProgressTasks.length < this.config.maxConcurrentPairs) {
			log.info(`Found ${pendingTasks.length} pending tasks, attempting to spawn workers`);
			const nextTask = await this.taskManager.getNextPendingTask();
			if (nextTask) {
				await this.maybeSpawnWorker(nextTask);
			}
		}
	}

	async forceState(newState: RoomAgentLifecycleState): Promise<void> {
		const previousState = this.state.lifecycleState;
		if (previousState === newState) return;

		if (this.lifecycleManager) {
			this.state = this.lifecycleManager.forceState(newState);
		} else {
			this.state = this.stateRepo.transitionTo(this.ctx.room.id, newState) ?? this.state;
			this.state =
				this.stateRepo.updateState(this.ctx.room.id, { lastActivityAt: Date.now() }) ?? this.state;
		}

		await this.ctx.daemonHub.emit('roomAgent.stateChanged', {
			sessionId: this.sessionId,
			roomId: this.ctx.room.id,
			previousState,
			newState,
			reason: 'Forced state change',
		});
	}

	getWaitingContext(): RoomAgentWaitingContext | null {
		if (this.state.lifecycleState !== 'waiting') return null;
		return this.waitingContext;
	}

	async handleHumanInput(input: RoomAgentHumanInput): Promise<void> {
		log.info(`Handling human input: ${input.type}`);

		if (this.agentSession) {
			if (input.type === 'message') {
				await this.injectEventMessage({
					type: 'user_message',
					source: 'human',
					content: (input as { content: string }).content,
					timestamp: Date.now(),
				});
			} else if (input.type === 'review_response' && this.lifecycleState === 'waiting') {
				await this.setLifecycleState('reviewing');
				await this.agentSession.messageQueue.enqueue(
					`Review response received: ${(input as { response?: string }).response ?? 'approved'}`,
					true
				);
			}
			return;
		}

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

	private async handleReviewResponse(
		input: Extract<RoomAgentHumanInput, { type: 'review_response' }>
	): Promise<void> {
		log.info(
			`Review response for task ${input.taskId}: ${input.approved ? 'approved' : 'rejected'}`
		);

		this.waitingContext = null;

		await this.ctx.daemonHub.emit('roomAgent.reviewReceived', {
			sessionId: this.sessionId,
			roomId: this.ctx.room.id,
			taskId: input.taskId,
			approved: input.approved,
			response: input.response,
		});

		if (input.approved) {
			await this.taskManager.completeTask(input.taskId, `Approved: ${input.response}`);
			await this.transitionTo('idle', 'Review approved');
		} else {
			await this.taskManager.blockTask(input.taskId, `Rejected: ${input.response}`);
			await this.transitionTo('idle', 'Review rejected');
		}
	}

	private async handleEscalationResponse(
		input: Extract<RoomAgentHumanInput, { type: 'escalation_response' }>
	): Promise<void> {
		log.info(`Escalation response for ${input.escalationId}: ${input.response}`);

		this.waitingContext = null;

		await this.ctx.daemonHub.emit('roomAgent.escalationResolved', {
			sessionId: this.sessionId,
			roomId: this.ctx.room.id,
			escalationId: input.escalationId,
			response: input.response,
		});

		await this.transitionTo('idle', 'Escalation resolved');
	}

	private async handleQuestionResponse(
		input: Extract<RoomAgentHumanInput, { type: 'question_response' }>
	): Promise<void> {
		log.info(`Question response for ${input.questionId}`);

		this.waitingContext = null;

		await this.ctx.daemonHub.emit('roomAgent.questionAnswered', {
			sessionId: this.sessionId,
			roomId: this.ctx.room.id,
			questionId: input.questionId,
			responses: input.responses,
		});

		await this.transitionTo('planning', 'Processing question response');
	}

	async setWaiting(context: RoomAgentWaitingContext): Promise<void> {
		this.waitingContext = context;
		if (this.lifecycleManager) {
			await this.lifecycleManager.waitForInput(`Waiting for ${context.type}`);
			this.state = this.lifecycleManager.getState();
		} else {
			await this.transitionTo('waiting', `Waiting for ${context.type}`);
		}
	}

	getAgentSession(): AgentSession | null {
		return this.agentSession;
	}

	getLifecycleManager(): RoomAgentLifecycleManager | null {
		return this.lifecycleManager;
	}

	// ========================
	// Prompt Building Methods
	// ========================

	private buildPlanningPrompt(context: RoomAgentPlanningContext): string {
		const parts: string[] = [];

		parts.push('# Room Agent Planning Phase\n');
		parts.push(`Room: ${this.ctx.room.name}`);
		parts.push(`Current Lifecycle State: ${this.lifecycleState}\n`);

		if (context.activeGoals.length > 0) {
			parts.push('## Active Goals');
			for (const goal of context.activeGoals) {
				parts.push(`- ${goal.title} (${goal.status}, ${goal.progress}%)`);
			}
			parts.push('');
		}

		if (context.pendingTasks.length > 0) {
			parts.push('## Pending Tasks');
			for (const task of context.pendingTasks) {
				parts.push(`- [${task.priority}] ${task.title}`);
			}
			parts.push('');
		}

		if (context.inProgressTasks.length > 0) {
			parts.push('## In-Progress Tasks');
			for (const task of context.inProgressTasks) {
				parts.push(`- ${task.title} (${task.progress ?? 0}%)`);
			}
			parts.push('');
		}

		if (context.recentEvents.length > 0) {
			parts.push('## Recent Events');
			for (const event of context.recentEvents) {
				parts.push(`- [${event.type}] ${event.summary}`);
			}
			parts.push('');
		}

		parts.push(`## Available Capacity: ${context.availableCapacity} workers`);

		parts.push('\n## Instructions');
		parts.push('Analyze the current state and decide:');
		parts.push('1. Should any goals be updated or completed?');
		parts.push('2. Should new tasks be created from pending work?');
		parts.push('3. Should workers be spawned for pending tasks?');
		parts.push('4. Are there any blockers or issues to address?');

		return parts.join('\n');
	}

	private buildReviewPrompt(context: RoomAgentReviewContext): string {
		const parts: string[] = [];

		parts.push('# Task Review\n');
		parts.push(`Task: ${context.task.title}`);
		parts.push(`Status: ${context.success ? 'Completed' : 'Failed'}`);
		parts.push(`\nSummary: ${context.summary}`);

		if (context.error) {
			parts.push(`\nError: ${context.error}`);
		}

		parts.push('\n## Instructions');
		parts.push('Review this task completion and:');
		parts.push('1. If successful, should any goals be updated?');
		parts.push('2. If failed, should the task be retried or escalated?');
		parts.push('3. Are there follow-up tasks to create?');

		return parts.join('\n');
	}

	private buildEventPrompt(event: RoomMessageEvent): string {
		const parts: string[] = [];

		parts.push('# External Event\n');
		parts.push(`Type: ${event.type}`);
		parts.push(`Source: ${event.source}`);
		parts.push(`Time: ${new Date(event.timestamp).toISOString()}`);
		parts.push(`\nContent:\n${event.content}`);

		parts.push('\n## Instructions');
		parts.push('Process this event and take appropriate action:');

		if (event.type === 'github_event' || event.type.startsWith('github_')) {
			parts.push('- Create a task if this requires work');
			parts.push('- Link the task to a goal if appropriate');
			parts.push('- Spawn a worker if capacity is available');
		} else if (event.type === 'user_message') {
			parts.push('- Respond to the user if needed');
			parts.push('- Create a task if the user is requesting work');
		}

		return parts.join('\n');
	}

	private buildContextUpdateMessage(changes: {
		background?: string;
		instructions?: string;
	}): string {
		const parts: string[] = [];

		parts.push('# Room Context Updated\n');
		parts.push(
			'The room context has been updated. Please review and adjust your behavior accordingly.\n'
		);

		if (changes.background !== undefined) {
			parts.push('## Background Context');
			parts.push(changes.background || '(cleared)');
			parts.push('');
		}

		if (changes.instructions !== undefined) {
			parts.push('## Instructions');
			parts.push(changes.instructions || '(cleared)');
			parts.push('');
		}

		parts.push('## Action Required');
		parts.push('Review the updated context and:');
		parts.push('1. Adjust any pending plans to align with the new context');
		parts.push('2. Update any affected goals if needed');
		parts.push('3. Communicate any significant changes to the user if appropriate');

		return parts.join('\n');
	}

	// ========================
	// MCP Tools Creation
	// ========================

	private createRoomAgentMcp(): ReturnType<typeof createRoomAgentMcpServer> {
		const config: RoomAgentToolsConfig = {
			roomId: this.ctx.room.id,
			sessionId: this.sessionId,
			onCompleteGoal: async (params: RoomCompleteGoalParams) => {
				await this.goalManager.completeGoal(params.goalId);
				log.info(`Goal completed: ${params.goalId}`);
			},
			onCreateTask: async (params: RoomCreateTaskParams) => {
				const task = await this.taskManager.createTask({
					title: params.title,
					description: params.description,
					priority: params.priority as TaskPriority | undefined,
				});
				if (params.goalId) {
					await this.goalManager.linkTaskToGoal(params.goalId, task.id);
				}
				log.info(`Task created: ${task.id}`);
				return { taskId: task.id };
			},
			onSpawnWorker: async (params: RoomSpawnWorkerParams) => {
				const task = await this.taskManager.getTask(params.taskId);
				if (!task) {
					throw new Error(`Task not found: ${params.taskId}`);
				}

				const result = await this.ctx.sessionPairManager.createPair({
					roomId: this.ctx.room.id,
					roomSessionId: this.sessionId,
					taskTitle: task.title,
					taskDescription: task.description,
					workspacePath:
						this.ctx.room.defaultPath ??
						this.ctx.room.allowedPaths[0]?.path ??
						this.ctx.workspaceRoot,
				});

				await this.taskManager.startTask(params.taskId, result.pair.workerSessionId);

				log.info(`Worker spawned: ${result.pair.workerSessionId} for task ${params.taskId}`);
				return { pairId: result.pair.id, workerSessionId: result.pair.workerSessionId };
			},
			onRequestReview: async (taskId: string, reason: string) => {
				await this.setWaiting({ type: 'review', taskId, reason, since: Date.now() });
				await this.ctx.daemonHub.emit('roomAgent.reviewRequested', {
					sessionId: this.sessionId,
					roomId: this.ctx.room.id,
					taskId,
					reason,
				} as unknown as Parameters<typeof this.ctx.daemonHub.emit>[1]);
				log.info(`Review requested for task ${taskId}: ${reason}`);
			},
			onEscalate: async (taskId: string, reason: string) => {
				await this.setWaiting({ type: 'escalation', taskId, reason, since: Date.now() });
				await this.ctx.daemonHub.emit('roomAgent.escalated', {
					sessionId: this.sessionId,
					roomId: this.ctx.room.id,
					taskId,
					reason,
				} as unknown as Parameters<typeof this.ctx.daemonHub.emit>[1]);
				log.warn(`Task ${taskId} escalated: ${reason}`);
			},
			onUpdateGoalProgress: async (params: RoomUpdateGoalProgressParams) => {
				await this.goalManager.updateGoalProgress(params.goalId, params.progress, params.metrics);
				log.debug(`Goal progress updated: ${params.goalId} -> ${params.progress}%`);
			},
			onScheduleJob: async (params: RoomScheduleJobParams) => {
				// Map RoomScheduleJobParams to CreateRecurringJobParams
				let schedule: import('@neokai/shared').RecurringJobSchedule;
				if (params.scheduleType === 'interval') {
					schedule = { type: 'interval', minutes: params.intervalMinutes ?? 60 };
				} else if (params.scheduleType === 'daily') {
					schedule = { type: 'daily', hour: params.hour ?? 9, minute: params.minute ?? 0 };
				} else {
					schedule = {
						type: 'weekly',
						dayOfWeek: params.dayOfWeek ?? 1,
						hour: params.hour ?? 9,
						minute: params.minute ?? 0,
					};
				}

				const result = await this.ctx.recurringJobScheduler.createJob({
					roomId: this.ctx.room.id,
					name: params.name,
					description: params.description,
					schedule,
					taskTemplate: {
						title: params.taskTemplate.title,
						description: params.taskTemplate.description,
						priority: (params.taskTemplate.priority as TaskPriority) ?? 'normal',
					},
					enabled: true,
					maxRuns: params.maxRuns,
				});
				log.info(`Recurring job scheduled: ${result.id}`);
				return { jobId: result.id };
			},
			onListGoals: async (status?: string) => {
				const goals = await this.goalManager.listGoals(
					status as import('@neokai/shared').GoalStatus | undefined
				);
				return goals.map((g) => ({
					id: g.id,
					title: g.title,
					description: g.description,
					status: g.status,
					priority: g.priority,
					progress: g.progress,
				}));
			},
			onListJobs: async () => {
				const jobs = this.ctx.recurringJobScheduler.listJobs(this.ctx.room.id);
				return jobs.map((j) => ({
					id: j.id,
					name: j.name,
					description: j.description,
					enabled: j.enabled,
					schedule: JSON.stringify(j.schedule),
				}));
			},
			onListTasks: async (status?: string) => {
				const tasks = await this.taskManager.listTasks(
					status ? { status: status as import('@neokai/shared').TaskStatus } : undefined
				);
				return tasks.map((t) => ({
					id: t.id,
					title: t.title,
					description: t.description,
					status: t.status,
					priority: t.priority,
					progress: t.progress ?? 0,
				}));
			},
		};

		return createRoomAgentMcpServer(config);
	}

	// ========================
	// System Prompt
	// ========================

	private async getSystemPrompt(): Promise<string> {
		const rendered = this.ctx.promptTemplateManager.getRenderedPrompt(
			this.ctx.room.id,
			'room_agent_system'
		);

		const base = rendered ? rendered.content : this.buildFallbackSystemPrompt();

		// Append the current concurrency limit dynamically so it stays accurate
		// even if the setting changes after the rendered template was stored.
		return base + `\n\nMaximum concurrent workers: ${this.config.maxConcurrentPairs}`;
	}

	private buildFallbackSystemPrompt(): string {
		return buildRoomAgentSystemPrompt({
			roomName: this.ctx.room.name,
			background: this.ctx.room.background,
			instructions: this.ctx.room.instructions,
			allowedPaths: this.ctx.room.allowedPaths.map((p) => p.path),
			defaultPath: this.ctx.room.defaultPath,
			maxConcurrentWorkers: this.config.maxConcurrentPairs,
		});
	}
}
