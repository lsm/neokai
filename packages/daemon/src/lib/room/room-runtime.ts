/**
 * RoomRuntime - Central orchestrator for autonomous room operation
 *
 * Manages the lifecycle of (Craft, Lead) agent pairs:
 * 1. Detects pending tasks and spawns pairs
 * 2. Routes Craft output to Lead for review
 * 3. Routes Lead feedback to Craft
 * 4. Handles Lead tool calls (complete_task, fail_task, send_to_craft)
 * 5. Enforces Lead tool contract (retry-then-escalate)
 * 6. Periodic tick as safety net
 *
 * All handlers are idempotent. Tick mutex prevents concurrent execution.
 */

import type { Room, NeoTask } from '@neokai/shared';
import type { TaskPairRepository } from './task-pair-repository';
import type { TaskManager } from './task-manager';
import type { GoalManager } from './goal-manager';
import type { SessionObserver, TerminalState } from './session-observer';
import type { SessionFactory } from './task-pair-manager';
import { TaskPairManager } from './task-pair-manager';
import type { LeadToolCallbacks, LeadToolResult } from './lead-agent';
import {
	formatCraftToLeadEnvelope,
	formatLeadToCraftFeedback,
	formatLeadContractNudge,
	sortTasksByPriority,
} from './message-routing';

export type RuntimeState = 'running' | 'paused' | 'stopped';

export interface RoomRuntimeConfig {
	room: Room;
	taskPairRepo: TaskPairRepository;
	sessionObserver: SessionObserver;
	taskManager: TaskManager;
	goalManager: GoalManager;
	sessionFactory: SessionFactory;
	workspacePath: string;
	model?: string;
	/** Max concurrent pairs (default: 1 for MVP) */
	maxConcurrentPairs?: number;
	/** Max feedback iterations before auto-escalation (default: 5) */
	maxFeedbackIterations?: number;
	/** Tick interval in ms (default: 30000) */
	tickInterval?: number;
}

function jsonResult(data: Record<string, unknown>): LeadToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

export class RoomRuntime {
	private state: RuntimeState = 'paused';
	private tickLocked = false;
	private tickQueued = false;
	private tickTimer: ReturnType<typeof setInterval> | null = null;

	private readonly room: Room;
	private readonly taskPairRepo: TaskPairRepository;
	private readonly observer: SessionObserver;
	private readonly taskManager: TaskManager;
	private readonly goalManager: GoalManager;
	private readonly sessionFactory: SessionFactory;
	private readonly maxConcurrentPairs: number;
	private readonly maxFeedbackIterations: number;
	private readonly tickInterval: number;

	readonly pairManager: TaskPairManager;

	constructor(config: RoomRuntimeConfig) {
		this.room = config.room;
		this.taskPairRepo = config.taskPairRepo;
		this.observer = config.sessionObserver;
		this.taskManager = config.taskManager;
		this.goalManager = config.goalManager;
		this.sessionFactory = config.sessionFactory;
		this.maxConcurrentPairs = config.maxConcurrentPairs ?? 1;
		this.maxFeedbackIterations = config.maxFeedbackIterations ?? 5;
		this.tickInterval = config.tickInterval ?? 30_000;

		this.pairManager = new TaskPairManager({
			room: config.room,
			taskPairRepo: config.taskPairRepo,
			sessionObserver: config.sessionObserver,
			taskManager: config.taskManager,
			goalManager: config.goalManager,
			sessionFactory: config.sessionFactory,
			workspacePath: config.workspacePath,
			model: config.model,
		});
	}

	// =========================================================================
	// Lifecycle
	// =========================================================================

	start(): void {
		this.state = 'running';
		this.tickTimer = setInterval(() => this.tick(), this.tickInterval);
		this.scheduleTick();
	}

	pause(): void {
		this.state = 'paused';
	}

	resume(): void {
		this.state = 'running';
		this.scheduleTick();
	}

	stop(): void {
		this.state = 'stopped';
		if (this.tickTimer) {
			clearInterval(this.tickTimer);
			this.tickTimer = null;
		}
		this.observer.dispose();
	}

	getState(): RuntimeState {
		return this.state;
	}

	// =========================================================================
	// Event Handlers (trigger tick)
	// =========================================================================

	/**
	 * Called when a goal is created. Triggers a tick to check for pending tasks.
	 */
	onGoalCreated(_goalId: string): void {
		this.scheduleTick();
	}

	/**
	 * Called when a task status changes. Triggers a tick.
	 */
	onTaskStatusChanged(_taskId: string): void {
		this.scheduleTick();
	}

	/**
	 * Called when Craft reaches a terminal state.
	 * Formats Craft output and routes to Lead.
	 */
	async onCraftTerminalState(pairId: string, terminalState: TerminalState): Promise<void> {
		const pair = this.taskPairRepo.getPair(pairId);
		if (!pair || pair.pairState !== 'awaiting_craft') return;

		const task = await this.taskManager.getTask(pair.taskId);
		if (!task) return;

		// Format craft output envelope
		const envelope = formatCraftToLeadEnvelope({
			iteration: pair.feedbackIteration,
			taskTitle: task.title,
			terminalState: terminalState.kind,
			craftOutput: `[Craft session ${pair.craftSessionId} reached terminal state: ${terminalState.kind}]`,
		});

		// Route to Lead
		await this.pairManager.routeCraftToLead(pairId, envelope);
	}

	/**
	 * Called when Lead reaches a terminal state.
	 * Validates Lead tool contract (retry-then-escalate).
	 */
	async onLeadTerminalState(pairId: string, _terminalState: TerminalState): Promise<void> {
		const pair = this.taskPairRepo.getPair(pairId);
		if (!pair || pair.pairState !== 'awaiting_lead') return;

		// Check if Lead called a tool (via in-memory map)
		const calledTool = this.pairManager.leadCalledToolMap.get(pairId) ?? false;

		if (calledTool) {
			// Lead called a tool → success, no action needed
			// (The tool handler already processed the action)
			return;
		}

		// Contract violation: Lead reached terminal without calling a tool
		const violations = pair.leadContractViolations;

		if (violations === 0) {
			// First violation: nudge
			const nudge = formatLeadContractNudge();
			await this.sessionFactory.injectMessage(pair.leadSessionId, nudge);
			this.taskPairRepo.updateLeadContractViolations(
				pairId,
				1,
				'', // turn ID placeholder - MVP doesn't track turn IDs
				pair.version
			);
		} else {
			// Second+ violation: auto-escalate
			const updated = this.taskPairRepo.updatePairState(pairId, 'awaiting_human', pair.version);
			if (updated) {
				await this.taskManager.escalateTask(
					pair.taskId,
					'Lead failed to call required tool after nudge'
				);
			}
		}
	}

	// =========================================================================
	// Lead Tool Handling (called from MCP tool callbacks)
	// =========================================================================

	/**
	 * Handle a Lead tool call. Called synchronously from MCP tool handler.
	 * Returns the tool result to be sent back to the Lead agent.
	 */
	async handleLeadTool(
		pairId: string,
		toolName: string,
		params: { message?: string; summary?: string; reason?: string }
	): Promise<LeadToolResult> {
		const pair = this.taskPairRepo.getPair(pairId);
		if (!pair) {
			return jsonResult({ success: false, error: `Pair not found: ${pairId}` });
		}

		if (pair.pairState !== 'awaiting_lead') {
			return jsonResult({
				success: false,
				error: `Pair not in awaiting_lead state (current: ${pair.pairState})`,
			});
		}

		// Mark that Lead called a tool
		this.pairManager.leadCalledToolMap.set(pairId, true);

		switch (toolName) {
			case 'send_to_craft': {
				const message = params.message ?? '';
				const feedback = formatLeadToCraftFeedback(message, pair.feedbackIteration + 1);
				await this.pairManager.routeLeadToCraft(pairId, feedback);
				return jsonResult({
					success: true,
					message: 'Feedback sent to Craft. Waiting for next iteration.',
				});
			}

			case 'complete_task': {
				const summary = params.summary ?? '';
				await this.pairManager.completePair(pairId, summary);
				this.scheduleTick();
				return jsonResult({ success: true, message: 'Task completed successfully.' });
			}

			case 'fail_task': {
				const reason = params.reason ?? '';
				await this.pairManager.failPair(pairId, reason);
				this.scheduleTick();
				return jsonResult({ success: true, message: 'Task marked as failed.' });
			}

			default:
				return jsonResult({ success: false, error: `Unknown tool: ${toolName}` });
		}
	}

	/**
	 * Create LeadToolCallbacks that route through this runtime.
	 */
	createLeadCallbacks(pairId: string): LeadToolCallbacks {
		return {
			sendToCraft: async (_pairId: string, message: string) => {
				return this.handleLeadTool(pairId, 'send_to_craft', { message });
			},
			completeTask: async (_pairId: string, summary: string) => {
				return this.handleLeadTool(pairId, 'complete_task', { summary });
			},
			failTask: async (_pairId: string, reason: string) => {
				return this.handleLeadTool(pairId, 'fail_task', { reason });
			},
		};
	}

	// =========================================================================
	// Tick Logic
	// =========================================================================

	/**
	 * Main scheduling loop. Idempotent with mutex protection.
	 */
	async tick(): Promise<void> {
		if (this.state !== 'running') return;

		// Mutex: only one tick at a time
		if (this.tickLocked) {
			this.tickQueued = true;
			return;
		}

		this.tickLocked = true;
		try {
			await this.executeTick();
		} finally {
			this.tickLocked = false;
			// Re-tick if queued while we were running
			if (this.tickQueued) {
				this.tickQueued = false;
				// Use microtask to avoid stack depth issues
				queueMicrotask(() => this.tick());
			}
		}
	}

	private async executeTick(): Promise<void> {
		// Check capacity
		const activePairs = this.taskPairRepo.getActivePairs(this.room.id);
		const availableSlots = this.maxConcurrentPairs - activePairs.length;

		if (availableSlots <= 0) return;

		// Find pending tasks
		const pendingTasks = await this.taskManager.listTasks({ status: 'pending' });
		if (pendingTasks.length === 0) return;

		// Sort by priority
		const sorted = sortTasksByPriority(pendingTasks);

		// Spawn pairs for available slots
		const toSpawn = sorted.slice(0, availableSlots);

		for (const task of toSpawn) {
			await this.spawnPairForTask(task);
		}
	}

	private async spawnPairForTask(task: NeoTask): Promise<void> {
		// Find the goal linked to this task
		const goals = await this.goalManager.getGoalsForTask(task.id);
		const goal = goals[0] ?? (await this.goalManager.getNextGoal());
		if (!goal) return;

		const callbacks = this.createLeadCallbacks(task.id);

		await this.pairManager.spawnPair(
			task,
			goal,
			(pairId, state) => this.onCraftTerminalState(pairId, state),
			(pairId, state) => this.onLeadTerminalState(pairId, state),
			callbacks
		);
	}

	private scheduleTick(): void {
		if (this.state !== 'running') return;
		// Use queueMicrotask for non-blocking tick scheduling
		queueMicrotask(() => this.tick());
	}
}
