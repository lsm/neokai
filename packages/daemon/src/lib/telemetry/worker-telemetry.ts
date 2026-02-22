/**
 * Worker Telemetry - Metrics collection for manager-less architecture
 *
 * PHASE 3: Collect metrics to validate worker-only vs manager-worker performance
 *
 * Metrics tracked:
 * - Task completion rates
 * - Task execution time
 * - Error rates
 * - Worker lifecycle events
 * - Comparison between modes (when feature flag is toggled)
 */

import type { DaemonHub } from '../daemon-hub';

/**
 * Worker lifecycle event for tracking
 */
export interface WorkerLifecycleEvent {
	workerSessionId: string;
	roomId: string;
	taskId: string;
	mode: 'worker-only' | 'manager-worker';
	timestamp: number;
	event: 'started' | 'completed' | 'failed' | 'review_requested';
}

/**
 * Task completion metrics
 */
export interface TaskCompletionMetrics {
	taskId: string;
	roomId: string;
	mode: 'worker-only' | 'manager-worker';
	startTime: number;
	endTime: number;
	durationMs: number;
	success: boolean;
	error?: string;
	filesChanged?: string[];
	nextSteps?: string[];
}

/**
 * Aggregated metrics for a room
 */
export interface RoomMetrics {
	roomId: string;
	workerOnly: {
		totalTasks: number;
		completedTasks: number;
		failedTasks: number;
		avgDurationMs: number;
	};
	managerWorker: {
		totalTasks: number;
		completedTasks: number;
		failedTasks: number;
		avgDurationMs: number;
	};
}

/**
 * Telemetry collector for worker metrics
 */
export class WorkerTelemetry {
	private taskMetrics: Map<string, TaskCompletionMetrics> = new Map();
	private lifecycleEvents: WorkerLifecycleEvent[] = [];
	private maxEventsStored = 10000; // Prevent unbounded growth

	constructor(private daemonHub: DaemonHub) {
		this.subscribeToEvents();
	}

	/**
	 * Subscribe to worker and pair events for metric collection
	 */
	private subscribeToEvents(): void {
		// Worker-only mode events
		this.daemonHub.on(
			'worker.started',
			(event) => {
				this.recordLifecycleEvent({
					workerSessionId: event.sessionId,
					roomId: event.roomId,
					taskId: event.taskId,
					mode: 'worker-only',
					timestamp: Date.now(),
					event: 'started',
				});
			},
			{ sessionId: 'telemetry' }
		);

		this.daemonHub.on(
			'worker.task_completed',
			(event) => {
				this.recordTaskCompletion({
					taskId: event.taskId,
					roomId: '', // Will be filled from existing record
					mode: 'worker-only',
					startTime: 0, // Will be filled from existing record
					endTime: Date.now(),
					durationMs: 0, // Will be calculated
					success: true,
					filesChanged: event.filesChanged,
					nextSteps: event.nextSteps,
				});
				this.recordLifecycleEvent({
					workerSessionId: event.sessionId,
					roomId: '', // Will be filled from existing record
					taskId: event.taskId,
					mode: 'worker-only',
					timestamp: Date.now(),
					event: 'completed',
				});
			},
			{ sessionId: 'telemetry' }
		);

		this.daemonHub.on(
			'worker.failed',
			(event) => {
				this.recordTaskCompletion({
					taskId: event.taskId,
					roomId: '', // Will be filled from existing record
					mode: 'worker-only',
					startTime: 0,
					endTime: Date.now(),
					durationMs: 0,
					success: false,
					error: event.error,
				});
				this.recordLifecycleEvent({
					workerSessionId: event.sessionId,
					roomId: '',
					taskId: event.taskId,
					mode: 'worker-only',
					timestamp: Date.now(),
					event: 'failed',
				});
			},
			{ sessionId: 'telemetry' }
		);

		this.daemonHub.on(
			'worker.review_requested',
			(event) => {
				this.recordLifecycleEvent({
					workerSessionId: event.sessionId,
					roomId: '',
					taskId: event.taskId,
					mode: 'worker-only',
					timestamp: Date.now(),
					event: 'review_requested',
				});
			},
			{ sessionId: 'telemetry' }
		);

		// Manager-worker mode events (for comparison)
		this.daemonHub.on(
			'pair.task_completed',
			(event) => {
				// Note: We don't have workerSessionId in this event, but we can still track the task
				this.recordTaskCompletion({
					taskId: event.taskId,
					roomId: '',
					mode: 'manager-worker',
					startTime: 0,
					endTime: Date.now(),
					durationMs: 0,
					success: true,
					filesChanged: event.filesChanged,
					nextSteps: event.nextSteps,
				});
			},
			{ sessionId: 'telemetry' }
		);
	}

	/**
	 * Record a lifecycle event
	 */
	private recordLifecycleEvent(event: WorkerLifecycleEvent): void {
		this.lifecycleEvents.push(event);

		// Prune old events if we exceed the limit
		if (this.lifecycleEvents.length > this.maxEventsStored) {
			this.lifecycleEvents = this.lifecycleEvents.slice(-this.maxEventsStored);
		}
	}

	/**
	 * Record task completion metrics
	 */
	private recordTaskCompletion(metrics: TaskCompletionMetrics): void {
		const existing = this.taskMetrics.get(metrics.taskId);
		if (existing) {
			// Update existing record with calculated values
			const durationMs = metrics.endTime - existing.startTime;
			this.taskMetrics.set(metrics.taskId, {
				...metrics,
				roomId: existing.roomId,
				startTime: existing.startTime,
				durationMs,
			});
		} else {
			// Create new record (will be updated when we get the start event)
			this.taskMetrics.set(metrics.taskId, metrics);
		}
	}

	/**
	 * Get metrics for a specific room
	 */
	getRoomMetrics(roomId: string): RoomMetrics | null {
		const roomTasks = Array.from(this.taskMetrics.values()).filter((m) =>
			this.lifecycleEvents.some((e) => e.roomId === roomId && e.taskId === m.taskId)
		);

		if (roomTasks.length === 0) {
			return null;
		}

		const workerOnlyTasks = roomTasks.filter((m) => m.mode === 'worker-only');
		const managerWorkerTasks = roomTasks.filter((m) => m.mode === 'manager-worker');

		return {
			roomId,
			workerOnly: this.calculateModeMetrics(workerOnlyTasks),
			managerWorker: this.calculateModeMetrics(managerWorkerTasks),
		};
	}

	/**
	 * Calculate metrics for a specific mode
	 */
	private calculateModeMetrics(tasks: TaskCompletionMetrics[]) {
		const completed = tasks.filter((t) => t.success);
		const failed = tasks.filter((t) => !t.success);
		const totalDuration = tasks.reduce((sum, t) => sum + t.durationMs, 0);

		return {
			totalTasks: tasks.length,
			completedTasks: completed.length,
			failedTasks: failed.length,
			avgDurationMs: tasks.length > 0 ? totalDuration / tasks.length : 0,
		};
	}

	/**
	 * Get all lifecycle events for a room
	 */
	getRoomLifecycleEvents(roomId: string): WorkerLifecycleEvent[] {
		return this.lifecycleEvents.filter((e) => e.roomId === roomId);
	}

	/**
	 * Get recent events across all rooms
	 */
	getRecentEvents(limit = 100): WorkerLifecycleEvent[] {
		return this.lifecycleEvents.slice(-limit);
	}

	/**
	 * Clear old metrics (for maintenance)
	 */
	clearMetrics(olderThanMs: number = 7 * 24 * 60 * 60 * 1000): number {
		const cutoff = Date.now() - olderThanMs;
		const beforeCount = this.taskMetrics.size;

		// Remove old task metrics
		for (const [taskId, metrics] of this.taskMetrics.entries()) {
			if (metrics.endTime < cutoff) {
				this.taskMetrics.delete(taskId);
			}
		}

		// Remove old lifecycle events
		this.lifecycleEvents = this.lifecycleEvents.filter((e) => e.timestamp >= cutoff);

		return beforeCount - this.taskMetrics.size;
	}

	/**
	 * Get metrics summary for reporting
	 */
	getSummary(): {
		totalTasksTracked: number;
		workerOnlyTasks: number;
		managerWorkerTasks: number;
		totalEvents: number;
		roomsTracked: number;
	} {
		const tasks = Array.from(this.taskMetrics.values());
		const rooms = new Set(
			this.lifecycleEvents.map((e) => e.roomId).filter((r): r is string => r !== '')
		);

		return {
			totalTasksTracked: tasks.length,
			workerOnlyTasks: tasks.filter((t) => t.mode === 'worker-only').length,
			managerWorkerTasks: tasks.filter((t) => t.mode === 'manager-worker').length,
			totalEvents: this.lifecycleEvents.length,
			roomsTracked: rooms.size,
		};
	}
}
