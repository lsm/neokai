import type { NeoTask, TaskSummary } from '@neokai/shared/types/neo';

/**
 * Convert a full NeoTask to a lightweight TaskSummary for list/overview contexts.
 */
export function toTaskSummary(task: NeoTask): TaskSummary {
	return {
		id: task.id,
		shortId: task.shortId,
		title: task.title,
		status: task.status,
		priority: task.priority,
		progress: task.progress,
		currentStep: task.currentStep,
		dependsOn: task.dependsOn,
		error: task.error,
		activeSession: task.activeSession,
		prUrl: task.prUrl,
		prNumber: task.prNumber,
		updatedAt: task.updatedAt,
	};
}
