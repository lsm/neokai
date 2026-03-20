/**
 * Space Workflow Run RPC Handlers
 *
 * RPC handlers for SpaceWorkflowRun lifecycle:
 * - spaceWorkflowRun.start   - Creates a run and triggers first step task creation
 * - spaceWorkflowRun.list    - Lists runs for a space (optional status filter)
 * - spaceWorkflowRun.get     - Gets a run by ID
 * - spaceWorkflowRun.cancel  - Cancels a run and all pending tasks
 */

import type { MessageHub } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { SpaceManager } from '../space/managers/space-manager';
import type { SpaceWorkflowManager } from '../space/managers/space-workflow-manager';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service';
import type { WorkflowRunStatus } from '@neokai/shared';
import { SpaceTaskManager } from '../space/managers/space-task-manager';
import type { Database as BunDatabase } from 'bun:sqlite';
import { Logger } from '../logger';

const log = new Logger('space-workflow-run-handlers');

export function setupSpaceWorkflowRunHandlers(
	messageHub: MessageHub,
	spaceManager: SpaceManager,
	spaceWorkflowManager: SpaceWorkflowManager,
	workflowRunRepo: SpaceWorkflowRunRepository,
	spaceRuntimeService: SpaceRuntimeService,
	db: BunDatabase,
	daemonHub: DaemonHub
): void {
	// ─── spaceWorkflowRun.start ──────────────────────────────────────────────
	messageHub.onRequest('spaceWorkflowRun.start', async (data) => {
		const params = data as {
			spaceId: string;
			workflowId?: string;
			title: string;
			description?: string;
		};

		if (!params.spaceId) throw new Error('spaceId is required');
		if (!params.title || params.title.trim() === '') throw new Error('title is required');

		// Verify space exists
		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) throw new Error(`Space not found: ${params.spaceId}`);

		// Resolve workflow: explicit workflowId or auto-select first workflow
		let workflowId = params.workflowId;
		if (!workflowId) {
			const workflows = spaceWorkflowManager.listWorkflows(params.spaceId);
			if (workflows.length === 0) {
				throw new Error(`No workflows found for space: ${params.spaceId}`);
			}
			workflowId = workflows[0].id;
		} else {
			// Validate provided workflow exists and belongs to this space
			const workflow = spaceWorkflowManager.getWorkflow(workflowId);
			if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);
			if (workflow.spaceId !== params.spaceId) throw new Error(`Workflow not found: ${workflowId}`);
		}

		// Get or create the runtime for this space (validates space, starts runtime if needed)
		const runtime = await spaceRuntimeService.createOrGetRuntime(params.spaceId);

		// Create the run and initial task via the runtime
		const { run } = await runtime.startWorkflowRun(
			params.spaceId,
			workflowId,
			params.title,
			params.description
		);

		daemonHub
			.emit('space.workflowRun.created', {
				sessionId: 'global',
				spaceId: params.spaceId,
				runId: run.id,
				run,
			})
			.catch((err) => {
				log.warn('Failed to emit space.workflowRun.created:', err);
			});

		return { run };
	});

	// ─── spaceWorkflowRun.list ───────────────────────────────────────────────
	messageHub.onRequest('spaceWorkflowRun.list', async (data) => {
		const params = data as { spaceId: string; status?: WorkflowRunStatus };

		if (!params.spaceId) throw new Error('spaceId is required');

		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) throw new Error(`Space not found: ${params.spaceId}`);

		let runs = workflowRunRepo.listBySpace(params.spaceId);
		if (params.status) {
			runs = runs.filter((r) => r.status === params.status);
		}

		return { runs };
	});

	// ─── spaceWorkflowRun.get ────────────────────────────────────────────────
	messageHub.onRequest('spaceWorkflowRun.get', async (data) => {
		const params = data as { id: string };

		if (!params.id) throw new Error('id is required');

		const run = workflowRunRepo.getRun(params.id);
		if (!run) throw new Error(`WorkflowRun not found: ${params.id}`);

		return { run };
	});

	// ─── spaceWorkflowRun.cancel ─────────────────────────────────────────────
	messageHub.onRequest('spaceWorkflowRun.cancel', async (data) => {
		const params = data as { id: string };

		if (!params.id) throw new Error('id is required');

		const run = workflowRunRepo.getRun(params.id);
		if (!run) throw new Error(`WorkflowRun not found: ${params.id}`);

		if (run.status === 'cancelled') {
			return { success: true };
		}
		if (run.status === 'completed') {
			throw new Error('Cannot cancel a completed workflow run');
		}

		// Cancel all pending tasks belonging to this run
		const taskManager = new SpaceTaskManager(db, run.spaceId);
		const tasks = await taskManager.listTasksByWorkflowRun(run.id);
		for (const task of tasks) {
			if (task.status === 'pending' || task.status === 'in_progress') {
				await taskManager.cancelTask(task.id).catch((err: unknown) => {
					log.warn(`Failed to cancel task ${task.id} for run ${run.id}:`, err);
				});
			}
		}

		// Cancel the run
		const updated = workflowRunRepo.updateStatus(params.id, 'cancelled');
		if (!updated) throw new Error(`WorkflowRun not found: ${params.id}`);

		daemonHub
			.emit('space.workflowRun.updated', {
				sessionId: 'global',
				spaceId: run.spaceId,
				runId: run.id,
				run: updated,
			})
			.catch((err) => {
				log.warn('Failed to emit space.workflowRun.updated:', err);
			});

		return { success: true };
	});
}
