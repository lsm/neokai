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
			expect(group.taskId).toBeUndefined();
			expect(group.members).toEqual([]);
			expect(group.createdAt).toBeGreaterThan(0);
		});

		it('creates a group with description', () => {
			const group = repo.createGroup({ spaceId, name: 'Group B', description: 'Desc' });
			expect(group.description).toBe('Desc');
		});

		it('creates a group with taskId', () => {
			const group = repo.createGroup({ spaceId, name: 'Group C', taskId: 'task-42' });
			expect(group.taskId).toBe('task-42');
		});
	});

	describe('getGroup', () => {
		it('returns group with members', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', { role: 'worker' });

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
		it('returns groups by task_id column', () => {
			repo.createGroup({ spaceId, name: 'Group for task-1', taskId: 'task-1' });
			repo.createGroup({ spaceId, name: 'Group for task-2', taskId: 'task-2' });
			repo.createGroup({ spaceId, name: 'other-group' });

			const groups = repo.getGroupsByTask(spaceId, 'task-1');
			expect(groups).toHaveLength(1);
			expect(groups[0].taskId).toBe('task-1');
		});

		it('returns empty array when no groups have matching task_id', () => {
			repo.createGroup({ spaceId, name: 'some-group' });
			expect(repo.getGroupsByTask(spaceId, 'task-99')).toHaveLength(0);
		});
	});

	describe('updateGroup', () => {
		it('updates name and description', () => {
			const group = repo.createGroup({ spaceId, name: 'Old' });
			const updated = repo.updateGroup(group.id, { name: 'New', description: 'Updated' });
			expect(updated!.name).toBe('New');
			expect(updated!.description).toBe('Updated');
		});

		it('updates taskId', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const updated = repo.updateGroup(group.id, { taskId: 'task-99' });
			expect(updated!.taskId).toBe('task-99');
		});

		it('clears taskId with null', () => {
			const group = repo.createGroup({ spaceId, name: 'G', taskId: 'task-1' });
			const updated = repo.updateGroup(group.id, { taskId: null });
			expect(updated!.taskId).toBeUndefined();
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
		it('adds a member with default status', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const member = repo.addMember(group.id, 'session-1', { role: 'leader' });

			expect(member.groupId).toBe(group.id);
			expect(member.sessionId).toBe('session-1');
			expect(member.role).toBe('leader');
			expect(member.status).toBe('active');
			expect(member.agentId).toBeUndefined();
			expect(member.orderIndex).toBe(0);
		});

		it('adds a member with agentId and custom status', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const member = repo.addMember(group.id, 'session-1', {
				role: 'coder',
				agentId: 'agent-42',
				status: 'completed',
			});

			expect(member.role).toBe('coder');
			expect(member.agentId).toBe('agent-42');
			expect(member.status).toBe('completed');
		});

		it('accepts freeform role strings', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const member = repo.addMember(group.id, 'session-1', { role: 'security-auditor' });
			expect(member.role).toBe('security-auditor');
		});

		it('is idempotent — updates existing member', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', { role: 'worker' });
			const updated = repo.addMember(group.id, 'session-1', {
				role: 'reviewer',
				orderIndex: 1,
				agentId: 'agent-5',
				status: 'completed',
			});

			expect(updated.role).toBe('reviewer');
			expect(updated.orderIndex).toBe(1);
			expect(updated.agentId).toBe('agent-5');
			expect(updated.status).toBe('completed');

			const found = repo.getGroup(group.id);
			expect(found!.members).toHaveLength(1);
		});

		it('multiple members are ordered by order_index', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-2', { role: 'worker', orderIndex: 1 });
			repo.addMember(group.id, 'session-1', { role: 'coder', orderIndex: 0 });

			const found = repo.getGroup(group.id);
			expect(found!.members[0].sessionId).toBe('session-1');
			expect(found!.members[1].sessionId).toBe('session-2');
		});
	});

	describe('updateMember', () => {
		it('updates status without touching other fields', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', { role: 'coder', agentId: 'agent-1' });

			const updated = repo.updateMember(group.id, 'session-1', { status: 'completed' });
			expect(updated).not.toBeNull();
			expect(updated!.status).toBe('completed');
			expect(updated!.role).toBe('coder');
			expect(updated!.agentId).toBe('agent-1');
		});

		it('updates multiple fields at once', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', { role: 'worker' });

			const updated = repo.updateMember(group.id, 'session-1', {
				role: 'reviewer',
				status: 'failed',
				agentId: 'agent-99',
			});
			expect(updated!.role).toBe('reviewer');
			expect(updated!.status).toBe('failed');
			expect(updated!.agentId).toBe('agent-99');
		});

		it('clears agentId with null', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', { role: 'coder', agentId: 'agent-1' });

			const updated = repo.updateMember(group.id, 'session-1', { agentId: null });
			expect(updated!.agentId).toBeUndefined();
		});

		it('returns null for non-existent member', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			expect(
				repo.updateMember(group.id, 'nonexistent-session', { status: 'completed' })
			).toBeNull();
		});

		it('touches group updated_at', async () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', { role: 'coder' });
			const before = repo.getGroup(group.id)!.updatedAt;

			await new Promise((r) => setTimeout(r, 5));
			repo.updateMember(group.id, 'session-1', { status: 'completed' });

			const after = repo.getGroup(group.id)!.updatedAt;
			expect(after).toBeGreaterThanOrEqual(before);
		});
	});

	describe('removeMember', () => {
		it('removes a member from a group', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', { role: 'worker' });

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
