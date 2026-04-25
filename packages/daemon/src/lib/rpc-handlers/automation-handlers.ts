/**
 * Automation RPC Handlers
 *
 * Public command surface for automation definitions and runtime dispatch.
 * Run creation stays owned by AutomationScheduler so the ledger cannot be
 * mutated directly over RPC.
 */

import type {
	MessageHub,
	AutomationTaskFilter,
	AutomationRunFilter,
	CreateAutomationTaskParams,
	UpdateAutomationTaskParams,
} from '@neokai/shared';
import type { AutomationManager } from '../automation/automation-manager';
import type { AutomationScheduler } from '../automation/automation-scheduler';

export function setupAutomationHandlers(
	messageHub: MessageHub,
	automationManager: AutomationManager,
	automationScheduler: AutomationScheduler
): void {
	messageHub.onRequest('automation.create', async (data) => {
		const params = data as CreateAutomationTaskParams;
		if (!params.ownerType) throw new Error('ownerType is required');
		if (!params.title) throw new Error('Automation title is required');
		if (!params.triggerType) throw new Error('triggerType is required');
		if (!params.targetType) throw new Error('targetType is required');
		const automation = automationManager.createTask(params);
		automationScheduler.scheduleTask(automation);
		return { automation };
	});

	messageHub.onRequest('automation.get', async (data) => {
		const params = data as { id: string };
		if (!params.id) throw new Error('Automation ID is required');
		const automation = automationManager.getTask(params.id);
		if (!automation) throw new Error(`Automation not found: ${params.id}`);
		return { automation };
	});

	messageHub.onRequest('automation.list', async (data) => {
		const filter = (data ?? {}) as AutomationTaskFilter;
		const automations = automationManager.listTasks(filter);
		return { automations };
	});

	messageHub.onRequest('automation.update', async (data) => {
		const params = data as { id: string; updates: UpdateAutomationTaskParams };
		if (!params.id) throw new Error('Automation ID is required');
		if (!params.updates || Object.keys(params.updates).length === 0) {
			throw new Error('No update fields provided');
		}
		const automation = automationManager.updateTask(params.id, params.updates);
		automationScheduler.cancelPendingJobs(params.id);
		automationScheduler.scheduleTask(automation);
		return { automation };
	});

	messageHub.onRequest('automation.archive', async (data) => {
		const params = data as { id: string };
		if (!params.id) throw new Error('Automation ID is required');
		const automation = automationManager.archiveTask(params.id);
		automationScheduler.cancelPendingJobs(params.id);
		return { automation };
	});

	messageHub.onRequest('automation.listRuns', async (data) => {
		const filter = (data ?? {}) as AutomationRunFilter;
		const runs = automationManager.listRuns(filter);
		return { runs };
	});

	messageHub.onRequest('automation.triggerNow', async (data) => {
		const params = data as { id: string };
		if (!params.id) throw new Error('Automation ID is required');
		const run = await automationScheduler.triggerNow(params.id);
		return { run };
	});

	messageHub.onRequest('automation.emitEvent', async (data) => {
		const params = data as { eventName: string; payload?: Record<string, unknown> };
		if (!params.eventName) throw new Error('eventName is required');
		const runs = await automationScheduler.emitEvent(params.eventName, params.payload ?? {});
		return { runs };
	});

	messageHub.onRequest('automation.pause', async (data) => {
		const params = data as { id: string };
		if (!params.id) throw new Error('Automation ID is required');
		const automation = automationScheduler.pause(params.id);
		return { automation };
	});

	messageHub.onRequest('automation.resume', async (data) => {
		const params = data as { id: string };
		if (!params.id) throw new Error('Automation ID is required');
		const automation = automationScheduler.resume(params.id);
		return { automation };
	});

	messageHub.onRequest('automation.setNextRunAt', async (data) => {
		const params = data as { id: string; nextRunAt: number | null };
		if (!params.id) throw new Error('Automation ID is required');
		if (params.nextRunAt !== null && typeof params.nextRunAt !== 'number') {
			throw new Error('nextRunAt must be a number or null');
		}
		const automation = automationScheduler.setNextRunAt(params.id, params.nextRunAt);
		return { automation };
	});
}
