/**
 * Space Workflow RPC Handlers
 *
 * RPC handlers for SpaceWorkflow CRUD operations:
 * - spaceWorkflow.create    - Create a workflow in a Space
 * - spaceWorkflow.list      - List workflows in a Space
 * - spaceWorkflow.get       - Get a workflow by ID
 * - spaceWorkflow.update    - Update workflow fields
 * - spaceWorkflow.delete    - Delete a workflow
 * - spaceWorkflow.setDefault - No-op stub (default concept removed in design; use explicit workflowId or AI auto-select)
 */

import type { MessageHub } from '@neokai/shared';
import type { CreateSpaceWorkflowParams, UpdateSpaceWorkflowParams } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { SpaceManager } from '../space/managers/space-manager';
import type { SpaceWorkflowManager } from '../space/managers/space-workflow-manager';
import { Logger } from '../logger';

const log = new Logger('space-workflow-handlers');

export function setupSpaceWorkflowHandlers(
	messageHub: MessageHub,
	spaceManager: SpaceManager,
	workflowManager: SpaceWorkflowManager,
	daemonHub: DaemonHub
): void {
	// ─── spaceWorkflow.create ────────────────────────────────────────────────
	messageHub.onRequest('spaceWorkflow.create', async (data) => {
		const params = data as CreateSpaceWorkflowParams;

		if (!params.spaceId) {
			throw new Error('spaceId is required');
		}
		if (!params.name || params.name.trim() === '') {
			throw new Error('name is required');
		}

		// Verify space exists
		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) {
			throw new Error(`Space not found: ${params.spaceId}`);
		}

		const workflow = workflowManager.createWorkflow(params);

		daemonHub
			.emit('spaceWorkflow.created', {
				sessionId: 'global',
				spaceId: params.spaceId,
				workflowId: workflow.id,
				workflow,
			})
			.catch((err) => {
				log.warn('Failed to emit spaceWorkflow.created:', err);
			});

		return { workflow };
	});

	// ─── spaceWorkflow.list ──────────────────────────────────────────────────
	messageHub.onRequest('spaceWorkflow.list', async (data) => {
		const params = data as { spaceId: string };

		if (!params.spaceId) {
			throw new Error('spaceId is required');
		}

		// Verify space exists
		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) {
			throw new Error(`Space not found: ${params.spaceId}`);
		}

		const workflows = workflowManager.listWorkflows(params.spaceId);
		return { workflows };
	});

	// ─── spaceWorkflow.get ───────────────────────────────────────────────────
	messageHub.onRequest('spaceWorkflow.get', async (data) => {
		const params = data as { id: string };

		if (!params.id) {
			throw new Error('id is required');
		}

		const workflow = workflowManager.getWorkflow(params.id);
		if (!workflow) {
			throw new Error(`Workflow not found: ${params.id}`);
		}

		return { workflow };
	});

	// ─── spaceWorkflow.update ────────────────────────────────────────────────
	messageHub.onRequest('spaceWorkflow.update', async (data) => {
		const params = data as { id: string } & UpdateSpaceWorkflowParams;

		if (!params.id) {
			throw new Error('id is required');
		}

		const { id, ...updateParams } = params;

		const workflow = workflowManager.updateWorkflow(id, updateParams);
		if (!workflow) {
			throw new Error(`Workflow not found: ${id}`);
		}

		daemonHub
			.emit('spaceWorkflow.updated', {
				sessionId: 'global',
				spaceId: workflow.spaceId,
				workflowId: id,
				workflow,
			})
			.catch((err) => {
				log.warn('Failed to emit spaceWorkflow.updated:', err);
			});

		return { workflow };
	});

	// ─── spaceWorkflow.delete ────────────────────────────────────────────────
	messageHub.onRequest('spaceWorkflow.delete', async (data) => {
		const params = data as { id: string };

		if (!params.id) {
			throw new Error('id is required');
		}

		// Fetch before deleting so we have spaceId for the event
		const workflow = workflowManager.getWorkflow(params.id);
		if (!workflow) {
			throw new Error(`Workflow not found: ${params.id}`);
		}

		const deleted = workflowManager.deleteWorkflow(params.id);
		if (!deleted) {
			throw new Error(`Workflow not found: ${params.id}`);
		}

		daemonHub
			.emit('spaceWorkflow.deleted', {
				sessionId: 'global',
				spaceId: workflow.spaceId,
				workflowId: params.id,
			})
			.catch((err) => {
				log.warn('Failed to emit spaceWorkflow.deleted:', err);
			});

		return { success: true };
	});

	// ─── spaceWorkflow.setDefault ────────────────────────────────────────────
	// The default workflow concept was removed in the design (Task 3.2).
	// Workflow selection uses either an explicit workflowId or AI auto-select.
	// This handler is a documented no-op stub for API compatibility.
	messageHub.onRequest('spaceWorkflow.setDefault', async (_data) => {
		return {
			success: false,
			reason:
				'Default workflow selection is not supported. Use explicit workflowId or AI auto-select.',
		};
	});
}
