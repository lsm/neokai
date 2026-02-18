/**
 * RoomAgentSession - Active AI session for room agent
 *
 * Unlike AgentSession which is human-driven, RoomAgentSession:
 * - Is driven by events (GitHub, timer, manager completion)
 * - Uses RoomAgentTools MCP for room-level operations
 * - Has a separate lifecycle state from processing state
 *
 * Key differences from AgentSession:
 * | Aspect              | AgentSession           | RoomAgentSession           |
 * |---------------------|------------------------|----------------------------|
 * | Prompt Source       | User messages from UI  | Events, timers, goals      |
 * | System Prompt       | Claude Code preset     | Room agent system template |
 * | MCP Tools           | Standard (Bash, etc.)  | RoomAgentTools MCP         |
 * | State Machine       | ProcessingState only   | ProcessingState + Lifecycle|
 * | Conversation        | Human-AI               | AI orchestration           |
 */

import type { Query } from '@anthropic-ai/claude-agent-sdk/sdk';
import type {
	Room,
	RoomAgentLifecycleState,
	AgentProcessingState,
	MessageHub,
	RoomGoal,
	NeoTask,
	SessionPair,
	TaskPriority,
	ProposalType,
	RoomProposal,
} from '@neokai/shared';
import type { SDKMessage, SDKUserMessage } from '@neokai/shared/sdk';
import { generateUUID } from '@neokai/shared';
import type { Database as BunDatabase } from 'bun:sqlite';
import type { Database } from '../../storage/index';
import type { DaemonHub } from '../daemon-hub';
import { Logger } from '../logger';
import { MessageQueue } from '../agent/message-queue';
import { ProcessingStateManager } from '../agent/processing-state-manager';
import { ContextTracker } from '../agent/context-tracker';
import {
	createRoomAgentMcpServer,
	type RoomAgentToolsConfig,
	type RoomCompleteGoalParams,
	type RoomCreateTaskParams,
	type RoomSpawnWorkerParams,
	type RoomUpdateGoalProgressParams,
	type RoomScheduleJobParams,
} from '../agent/room-agent-tools';
import { GoalManager } from './goal-manager';
import { TaskManager } from './task-manager';
import { SessionPairManager } from './session-pair-manager';
import type { PromptTemplateManager } from '../prompts/prompt-template-manager';
import { SDKMessageRepository } from '../../storage/repositories/sdk-message-repository';
import { ProposalRepository } from '../../storage/repositories/proposal-repository';
import type { QARoundManager } from './qa-round-manager';

/**
 * Context for planning phase messages
 */
export interface RoomAgentPlanningContext {
	/** Current active goals */
	activeGoals: RoomGoal[];
	/** Pending tasks waiting to be picked up */
	pendingTasks: NeoTask[];
	/** In-progress tasks */
	inProgressTasks: NeoTask[];
	/** Recent events (GitHub, etc.) */
	recentEvents: Array<{ type: string; summary: string; timestamp: number }>;
	/** Available capacity for new workers */
	availableCapacity: number;
}

/**
 * Context for review phase messages
 */
export interface RoomAgentReviewContext {
	/** Task that was completed */
	task: NeoTask;
	/** Session pair that executed the task */
	sessionPair?: SessionPair;
	/** Summary of what was done */
	summary: string;
	/** Whether the task succeeded */
	success: boolean;
	/** Error if failed */
	error?: string;
}

/**
 * Event message from external sources
 */
export interface RoomMessageEvent {
	/** Event type (github_issue, github_pr, user_message, etc.) */
	type: string;
	/** Event source identifier */
	source: string;
	/** Raw event content */
	content: string;
	/** Parsed metadata */
	metadata?: Record<string, unknown>;
	/** Timestamp */
	timestamp: number;
}

/**
 * Human input to the room agent
 */
export interface RoomAgentHumanInput {
	/** Input type */
	type: 'command' | 'message' | 'review_response';
	/** Content of the input */
	content: string;
	/** Optional task context */
	taskId?: string;
}

/**
 * Minimal interface for RecurringJobScheduler (to avoid circular deps)
 * Uses unknown to allow any job params type since the implementations differ
 */
export interface RecurringJobSchedulerLike {
	createJob(params: unknown): Promise<{ id: string }>;
	cancelJob?(jobId: string): Promise<void>;
	deleteJob(jobId: string): Promise<boolean>;
}

/**
 * Context passed to RoomAgentSession
 */
export interface RoomAgentSessionContext {
	room: Room;
	db: Database | BunDatabase;
	daemonHub: DaemonHub;
	messageHub: MessageHub;
	getApiKey: () => Promise<string | null>;
	taskManager: TaskManager;
	goalManager: GoalManager;
	sessionPairManager: SessionPairManager;
	recurringJobScheduler: RecurringJobSchedulerLike;
	promptTemplateManager: PromptTemplateManager;
	/** Q&A round manager for context refinement */
	qaRoundManager?: QARoundManager;
	/** Model to use for the agent */
	model?: string;
	/** Maximum concurrent workers */
	maxConcurrentWorkers?: number;
}

/**
 * SDK MCP Server configuration with instance
 */
interface McpSdkServerConfigWithInstance {
	server: ReturnType<typeof createRoomAgentMcpServer>;
}

const DEFAULT_MODEL = 'sonnet';
const DEFAULT_MAX_CONCURRENT_WORKERS = 3;

/**
 * RoomAgentSession - Active AI orchestration session for a room
 *
 * This class manages the AI agent that orchestrates work within a room.
 * It processes events, creates tasks, spawns workers, and reviews results.
 */
export class RoomAgentSession {
	readonly sessionId: string;
	readonly messageQueue: MessageQueue;
	readonly processingStateManager: ProcessingStateManager;
	readonly contextTracker: ContextTracker;

	private roomAgentToolsMcp: McpSdkServerConfigWithInstance | null = null;
	private abortController: AbortController | null = null;
	private lifecycleState: RoomAgentLifecycleState = 'idle';
	private queryObject: Query | null = null;
	private queryPromise: Promise<void> | null = null;
	private queryGeneration: number = 0;
	private isCleaningUp: boolean = false;
	private unsubscribers: Array<() => void> = [];

	private logger: Logger;
	private maxConcurrentWorkers: number;
	private sdkMessageRepo: SDKMessageRepository;
	private proposalRepo: ProposalRepository;

	constructor(private ctx: RoomAgentSessionContext) {
		this.sessionId = `room-agent:${ctx.room.id}`;
		this.logger = new Logger(`RoomAgentSession ${ctx.room.id.slice(0, 8)}`);
		this.maxConcurrentWorkers = ctx.maxConcurrentWorkers ?? DEFAULT_MAX_CONCURRENT_WORKERS;

		// Handle both Database wrapper and raw BunDatabase
		const rawDb = 'getDatabase' in ctx.db ? ctx.db.getDatabase() : ctx.db;
		this.sdkMessageRepo = new SDKMessageRepository(rawDb);
		this.proposalRepo = new ProposalRepository(rawDb);

		// Initialize core components
		this.messageQueue = new MessageQueue();

		// ProcessingStateManager requires Database wrapper - get it from context
		// If we only have raw BunDatabase, create a minimal wrapper-like interface
		const dbWrapper = 'getDatabase' in ctx.db ? ctx.db : null;
		if (!dbWrapper) {
			throw new Error('RoomAgentSession requires Database wrapper for ProcessingStateManager');
		}
		this.processingStateManager = new ProcessingStateManager(
			this.sessionId,
			ctx.daemonHub,
			dbWrapper
		);
		this.contextTracker = new ContextTracker(
			this.sessionId,
			ctx.model ?? DEFAULT_MODEL,
			ctx.daemonHub,
			() => {} // No persistence callback needed for room agents
		);
	}

	/**
	 * Start the room agent session
	 */
	async start(): Promise<void> {
		this.logger.info('Starting room agent session');

		// Create the RoomAgentTools MCP
		this.roomAgentToolsMcp = this.createRoomAgentMcp();

		// Subscribe to events that should trigger the agent
		this.setupEventSubscriptions();

		// Start the streaming query
		await this.startStreamingQuery();

		this.logger.info('Room agent session started');
	}

	/**
	 * Stop the room agent session
	 */
	async stop(): Promise<void> {
		this.logger.info('Stopping room agent session');
		this.isCleaningUp = true;

		// Unsubscribe from events
		for (const unsubscribe of this.unsubscribers) {
			unsubscribe();
		}
		this.unsubscribers = [];

		// Abort any running query
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}

		// Stop the message queue
		this.messageQueue.stop();
		this.messageQueue.clear();

		// Clear query state
		this.queryObject = null;
		this.queryPromise = null;

		this.logger.info('Room agent session stopped');
	}

	/**
	 * Get current lifecycle state
	 */
	getLifecycleState(): RoomAgentLifecycleState {
		return this.lifecycleState;
	}

	/**
	 * Get current processing state
	 */
	getProcessingState(): AgentProcessingState {
		return this.processingStateManager.getState();
	}

	/**
	 * Inject a planning message to trigger agent reasoning
	 */
	async injectPlanningMessage(context: RoomAgentPlanningContext): Promise<void> {
		this.logger.debug('Injecting planning message');

		// Build the planning prompt
		const prompt = this.buildPlanningPrompt(context);

		// Set lifecycle state
		await this.setLifecycleState('planning');

		// Enqueue the message
		await this.messageQueue.enqueue(prompt, true);
	}

	/**
	 * Inject a review message for completed work
	 */
	async injectReviewMessage(context: RoomAgentReviewContext): Promise<void> {
		this.logger.debug(`Injecting review message for task ${context.task.id}`);

		// Build the review prompt
		const prompt = this.buildReviewPrompt(context);

		// Set lifecycle state
		await this.setLifecycleState('reviewing');

		// Enqueue the message
		await this.messageQueue.enqueue(prompt, true);
	}

	/**
	 * Inject an external event message
	 */
	async injectEventMessage(event: RoomMessageEvent): Promise<void> {
		this.logger.debug(`Injecting event message: ${event.type}`);

		// Build the event prompt
		const prompt = this.buildEventPrompt(event);

		// Set lifecycle state based on event
		if (this.lifecycleState === 'idle') {
			await this.setLifecycleState('planning');
		}

		// Enqueue the message
		await this.messageQueue.enqueue(prompt, true);
	}

	/**
	 * Handle human input to the room agent
	 */
	async handleHumanInput(input: RoomAgentHumanInput): Promise<void> {
		this.logger.debug(`Handling human input: ${input.type}`);

		switch (input.type) {
			case 'command':
				await this.handleCommand(input.content);
				break;
			case 'message':
				await this.injectEventMessage({
					type: 'user_message',
					source: 'human',
					content: input.content,
					timestamp: Date.now(),
				});
				break;
			case 'review_response':
				// Handle review response - this should resume waiting agent
				if (this.lifecycleState === 'waiting') {
					await this.setLifecycleState('reviewing');
					await this.messageQueue.enqueue(`Review response received: ${input.content}`, true);
				}
				break;
		}
	}

	/**
	 * Setup event subscriptions
	 */
	private setupEventSubscriptions(): void {
		// Subscribe to room.message events
		const unsubRoomMessage = this.ctx.daemonHub.on(
			'room.message',
			async (event: {
				roomId: string;
				message: { role: string; content: string; timestamp: number };
				sender?: string;
			}) => {
				if (event.roomId === this.ctx.room.id) {
					await this.injectEventMessage({
						type: event.message.role,
						source: event.sender ?? 'unknown',
						content: event.message.content,
						timestamp: event.message.timestamp,
					});
				}
			},
			{ sessionId: this.sessionId }
		);
		this.unsubscribers.push(unsubRoomMessage);

		// Subscribe to room context updated events
		const unsubContextUpdated = this.ctx.daemonHub.on(
			'room.contextUpdated',
			async (event: {
				roomId: string;
				changes: { background?: string; instructions?: string };
			}) => {
				if (event.roomId === this.ctx.room.id) {
					this.logger.info('Room context updated, injecting context change message');
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

		// Subscribe to task completion events
		const unsubTaskComplete = this.ctx.daemonHub.on(
			'pair.task_completed',
			async (event: { pairId: string; taskId: string; summary: string }) => {
				const pair = this.ctx.sessionPairManager.getPair(event.pairId);
				if (pair && pair.roomId === this.ctx.room.id) {
					const task = await this.ctx.taskManager.getTask(event.taskId);
					if (task) {
						await this.injectReviewMessage({
							task,
							sessionPair: pair,
							summary: event.summary,
							success: true,
						});
					}
				}
			},
			{ sessionId: this.sessionId }
		);
		this.unsubscribers.push(unsubTaskComplete);

		// Subscribe to task failure events
		const unsubTaskFailed = this.ctx.daemonHub.on(
			'pair.task_completed',
			async (event: { pairId: string; taskId: string; summary?: string; error?: string }) => {
				const pair = this.ctx.sessionPairManager.getPair(event.pairId);
				if (pair && pair.roomId === this.ctx.room.id) {
					const task = await this.ctx.taskManager.getTask(event.taskId);
					if (task) {
						await this.injectReviewMessage({
							task,
							sessionPair: pair,
							summary: event.summary ?? 'Task failed',
							success: false,
							error: event.error,
						});
					}
				}
			},
			{ sessionId: this.sessionId }
		);
		this.unsubscribers.push(unsubTaskFailed);

		// Subscribe to idle check events
		const unsubIdleCheck = this.ctx.daemonHub.on(
			'roomAgent.idle',
			async (event: { roomId: string }) => {
				if (event.roomId === this.ctx.room.id && this.lifecycleState === 'idle') {
					await this.performIdleCheck();
				}
			},
			{ sessionId: this.sessionId }
		);
		this.unsubscribers.push(unsubIdleCheck);

		// Subscribe to recurring job triggers
		const unsubRecurringJob = this.ctx.daemonHub.on(
			'recurringJob.triggered',
			async (event: { roomId: string; jobId: string; taskId: string; timestamp: number }) => {
				if (event.roomId !== this.ctx.room.id) return;

				// Get the task that was created
				const task = await this.ctx.taskManager.getTask(event.taskId);
				if (!task) return;

				// Inject as planning message to let AI decide what to do with the triggered job
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
					availableCapacity: this.maxConcurrentWorkers,
				});
			},
			{ sessionId: this.sessionId }
		);
		this.unsubscribers.push(unsubRecurringJob);

		// Subscribe to proposal.approved events
		const unsubProposalApproved = this.ctx.daemonHub.on(
			'proposal.approved',
			async (event: { roomId: string; proposalId: string; proposal: RoomProposal }) => {
				if (event.roomId !== this.ctx.room.id) return;

				this.logger.info(`Proposal ${event.proposalId} approved, injecting message`);
				await this.injectEventMessage({
					type: 'proposal_approved',
					source: 'human',
					content: this.buildProposalApprovedMessage(event.proposal),
					metadata: { proposalId: event.proposalId },
					timestamp: Date.now(),
				});
			},
			{ sessionId: this.sessionId }
		);
		this.unsubscribers.push(unsubProposalApproved);

		// Subscribe to proposal.rejected events
		const unsubProposalRejected = this.ctx.daemonHub.on(
			'proposal.rejected',
			async (event: { roomId: string; proposalId: string; proposal: RoomProposal }) => {
				if (event.roomId !== this.ctx.room.id) return;

				this.logger.info(`Proposal ${event.proposalId} rejected, injecting message`);
				await this.injectEventMessage({
					type: 'proposal_rejected',
					source: 'human',
					content: this.buildProposalRejectedMessage(event.proposal),
					metadata: { proposalId: event.proposalId },
					timestamp: Date.now(),
				});
			},
			{ sessionId: this.sessionId }
		);
		this.unsubscribers.push(unsubProposalRejected);
	}

	/**
	 * Create a proposal that requires human approval
	 * The agent will transition to 'waiting' state until the proposal is approved or rejected.
	 */
	async createProposal(params: {
		type: ProposalType;
		title: string;
		description: string;
		proposedChanges: Record<string, unknown>;
		reasoning: string;
	}): Promise<RoomProposal> {
		this.logger.info(`Creating proposal: ${params.title}`);

		const proposal = this.proposalRepo.createProposal({
			roomId: this.ctx.room.id,
			sessionId: this.sessionId,
			type: params.type,
			title: params.title,
			description: params.description,
			proposedChanges: params.proposedChanges,
			reasoning: params.reasoning,
		});

		// Emit proposal created event
		await this.ctx.daemonHub.emit('proposal.created', {
			sessionId: this.sessionId,
			roomId: this.ctx.room.id,
			proposalId: proposal.id,
			proposal,
		});

		// Transition to waiting state
		await this.setLifecycleState('waiting');

		return proposal;
	}

	/**
	 * Build proposal approved message
	 */
	private buildProposalApprovedMessage(proposal: RoomProposal): string {
		return `# Proposal Approved

**Proposal ID:** ${proposal.id}
**Title:** ${proposal.title}
**Type:** ${proposal.type}

Your proposal has been approved by ${proposal.actedBy ?? 'a human'}.

**Response:** ${proposal.actionResponse ?? 'No additional response provided.'}

You may now proceed to apply the proposed changes.`;
	}

	/**
	 * Build proposal rejected message
	 */
	private buildProposalRejectedMessage(proposal: RoomProposal): string {
		return `# Proposal Rejected

**Proposal ID:** ${proposal.id}
**Title:** ${proposal.title}
**Type:** ${proposal.type}

Your proposal has been rejected by ${proposal.actedBy ?? 'a human'}.

**Reason:** ${proposal.actionResponse ?? 'No reason provided.'}

Please consider alternative approaches or address the concerns raised.`;
	}

	/**
	 * Perform idle check and potentially create planning message
	 */
	private async performIdleCheck(): Promise<void> {
		this.logger.debug('Performing idle check');

		const activeGoals = await this.ctx.goalManager.getActiveGoals();
		const pendingTasks = await this.ctx.taskManager.listTasks({ status: 'pending' });
		const inProgressTasks = await this.ctx.taskManager.listTasks({ status: 'in_progress' });

		// Only create planning message if there's something to do
		if (activeGoals.length > 0 || pendingTasks.length > 0) {
			const availableCapacity = this.maxConcurrentWorkers - inProgressTasks.length;

			await this.injectPlanningMessage({
				activeGoals,
				pendingTasks,
				inProgressTasks,
				recentEvents: [],
				availableCapacity,
			});
		}
	}

	/**
	 * Set lifecycle state and emit event
	 */
	private async setLifecycleState(state: RoomAgentLifecycleState): Promise<void> {
		const previousState = this.lifecycleState;
		if (previousState === state) return;

		this.lifecycleState = state;
		this.logger.debug(`Lifecycle state: ${previousState} -> ${state}`);

		// Emit state change event
		await this.ctx.daemonHub.emit('roomAgent.stateChanged', {
			sessionId: this.sessionId,
			roomId: this.ctx.room.id,
			previousState,
			newState: state,
		});
	}

	/**
	 * Handle slash commands
	 */
	private async handleCommand(content: string): Promise<void> {
		const command = content.split(' ')[0].toLowerCase();
		const _args = content.slice(command.length).trim();

		switch (command) {
			case '/pause':
				await this.setLifecycleState('paused');
				break;
			case '/resume':
				await this.setLifecycleState('idle');
				break;
			case '/status':
				await this.ctx.daemonHub.emit('room.message', {
					sessionId: this.sessionId,
					roomId: this.ctx.room.id,
					message: {
						id: generateUUID(),
						role: 'assistant',
						content: `Agent Status: ${this.lifecycleState}\nProcessing: ${this.processingStateManager.getState().status}`,
						timestamp: Date.now(),
					},
					sender: 'Neo',
				});
				break;
			case '/goals':
				const goals = await this.ctx.goalManager.listGoals();
				const summary = goals.map((g) => `- ${g.title} (${g.status}, ${g.progress}%)`).join('\n');
				await this.ctx.daemonHub.emit('room.message', {
					sessionId: this.sessionId,
					roomId: this.ctx.room.id,
					message: {
						id: generateUUID(),
						role: 'assistant',
						content: `Goals:\n${summary || 'No goals defined'}`,
						timestamp: Date.now(),
					},
					sender: 'Neo',
				});
				break;
			default:
				this.logger.warn(`Unknown command: ${command}`);
		}
	}

	/**
	 * Build planning prompt from context
	 */
	private buildPlanningPrompt(context: RoomAgentPlanningContext): string {
		const parts: string[] = [];

		parts.push('# Room Agent Planning Phase\n');
		parts.push(`Room: ${this.ctx.room.name}`);
		parts.push(`Current Lifecycle State: ${this.lifecycleState}\n`);

		// Active goals
		if (context.activeGoals.length > 0) {
			parts.push('## Active Goals');
			for (const goal of context.activeGoals) {
				parts.push(`- ${goal.title} (${goal.status}, ${goal.progress}%)`);
			}
			parts.push('');
		}

		// Pending tasks
		if (context.pendingTasks.length > 0) {
			parts.push('## Pending Tasks');
			for (const task of context.pendingTasks) {
				parts.push(`- [${task.priority}] ${task.title}`);
			}
			parts.push('');
		}

		// In-progress tasks
		if (context.inProgressTasks.length > 0) {
			parts.push('## In-Progress Tasks');
			for (const task of context.inProgressTasks) {
				parts.push(`- ${task.title} (${task.progress ?? 0}%)`);
			}
			parts.push('');
		}

		// Recent events
		if (context.recentEvents.length > 0) {
			parts.push('## Recent Events');
			for (const event of context.recentEvents) {
				parts.push(`- [${event.type}] ${event.summary}`);
			}
			parts.push('');
		}

		// Capacity
		parts.push(`## Available Capacity: ${context.availableCapacity} workers`);

		// Instructions
		parts.push('\n## Instructions');
		parts.push('Analyze the current state and decide:');
		parts.push('1. Should any goals be updated or completed?');
		parts.push('2. Should new tasks be created from pending work?');
		parts.push('3. Should workers be spawned for pending tasks?');
		parts.push('4. Are there any blockers or issues to address?');

		return parts.join('\n');
	}

	/**
	 * Build review prompt from context
	 */
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

	/**
	 * Build event prompt
	 */
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

	/**
	 * Build context update message
	 */
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
			if (changes.background) {
				parts.push(changes.background);
			} else {
				parts.push('(cleared)');
			}
			parts.push('');
		}

		if (changes.instructions !== undefined) {
			parts.push('## Instructions');
			if (changes.instructions) {
				parts.push(changes.instructions);
			} else {
				parts.push('(cleared)');
			}
			parts.push('');
		}

		parts.push('## Action Required');
		parts.push('Review the updated context and:');
		parts.push('1. Adjust any pending plans to align with the new context');
		parts.push('2. Update any affected goals if needed');
		parts.push('3. Communicate any significant changes to the user if appropriate');

		return parts.join('\n');
	}

	/**
	 * Create the RoomAgentTools MCP server
	 */
	private createRoomAgentMcp(): McpSdkServerConfigWithInstance {
		const config: RoomAgentToolsConfig = {
			roomId: this.ctx.room.id,
			sessionId: this.sessionId,
			onCompleteGoal: async (params: RoomCompleteGoalParams) => {
				await this.ctx.goalManager.completeGoal(params.goalId);
				this.logger.info(`Goal completed: ${params.goalId}`);
			},
			onCreateTask: async (params: RoomCreateTaskParams) => {
				const task = await this.ctx.taskManager.createTask({
					title: params.title,
					description: params.description,
					priority: params.priority as TaskPriority | undefined,
				});
				if (params.goalId) {
					await this.ctx.goalManager.linkTaskToGoal(params.goalId, task.id);
				}
				this.logger.info(`Task created: ${task.id}`);
				return { taskId: task.id };
			},
			onSpawnWorker: async (params: RoomSpawnWorkerParams) => {
				const task = await this.ctx.taskManager.getTask(params.taskId);
				if (!task) {
					throw new Error(`Task not found: ${params.taskId}`);
				}

				const result = await this.ctx.sessionPairManager.createPair({
					roomId: this.ctx.room.id,
					roomSessionId: this.sessionId,
					taskTitle: task.title,
					taskDescription: task.description,
					workspacePath: this.ctx.room.defaultPath ?? this.ctx.room.allowedPaths[0],
				});

				await this.ctx.taskManager.startTask(params.taskId, result.pair.workerSessionId);

				this.logger.info(
					`Worker spawned: ${result.pair.workerSessionId} for task ${params.taskId}`
				);
				return { pairId: result.pair.id, workerSessionId: result.pair.workerSessionId };
			},
			onRequestReview: async (taskId: string, reason: string) => {
				await this.setLifecycleState('waiting');
				await this.ctx.daemonHub.emit('roomAgent.reviewRequested', {
					sessionId: this.sessionId,
					roomId: this.ctx.room.id,
					taskId,
					reason,
				} as unknown as Parameters<typeof this.ctx.daemonHub.emit>[1]);
				this.logger.info(`Review requested for task ${taskId}: ${reason}`);
			},
			onEscalate: async (taskId: string, reason: string) => {
				await this.setLifecycleState('waiting');
				await this.ctx.daemonHub.emit('roomAgent.escalated', {
					sessionId: this.sessionId,
					roomId: this.ctx.room.id,
					taskId,
					reason,
				} as unknown as Parameters<typeof this.ctx.daemonHub.emit>[1]);
				this.logger.warn(`Task ${taskId} escalated: ${reason}`);
			},
			onUpdateGoalProgress: async (params: RoomUpdateGoalProgressParams) => {
				await this.ctx.goalManager.updateGoalProgress(
					params.goalId,
					params.progress,
					params.metrics
				);
				this.logger.debug(`Goal progress updated: ${params.goalId} -> ${params.progress}%`);
			},
			onScheduleJob: async (params: RoomScheduleJobParams) => {
				const result = await this.ctx.recurringJobScheduler.createJob(params);
				this.logger.info(`Recurring job scheduled: ${result.id}`);
				return { jobId: result.id };
			},
			// Q&A round callbacks
			onAskQuestion: this.ctx.qaRoundManager
				? async (question: string) => {
						const qa = await this.ctx.qaRoundManager!.askQuestion(question);
						this.logger.info(`Q&A question asked: ${qa.id}`);
						return { questionId: qa.id };
					}
				: undefined,
			onCompleteQARound: this.ctx.qaRoundManager
				? async (summary?: string) => {
						await this.ctx.qaRoundManager!.completeRound(summary);
						this.logger.info('Q&A round completed');
					}
				: undefined,
		};

		const server = createRoomAgentMcpServer(config);
		return { server };
	}

	/**
	 * Start the streaming query
	 */
	private async startStreamingQuery(): Promise<void> {
		if (this.messageQueue.isRunning()) {
			return;
		}

		this.messageQueue.start();
		this.queryGeneration++;

		// Run the query in background
		this.queryPromise = this.runQuery();
	}

	/**
	 * Run the SDK query
	 */
	private async runQuery(): Promise<void> {
		try {
			// Get API key
			const apiKey = await this.ctx.getApiKey();
			if (!apiKey) {
				this.logger.error('No API key available');
				return;
			}

			// Get the room agent system prompt
			const systemPrompt = await this.getSystemPrompt();

			// Build query options (simplified for room agent)
			const options = await this.buildQueryOptions(systemPrompt);

			// Import query function dynamically
			const { query } = await import('@anthropic-ai/claude-agent-sdk');

			// Create abort controller
			this.abortController = new AbortController();

			// Create the query
			this.queryObject = query({
				prompt: this.createMessageGenerator(),
				options,
			});

			// Process messages
			for await (const message of this.createAbortableIterator(this.queryObject)) {
				if (this.isCleaningUp) break;

				await this.handleSDKMessage(message as SDKMessage);
			}
		} catch (error) {
			if (!this.isCleaningUp) {
				this.logger.error('Query error:', error);
				await this.setLifecycleState('error');
			}
		} finally {
			this.messageQueue.stop();
			await this.setLifecycleState('idle');
		}
	}

	/**
	 * Create the message generator for the SDK
	 */
	private async *createMessageGenerator(): AsyncGenerator<SDKUserMessage> {
		for await (const { message, onSent } of this.messageQueue.messageGenerator(this.sessionId)) {
			await this.processingStateManager.setProcessing(message.uuid ?? 'unknown', 'initializing');
			yield message;
			onSent();
		}
	}

	/**
	 * Create an abortable async iterator
	 */
	private async *createAbortableIterator(
		queryObj: Query,
		signal?: AbortSignal
	): AsyncGenerator<unknown> {
		const abortSignal = signal ?? this.abortController?.signal;
		const iterator = queryObj[Symbol.asyncIterator]();
		const abortError = new Error('Query aborted');

		try {
			while (!abortSignal?.aborted && !this.isCleaningUp) {
				const result = await Promise.race([
					iterator.next(),
					new Promise<never>((_, reject) => {
						if (abortSignal?.aborted) {
							reject(abortError);
						} else {
							abortSignal?.addEventListener('abort', () => reject(abortError), {
								once: true,
							});
						}
					}),
				]);

				if (result.done) break;
				yield result.value;
			}
		} finally {
			try {
				await iterator.return?.();
			} catch {
				// Ignore cleanup errors
			}
		}
	}

	/**
	 * Handle an SDK message
	 */
	private async handleSDKMessage(message: SDKMessage): Promise<void> {
		// Update processing state based on message type
		await this.processingStateManager.detectPhaseFromMessage(message);

		// Save message to database
		this.sdkMessageRepo.saveSDKMessage(this.sessionId, message);

		// Emit message to clients
		this.ctx.messageHub.event(
			'state.sdkMessages.delta',
			{ added: [message], timestamp: Date.now() },
			{ channel: `session:${this.sessionId}` }
		);

		// Handle result message
		if (message.type === 'result') {
			await this.handleResultMessage(message);
		}
	}

	/**
	 * Handle result message
	 */
	private async handleResultMessage(_message: SDKMessage): Promise<void> {
		// Update lifecycle state based on result
		if (this.lifecycleState === 'planning' || this.lifecycleState === 'reviewing') {
			// Return to idle after planning/reviewing unless waiting for input
			const state = this.processingStateManager.getState();
			if (state.status !== 'waiting_for_input') {
				await this.setLifecycleState('idle');
			}
		}
	}

	/**
	 * Get the system prompt for the room agent
	 */
	private async getSystemPrompt(): Promise<string> {
		// Try to get from template manager
		const rendered = this.ctx.promptTemplateManager.getRenderedPrompt(
			this.ctx.room.id,
			'room_agent_system'
		);

		if (rendered) {
			return rendered.content;
		}

		// Fall back to a basic system prompt
		return this.getDefaultSystemPrompt();
	}

	/**
	 * Get the default system prompt
	 */
	private getDefaultSystemPrompt(): string {
		return `You are a Room Agent for the "${this.ctx.room.name}" room.

Your responsibilities:
1. Process incoming events and create appropriate tasks
2. Monitor goal progress and update goals as needed
3. Spawn worker sessions to execute tasks
4. Review completed work and take follow-up actions

You have access to room-level tools for:
- Completing goals
- Creating and managing tasks
- Spawning worker sessions
- Requesting human reviews
- Escalating issues
- Updating goal progress
- Scheduling recurring jobs

Always consider the room's goals and priorities when making decisions.
Maximum concurrent workers: ${this.maxConcurrentWorkers}`;
	}

	/**
	 * Build query options for the SDK
	 */
	private async buildQueryOptions(systemPrompt: string): Promise<Record<string, unknown>> {
		const model = this.ctx.model ?? DEFAULT_MODEL;

		// Determine the SDK model ID
		let sdkModelId = model;
		if (model === 'sonnet' || model === 'claude-sonnet') {
			sdkModelId = 'default';
		}

		return {
			model: sdkModelId,
			systemPrompt,
			mcpServers: {
				'room-agent-tools': this.roomAgentToolsMcp?.server,
			},
			cwd: this.ctx.room.defaultPath ?? this.ctx.room.allowedPaths[0],
			permissionMode: 'bypassPermissions',
			maxTurns: Infinity,
		};
	}
}
