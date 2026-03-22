/**
 * Space Session Group RPC Handlers
 *
 * Admin-oriented RPC handlers for session group management:
 * - space.sessionGroup.list         - List all groups for a space
 * - space.sessionGroup.create       - Create a group with optional initial members (test/admin)
 * - space.sessionGroup.updateMember - Force-update a member's status (admin / stuck recovery)
 * - space.sessionGroup.delete       - Delete a stuck / orphaned group
 */

import type { MessageHub } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { SpaceSessionGroupRepository } from '../../storage/repositories/space-session-group-repository';
import type { SpaceManager } from '../space/managers/space-manager';
import { Logger } from '../logger';

const log = new Logger('space-session-group-handlers');

export function setupSpaceSessionGroupHandlers(
	messageHub: MessageHub,
	daemonHub: DaemonHub,
	spaceManager: SpaceManager,
	sessionGroupRepo: SpaceSessionGroupRepository
): void {
	// ─── space.sessionGroup.list ─────────────────────────────────────────────────
	messageHub.onRequest('space.sessionGroup.list', async (data) => {
		const params = data as { spaceId: string };

		if (!params.spaceId) {
			throw new Error('spaceId is required');
		}

		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) {
			throw new Error(`Space not found: ${params.spaceId}`);
		}

		const groups = sessionGroupRepo.getGroupsBySpace(params.spaceId);
		return { groups };
	});

	// ─── space.sessionGroup.create ───────────────────────────────────────────────
	// Admin / test-infrastructure operation: create a session group with optional members.
	// Used by E2E tests to inject session group state without running real agents.
	// Not available in production to prevent creation of orphaned groups with phantom sessions.
	messageHub.onRequest('space.sessionGroup.create', async (data) => {
		if (process.env.NODE_ENV === 'production') {
			throw new Error('space.sessionGroup.create is not available in production');
		}

		const params = data as {
			spaceId: string;
			name: string;
			taskId?: string;
			members?: Array<{
				sessionId: string;
				role: string;
				agentId?: string;
				status?: 'active' | 'completed' | 'failed';
			}>;
		};

		if (!params.spaceId) throw new Error('spaceId is required');
		if (!params.name) throw new Error('name is required');

		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) {
			throw new Error(`Space not found: ${params.spaceId}`);
		}

		const group = sessionGroupRepo.createGroup({
			spaceId: params.spaceId,
			name: params.name,
			taskId: params.taskId,
		});

		await daemonHub
			.emit('spaceSessionGroup.created', {
				sessionId: `space:${params.spaceId}`,
				spaceId: params.spaceId,
				taskId: params.taskId ?? '',
				group,
			})
			.catch((err) => {
				log.warn('Failed to emit spaceSessionGroup.created:', err);
			});

		for (let i = 0; i < (params.members ?? []).length; i++) {
			const m = params.members![i];
			const member = sessionGroupRepo.addMember(group.id, m.sessionId, {
				role: m.role,
				agentId: m.agentId,
				status: m.status ?? 'active',
				orderIndex: i,
			});

			await daemonHub
				.emit('spaceSessionGroup.memberAdded', {
					sessionId: `space:${params.spaceId}`,
					spaceId: params.spaceId,
					groupId: group.id,
					member,
				})
				.catch((err) => {
					log.warn('Failed to emit spaceSessionGroup.memberAdded:', err);
				});
		}

		const fullGroup = sessionGroupRepo.getGroup(group.id)!;
		return { group: fullGroup };
	});

	// ─── space.sessionGroup.updateMember ─────────────────────────────────────────
	// Admin operation: force-complete or mark failed a stuck member session.
	messageHub.onRequest('space.sessionGroup.updateMember', async (data) => {
		const params = data as {
			spaceId: string;
			groupId: string;
			sessionId: string;
			status: 'active' | 'completed' | 'failed';
			role?: string;
		};

		if (!params.spaceId) throw new Error('spaceId is required');
		if (!params.groupId) throw new Error('groupId is required');
		if (!params.sessionId) throw new Error('sessionId is required');
		if (!params.status) throw new Error('status is required');
		if (!(['active', 'completed', 'failed'] as const).includes(params.status)) {
			throw new Error('Invalid status: must be one of active, completed, failed');
		}

		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) {
			throw new Error(`Space not found: ${params.spaceId}`);
		}

		const group = sessionGroupRepo.getGroup(params.groupId);
		if (!group) {
			throw new Error(`Session group not found: ${params.groupId}`);
		}
		if (group.spaceId !== params.spaceId) {
			throw new Error(`Session group ${params.groupId} does not belong to space ${params.spaceId}`);
		}

		const updateParams: { status: 'active' | 'completed' | 'failed'; role?: string } = {
			status: params.status,
		};
		if (params.role !== undefined) {
			updateParams.role = params.role;
		}

		const member = sessionGroupRepo.updateMember(params.groupId, params.sessionId, updateParams);
		if (!member) {
			throw new Error(`Member session ${params.sessionId} not found in group ${params.groupId}`);
		}

		await daemonHub
			.emit('spaceSessionGroup.memberUpdated', {
				sessionId: `space:${params.spaceId}`,
				spaceId: params.spaceId,
				groupId: params.groupId,
				memberId: member.id,
				member,
			})
			.catch((err) => {
				log.warn('Failed to emit spaceSessionGroup.memberUpdated:', err);
			});

		return { member };
	});

	// ─── space.sessionGroup.delete ───────────────────────────────────────────────
	// Admin operation: delete a stuck or orphaned session group.
	messageHub.onRequest('space.sessionGroup.delete', async (data) => {
		const params = data as { spaceId: string; groupId: string };

		if (!params.spaceId) throw new Error('spaceId is required');
		if (!params.groupId) throw new Error('groupId is required');

		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) {
			throw new Error(`Space not found: ${params.spaceId}`);
		}

		const group = sessionGroupRepo.getGroup(params.groupId);
		if (!group) {
			throw new Error(`Session group not found: ${params.groupId}`);
		}
		if (group.spaceId !== params.spaceId) {
			throw new Error(`Session group ${params.groupId} does not belong to space ${params.spaceId}`);
		}

		const deleted = sessionGroupRepo.deleteGroup(params.groupId);

		if (deleted) {
			await daemonHub
				.emit('spaceSessionGroup.deleted', {
					sessionId: `space:${params.spaceId}`,
					spaceId: params.spaceId,
					groupId: params.groupId,
				})
				.catch((err) => {
					log.warn('Failed to emit spaceSessionGroup.deleted:', err);
				});
		}

		return { deleted };
	});
}
