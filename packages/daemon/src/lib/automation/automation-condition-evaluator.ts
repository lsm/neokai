/**
 * AutomationConditionEvaluator
 *
 * Evaluates runtime predicates before an automation launches concrete work.
 * Conditions are advisory gates: false means "record the check and skip this
 * firing", while thrown errors mean the automation itself failed to evaluate.
 */

import type {
	AutomationTask,
	AutomationConditionConfig,
	GitHubPrStatusAutomationConditionConfig,
	RoomGoal,
	RoomGoalHealthAutomationConditionConfig,
	SpaceTask,
	SpaceTaskHealthAutomationConditionConfig,
	WebQueryAutomationConditionConfig,
} from '@neokai/shared';

export interface AutomationConditionGoalReader {
	getGoal(goalId: string): Promise<RoomGoal | null>;
}

export interface AutomationConditionSpaceTaskReader {
	listTasks(includeArchived?: boolean): Promise<SpaceTask[]>;
}

export interface AutomationConditionGitHubReader {
	getPullRequestStatus(
		repository: string,
		prNumber: number
	): Promise<{ state: string; draft: boolean; headSha: string | null }>;
}

export interface AutomationConditionWebReader {
	query(
		url: string,
		options: { method: 'GET' | 'HEAD' }
	): Promise<{ status: number; text?: string | null }>;
}

export interface AutomationConditionEvaluation {
	passed: boolean;
	reason: string;
	metadata?: Record<string, unknown>;
}

export interface AutomationConditionEvaluatorConfig {
	goalManagerFactory?: (roomId: string) => AutomationConditionGoalReader;
	spaceTaskManagerFactory?: (spaceId: string) => AutomationConditionSpaceTaskReader;
	gitHubReader?: AutomationConditionGitHubReader;
	webReader?: AutomationConditionWebReader;
	now?: () => number;
}

const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export class AutomationConditionEvaluator {
	private now: () => number;

	constructor(private config: AutomationConditionEvaluatorConfig = {}) {
		this.now = config.now ?? Date.now;
	}

	async evaluate(task: AutomationTask): Promise<AutomationConditionEvaluation> {
		return this.evaluateCondition(task, task.conditionConfig);
	}

	private async evaluateCondition(
		task: AutomationTask,
		condition: AutomationConditionConfig | null
	): Promise<AutomationConditionEvaluation> {
		if (condition === null || condition.type === 'always') {
			return { passed: true, reason: 'always' };
		}

		switch (condition.type) {
			case 'all':
				return this.evaluateAll(task, condition.conditions);
			case 'any':
				return this.evaluateAny(task, condition.conditions);
			case 'not':
				return this.evaluateNot(task, condition.conditions);
			case 'room_goal_health':
				return this.evaluateRoomGoalHealth(task, condition);
			case 'space_task_health':
				return this.evaluateSpaceTaskHealth(task, condition);
			case 'github_pr_status':
				return this.evaluateGitHubPrStatus(condition);
			case 'web_query':
				return this.evaluateWebQuery(condition);
		}
	}

	private async evaluateAll(
		task: AutomationTask,
		conditions: AutomationConditionConfig[]
	): Promise<AutomationConditionEvaluation> {
		const results: AutomationConditionEvaluation[] = [];
		for (const condition of conditions) {
			const result = await this.evaluateCondition(task, condition);
			results.push(result);
			if (!result.passed) {
				return {
					passed: false,
					reason: 'all_condition_failed',
					metadata: { results },
				};
			}
		}
		return { passed: true, reason: 'all_conditions_passed', metadata: { results } };
	}

	private async evaluateAny(
		task: AutomationTask,
		conditions: AutomationConditionConfig[]
	): Promise<AutomationConditionEvaluation> {
		const results: AutomationConditionEvaluation[] = [];
		for (const condition of conditions) {
			const result = await this.evaluateCondition(task, condition);
			results.push(result);
			if (result.passed) {
				return {
					passed: true,
					reason: 'any_condition_passed',
					metadata: { results },
				};
			}
		}
		return { passed: false, reason: 'any_condition_failed', metadata: { results } };
	}

	private async evaluateNot(
		task: AutomationTask,
		conditions: AutomationConditionConfig[]
	): Promise<AutomationConditionEvaluation> {
		const result = await this.evaluateCondition(task, conditions[0] ?? null);
		return {
			passed: !result.passed,
			reason: result.passed ? 'not_condition_failed' : 'not_condition_passed',
			metadata: { result },
		};
	}

	private async evaluateGitHubPrStatus(
		condition: GitHubPrStatusAutomationConditionConfig
	): Promise<AutomationConditionEvaluation> {
		const reader = this.config.gitHubReader;
		if (!reader) {
			return {
				passed: false,
				reason: 'condition_evaluator_unavailable',
				metadata: { conditionType: condition.type },
			};
		}
		const status = await reader.getPullRequestStatus(condition.repository, condition.prNumber);
		const allowedStates = condition.states ?? ['open', 'merged'];
		const passed = allowedStates.includes(status.state);
		return {
			passed,
			reason: passed ? 'github_pr_state_matched' : 'github_pr_state_not_matched',
			metadata: {
				repository: condition.repository,
				prNumber: condition.prNumber,
				state: status.state,
				draft: status.draft,
				headSha: status.headSha,
				allowedStates,
			},
		};
	}

	private async evaluateWebQuery(
		condition: WebQueryAutomationConditionConfig
	): Promise<AutomationConditionEvaluation> {
		const reader = this.config.webReader;
		if (!reader) {
			return {
				passed: false,
				reason: 'condition_evaluator_unavailable',
				metadata: { conditionType: condition.type },
			};
		}
		const response = await reader.query(condition.url, {
			method: condition.method ?? 'GET',
		});
		const statusMatches =
			condition.expectedStatus === undefined || response.status === condition.expectedStatus;
		const textMatches =
			condition.containsText === undefined ||
			(response.text ?? '').includes(condition.containsText);
		const passed = statusMatches && textMatches;
		return {
			passed,
			reason: passed ? 'web_query_matched' : 'web_query_not_matched',
			metadata: {
				url: condition.url,
				status: response.status,
				expectedStatus: condition.expectedStatus ?? null,
				containsText: condition.containsText ?? null,
				statusMatches,
				textMatches,
			},
		};
	}

	private async evaluateRoomGoalHealth(
		task: AutomationTask,
		condition: RoomGoalHealthAutomationConditionConfig
	): Promise<AutomationConditionEvaluation> {
		if (task.ownerType !== 'room' || task.ownerId !== condition.roomId) {
			return {
				passed: false,
				reason: 'owner_scope_mismatch',
				metadata: { ownerType: task.ownerType, ownerId: task.ownerId, roomId: condition.roomId },
			};
		}
		const manager = this.config.goalManagerFactory?.(condition.roomId);
		if (!manager) {
			return {
				passed: false,
				reason: 'condition_evaluator_unavailable',
				metadata: { conditionType: condition.type },
			};
		}
		const goal = await manager.getGoal(condition.goalId);
		if (!goal) {
			return {
				passed: false,
				reason: 'goal_not_found',
				metadata: { goalId: condition.goalId },
			};
		}
		if (goal.status === 'completed' || goal.status === 'archived') {
			return {
				passed: false,
				reason: 'goal_terminal',
				metadata: { goalId: goal.id, status: goal.status },
			};
		}

		const staleAfterMs = condition.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
		const ageMs = this.now() - goal.updatedAt;
		if (ageMs < staleAfterMs) {
			return {
				passed: false,
				reason: 'goal_recently_updated',
				metadata: { goalId: goal.id, ageMs, staleAfterMs },
			};
		}

		return {
			passed: true,
			reason: 'goal_stale',
			metadata: {
				goalId: goal.id,
				status: goal.status,
				progress: goal.progress,
				ageMs,
				staleAfterMs,
			},
		};
	}

	private async evaluateSpaceTaskHealth(
		task: AutomationTask,
		condition: SpaceTaskHealthAutomationConditionConfig
	): Promise<AutomationConditionEvaluation> {
		if (task.ownerType !== 'space' || task.ownerId !== condition.spaceId) {
			return {
				passed: false,
				reason: 'owner_scope_mismatch',
				metadata: { ownerType: task.ownerType, ownerId: task.ownerId, spaceId: condition.spaceId },
			};
		}
		const manager = this.config.spaceTaskManagerFactory?.(condition.spaceId);
		if (!manager) {
			return {
				passed: false,
				reason: 'condition_evaluator_unavailable',
				metadata: { conditionType: condition.type },
			};
		}
		const tasks = await manager.listTasks(false);
		const staleAfterMs = condition.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
		const now = this.now();
		const attentionTasks = tasks.filter((spaceTask) => {
			if (spaceTask.status === 'blocked' || spaceTask.status === 'review') return true;
			if (spaceTask.status !== 'in_progress' || spaceTask.startedAt === null) return false;
			return now - spaceTask.startedAt >= staleAfterMs;
		});

		if (attentionTasks.length === 0) {
			return {
				passed: false,
				reason: 'space_tasks_healthy',
				metadata: { checkedTaskCount: tasks.length, staleAfterMs },
			};
		}

		return {
			passed: true,
			reason: 'space_tasks_need_attention',
			metadata: {
				checkedTaskCount: tasks.length,
				attentionTaskIds: attentionTasks.map((spaceTask) => spaceTask.id),
				staleAfterMs,
			},
		};
	}
}
