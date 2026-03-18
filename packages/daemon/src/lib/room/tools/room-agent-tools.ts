/**
 * Room Agent Tools - MCP tools for Room chat session
 *
 * These tools allow the Room Agent to manage goals and tasks on behalf of
 * the human user. The Room Agent session already exists (room:chat:${roomId}),
 * these tools are attached to it.
 *
 * Tools: create_goal, list_goals, update_goal, create_task, list_tasks,
 *        update_task, cancel_task, stop_session, get_room_status, approve_task, reject_task,
 *        send_message_to_task, get_task_detail
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { TaskStatus, TaskType, AgentType } from '@neokai/shared';
import { VALID_STATUS_TRANSITIONS } from '../managers/task-manager';
import type { GoalManager } from '../managers/goal-manager';
import type { TaskManager } from '../managers/task-manager';
import type { SessionGroupRepository } from '../state/session-group-repository';
import type { DaemonHub } from '../../daemon-hub';
import type { RoomRuntime } from '../runtime/room-runtime';
import { routeHumanMessageToGroup } from '../runtime/human-message-routing';
import { isValidCronExpression, getNextRunAt, getSystemTimezone } from '../runtime/cron-utils';

export interface RoomAgentToolsConfig {
	roomId: string;
	goalManager: GoalManager;
	taskManager: TaskManager;
	groupRepo: SessionGroupRepository;
	daemonHub?: DaemonHub;
	runtimeService?: {
		getRuntime(roomId: string): RoomRuntime | null;
	};
}

interface ToolResult {
	content: Array<{ type: 'text'; text: string }>;
}

function jsonResult(data: Record<string, unknown>): ToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

/**
 * Create tool handler functions that can be tested directly.
 * Returns a map of tool name -> handler function.
 */
export function createRoomAgentToolHandlers(config: RoomAgentToolsConfig) {
	const { goalManager, taskManager, groupRepo, roomId, daemonHub, runtimeService } = config;

	return {
		async create_goal(args: {
			title: string;
			description?: string;
			priority?: 'low' | 'normal' | 'high' | 'urgent';
		}): Promise<ToolResult> {
			const goal = await goalManager.createGoal({
				title: args.title,
				description: args.description,
				priority: args.priority,
			});
			// Notify runtime so it schedules a tick immediately (instead of waiting for the timer)
			if (daemonHub) {
				void daemonHub.emit('goal.created', {
					sessionId: `room:${roomId}`,
					roomId,
					goalId: goal.id,
					goal,
				});
			}
			return jsonResult({ success: true, goalId: goal.id, goal });
		},

		async list_goals(): Promise<ToolResult> {
			const goals = await goalManager.listGoals();
			return jsonResult({ success: true, goals });
		},

		async update_goal(args: {
			goal_id: string;
			status?: 'active' | 'needs_human' | 'completed' | 'archived';
			priority?: 'low' | 'normal' | 'high' | 'urgent';
		}): Promise<ToolResult> {
			const goal = await goalManager.getGoal(args.goal_id);
			if (!goal) {
				return jsonResult({ success: false, error: `Goal not found: ${args.goal_id}` });
			}
			let updated = goal;
			if (args.status) {
				updated = await goalManager.updateGoalStatus(args.goal_id, args.status);
			}
			if (args.priority) {
				updated = await goalManager.updateGoalPriority(args.goal_id, args.priority);
			}
			return jsonResult({ success: true, goal: updated });
		},

		async create_task(args: {
			title: string;
			description: string;
			goal_id?: string;
			priority?: 'low' | 'normal' | 'high' | 'urgent';
			depends_on?: string[];
			task_type?: TaskType;
			assigned_agent?: AgentType;
		}): Promise<ToolResult> {
			// 'planning' is reserved for internal use by the runtime's planning phase.
			// User-created tasks must use 'coding', 'research', 'design', or 'goal_review'.
			if (args.task_type === 'planning') {
				return jsonResult({
					success: false,
					error:
						"Task type 'planning' is reserved for internal use. Use 'coding', 'research', 'design', or 'goal_review' instead.",
				});
			}
			let task;
			try {
				task = await taskManager.createTask({
					title: args.title,
					description: args.description,
					priority: args.priority,
					dependsOn: args.depends_on,
					taskType: args.task_type,
					assignedAgent: args.assigned_agent,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return jsonResult({ success: false, error: message });
			}
			if (args.goal_id) {
				// For recurring missions with an active execution, use the atomic dual-write path.
				// For all other goals, use the standard linkTaskToGoal path.
				const linkedGoal = await goalManager.getGoal(args.goal_id);
				if (linkedGoal?.missionType === 'recurring') {
					const activeExecution = goalManager.getActiveExecution(args.goal_id);
					if (activeExecution) {
						await goalManager.linkTaskToExecution(args.goal_id, activeExecution.id, task.id);
					} else {
						await goalManager.linkTaskToGoal(args.goal_id, task.id);
					}
				} else {
					await goalManager.linkTaskToGoal(args.goal_id, task.id);
				}
			}
			// Notify runtime so it schedules a tick immediately
			if (daemonHub) {
				void daemonHub.emit('room.task.update', {
					sessionId: `room:${roomId}`,
					roomId,
					task,
				});
			}
			return jsonResult({ success: true, taskId: task.id, task });
		},

		async list_tasks(args: { goal_id?: string; status?: TaskStatus }): Promise<ToolResult> {
			let tasks = await taskManager.listTasks(args.status ? { status: args.status } : undefined);
			if (args.goal_id) {
				const goal = await goalManager.getGoal(args.goal_id);
				if (goal) {
					const linkedIds = new Set(goal.linkedTaskIds);
					tasks = tasks.filter((t) => linkedIds.has(t.id));
				}
			}
			return jsonResult({ success: true, tasks });
		},

		async update_task(args: {
			task_id: string;
			title?: string;
			description?: string;
			priority?: 'low' | 'normal' | 'high' | 'urgent';
			depends_on?: string[];
		}): Promise<ToolResult> {
			const task = await taskManager.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			const updates: {
				title?: string;
				description?: string;
				priority?: 'low' | 'normal' | 'high' | 'urgent';
				dependsOn?: string[];
			} = {};
			if (args.title !== undefined) updates.title = args.title;
			if (args.description !== undefined) updates.description = args.description;
			if (args.priority !== undefined) updates.priority = args.priority;
			if (args.depends_on !== undefined) updates.dependsOn = args.depends_on;
			// Apply updates if any fields were provided; otherwise return existing task unchanged
			let updated;
			try {
				updated =
					Object.keys(updates).length > 0
						? await taskManager.updateTaskFields(args.task_id, updates)
						: task;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return jsonResult({ success: false, error: message });
			}
			// Notify UI of the update
			if (daemonHub) {
				void daemonHub.emit('room.task.update', {
					sessionId: `room:${roomId}`,
					roomId,
					task: updated,
				});
			}
			return jsonResult({ success: true, task: updated });
		},

		async cancel_task(args: { task_id: string }): Promise<ToolResult> {
			const task = await taskManager.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}

			let cancelledTaskIds: string[] = [];
			let usedRuntimeCancellation = false;
			if (runtimeService) {
				const runtime = runtimeService.getRuntime(roomId);
				if (runtime) {
					const result = await runtime.cancelTask(args.task_id);
					if (!result.success) {
						return jsonResult({
							success: false,
							error: `Failed to cancel task: ${args.task_id}`,
						});
					}
					cancelledTaskIds = result.cancelledTaskIds;
					usedRuntimeCancellation = true;
				}
			}

			// Fallback when runtime service is unavailable: status-only cancellation.
			if (!usedRuntimeCancellation) {
				const cancelledTasks = await taskManager.cancelTaskCascade(args.task_id);
				cancelledTaskIds = cancelledTasks.map((cancelledTask) => cancelledTask.id);

				// Notify UI of status change for every affected task in fallback mode.
				if (daemonHub) {
					for (const cancelledTaskId of cancelledTaskIds) {
						const cancelledTask = await taskManager.getTask(cancelledTaskId);
						if (!cancelledTask) continue;
						void daemonHub.emit('room.task.update', {
							sessionId: `room:${roomId}`,
							roomId,
							task: cancelledTask,
						});
					}
				}
			}
			return jsonResult({ success: true, message: `Task ${args.task_id} cancelled` });
		},

		async stop_session(args: { task_id: string }): Promise<ToolResult> {
			const task = await taskManager.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}

			if (task.status !== 'in_progress' && task.status !== 'review') {
				return jsonResult({
					success: false,
					error: `Task cannot be interrupted (current status: ${task.status}). Only in_progress or review tasks can be interrupted.`,
				});
			}

			if (runtimeService) {
				const runtime = runtimeService.getRuntime(roomId);
				if (runtime) {
					const result = await runtime.interruptTaskSession(args.task_id);
					if (!result.success) {
						return jsonResult({
							success: false,
							error: `Failed to interrupt session for task ${args.task_id}`,
						});
					}
					return jsonResult({
						success: true,
						message: `Generation interrupted for task ${args.task_id}. Task remains active and awaiting input.`,
					});
				}
			}

			return jsonResult({ success: false, error: 'Runtime service unavailable' });
		},

		async set_task_status(args: {
			task_id: string;
			status: TaskStatus;
			result?: string;
			error?: string;
		}): Promise<ToolResult> {
			const task = await taskManager.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}

			// Validate status transition
			const allowedTransitions = VALID_STATUS_TRANSITIONS[task.status];
			if (!allowedTransitions.includes(args.status)) {
				return jsonResult({
					success: false,
					error: `Invalid status transition from '${task.status}' to '${args.status}'. Allowed: ${allowedTransitions.join(', ') || 'none'}`,
				});
			}

			// Check for active group when transitioning from in_progress or review
			if (task.status === 'in_progress' || task.status === 'review') {
				if (runtimeService) {
					const runtime = runtimeService.getRuntime(roomId);
					if (runtime) {
						const group = groupRepo.getGroupByTaskId(args.task_id);
						if (group && group.completedAt === null) {
							// There's an active group - cancel it first if moving to terminal state
							if (
								args.status === 'completed' ||
								args.status === 'needs_attention' ||
								args.status === 'cancelled'
							) {
								const cancelledGroup = await runtime.taskGroupManager.cancel(group.id);
								if (!cancelledGroup) {
									return jsonResult({
										success: false,
										error: `Failed to cancel active group for task ${args.task_id} — group may have been modified concurrently`,
									});
								}
							}
						}
					}
				}
			}

			// Handle restart/revive: update group state for needs_attention/cancelled tasks
			if (task.status === 'needs_attention' || task.status === 'cancelled') {
				const group = groupRepo.getGroupByTaskId(args.task_id);
				if (group) {
					if (args.status === 'pending' || args.status === 'in_progress') {
						// Full reset: wipe metadata so the runtime picks the task up fresh
						const reset = groupRepo.resetGroupForRestart(group.id);
						if (!reset) {
							return jsonResult({
								success: false,
								error: `Failed to reset group for task ${args.task_id} — group may have been modified concurrently`,
							});
						}
					} else if (
						args.status === 'review' &&
						task.status === 'needs_attention' &&
						group.completedAt !== null
					) {
						// Lightweight revive (failed → review only): clear completedAt without
						// resetting metadata. Only supported for failed tasks — cancelled tasks
						// have their worktree cleaned up so reviving the group would point
						// sessions at a gone workspace.
						const revived = groupRepo.reviveGroup(group.id);
						if (!revived) {
							return jsonResult({
								success: false,
								error: `Failed to revive group for task ${args.task_id} — group may have been modified concurrently`,
							});
						}
					}
				}
			}

			// Apply status change
			let updatedTask: typeof task;
			try {
				updatedTask = await taskManager.setTaskStatus(args.task_id, args.status, {
					result: args.result,
					error: args.error,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return jsonResult({ success: false, error: message });
			}

			const group = groupRepo.getGroupByTaskId(args.task_id);
			if (group && group.completedAt === null) {
				if (args.status === 'review') {
					groupRepo.setSubmittedForReview(group.id, true);
				} else if (task.status === 'review') {
					groupRepo.setSubmittedForReview(group.id, false);
				}
			}

			// Notify UI of the status change
			if (daemonHub) {
				void daemonHub.emit('room.task.update', {
					sessionId: `room:${roomId}`,
					roomId,
					task: updatedTask,
				});
			}

			return jsonResult({
				success: true,
				message: `Task ${args.task_id} status changed from '${task.status}' to '${args.status}'`,
				task: updatedTask,
			});
		},

		async approve_task(args: { task_id: string }): Promise<ToolResult> {
			const task = await taskManager.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			if (!runtimeService) {
				return jsonResult({ success: false, error: 'Runtime service not available' });
			}
			const runtime = runtimeService.getRuntime(roomId);
			if (!runtime) {
				return jsonResult({ success: false, error: 'Room runtime not found' });
			}
			const approved = await runtime.resumeWorkerFromHuman(
				args.task_id,
				'Task approved. Please proceed.',
				{ approved: true }
			);
			if (!approved) {
				return jsonResult({
					success: false,
					error: 'Failed to approve task — task may not be awaiting review',
				});
			}
			return jsonResult({ success: true, message: `Task ${args.task_id} approved` });
		},

		async reject_task(args: { task_id: string; feedback: string }): Promise<ToolResult> {
			const task = await taskManager.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			if (!runtimeService) {
				return jsonResult({ success: false, error: 'Runtime service not available' });
			}
			const runtime = runtimeService.getRuntime(roomId);
			if (!runtime) {
				return jsonResult({ success: false, error: 'Room runtime not found' });
			}
			const resumed = await runtime.resumeWorkerFromHuman(args.task_id, args.feedback, {
				approved: false,
			});
			if (!resumed) {
				return jsonResult({
					success: false,
					error: 'Failed to reject task — task may not be awaiting review',
				});
			}
			return jsonResult({ success: true, message: `Task ${args.task_id} rejected with feedback` });
		},

		async send_message_to_task(args: { task_id: string; message: string }): Promise<ToolResult> {
			const task = await taskManager.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			if (!runtimeService) {
				return jsonResult({ success: false, error: 'Runtime service not available' });
			}
			const runtime = runtimeService.getRuntime(roomId);
			if (!runtime) {
				return jsonResult({ success: false, error: 'Room runtime not found' });
			}

			// Cancelled tasks cannot be revived via message — the worktree is cleaned
			// up on cancellation so restoring the session would point to a gone
			// workspace. Direct the caller to restart the task from scratch instead.
			if (task.status === 'cancelled') {
				return jsonResult({
					success: false,
					error:
						`Task ${args.task_id} is cancelled. Cancelled tasks cannot receive messages ` +
						'because their workspace has been cleaned up. Use set_task_status to restart it ' +
						'(e.g. status: "pending" or "in_progress").',
				});
			}

			// Auto-revive: if the task needs attention, transition it to 'review' and
			// restore the agent sessions so the message can be delivered. Needs_attention
			// tasks preserve their worktree, so session restoration is safe.
			if (task.status === 'needs_attention') {
				try {
					await taskManager.setTaskStatus(args.task_id, 'review');
				} catch (err) {
					return jsonResult({
						success: false,
						error: `Failed to revive task ${args.task_id}: ${String(err)}`,
					});
				}

				const revived = await runtime.reviveTaskForMessage(args.task_id, args.message);
				if (!revived) {
					// Roll back the task status; review → needs_attention is a valid transition.
					try {
						await taskManager.setTaskStatus(args.task_id, 'needs_attention');
					} catch {
						// Rollback is best-effort; swallow to avoid masking the original error
					}
					return jsonResult({
						success: false,
						error:
							`Failed to revive task ${args.task_id}: agent sessions could not be restored. ` +
							'Task status has been reset to needs_attention.',
					});
				}
				return jsonResult({
					success: true,
					message: `Task ${args.task_id} revived from needs_attention to review and message delivered to agent`,
				});
			}

			const { success, error } = await routeHumanMessageToGroup(
				runtime,
				groupRepo,
				taskManager,
				args.task_id,
				args.message
			);
			// Emit task update after successful message routing (may have changed status)
			if (success) {
				const updatedTask = await taskManager.getTask(args.task_id);
				if (updatedTask && daemonHub) {
					void daemonHub.emit('room.task.update', {
						sessionId: `room:${roomId}`,
						roomId,
						task: updatedTask,
					});
				}
			}
			return jsonResult(error !== undefined ? { success, error } : { success });
		},

		async get_task_detail(args: { task_id: string }): Promise<ToolResult> {
			const task = await taskManager.getTask(args.task_id);
			if (!task) {
				return jsonResult({ success: false, error: `Task not found: ${args.task_id}` });
			}
			const group = groupRepo.getGroupByTaskId(args.task_id);
			return jsonResult({
				success: true,
				task,
				group: group
					? {
							id: group.id,
							completedAt: group.completedAt,
							workerSessionId: group.workerSessionId,
							leaderSessionId: group.leaderSessionId,
							feedbackIteration: group.feedbackIteration,
							awaitingHumanReview: group.submittedForReview,
						}
					: null,
			});
		},

		async set_schedule(args: {
			goal_id: string;
			cron_expression: string;
			timezone?: string;
		}): Promise<ToolResult> {
			const goal = await goalManager.getGoal(args.goal_id);
			if (!goal) {
				return jsonResult({ success: false, error: `Goal not found: ${args.goal_id}` });
			}
			if (goal.missionType !== 'recurring') {
				return jsonResult({
					success: false,
					error: `Goal ${args.goal_id} is not a recurring mission (missionType=${goal.missionType ?? 'one_shot'}). Only recurring missions can have a schedule.`,
				});
			}
			if (!isValidCronExpression(args.cron_expression)) {
				return jsonResult({
					success: false,
					error: `Invalid cron expression: "${args.cron_expression}". Use 5-field cron (e.g. "0 9 * * *") or presets (@daily, @weekly, @hourly, @monthly).`,
				});
			}
			const tz = args.timezone ?? goal.schedule?.timezone ?? getSystemTimezone();
			const nextRunAt = getNextRunAt(args.cron_expression, tz);
			if (nextRunAt === null) {
				return jsonResult({
					success: false,
					error: `Cron expression "${args.cron_expression}" produces no future run times.`,
				});
			}
			const updated = await goalManager.updateGoalStatus(args.goal_id, goal.status, {
				schedule: { expression: args.cron_expression, timezone: tz },
				nextRunAt,
				missionType: 'recurring',
			});
			return jsonResult({
				success: true,
				goal: updated,
				nextRunAt,
				nextRunAtISO: new Date(nextRunAt * 1000).toISOString(),
			});
		},

		async pause_schedule(args: { goal_id: string }): Promise<ToolResult> {
			const goal = await goalManager.getGoal(args.goal_id);
			if (!goal) {
				return jsonResult({ success: false, error: `Goal not found: ${args.goal_id}` });
			}
			if (goal.missionType !== 'recurring') {
				return jsonResult({
					success: false,
					error: `Goal ${args.goal_id} is not a recurring mission.`,
				});
			}
			const updated = await goalManager.updateGoalStatus(args.goal_id, goal.status, {
				schedulePaused: true,
			});
			return jsonResult({ success: true, goal: updated, message: 'Schedule paused.' });
		},

		async resume_schedule(args: { goal_id: string }): Promise<ToolResult> {
			const goal = await goalManager.getGoal(args.goal_id);
			if (!goal) {
				return jsonResult({ success: false, error: `Goal not found: ${args.goal_id}` });
			}
			if (goal.missionType !== 'recurring') {
				return jsonResult({
					success: false,
					error: `Goal ${args.goal_id} is not a recurring mission.`,
				});
			}
			if (!goal.schedule) {
				return jsonResult({
					success: false,
					error: `Goal ${args.goal_id} has no schedule set. Use set_schedule first.`,
				});
			}
			// Recalculate next_run_at from current time on resume
			const tz = goal.schedule.timezone ?? getSystemTimezone();
			const nextRunAt = getNextRunAt(goal.schedule.expression, tz);
			const updated = await goalManager.updateGoalStatus(args.goal_id, goal.status, {
				schedulePaused: false,
				nextRunAt: nextRunAt ?? undefined,
			});
			return jsonResult({
				success: true,
				goal: updated,
				message: 'Schedule resumed.',
				nextRunAt,
				nextRunAtISO: nextRunAt !== null ? new Date(nextRunAt * 1000).toISOString() : null,
			});
		},

		async get_room_status(): Promise<ToolResult> {
			const goals = await goalManager.listGoals();
			const tasks = await taskManager.listTasks();
			const activeGroups = groupRepo.getActiveGroups(roomId);

			// Collect task IDs that need human review:
			// either the task is in 'review' status OR the group has submittedForReview flag
			const needsReviewIds = new Set<string>();
			tasks.filter((t) => t.status === 'review').forEach((t) => needsReviewIds.add(t.id));
			activeGroups.filter((g) => g.submittedForReview).forEach((g) => needsReviewIds.add(g.taskId));

			const tasksNeedingReview = [...needsReviewIds].map((taskId) => {
				const task = tasks.find((t) => t.id === taskId);
				return { taskId, title: task?.title ?? '' };
			});

			return jsonResult({
				success: true,
				status: {
					goals: {
						total: goals.length,
						active: goals.filter((g) => g.status === 'active').length,
						completed: goals.filter((g) => g.status === 'completed').length,
						needsHuman: goals.filter((g) => g.status === 'needs_human').length,
					},
					tasks: {
						total: tasks.length,
						pending: tasks.filter((t) => t.status === 'pending').length,
						inProgress: tasks.filter((t) => t.status === 'in_progress').length,
						review: tasks.filter((t) => t.status === 'review').length,
						completed: tasks.filter((t) => t.status === 'completed').length,
						needsAttention: tasks.filter((t) => t.status === 'needs_attention').length,
						cancelled: tasks.filter((t) => t.status === 'cancelled').length,
					},
					activeGroups: activeGroups.length,
					groups: activeGroups.map((g) => ({
						id: g.id,
						taskId: g.taskId,
						submittedForReview: g.submittedForReview,
						iteration: g.feedbackIteration,
					})),
					tasksNeedingReview,
				},
			});
		},

		async record_metric(args: {
			goal_id: string;
			metric_name: string;
			value: number;
		}): Promise<ToolResult> {
			const goal = await goalManager.getGoal(args.goal_id);
			if (!goal) {
				return jsonResult({ success: false, error: `Goal not found: ${args.goal_id}` });
			}
			if (goal.missionType !== 'measurable') {
				return jsonResult({
					success: false,
					error: `Goal "${args.goal_id}" is not a measurable mission (missionType: ${goal.missionType ?? 'one_shot'}).`,
				});
			}
			try {
				const updated = await goalManager.recordMetric(args.goal_id, args.metric_name, args.value);
				if (daemonHub) {
					void daemonHub.emit('goal.progressUpdated', {
						sessionId: `room:${roomId}`,
						roomId,
						goalId: updated.id,
						progress: updated.progress,
					});
				}
				return jsonResult({
					success: true,
					metric: {
						name: args.metric_name,
						value: args.value,
						goalProgress: updated.progress,
					},
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		async get_metrics(args: { goal_id: string }): Promise<ToolResult> {
			const goal = await goalManager.getGoal(args.goal_id);
			if (!goal) {
				return jsonResult({ success: false, error: `Goal not found: ${args.goal_id}` });
			}
			// Legacy compat: goals with no structuredMetrics but with legacy metrics field
			if (!goal.structuredMetrics || goal.structuredMetrics.length === 0) {
				return jsonResult({
					success: true,
					missionType: goal.missionType ?? 'one_shot',
					structuredMetrics: [],
					legacyMetrics: goal.metrics ?? {},
					note: 'No structured metrics configured. For measurable missions, add structuredMetrics to the goal.',
				});
			}
			const checkResult = await goalManager.checkMetricTargets(args.goal_id);
			return jsonResult({
				success: true,
				missionType: goal.missionType ?? 'one_shot',
				allTargetsMet: checkResult.allMet,
				metrics: checkResult.results.map((r) => {
					const metric = goal.structuredMetrics!.find((m) => m.name === r.name);
					return {
						name: r.name,
						current: r.current,
						target: r.target,
						met: r.met,
						direction: metric?.direction ?? 'increase',
						...(metric?.baseline !== undefined ? { baseline: metric.baseline } : {}),
						...(metric?.unit ? { unit: metric.unit } : {}),
					};
				}),
			});
		},
	};
}

export function createRoomAgentMcpServer(config: RoomAgentToolsConfig) {
	const handlers = createRoomAgentToolHandlers(config);

	const tools = [
		tool(
			'create_goal',
			'Create a new goal for the room',
			{
				title: z.string().describe('Short title for the goal'),
				description: z.string().optional().describe('Detailed description'),
				priority: z
					.enum(['low', 'normal', 'high', 'urgent'])
					.optional()
					.default('normal')
					.describe('Goal priority'),
			},
			(args) => handlers.create_goal(args)
		),
		tool('list_goals', 'List all goals in this room', {}, () => handlers.list_goals()),
		tool(
			'update_goal',
			'Update an existing goal',
			{
				goal_id: z.string().describe('ID of the goal to update'),
				status: z
					.enum(['active', 'needs_human', 'completed', 'archived'])
					.optional()
					.describe('New status'),
				priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('New priority'),
			},
			(args) => handlers.update_goal(args)
		),
		tool(
			'create_task',
			'Create a new task and optionally link it to a goal',
			{
				title: z.string().describe('Short title for the task'),
				description: z.string().describe('Detailed task description and acceptance criteria'),
				goal_id: z.string().optional().describe('Goal ID to link this task to'),
				priority: z
					.enum(['low', 'normal', 'high', 'urgent'])
					.optional()
					.default('normal')
					.describe('Task priority'),
				depends_on: z
					.array(z.string())
					.optional()
					.describe('IDs of tasks this task depends on (must complete first)'),
				task_type: z
					.enum(['coding', 'research', 'design', 'goal_review'])
					.optional()
					.describe(
						"Task type - determines agent preset (default: coding). Note: 'planning' is reserved for internal use."
					),
				assigned_agent: z
					.enum(['coder', 'general'])
					.optional()
					.describe('Agent type to execute this task (default: coder)'),
			},
			(args) => handlers.create_task(args)
		),
		tool(
			'list_tasks',
			'List tasks in this room, optionally filtered by goal',
			{
				goal_id: z.string().optional().describe('Filter to tasks linked to this goal'),
				status: z
					.enum([
						'draft',
						'pending',
						'in_progress',
						'review',
						'completed',
						'needs_attention',
						'cancelled',
					])
					.optional()
					.describe('Filter by status'),
			},
			(args) => handlers.list_tasks(args)
		),
		tool(
			'update_task',
			'Update an existing task (title, description, priority, and/or dependencies). Only provided fields are changed; omitted fields keep their current values.',
			{
				task_id: z.string().describe('ID of the task to update'),
				title: z.string().trim().min(1).optional().describe('New title for the task'),
				description: z.string().trim().min(1).optional().describe('New description for the task'),
				priority: z.enum(['low', 'normal', 'high', 'urgent']).optional().describe('New priority'),
				depends_on: z
					.array(z.string())
					.optional()
					.describe('New list of task IDs this task depends on (replaces existing)'),
			},
			(args) => handlers.update_task(args)
		),
		tool(
			'cancel_task',
			'Cancel a task (marks as cancelled — distinct from needs_attention — and cleans up agent sessions)',
			{ task_id: z.string().describe('ID of the task to cancel') },
			(args) => handlers.cancel_task(args)
		),
		tool(
			'stop_session',
			'Interrupt the current agent session(s) for a task. Stops LLM generation mid-stream while keeping the task in its current state (in_progress or review). The user can immediately type new instructions without any revive flow.',
			{ task_id: z.string().describe('ID of the task whose session(s) to stop') },
			(args) => handlers.stop_session(args)
		),
		tool(
			'set_task_status',
			'Set task status to any valid status. Use this to complete, fail, restart, or change status of any task. Validates that the status transition is allowed.',
			{
				task_id: z.string().describe('ID of the task to update'),
				status: z
					.enum([
						'draft',
						'pending',
						'in_progress',
						'review',
						'completed',
						'needs_attention',
						'cancelled',
					])
					.describe('New status for the task'),
				result: z.string().optional().describe('Result description (for completed status)'),
				error: z.string().optional().describe('Error message (for needs_attention status)'),
			},
			(args) => handlers.set_task_status(args)
		),
		tool(
			'approve_task',
			'Approve a task that is awaiting human review, allowing the worker to proceed',
			{ task_id: z.string().describe('ID of the task to approve') },
			(args) => handlers.approve_task(args)
		),
		tool(
			'reject_task',
			'Reject a task that is awaiting human review, sending feedback to the worker',
			{
				task_id: z.string().describe('ID of the task to reject'),
				feedback: z.string().describe('Feedback explaining what needs to be fixed or improved'),
			},
			(args) => handlers.reject_task(args)
		),
		tool(
			'send_message_to_task',
			'Send a message to the active worker session for a task',
			{
				task_id: z.string().describe('ID of the task to send the message to'),
				message: z.string().describe('The message content to send'),
			},
			(args) => handlers.send_message_to_task(args)
		),
		tool(
			'get_task_detail',
			'Get full details for a task including group session IDs and whether it is awaiting human review',
			{ task_id: z.string().describe('ID of the task to get details for') },
			(args) => handlers.get_task_detail(args)
		),
		tool(
			'set_schedule',
			'Set or update the cron schedule for a recurring mission. Supports 5-field cron expressions (e.g. "0 9 * * *") and presets: @hourly, @daily, @weekly, @monthly.',
			{
				goal_id: z.string().describe('ID of the recurring mission goal'),
				cron_expression: z
					.string()
					.describe(
						'Cron expression (e.g. "0 9 * * *" = 9am daily) or preset (@hourly, @daily, @weekly, @monthly)'
					),
				timezone: z
					.string()
					.optional()
					.describe('IANA timezone string (e.g. "America/New_York"). Defaults to system timezone.'),
			},
			(args) => handlers.set_schedule(args)
		),
		tool(
			'pause_schedule',
			'Pause the schedule for a recurring mission. While paused, the mission will not trigger automatically.',
			{ goal_id: z.string().describe('ID of the recurring mission goal') },
			(args) => handlers.pause_schedule(args)
		),
		tool(
			'resume_schedule',
			'Resume a paused recurring mission schedule. Recalculates next_run_at from the current time.',
			{ goal_id: z.string().describe('ID of the recurring mission goal') },
			(args) => handlers.resume_schedule(args)
		),
		tool(
			'get_room_status',
			'Get an overview of the room state including goals, tasks, active groups, and tasks needing review',
			{},
			() => handlers.get_room_status()
		),
		tool(
			'record_metric',
			'Record a metric value for a measurable mission goal. Agents use this to report KPI progress.',
			{
				goal_id: z.string().describe('ID of the measurable mission goal'),
				metric_name: z.string().describe('Name of the metric to record (must match structuredMetrics)'),
				value: z.number().describe('The current value of the metric'),
			},
			(args) => handlers.record_metric(args)
		),
		tool(
			'get_metrics',
			'View current metric state and targets for a goal. Returns current values, targets, and whether targets are met.',
			{
				goal_id: z.string().describe('ID of the goal to get metrics for'),
			},
			(args) => handlers.get_metrics(args)
		),
	];

	return createSdkMcpServer({ name: 'room-agent', tools });
}

export type RoomAgentMcpServer = ReturnType<typeof createRoomAgentMcpServer>;

/**
 * Narrow config type for the leader context MCP server.
 * Excludes daemonHub and runtimeService since read-only tools do not need them.
 */
export type LeaderContextMcpConfig = Pick<
	RoomAgentToolsConfig,
	'roomId' | 'goalManager' | 'taskManager' | 'groupRepo'
>;

/**
 * Create a minimal read-only MCP server for the Leader agent.
 *
 * Registered as `'leader-context'` (distinct from `'room-agent'` used by the full server).
 * Exposes only 4 read-only tools: list_goals, list_tasks, get_task_detail, get_room_status.
 *
 * The leader only needs context tools — it should NOT have write or human-only tools.
 * Excluded tools and reasons:
 *   - approve_task / reject_task: human-only decisions
 *   - create_goal / update_goal: not the leader's role
 *   - create_task / update_task: leader delegates to worker via send_to_worker
 *   - cancel_task / stop_session: not the leader's role
 *   - set_task_status: leader uses complete_task / fail_task from leader-agent-tools instead
 *   - send_message_to_task: leader uses send_to_worker from leader-agent-tools instead
 */
export function createLeaderContextMcpServer(config: LeaderContextMcpConfig) {
	const handlers = createRoomAgentToolHandlers(config);

	const tools = [
		tool('list_goals', 'List all goals in this room', {}, () => handlers.list_goals()),
		tool(
			'list_tasks',
			'List tasks in this room, optionally filtered by goal',
			{
				goal_id: z.string().optional().describe('Filter to tasks linked to this goal'),
				status: z
					.enum([
						'draft',
						'pending',
						'in_progress',
						'review',
						'completed',
						'needs_attention',
						'cancelled',
					])
					.optional()
					.describe('Filter by status'),
			},
			(args) => handlers.list_tasks(args)
		),
		tool(
			'get_task_detail',
			'Get full details for a task including group session IDs and whether it is awaiting human review',
			{ task_id: z.string().describe('ID of the task to get details for') },
			(args) => handlers.get_task_detail(args)
		),
		tool(
			'get_room_status',
			'Get an overview of the room state including goals, tasks, active groups, and tasks needing review',
			{},
			() => handlers.get_room_status()
		),
	];

	return createSdkMcpServer({ name: 'leader-context', tools });
}

export type LeaderContextMcpServer = ReturnType<typeof createLeaderContextMcpServer>;
