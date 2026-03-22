/**
 * Space Session Group RPC Handlers
 *
 * Admin-oriented RPC handlers for session group management:
 * - space.sessionGroup.list         - List all groups for a space
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

		daemonHub
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
		return { deleted };
	});
}
