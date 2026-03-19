/**
 * SpaceSessionGroupRepository Tests
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { SpaceSessionGroupRepository } from '../../../src/storage/repositories/space-session-group-repository';
import { createSpaceTables } from '../helpers/space-test-db';

describe('SpaceSessionGroupRepository', () => {
	let db: Database;
	let spaceRepo: SpaceRepository;
	let repo: SpaceSessionGroupRepository;
	let spaceId: string;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceTables(db);
		spaceRepo = new SpaceRepository(db as any);
		repo = new SpaceSessionGroupRepository(db as any);

		const space = spaceRepo.createSpace({ workspacePath: '/workspace/test', name: 'Test' });
		spaceId = space.id;
	});

	afterEach(() => {
		db.close();
	});

	describe('createGroup', () => {
		it('creates a group with required fields', () => {
			const group = repo.createGroup({ spaceId, name: 'Group A' });

			expect(group.id).toBeDefined();
			expect(group.spaceId).toBe(spaceId);
			expect(group.name).toBe('Group A');
			expect(group.description).toBeUndefined();
			expect(group.members).toEqual([]);
			expect(group.createdAt).toBeGreaterThan(0);
		});

		it('creates a group with description', () => {
			const group = repo.createGroup({ spaceId, name: 'Group B', description: 'Desc' });
			expect(group.description).toBe('Desc');
		});
	});

	describe('getGroup', () => {
		it('returns group with members', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', 'worker');

			const found = repo.getGroup(group.id);
			expect(found).not.toBeNull();
			expect(found!.members).toHaveLength(1);
			expect(found!.members[0].sessionId).toBe('session-1');
			expect(found!.members[0].role).toBe('worker');
		});

		it('returns null for unknown ID', () => {
			expect(repo.getGroup('nonexistent')).toBeNull();
		});
	});

	describe('getGroupsBySpace', () => {
		it('returns all groups for a space', () => {
			repo.createGroup({ spaceId, name: 'G1' });
			repo.createGroup({ spaceId, name: 'G2' });

			const groups = repo.getGroupsBySpace(spaceId);
			expect(groups).toHaveLength(2);
		});

		it('returns empty array for unknown space', () => {
			expect(repo.getGroupsBySpace('unknown')).toHaveLength(0);
		});
	});

	describe('getGroupsByTask', () => {
		it('returns groups named task:{taskId}', () => {
			repo.createGroup({ spaceId, name: 'task:task-1' });
			repo.createGroup({ spaceId, name: 'task:task-2' });
			repo.createGroup({ spaceId, name: 'other-group' });

			const groups = repo.getGroupsByTask(spaceId, 'task-1');
			expect(groups).toHaveLength(1);
			expect(groups[0].name).toBe('task:task-1');
		});
	});

	describe('updateGroup', () => {
		it('updates name and description', () => {
			const group = repo.createGroup({ spaceId, name: 'Old' });
			const updated = repo.updateGroup(group.id, { name: 'New', description: 'Updated' });
			expect(updated!.name).toBe('New');
			expect(updated!.description).toBe('Updated');
		});

		it('returns null for unknown ID', () => {
			expect(repo.updateGroup('nonexistent', { name: 'X' })).toBeNull();
		});
	});

	describe('deleteGroup', () => {
		it('deletes a group', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			expect(repo.deleteGroup(group.id)).toBe(true);
			expect(repo.getGroup(group.id)).toBeNull();
		});

		it('returns false for unknown ID', () => {
			expect(repo.deleteGroup('nonexistent')).toBe(false);
		});
	});

	describe('addMember', () => {
		it('adds a member to a group', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const member = repo.addMember(group.id, 'session-1', 'leader', 0);

			expect(member.groupId).toBe(group.id);
			expect(member.sessionId).toBe('session-1');
			expect(member.role).toBe('leader');
			expect(member.orderIndex).toBe(0);
		});

		it('is idempotent — updates existing member', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', 'worker');
			const updated = repo.addMember(group.id, 'session-1', 'leader', 1);

			expect(updated.role).toBe('leader');
			expect(updated.orderIndex).toBe(1);

			const found = repo.getGroup(group.id);
			expect(found!.members).toHaveLength(1);
		});

		it('multiple members are ordered by order_index', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-2', 'worker', 1);
			repo.addMember(group.id, 'session-1', 'leader', 0);

			const found = repo.getGroup(group.id);
			expect(found!.members[0].sessionId).toBe('session-1');
			expect(found!.members[1].sessionId).toBe('session-2');
		});
	});

	describe('removeMember', () => {
		it('removes a member from a group', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', 'worker');

			const removed = repo.removeMember(group.id, 'session-1');
			expect(removed).toBe(true);
			expect(repo.getGroup(group.id)!.members).toHaveLength(0);
		});

		it('returns false when member does not exist', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			expect(repo.removeMember(group.id, 'nonexistent')).toBe(false);
		});
	});
});
