/**
 * AutomationManager
 *
 * Thin domain facade over AutomationRepository. Scheduler and target execution
 * logic are added in later milestones; this manager owns validation and the
 * CRUD/run-ledger surface for Milestone 1.
 */

import type {
	AutomationTask,
	AutomationRun,
	AutomationTaskFilter,
	AutomationRunFilter,
	CreateAutomationTaskParams,
	UpdateAutomationTaskParams,
	CreateAutomationRunParams,
	UpdateAutomationRunParams,
	AutomationOwnerType,
	AutomationTargetType,
	AutomationTriggerType,
	AutomationTriggerConfig,
	AutomationTargetConfig,
	AutomationConditionConfig,
} from '@neokai/shared';
import type { AutomationRepository } from '../../storage/repositories/automation-repository';

export class AutomationManager {
	constructor(private repo: AutomationRepository) {}

	createTask(params: CreateAutomationTaskParams): AutomationTask {
		this.validateTaskInput(params);
		return this.repo.createTask(params);
	}

	getTask(id: string): AutomationTask | null {
		return this.repo.getTask(id);
	}

	listTasks(filter?: AutomationTaskFilter): AutomationTask[] {
		return this.repo.listTasks(filter);
	}

	updateTask(id: string, params: UpdateAutomationTaskParams): AutomationTask {
		const existing = this.repo.getTask(id);
		if (!existing) {
			throw new Error(`Automation not found: ${id}`);
		}
		this.validateTaskPatch(existing, params);
		const updated = this.repo.updateTask(id, params);
		if (!updated) {
			throw new Error(`Automation not found: ${id}`);
		}
		return updated;
	}

	archiveTask(id: string): AutomationTask {
		const updated = this.repo.archiveTask(id);
		if (!updated) {
			throw new Error(`Automation not found: ${id}`);
		}
		return updated;
	}

	listDueTasks(now?: number, limit?: number): AutomationTask[] {
		return this.repo.listDueTasks(now, limit);
	}

	createRun(params: CreateAutomationRunParams): AutomationRun {
		return this.repo.createRun(params);
	}

	getRun(id: string): AutomationRun | null {
		return this.repo.getRun(id);
	}

	listRuns(filter?: AutomationRunFilter): AutomationRun[] {
		return this.repo.listRuns(filter);
	}

	listActiveRuns(automationTaskId: string): AutomationRun[] {
		return this.repo.listActiveRuns(automationTaskId);
	}

	listLinkedActiveRuns(limit?: number): AutomationRun[] {
		return this.repo.listLinkedActiveRuns(limit);
	}

	updateRun(id: string, params: UpdateAutomationRunParams): AutomationRun {
		const updated = this.repo.updateRun(id, params);
		if (!updated) {
			throw new Error(`Automation run not found: ${id}`);
		}
		return updated;
	}

	private validateTaskInput(params: CreateAutomationTaskParams): void {
		if (!params.title.trim()) {
			throw new Error('Automation title is required');
		}
		if (params.ownerType !== 'global' && !params.ownerId) {
			throw new Error(`ownerId is required for ${params.ownerType} automations`);
		}
		this.validateTriggerConfig(params.triggerType, params.triggerConfig ?? {});
		this.validateTargetConfig(
			params.ownerType,
			params.ownerId ?? null,
			params.targetType,
			params.targetConfig ?? {}
		);
		this.validateConditionConfig(
			params.ownerType,
			params.ownerId ?? null,
			params.conditionConfig ?? null
		);
		if (params.maxRetries !== undefined && params.maxRetries < 0) {
			throw new Error('maxRetries must be greater than or equal to 0');
		}
		if (params.timeoutMs !== undefined && params.timeoutMs !== null && params.timeoutMs <= 0) {
			throw new Error('timeoutMs must be greater than 0');
		}
	}

	private validateTaskPatch(existing: AutomationTask, patch: UpdateAutomationTaskParams): void {
		const triggerType = patch.triggerType ?? existing.triggerType;
		const triggerConfig = patch.triggerConfig ?? existing.triggerConfig;
		const targetType = patch.targetType ?? existing.targetType;
		const targetConfig = patch.targetConfig ?? existing.targetConfig;
		const conditionConfig =
			'conditionConfig' in patch ? patch.conditionConfig : existing.conditionConfig;

		this.validateTriggerConfig(triggerType, triggerConfig);
		this.validateTargetConfig(existing.ownerType, existing.ownerId, targetType, targetConfig);
		this.validateConditionConfig(existing.ownerType, existing.ownerId, conditionConfig ?? null);
		if (patch.maxRetries !== undefined && patch.maxRetries < 0) {
			throw new Error('maxRetries must be greater than or equal to 0');
		}
		if (patch.timeoutMs !== undefined && patch.timeoutMs !== null && patch.timeoutMs <= 0) {
			throw new Error('timeoutMs must be greater than 0');
		}
	}

	private validateTriggerConfig(
		triggerType: AutomationTriggerType,
		config: AutomationTriggerConfig | object
	): void {
		switch (triggerType) {
			case 'cron':
				this.requireString(config, 'expression', 'cron trigger');
				this.requireString(config, 'timezone', 'cron trigger');
				break;
			case 'at':
				this.requirePositiveNumber(config, 'runAt', 'at trigger');
				break;
			case 'interval':
				this.requirePositiveNumber(config, 'intervalMs', 'interval trigger');
				break;
			case 'heartbeat': {
				const intervalMs = this.getNumber(config, 'intervalMs');
				if (intervalMs !== undefined && intervalMs <= 0) {
					throw new Error('heartbeat trigger intervalMs must be greater than 0');
				}
				break;
			}
			case 'event':
				this.requireString(config, 'eventName', 'event trigger');
				break;
			case 'manual':
				break;
		}
	}

	private validateTargetConfig(
		ownerType: AutomationOwnerType,
		ownerId: string | null,
		targetType: AutomationTargetType,
		config: AutomationTargetConfig | object
	): void {
		switch (targetType) {
			case 'room_task':
				this.requireOwnerTarget(ownerType, ownerId, 'room', this.requireString(config, 'roomId'));
				this.requireString(config, 'titleTemplate', 'room_task target');
				this.requireString(config, 'descriptionTemplate', 'room_task target');
				break;
			case 'room_mission':
				this.requireOwnerTarget(ownerType, ownerId, 'room', this.requireString(config, 'roomId'));
				this.requireString(config, 'goalId', 'room_mission target');
				this.requireOneOf(config, 'action', ['trigger', 'check'], 'room_mission target');
				break;
			case 'space_task':
				this.requireOwnerTarget(ownerType, ownerId, 'space', this.requireString(config, 'spaceId'));
				this.requireString(config, 'titleTemplate', 'space_task target');
				this.requireString(config, 'descriptionTemplate', 'space_task target');
				break;
			case 'space_workflow':
				this.requireOwnerTarget(ownerType, ownerId, 'space', this.requireString(config, 'spaceId'));
				this.requireString(config, 'titleTemplate', 'space_workflow target');
				this.requireString(config, 'descriptionTemplate', 'space_workflow target');
				break;
			case 'neo_agent':
				if (ownerType !== 'global') {
					throw new Error('neo_agent automations must be global-scoped');
				}
				this.requireString(config, 'promptTemplate', 'neo_agent target');
				break;
			case 'job_handler':
				if (ownerType !== 'global') {
					throw new Error('job_handler automations must be global-scoped');
				}
				this.requireString(config, 'queue', 'job_handler target');
				break;
		}
	}

	private validateConditionConfig(
		ownerType: AutomationOwnerType,
		ownerId: string | null,
		config: AutomationConditionConfig | null
	): void {
		if (config === null) return;
		const type = this.requireString(config, 'type', 'condition');
		switch (type) {
			case 'always':
				return;
			case 'github_pr_status':
				this.requireString(config, 'repository', 'github_pr_status condition');
				this.requirePositiveNumber(config, 'prNumber', 'github_pr_status condition');
				return;
			case 'room_goal_health':
				this.requireOwnerTarget(
					ownerType,
					ownerId,
					'room',
					this.requireString(config, 'roomId', 'room_goal_health condition')
				);
				this.requireString(config, 'goalId', 'room_goal_health condition');
				return;
			case 'space_task_health':
				this.requireOwnerTarget(
					ownerType,
					ownerId,
					'space',
					this.requireString(config, 'spaceId', 'space_task_health condition')
				);
				return;
			default:
				throw new Error(`Unsupported Automation condition type: ${type}`);
		}
	}

	private requireOwnerTarget(
		ownerType: AutomationOwnerType,
		ownerId: string | null,
		expectedOwnerType: 'room' | 'space',
		targetOwnerId: string
	): void {
		if (ownerType !== expectedOwnerType) {
			throw new Error(
				`${expectedOwnerType} targets require ${expectedOwnerType}-scoped automations`
			);
		}
		if (ownerId !== targetOwnerId) {
			throw new Error(
				`Automation ownerId (${ownerId ?? 'null'}) must match target ${expectedOwnerType}Id (${targetOwnerId})`
			);
		}
	}

	private requireString(config: object, key: string, label = 'config'): string {
		const value = (config as Record<string, unknown>)[key];
		if (typeof value !== 'string' || value.trim() === '') {
			throw new Error(`${label} requires ${key}`);
		}
		return value;
	}

	private requirePositiveNumber(config: object, key: string, label: string): number {
		const value = this.getNumber(config, key);
		if (value === undefined || value <= 0) {
			throw new Error(`${label} requires positive ${key}`);
		}
		return value;
	}

	private requireOneOf<T extends string>(
		config: object,
		key: string,
		values: readonly T[],
		label: string
	): T {
		const value = this.requireString(config, key, label);
		if (!values.includes(value as T)) {
			throw new Error(`${label} ${key} must be one of: ${values.join(', ')}`);
		}
		return value as T;
	}

	private getNumber(config: object, key: string): number | undefined {
		const value = (config as Record<string, unknown>)[key];
		return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
	}
}
