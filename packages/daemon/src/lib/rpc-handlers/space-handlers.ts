/**
 * Space RPC Handlers
 *
 * RPC handlers for Space CRUD operations:
 * - space.create  - Create a Space (validates workspace path exists, rejects invalid paths)
 * - space.list    - List all Spaces (optionally including archived)
 * - space.get     - Get a Space by ID
 * - space.update  - Update Space metadata
 * - space.archive - Archive a Space
 * - space.delete  - Delete a Space
 * - space.overview - Get a Space with tasks, workflowRuns, and sessions
 */

import type { MessageHub } from '@neokai/shared';
import type {
	Space,
	CreateSpaceParams,
	UpdateSpaceParams,
	SpaceTask,
	SpaceWorkflowRun,
} from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { SpaceManager } from '../space/managers/space-manager';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository';
import { Logger } from '../logger';

const log = new Logger('space-handlers');

export interface SpaceOverviewResult {
	space: Space;
	tasks: SpaceTask[];
	workflowRuns: SpaceWorkflowRun[];
	sessions: string[];
}

export function setupSpaceHandlers(
	messageHub: MessageHub,
	spaceManager: SpaceManager,
	taskRepo: SpaceTaskRepository,
	workflowRunRepo: SpaceWorkflowRunRepository,
	daemonHub: DaemonHub
): void {
	// ─── space.create ───────────────────────────────────────────────────────────
	messageHub.onRequest('space.create', async (data) => {
		const params = data as CreateSpaceParams;

		if (!params.workspacePath) {
			throw new Error('workspacePath is required');
		}
		if (!params.name || params.name.trim() === '') {
			throw new Error('name is required');
		}

		const space = await spaceManager.createSpace(params);

		daemonHub
			.emit('space.created', { sessionId: 'global', spaceId: space.id, space })
			.catch((err) => {
				log.warn('Failed to emit space.created:', err);
			});

		return space;
	});

	// ─── space.list ─────────────────────────────────────────────────────────────
	messageHub.onRequest('space.list', async (data) => {
		const params = (data ?? {}) as { includeArchived?: boolean };
		return spaceManager.listSpaces(params.includeArchived ?? false);
	});

	// ─── space.get ──────────────────────────────────────────────────────────────
	messageHub.onRequest('space.get', async (data) => {
		const params = data as { id: string };

		if (!params.id) {
			throw new Error('id is required');
		}

		const space = await spaceManager.getSpace(params.id);
		if (!space) {
			throw new Error(`Space not found: ${params.id}`);
		}

		return space;
	});

	// ─── space.update ───────────────────────────────────────────────────────────
	messageHub.onRequest('space.update', async (data) => {
		const params = data as { id: string } & UpdateSpaceParams;

		if (!params.id) {
			throw new Error('id is required');
		}

		const { id, ...updateParams } = params;
		const space = await spaceManager.updateSpace(id, updateParams);

		daemonHub.emit('space.updated', { sessionId: 'global', spaceId: id, space }).catch((err) => {
			log.warn('Failed to emit space.updated:', err);
		});

		return space;
	});

	// ─── space.archive ──────────────────────────────────────────────────────────
	messageHub.onRequest('space.archive', async (data) => {
		const params = data as { id: string };

		if (!params.id) {
			throw new Error('id is required');
		}

		const space = await spaceManager.archiveSpace(params.id);

		daemonHub
			.emit('space.updated', {
				sessionId: 'global',
				spaceId: params.id,
				space: { status: 'archived' },
			})
			.catch((err) => {
				log.warn('Failed to emit space.updated (archive):', err);
			});

		return space;
	});

	// ─── space.delete ───────────────────────────────────────────────────────────
	messageHub.onRequest('space.delete', async (data) => {
		const params = data as { id: string };

		if (!params.id) {
			throw new Error('id is required');
		}

		const deleted = await spaceManager.deleteSpace(params.id);
		if (!deleted) {
			throw new Error(`Space not found: ${params.id}`);
		}

		daemonHub.emit('space.deleted', { sessionId: 'global', spaceId: params.id }).catch((err) => {
			log.warn('Failed to emit space.deleted:', err);
		});

		return { success: true };
	});

	// ─── space.overview ─────────────────────────────────────────────────────────
	messageHub.onRequest('space.overview', async (data) => {
		const params = data as { id: string };

		if (!params.id) {
			throw new Error('id is required');
		}

		const space = await spaceManager.getSpace(params.id);
		if (!space) {
			throw new Error(`Space not found: ${params.id}`);
		}

		const tasks = taskRepo.listBySpace(params.id);
		const workflowRuns = workflowRunRepo.listBySpace(params.id);

		const result: SpaceOverviewResult = {
			space,
			tasks,
			workflowRuns,
			sessions: space.sessionIds,
		};

		return result;
	});
}
