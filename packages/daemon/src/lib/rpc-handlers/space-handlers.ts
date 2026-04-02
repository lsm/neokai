/**
 * Space RPC Handlers
 *
 * RPC handlers for Space CRUD operations:
 * - space.create  - Create a Space (validates workspace path exists, rejects invalid paths)
 * - space.list    - List all Spaces (optionally including archived)
 * - space.get     - Get a Space by ID
 * - space.update  - Update Space metadata
 * - space.archive - Archive a Space (emits dedicated space.archived event)
 * - space.delete  - Delete a Space
 * - space.overview - Get a Space with tasks, workflowRuns, and sessions
 */

import type { MessageHub } from '@neokai/shared';
import type {
	Space,
	SpaceAutonomyLevel,
	CreateSpaceParams,
	UpdateSpaceParams,
	SpaceTask,
	SpaceWorkflowRun,
} from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { SpaceManager } from '../space/managers/space-manager';
import type { SpaceAgentManager } from '../space/managers/space-agent-manager';
import type { SpaceWorkflowManager } from '../space/managers/space-workflow-manager';
import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../storage/repositories/space-workflow-run-repository';
import type { SessionManager } from '../session-manager';
import type { SpaceRuntimeService } from '../space/runtime/space-runtime-service';
import { seedPresetAgents } from '../space/agents/seed-agents';
import { seedBuiltInWorkflows } from '../space/workflows/built-in-workflows';
import { Logger } from '../logger';

const log = new Logger('space-handlers');
const VALID_AUTONOMY_LEVELS: SpaceAutonomyLevel[] = ['supervised', 'semi_autonomous'];

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
	daemonHub: DaemonHub,
	spaceAgentManager: SpaceAgentManager,
	spaceWorkflowManager: SpaceWorkflowManager,
	sessionManager?: SessionManager,
	spaceRuntimeService?: SpaceRuntimeService
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
		if (
			params.autonomyLevel !== undefined &&
			!VALID_AUTONOMY_LEVELS.includes(params.autonomyLevel)
		) {
			throw new Error(
				`Invalid autonomyLevel: ${params.autonomyLevel}. Must be one of: ${VALID_AUTONOMY_LEVELS.join(', ')}`
			);
		}

		const space = await spaceManager.createSpace(params);

		// Seed preset agents (Coder, General, Planner, Reviewer) for the new space.
		// Errors are non-fatal — the space is still usable without preset agents.
		try {
			await seedPresetAgents(space.id, spaceAgentManager);
		} catch (err) {
			log.warn('Failed to seed preset agents for space', space.id, err);
		}

		// Seed built-in workflow templates after preset agents are available.
		// Resolves role names ('planner', 'coder', 'general') to SpaceAgent UUIDs.
		try {
			const agents = spaceAgentManager.listBySpaceId(space.id);
			seedBuiltInWorkflows(
				space.id,
				spaceWorkflowManager,
				(name) => agents.find((a) => a.name.toLowerCase() === name.toLowerCase())?.id
			);
		} catch (err) {
			log.warn('Failed to seed built-in workflows for space', space.id, err);
		}

		// Create the space's user-facing chat session.
		// Session ID format: space:chat:${spaceId}
		// Mirrors the room:chat:${roomId} pattern from room-handlers.ts.
		if (sessionManager) {
			const spaceChatSessionId = `space:chat:${space.id}`;
			try {
				await sessionManager.createSession({
					sessionId: spaceChatSessionId,
					title: space.name,
					workspacePath: space.workspacePath,
					config: {
						model: space.defaultModel,
					},
					sessionType: 'space_chat',
					spaceId: space.id,
					createdBy: 'neo',
				});
				// Register the session on the space so it appears in space.sessionIds.
				// Mirrors roomManager.assignSession() in room-handlers.ts.
				await spaceManager.addSession(space.id, spaceChatSessionId);
				// Attach MCP tools and system prompt directly (session is in DB now).
				// This avoids relying on the space.created event which fires asynchronously.
				if (spaceRuntimeService) {
					await spaceRuntimeService.setupSpaceAgentSession(space).catch((err) => {
						log.warn(`Failed to provision space chat session for space ${space.id}:`, err);
					});
				}
			} catch (error) {
				log.warn(`Failed to create space chat session for space ${space.id}:`, error);
			}
		}

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
	// Accepts either { id } or { slug } to look up a space.
	messageHub.onRequest('space.get', async (data) => {
		const params = data as { id?: string; slug?: string };

		if (!params.id && !params.slug) {
			throw new Error('id or slug is required');
		}

		let space;
		if (params.id) {
			space = await spaceManager.getSpace(params.id);
		} else {
			space = await spaceManager.getSpaceBySlug(params.slug!);
		}

		if (!space) {
			throw new Error(`Space not found: ${params.id ?? params.slug}`);
		}

		return space;
	});

	// ─── space.updateSlug ──────────────────────────────────────────────────────
	messageHub.onRequest('space.updateSlug', async (data) => {
		const params = data as { id: string; slug: string };

		if (!params.id) {
			throw new Error('id is required');
		}
		if (!params.slug) {
			throw new Error('slug is required');
		}

		const space = await spaceManager.updateSlug(params.id, params.slug);

		daemonHub
			.emit('space.updated', { sessionId: 'global', spaceId: params.id, space })
			.catch((err) => {
				log.warn('Failed to emit space.updated:', err);
			});

		return space;
	});

	// ─── space.update ───────────────────────────────────────────────────────────
	messageHub.onRequest('space.update', async (data) => {
		const params = data as { id: string } & UpdateSpaceParams;

		if (!params.id) {
			throw new Error('id is required');
		}
		if (
			params.autonomyLevel !== undefined &&
			!VALID_AUTONOMY_LEVELS.includes(params.autonomyLevel)
		) {
			throw new Error(
				`Invalid autonomyLevel: ${params.autonomyLevel}. Must be one of: ${VALID_AUTONOMY_LEVELS.join(', ')}`
			);
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

		// Emit a dedicated space.archived event (consistent with room.archived pattern),
		// carrying the full archived space object so subscribers have complete state.
		daemonHub
			.emit('space.archived', { sessionId: 'global', spaceId: params.id, space })
			.catch((err) => {
				log.warn('Failed to emit space.archived:', err);
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

	// ─── space.listWithTasks ────────────────────────────────────────────────────
	// Returns all spaces with their active (non-completed, non-cancelled) tasks.
	// Used by the Context Panel to show thread-style space list with nested tasks.
	messageHub.onRequest('space.listWithTasks', async (data) => {
		const params = (data ?? {}) as { includeArchived?: boolean };
		const spaces = await spaceManager.listSpaces(params.includeArchived ?? false);

		return spaces.map((space) => ({
			...space,
			tasks: taskRepo
				.listBySpace(space.id)
				.filter((t) => t.status !== 'done' && t.status !== 'cancelled'),
		}));
	});

	// ─── space.overview ─────────────────────────────────────────────────────────
	// Accepts either { id } or { slug } to look up the space.
	messageHub.onRequest('space.overview', async (data) => {
		const params = data as { id?: string; slug?: string };

		if (!params.id && !params.slug) {
			throw new Error('id or slug is required');
		}

		let space;
		if (params.id) {
			space = await spaceManager.getSpace(params.id);
		} else {
			space = await spaceManager.getSpaceBySlug(params.slug!);
		}

		if (!space) {
			throw new Error(`Space not found: ${params.id ?? params.slug}`);
		}

		const tasks = taskRepo.listBySpace(space.id);
		const workflowRuns = workflowRunRepo.listBySpace(space.id);

		const result: SpaceOverviewResult = {
			space,
			tasks,
			workflowRuns,
			sessions: space.sessionIds,
		};

		return result;
	});
}
