/**
 * AutomationScheduler
 *
 * Owns Automation command execution and dispatch. It is the only layer that
 * creates user-triggered run rows; target launchers create concrete Room/Space
 * work and return links for the run ledger.
 */

import type {
	AutomationRun,
	AutomationRunStatus,
	AutomationTask,
	AutomationTargetType,
	AutomationTriggerType,
	JobHandlerAutomationTargetConfig,
	NeoAgentAutomationTargetConfig,
	RoomMissionAutomationTargetConfig,
	RoomTaskAutomationTargetConfig,
	SpaceTaskAutomationTargetConfig,
	SpaceWorkflowAutomationTargetConfig,
} from '@neokai/shared';
import type { AutomationManager } from './automation-manager';
import {
	AutomationConditionEvaluator,
	type AutomationConditionEvaluation,
} from './automation-condition-evaluator';
import type { Job, JobQueueRepository } from '../../storage/repositories/job-queue-repository';
import { AUTOMATION_DISPATCH } from '../job-queue-constants';
import { getNextRunAt } from '../room/runtime/cron-utils';

const FAILURE_CIRCUIT_BREAKER_THRESHOLD = 3;

export interface AutomationLaunchResult {
	roomTaskId?: string;
	roomGoalId?: string;
	missionExecutionId?: string;
	spaceTaskId?: string;
	spaceWorkflowRunId?: string;
	sessionId?: string;
	status?: AutomationRunStatus;
	resultSummary?: string;
	metadata?: Record<string, unknown>;
}

export interface AutomationTargetLauncher {
	launch(task: AutomationTask, run: AutomationRun): Promise<AutomationLaunchResult>;
}

export interface AutomationTargetStateReader {
	getRoomTaskStatus?(
		roomId: string,
		taskId: string
	): Promise<{ status: string; result?: string | null } | null>;
	getSpaceTaskStatus?(
		spaceId: string,
		taskId: string
	): Promise<{ status: string; result?: string | null } | null>;
	getMissionExecutionStatus?(
		roomId: string,
		executionId: string
	): Promise<{ status: string; resultSummary?: string | null } | null>;
}

export class AutomationScheduler {
	private launchers = new Map<AutomationTargetType, AutomationTargetLauncher>();

	constructor(
		private manager: AutomationManager,
		private jobQueue: JobQueueRepository,
		private conditionEvaluator = new AutomationConditionEvaluator(),
		private targetStateReader: AutomationTargetStateReader = {}
	) {}

	registerLauncher(targetType: AutomationTargetType, launcher: AutomationTargetLauncher): void {
		this.launchers.set(targetType, launcher);
	}

	scheduleTask(task: AutomationTask): void {
		if (task.status !== 'active') return;
		const runAt = task.nextRunAt ?? this.computeInitialRunAt(task);
		if (runAt === null) return;
		if (task.nextRunAt === null) {
			this.manager.updateTask(task.id, { nextRunAt: runAt });
		}
		this.enqueueDispatch(task.id, runAt);
	}

	seedSchedules(limit = 1000): void {
		const active = this.manager.listTasks({ status: 'active', limit });
		for (const task of active) {
			this.scheduleTask(task);
		}
	}

	pause(id: string): AutomationTask {
		const task = this.manager.updateTask(id, { status: 'paused' });
		this.cancelPendingDispatchJobs(id);
		return task;
	}

	resume(id: string): AutomationTask {
		const task = this.manager.updateTask(id, {
			status: 'active',
			consecutiveFailureCount: 0,
			lastFailureFingerprint: null,
			pausedReason: null,
		});
		this.scheduleTask(task);
		return task;
	}

	setNextRunAt(id: string, nextRunAt: number | null): AutomationTask {
		if (nextRunAt !== null && nextRunAt <= Date.now()) {
			throw new Error('nextRunAt must be in the future');
		}
		const task = this.manager.updateTask(id, { nextRunAt });
		this.cancelPendingDispatchJobs(id);
		this.scheduleTask(task);
		return task;
	}

	cancelPendingJobs(id: string): void {
		this.cancelPendingDispatchJobs(id);
	}

	async triggerNow(id: string): Promise<AutomationRun> {
		return this.dispatch(id, {
			triggerType: 'manual',
			triggerReason: 'manual',
			ignoreDueTime: true,
			consumeSchedule: false,
		});
	}

	async emitEvent(
		eventName: string,
		payload: Record<string, unknown> = {}
	): Promise<AutomationRun[]> {
		const automations = this.manager
			.listTasks({ status: 'active', triggerType: 'event', limit: 1000 })
			.filter((task) => {
				const config = task.triggerConfig as {
					eventName?: string;
					filters?: Record<string, unknown>;
				};
				if (config.eventName !== eventName) return false;
				return this.matchesEventFilters(config.filters, payload);
			});
		const runs: AutomationRun[] = [];
		for (const automation of automations) {
			runs.push(
				await this.dispatch(automation.id, {
					triggerType: 'event',
					triggerReason: eventName,
					ignoreDueTime: true,
				})
			);
		}
		return runs;
	}

	async handleDispatchJob(job: Job): Promise<Record<string, unknown>> {
		const payload = job.payload as {
			automationId?: string;
			triggerReason?: string;
			attempt?: number;
			dispatchKey?: string;
		};
		if (!payload.automationId) {
			throw new Error('automation.dispatch payload missing automationId');
		}
		this.sweepTimedOutRuns();
		this.recoverOrphanedRuns();
		await this.syncLinkedRuns();
		const run = await this.dispatch(payload.automationId, {
			triggerReason: payload.triggerReason ?? 'scheduled',
			jobId: job.id,
			attempt: payload.attempt,
			dispatchKey: payload.dispatchKey,
		});
		return { automationId: payload.automationId, runId: run.id, status: run.status };
	}

	async dispatch(
		automationId: string,
		options?: {
			triggerType?: AutomationTriggerType;
			triggerReason?: string;
			jobId?: string;
			attempt?: number;
			dispatchKey?: string;
			ignoreDueTime?: boolean;
			consumeSchedule?: boolean;
		}
	): Promise<AutomationRun> {
		const task = this.manager.getTask(automationId);
		if (!task) {
			throw new Error(`Automation not found: ${automationId}`);
		}
		if (task.status !== 'active') {
			throw new Error(`Automation ${automationId} is not active`);
		}
		const now = Date.now();
		if (!options?.ignoreDueTime && task.nextRunAt !== null && task.nextRunAt > now) {
			throw new Error(`Automation ${automationId} is not due yet`);
		}
		const dispatchKey = options?.dispatchKey ?? this.buildDispatchKey(task, options);
		const existingRun = dispatchKey ? this.manager.getRunByDispatchKey(dispatchKey) : null;
		if (existingRun) {
			this.recordRunEvent(existingRun, 'run_recovered', 'Dispatch key reused existing run', {
				dispatchKey,
			});
			return existingRun;
		}

		const condition = await this.evaluateCondition(task);
		if (!condition.passed) {
			const skipped = this.manager.createRun({
				automationTaskId: task.id,
				ownerType: task.ownerType,
				ownerId: task.ownerId,
				status: 'succeeded',
				triggerType: options?.triggerType ?? task.triggerType,
				triggerReason: options?.triggerReason ?? 'condition_not_met',
				dispatchKey,
				jobId: options?.jobId,
				metadata: {
					skippedTarget: true,
					reason: 'condition_not_met',
					condition,
				},
			});
			this.recordRunEvent(skipped, 'condition_evaluated', condition.reason, {
				passed: false,
				condition,
			});
			this.finishDispatchSchedule(task, options?.consumeSchedule ?? true);
			return skipped;
		}

		const activeRuns = this.manager.listActiveRuns(task.id);
		const runningRuns = activeRuns.filter((run) => run.status === 'running');
		const queuedRuns = activeRuns.filter((run) => run.status === 'queued');
		if (runningRuns.length > 0 && task.concurrencyPolicy === 'skip') {
			const skipped = this.manager.createRun({
				automationTaskId: task.id,
				ownerType: task.ownerType,
				ownerId: task.ownerId,
				status: 'succeeded',
				triggerType: options?.triggerType ?? task.triggerType,
				triggerReason: options?.triggerReason ?? 'skipped_overlap',
				dispatchKey,
				jobId: options?.jobId,
				metadata: {
					skippedTarget: true,
					reason: 'active_run_exists',
					activeRunIds: runningRuns.map((run) => run.id),
				},
			});
			this.recordRunEvent(skipped, 'concurrency_skipped', 'Skipped because an active run exists', {
				activeRunIds: runningRuns.map((run) => run.id),
			});
			this.finishDispatchSchedule(task, options?.consumeSchedule ?? true);
			return skipped;
		}
		if (runningRuns.length > 0 && task.concurrencyPolicy === 'queue') {
			const queued = this.manager.createRun({
				automationTaskId: task.id,
				ownerType: task.ownerType,
				ownerId: task.ownerId,
				status: 'queued',
				triggerType: options?.triggerType ?? task.triggerType,
				triggerReason: options?.triggerReason ?? 'queued_overlap',
				dispatchKey,
				jobId: options?.jobId,
				attempt: options?.attempt ?? 1,
				metadata: {
					reason: 'active_run_exists',
					activeRunIds: runningRuns.map((run) => run.id),
				},
			});
			this.recordRunEvent(queued, 'concurrency_queued', 'Queued behind an active run', {
				activeRunIds: runningRuns.map((run) => run.id),
			});
			this.enqueueQueuedDrain(task.id);
			this.finishDispatchSchedule(task, options?.consumeSchedule ?? true);
			return queued;
		}
		if (runningRuns.length > 0 && task.concurrencyPolicy === 'cancel_previous') {
			for (const activeRun of runningRuns) {
				this.manager.updateRun(activeRun.id, {
					status: 'cancelled',
					error: 'Cancelled by newer automation dispatch',
				});
				this.recordRunEvent(
					{ ...activeRun, status: 'cancelled', error: 'Cancelled by newer automation dispatch' },
					'concurrency_cancelled_previous',
					'Cancelled by newer automation dispatch'
				);
			}
		}
		if (
			runningRuns.length > 0 &&
			task.concurrencyPolicy !== 'allow_parallel' &&
			task.concurrencyPolicy !== 'cancel_previous'
		) {
			throw new Error(`Concurrency policy ${task.concurrencyPolicy} is not implemented yet`);
		}

		const run =
			queuedRuns.length > 0
				? this.manager.updateRun(queuedRuns[queuedRuns.length - 1].id, {
						status: 'running',
						jobId: options?.jobId ?? null,
						dispatchKey,
					})
				: this.manager.createRun({
						automationTaskId: task.id,
						ownerType: task.ownerType,
						ownerId: task.ownerId,
						status: 'running',
						triggerType: options?.triggerType ?? task.triggerType,
						triggerReason: options?.triggerReason ?? null,
						dispatchKey,
						jobId: options?.jobId,
						attempt: options?.attempt ?? 1,
					});
		this.recordRunEvent(run, 'run_created', 'Automation run started', {
			triggerReason: run.triggerReason,
			attempt: run.attempt,
		});

		try {
			const launcher = this.launchers.get(task.targetType);
			if (!launcher) {
				throw new Error(`Automation target is not implemented: ${task.targetType}`);
			}
			this.recordRunEvent(run, 'target_launch_started', `Launching ${task.targetType} target`, {
				targetType: task.targetType,
			});
			const result = await launcher.launch(task, run);
			const updated = this.manager.updateRun(run.id, {
				status: result.status ?? 'running',
				roomTaskId: result.roomTaskId ?? null,
				roomGoalId: result.roomGoalId ?? null,
				missionExecutionId: result.missionExecutionId ?? null,
				spaceTaskId: result.spaceTaskId ?? null,
				spaceWorkflowRunId: result.spaceWorkflowRunId ?? null,
				sessionId: result.sessionId ?? null,
				resultSummary: result.resultSummary ?? null,
				metadata: result.metadata ?? null,
			});
			this.recordRunEvent(updated, 'target_launch_succeeded', result.resultSummary ?? null, {
				targetType: task.targetType,
				roomTaskId: result.roomTaskId ?? null,
				spaceTaskId: result.spaceTaskId ?? null,
				sessionId: result.sessionId ?? null,
			});
			this.recordRunOutcome(task, updated);
			this.finishDispatchSchedule(task, options?.consumeSchedule ?? true);
			return updated;
		} catch (error) {
			const failed = this.manager.updateRun(run.id, {
				status: 'failed',
				error: error instanceof Error ? error.message : String(error),
			});
			this.recordRunEvent(failed, 'target_launch_failed', failed.error, {
				targetType: task.targetType,
			});
			this.recordRunOutcome(task, failed);
			if (!this.isCircuitBreakerPaused(task.id)) {
				this.enqueueRetryIfAllowed(task, failed);
			}
			this.finishDispatchSchedule(task, options?.consumeSchedule ?? true);
			return failed;
		}
	}

	sweepTimedOutRuns(limit = 100): number {
		const runningRuns = this.manager.listRuns({ status: 'running', limit });
		let timedOut = 0;
		for (const run of runningRuns) {
			if (run.startedAt === null) continue;
			const task = this.manager.getTask(run.automationTaskId);
			if (!task || task.timeoutMs === null) continue;
			const ageMs = Date.now() - run.startedAt;
			if (ageMs < task.timeoutMs) continue;
			this.manager.updateRun(run.id, {
				status: 'timed_out',
				error: `Automation run timed out after ${task.timeoutMs}ms`,
			});
			const timedOutRun = {
				...run,
				status: 'timed_out' as const,
				error: `Automation run timed out after ${task.timeoutMs}ms`,
			};
			this.recordRunEvent(timedOutRun, 'timed_out', timedOutRun.error, {
				timeoutMs: task.timeoutMs,
			});
			this.recordRunOutcome(task, timedOutRun);
			if (!this.isCircuitBreakerPaused(task.id)) {
				this.enqueueRetryIfAllowed(task, timedOutRun);
			}
			timedOut++;
		}
		return timedOut;
	}

	recoverOrphanedRuns(maxAgeMs = 5 * 60_000, limit = 100): number {
		const runningRuns = this.manager.listRuns({ status: 'running', limit });
		let recovered = 0;
		for (const run of runningRuns) {
			const startedAt = run.startedAt ?? run.createdAt;
			if (Date.now() - startedAt < maxAgeMs) continue;
			if (
				run.roomTaskId ||
				run.spaceTaskId ||
				run.spaceWorkflowRunId ||
				run.missionExecutionId ||
				run.sessionId
			) {
				continue;
			}
			const updated = this.manager.updateRun(run.id, {
				status: 'lost',
				error: 'Automation run lost before a target was linked',
			});
			this.recordRunEvent(
				updated,
				'run_recovered',
				'Marked lost because no target was linked after startup recovery'
			);
			const task = this.manager.getTask(run.automationTaskId);
			if (task) {
				this.recordRunOutcome(task, updated);
				if (!this.isCircuitBreakerPaused(task.id)) {
					this.enqueueRetryIfAllowed(task, updated);
				}
			}
			recovered++;
		}
		return recovered;
	}

	async syncLinkedRuns(limit = 100): Promise<number> {
		const runs = this.manager.listLinkedActiveRuns(limit);
		let updatedCount = 0;
		for (const run of runs) {
			const task = this.manager.getTask(run.automationTaskId);
			if (!task) continue;
			const outcome = await this.readLinkedRunOutcome(task, run);
			if (!outcome) continue;
			const updatedRun = this.manager.updateRun(run.id, {
				status: outcome.status,
				resultSummary: outcome.resultSummary ?? null,
				error: outcome.error ?? null,
			});
			updatedCount++;
			this.recordRunEvent(updatedRun, 'linked_run_synced', outcome.error ?? outcome.resultSummary, {
				status: outcome.status,
			});
			this.recordRunOutcome(task, updatedRun);
			if (outcome.status === 'failed') {
				if (!this.isCircuitBreakerPaused(task.id)) {
					this.enqueueRetryIfAllowed(task, { ...run, status: outcome.status });
				}
			}
			if (task.concurrencyPolicy === 'queue') {
				this.enqueueQueuedDrain(task.id);
			}
		}
		return updatedCount;
	}

	private async evaluateCondition(task: AutomationTask): Promise<AutomationConditionEvaluation> {
		const condition = await this.conditionEvaluator.evaluate(task);
		this.manager.updateTask(task.id, {
			lastCheckedAt: Date.now(),
			lastConditionResult: {
				passed: condition.passed,
				reason: condition.reason,
				metadata: condition.metadata ?? null,
			},
			conditionFailureCount: condition.passed ? 0 : task.conditionFailureCount + 1,
		});
		return condition;
	}

	private advanceSchedule(task: AutomationTask): void {
		const nextRunAt = this.computeNextRunAt(task);
		this.manager.updateTask(task.id, {
			lastRunAt: Date.now(),
			nextRunAt,
			...(task.triggerType === 'at' && nextRunAt === null ? { status: 'paused' as const } : {}),
		});
		if (nextRunAt !== null) {
			this.enqueueDispatch(task.id, nextRunAt);
		}
	}

	private finishDispatchSchedule(task: AutomationTask, consumeSchedule: boolean): void {
		const latest = this.manager.getTask(task.id);
		if (latest?.status !== 'active') return;
		if (consumeSchedule) {
			this.advanceSchedule(latest);
			return;
		}
		this.manager.updateTask(latest.id, {
			lastRunAt: Date.now(),
		});
	}

	private enqueueRetryIfAllowed(task: AutomationTask, run: AutomationRun): void {
		if (run.attempt > task.maxRetries) return;
		const delayMs = Math.pow(2, Math.max(0, run.attempt - 1)) * 1000;
		this.jobQueue.enqueue({
			queue: AUTOMATION_DISPATCH,
			payload: {
				automationId: task.id,
				triggerReason: 'retry',
				attempt: run.attempt + 1,
				dispatchKey: `${run.dispatchKey ?? run.id}:retry:${run.attempt + 1}`,
			},
			runAt: Date.now() + delayMs,
			maxRetries: 0,
		});
		this.manager.createRunEvent({
			automationRunId: run.id,
			automationTaskId: task.id,
			eventType: 'retry_scheduled',
			message: `Retry ${run.attempt + 1} scheduled`,
			metadata: {
				attempt: run.attempt + 1,
				delayMs,
			},
		});
	}

	private recordRunEvent(
		run: AutomationRun,
		eventType: Parameters<AutomationManager['createRunEvent']>[0]['eventType'],
		message?: string | null,
		metadata?: Record<string, unknown> | null
	): void {
		this.manager.createRunEvent({
			automationRunId: run.id,
			automationTaskId: run.automationTaskId,
			eventType,
			message: message ?? null,
			metadata: metadata ?? null,
		});
	}

	private recordRunOutcome(task: AutomationTask, run: AutomationRun): void {
		if (run.status === 'succeeded' || run.status === 'cancelled') {
			this.manager.updateTask(task.id, {
				consecutiveFailureCount: 0,
				lastFailureFingerprint: null,
				pausedReason: null,
			});
			return;
		}
		if (run.status !== 'failed' && run.status !== 'timed_out' && run.status !== 'lost') {
			return;
		}

		const latest = this.manager.getTask(task.id) ?? task;
		const fingerprint = this.buildFailureFingerprint(latest, run);
		const consecutiveFailureCount =
			latest.lastFailureFingerprint === fingerprint ? latest.consecutiveFailureCount + 1 : 1;
		if (consecutiveFailureCount >= FAILURE_CIRCUIT_BREAKER_THRESHOLD) {
			this.manager.updateTask(task.id, {
				status: 'paused',
				nextRunAt: null,
				consecutiveFailureCount,
				lastFailureFingerprint: fingerprint,
				pausedReason: `Paused after ${consecutiveFailureCount} consecutive automation failures with the same fingerprint.`,
			});
			this.manager.createRunEvent({
				automationRunId: run.id,
				automationTaskId: task.id,
				eventType: 'circuit_breaker_paused',
				message: `Paused after ${consecutiveFailureCount} consecutive automation failures`,
				metadata: {
					consecutiveFailureCount,
					fingerprint,
				},
			});
			this.cancelPendingDispatchJobs(task.id);
			return;
		}

		this.manager.updateTask(task.id, {
			consecutiveFailureCount,
			lastFailureFingerprint: fingerprint,
			pausedReason: null,
		});
	}

	private buildFailureFingerprint(task: AutomationTask, run: AutomationRun): string {
		const error = run.error ?? run.resultSummary ?? run.status;
		return [task.targetType, task.ownerType, task.ownerId ?? 'global', error].join(':');
	}

	private isCircuitBreakerPaused(automationId: string): boolean {
		const task = this.manager.getTask(automationId);
		return task?.status === 'paused' && task.pausedReason !== null;
	}

	private async readLinkedRunOutcome(
		task: AutomationTask,
		run: AutomationRun
	): Promise<{
		status: AutomationRunStatus;
		resultSummary?: string | null;
		error?: string | null;
	} | null> {
		if (run.roomTaskId && task.ownerType === 'room' && task.ownerId) {
			const state = await this.targetStateReader.getRoomTaskStatus?.(task.ownerId, run.roomTaskId);
			if (!state) return null;
			return this.mapRoomTaskStatus(state.status, state.result);
		}
		if (run.spaceTaskId && task.ownerType === 'space' && task.ownerId) {
			const state = await this.targetStateReader.getSpaceTaskStatus?.(
				task.ownerId,
				run.spaceTaskId
			);
			if (!state) return null;
			return this.mapSpaceTaskStatus(state.status, state.result);
		}
		if (run.missionExecutionId && task.ownerType === 'room' && task.ownerId) {
			const state = await this.targetStateReader.getMissionExecutionStatus?.(
				task.ownerId,
				run.missionExecutionId
			);
			if (!state) return null;
			return this.mapMissionExecutionStatus(state.status, state.resultSummary);
		}
		return null;
	}

	private mapRoomTaskStatus(
		status: string,
		result?: string | null
	): { status: AutomationRunStatus; resultSummary?: string | null; error?: string | null } | null {
		switch (status) {
			case 'completed':
				return { status: 'succeeded', resultSummary: result };
			case 'needs_attention':
			case 'cancelled':
			case 'rate_limited':
			case 'usage_limited':
				return { status: 'failed', error: `Room task ended with status ${status}` };
			case 'archived':
				return { status: 'cancelled', error: 'Room task was archived' };
			default:
				return null;
		}
	}

	private mapSpaceTaskStatus(
		status: string,
		result?: string | null
	): { status: AutomationRunStatus; resultSummary?: string | null; error?: string | null } | null {
		switch (status) {
			case 'done':
				return { status: 'succeeded', resultSummary: result };
			case 'blocked':
			case 'cancelled':
				return { status: 'failed', error: `Space task ended with status ${status}` };
			case 'archived':
				return { status: 'cancelled', error: 'Space task was archived' };
			default:
				return null;
		}
	}

	private mapMissionExecutionStatus(
		status: string,
		resultSummary?: string | null
	): { status: AutomationRunStatus; resultSummary?: string | null; error?: string | null } | null {
		switch (status) {
			case 'completed':
				return { status: 'succeeded', resultSummary };
			case 'failed':
				return { status: 'failed', error: resultSummary ?? 'Mission execution failed' };
			case 'cancelled':
				return { status: 'cancelled', error: resultSummary ?? 'Mission execution cancelled' };
			default:
				return null;
		}
	}

	private enqueueQueuedDrain(automationId: string): void {
		this.jobQueue.enqueue({
			queue: AUTOMATION_DISPATCH,
			payload: {
				automationId,
				triggerReason: 'queued',
			},
			runAt: Date.now() + 5_000,
			maxRetries: 0,
		});
	}

	private matchesEventFilters(
		filters: Record<string, unknown> | undefined,
		payload: Record<string, unknown>
	): boolean {
		if (!filters) return true;
		for (const [key, expected] of Object.entries(filters)) {
			if (payload[key] !== expected) return false;
		}
		return true;
	}

	private computeNextRunAt(task: AutomationTask): number | null {
		switch (task.triggerType) {
			case 'cron': {
				const config = task.triggerConfig as { expression: string; timezone: string };
				return getNextRunAt(config.expression, config.timezone);
			}
			case 'interval': {
				const config = task.triggerConfig as { intervalMs: number };
				return Date.now() + config.intervalMs;
			}
			case 'heartbeat': {
				const config = task.triggerConfig as { intervalMs?: number };
				return Date.now() + (config.intervalMs ?? 60_000);
			}
			case 'at':
			case 'manual':
			case 'event':
				return null;
		}
	}

	private computeInitialRunAt(task: AutomationTask): number | null {
		switch (task.triggerType) {
			case 'cron':
			case 'interval':
			case 'heartbeat':
				return this.computeNextRunAt(task);
			case 'at': {
				const config = task.triggerConfig as { runAt: number };
				return config.runAt;
			}
			case 'manual':
			case 'event':
				return null;
		}
	}

	private enqueueDispatch(automationId: string, runAt: number): void {
		const pending = this.jobQueue.listJobs({
			queue: AUTOMATION_DISPATCH,
			status: ['pending'],
			limit: 10_000,
		});
		const existing = pending.find(
			(job) => (job.payload as { automationId?: string }).automationId === automationId
		);
		if (existing && existing.runAt <= runAt) return;

		this.jobQueue.enqueue({
			queue: AUTOMATION_DISPATCH,
			payload: {
				automationId,
				triggerReason: 'scheduled',
				dispatchKey: `${automationId}:scheduled:${runAt}`,
			},
			runAt,
			maxRetries: 0,
		});

		if (existing) {
			this.jobQueue.deleteJob(existing.id);
		}
	}

	private cancelPendingDispatchJobs(automationId: string): void {
		const pending = this.jobQueue.listJobs({
			queue: AUTOMATION_DISPATCH,
			status: ['pending'],
			limit: 10_000,
		});
		for (const job of pending) {
			if ((job.payload as { automationId?: string }).automationId === automationId) {
				this.jobQueue.deleteJob(job.id);
			}
		}
	}

	private buildDispatchKey(
		task: AutomationTask,
		options?: {
			triggerType?: AutomationTriggerType;
			triggerReason?: string;
			jobId?: string;
			attempt?: number;
			dispatchKey?: string;
			ignoreDueTime?: boolean;
			consumeSchedule?: boolean;
		}
	): string | null {
		if (options?.triggerType === 'manual') return null;
		if (task.triggerType === 'manual') return null;
		if (options?.jobId) return `job:${options.jobId}`;
		if (task.nextRunAt !== null)
			return `${task.id}:${options?.triggerReason ?? 'scheduled'}:${task.nextRunAt}`;
		return `${task.id}:${options?.triggerReason ?? task.triggerType}:${Date.now()}`;
	}
}

export function assertRoomTaskTargetConfig(
	targetType: AutomationTargetType,
	config: unknown
): RoomTaskAutomationTargetConfig {
	if (targetType !== 'room_task') throw new Error(`Expected room_task target, got ${targetType}`);
	return config as RoomTaskAutomationTargetConfig;
}

export function assertRoomMissionTargetConfig(
	targetType: AutomationTargetType,
	config: unknown
): RoomMissionAutomationTargetConfig {
	if (targetType !== 'room_mission') {
		throw new Error(`Expected room_mission target, got ${targetType}`);
	}
	return config as RoomMissionAutomationTargetConfig;
}

export function assertSpaceTaskTargetConfig(
	targetType: AutomationTargetType,
	config: unknown
): SpaceTaskAutomationTargetConfig {
	if (targetType !== 'space_task') throw new Error(`Expected space_task target, got ${targetType}`);
	return config as SpaceTaskAutomationTargetConfig;
}

export function assertSpaceWorkflowTargetConfig(
	targetType: AutomationTargetType,
	config: unknown
): SpaceWorkflowAutomationTargetConfig {
	if (targetType !== 'space_workflow') {
		throw new Error(`Expected space_workflow target, got ${targetType}`);
	}
	return config as SpaceWorkflowAutomationTargetConfig;
}

export function assertJobHandlerTargetConfig(
	targetType: AutomationTargetType,
	config: unknown
): JobHandlerAutomationTargetConfig {
	if (targetType !== 'job_handler') {
		throw new Error(`Expected job_handler target, got ${targetType}`);
	}
	return config as JobHandlerAutomationTargetConfig;
}

export function assertNeoAgentTargetConfig(
	targetType: AutomationTargetType,
	config: unknown
): NeoAgentAutomationTargetConfig {
	if (targetType !== 'neo_agent') {
		throw new Error(`Expected neo_agent target, got ${targetType}`);
	}
	return config as NeoAgentAutomationTargetConfig;
}
