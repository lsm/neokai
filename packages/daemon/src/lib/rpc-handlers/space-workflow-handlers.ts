/**
 * Space Workflow RPC Handlers
 *
 * RPC handlers for SpaceWorkflow CRUD operations:
 * - spaceWorkflow.create    - Create a workflow in a Space
 * - spaceWorkflow.list      - List workflows in a Space
 * - spaceWorkflow.get       - Get a workflow by ID (optional spaceId: existence + ownership check)
 * - spaceWorkflow.update    - Update workflow fields (optional spaceId: existence + ownership check)
 * - spaceWorkflow.delete    - Delete a workflow (optional spaceId: existence + ownership check)
 *
 * No spaceWorkflow.setDefault — default selection is removed from the design.
 * Workflow selection uses only explicit workflowId or AI auto-select.
 *
 * Events emitted (spaceWorkflow.* namespace — matches SpaceStore subscriptions in M5):
 * - spaceWorkflow.created
 * - spaceWorkflow.updated
 * - spaceWorkflow.deleted
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
		const params = data as { id: string; spaceId?: string };

		if (!params.id) {
			throw new Error('id is required');
		}

		// When spaceId is provided: verify the space exists before fetching the workflow.
		// This matches the space-task-handlers.ts pattern and surfaces "Space not found"
		// correctly instead of silently returning an orphaned workflow.
		if (params.spaceId) {
			const space = await spaceManager.getSpace(params.spaceId);
			if (!space) {
				throw new Error(`Space not found: ${params.spaceId}`);
			}
		}

		const workflow = workflowManager.getWorkflow(params.id);
		if (!workflow) {
			throw new Error(`Workflow not found: ${params.id}`);
		}

		// Ownership check — reject if caller's spaceId doesn't match the workflow's owner
		if (params.spaceId && workflow.spaceId !== params.spaceId) {
			throw new Error(`Workflow not found: ${params.id}`);
		}

		return { workflow };
	});

	// ─── spaceWorkflow.update ────────────────────────────────────────────────
	messageHub.onRequest('spaceWorkflow.update', async (data) => {
		const params = data as { id: string; spaceId?: string } & UpdateSpaceWorkflowParams;

		if (!params.id) {
			throw new Error('id is required');
		}

		// When spaceId is provided: verify space exists and ownership before mutating.
		// The ownership check requires fetching the workflow here; updateWorkflow will
		// re-fetch internally (synchronous SQLite — acceptable for this pattern).
		if (params.spaceId) {
			const space = await spaceManager.getSpace(params.spaceId);
			if (!space) {
				throw new Error(`Space not found: ${params.spaceId}`);
			}
			const existing = workflowManager.getWorkflow(params.id);
			if (!existing) {
				throw new Error(`Workflow not found: ${params.id}`);
			}
			if (existing.spaceId !== params.spaceId) {
				throw new Error(`Workflow not found: ${params.id}`);
			}
		}

		const { id, spaceId: _spaceId, ...updateParams } = params;

		const workflow = workflowManager.updateWorkflow(id, updateParams);
		if (!workflow) {
			throw new Error(`Workflow not found: ${id}`);
		}

		daemonHub
			.emit('spaceWorkflow.updated', {
				sessionId: 'global',
				spaceId: workflow.spaceId,
				workflow,
			})
			.catch((err) => {
				log.warn('Failed to emit spaceWorkflow.updated:', err);
			});

		return { workflow };
	});

	// ─── spaceWorkflow.delete ────────────────────────────────────────────────
	messageHub.onRequest('spaceWorkflow.delete', async (data) => {
		const params = data as { id: string; spaceId?: string };

		if (!params.id) {
			throw new Error('id is required');
		}

		// When spaceId is provided: verify space exists before fetching the workflow.
		if (params.spaceId) {
			const space = await spaceManager.getSpace(params.spaceId);
			if (!space) {
				throw new Error(`Space not found: ${params.spaceId}`);
			}
		}

		// Fetch before deleting — needed for the event payload and optional ownership check
		const workflow = workflowManager.getWorkflow(params.id);
		if (!workflow) {
			throw new Error(`Workflow not found: ${params.id}`);
		}

		// Ownership check
		if (params.spaceId && workflow.spaceId !== params.spaceId) {
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
}
