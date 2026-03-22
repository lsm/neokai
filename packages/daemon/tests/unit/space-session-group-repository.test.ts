/**
 * Unit Tests for SpaceSessionGroupRepository (Updated Schema)
 *
 * Covers all new fields and operations introduced in migration 40:
 *   - taskId on groups
 *   - Freeform role strings on members
 *   - agentId and status on members
 *   - getGroupsByTask() query
 *   - updateMemberStatus() transitions
 *   - Idempotent addMember()
 *   - rowToGroup / rowToMember field mapping
 *   - Backward compatibility with old 'worker'/'leader' roles
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SpaceRepository } from '../../src/storage/repositories/space-repository';
import { SpaceSessionGroupRepository } from '../../src/storage/repositories/space-session-group-repository';
import { createSpaceTables } from './helpers/space-test-db';

describe('SpaceSessionGroupRepository — updated schema', () => {
	let db: Database;
	let spaceRepo: SpaceRepository;
	let repo: SpaceSessionGroupRepository;
	let spaceId: string;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceTables(db as any);
		spaceRepo = new SpaceRepository(db as any);
		repo = new SpaceSessionGroupRepository(db as any);

		const space = spaceRepo.createSpace({ workspacePath: '/workspace/test', name: 'Test Space' });
		spaceId = space.id;
	});

	afterEach(() => {
		db.close();
	});

	// ─── createGroup with taskId ────────────────────────────────────────────────

	describe('createGroup() with taskId', () => {
		it('stores and returns taskId when provided', () => {
			const group = repo.createGroup({ spaceId, name: 'Task Group', taskId: 'task-abc' });

			expect(group.taskId).toBe('task-abc');
		});

		it('returns undefined taskId when not provided', () => {
			const group = repo.createGroup({ spaceId, name: 'No Task Group' });

			expect(group.taskId).toBeUndefined();
		});

		it('creates multiple groups with different taskIds', () => {
			const g1 = repo.createGroup({ spaceId, name: 'G1', taskId: 'task-1' });
			const g2 = repo.createGroup({ spaceId, name: 'G2', taskId: 'task-2' });

			expect(g1.taskId).toBe('task-1');
			expect(g2.taskId).toBe('task-2');
		});

		it('defaults status to active when not provided', () => {
			const group = repo.createGroup({ spaceId, name: 'G', taskId: 'task-x' });

			expect(group.status).toBe('active');
		});

		it('accepts explicit status on creation', () => {
			const group = repo.createGroup({
				spaceId,
				name: 'Completed Group',
				taskId: 'task-y',
				status: 'completed',
			});

			expect(group.status).toBe('completed');
			expect(group.taskId).toBe('task-y');
		});
	});

	// ─── addMember with freeform role, agentId, status ─────────────────────────

	describe('addMember() with freeform role, agentId, and status', () => {
		it('accepts freeform role strings (not just worker/leader)', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });

			const freeformRoles = [
				'coder',
				'reviewer',
				'security-auditor',
				'backend-engineer',
				'qa-tester',
				'architect',
			];

			for (const role of freeformRoles) {
				const member = repo.addMember(group.id, `session-${role}`, { role });
				expect(member.role).toBe(role);
			}
		});

		it('stores agentId when provided', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const member = repo.addMember(group.id, 'session-1', {
				role: 'coder',
				agentId: 'agent-42',
			});

			expect(member.agentId).toBe('agent-42');
		});

		it('stores undefined agentId when not provided', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const member = repo.addMember(group.id, 'session-1', { role: 'coder' });

			expect(member.agentId).toBeUndefined();
		});

		it('stores explicit status when provided', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });

			const completedMember = repo.addMember(group.id, 'session-1', {
				role: 'coder',
				status: 'completed',
			});
			expect(completedMember.status).toBe('completed');

			const failedMember = repo.addMember(group.id, 'session-2', {
				role: 'reviewer',
				status: 'failed',
			});
			expect(failedMember.status).toBe('failed');
		});

		it('defaults status to active when not provided', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const member = repo.addMember(group.id, 'session-1', { role: 'worker' });

			expect(member.status).toBe('active');
		});

		it('stores all three new fields together', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const member = repo.addMember(group.id, 'session-1', {
				role: 'security-auditor',
				agentId: 'agent-sec-7',
				status: 'active',
				orderIndex: 2,
			});

			expect(member.role).toBe('security-auditor');
			expect(member.agentId).toBe('agent-sec-7');
			expect(member.status).toBe('active');
			expect(member.orderIndex).toBe(2);
		});

		it('persists member fields and is retrievable via getGroup', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', {
				role: 'backend-engineer',
				agentId: 'agent-be',
				status: 'active',
			});

			const found = repo.getGroup(group.id);
			expect(found).not.toBeNull();
			expect(found!.members).toHaveLength(1);
			expect(found!.members[0].role).toBe('backend-engineer');
			expect(found!.members[0].agentId).toBe('agent-be');
			expect(found!.members[0].status).toBe('active');
		});
	});

	// ─── updateMemberStatus transitions ────────────────────────────────────────

	describe('updateMemberStatus() for all valid transitions', () => {
		it('transitions active → completed', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const member = repo.addMember(group.id, 'session-1', { role: 'coder' });
			expect(member.status).toBe('active');

			const updated = repo.updateMemberStatus(member.id, 'completed');
			expect(updated).not.toBeNull();
			expect(updated!.status).toBe('completed');
		});

		it('transitions active → failed', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const member = repo.addMember(group.id, 'session-1', { role: 'worker' });

			const updated = repo.updateMemberStatus(member.id, 'failed');
			expect(updated!.status).toBe('failed');
		});

		it('transitions completed → active (re-activation)', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const member = repo.addMember(group.id, 'session-1', {
				role: 'coder',
				status: 'completed',
			});

			const updated = repo.updateMemberStatus(member.id, 'active');
			expect(updated!.status).toBe('active');
		});

		it('transitions failed → active (retry)', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const member = repo.addMember(group.id, 'session-1', {
				role: 'coder',
				status: 'failed',
			});

			const updated = repo.updateMemberStatus(member.id, 'active');
			expect(updated!.status).toBe('active');
		});

		it('transitions failed → completed', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const member = repo.addMember(group.id, 'session-1', {
				role: 'reviewer',
				status: 'failed',
			});

			const updated = repo.updateMemberStatus(member.id, 'completed');
			expect(updated!.status).toBe('completed');
		});

		it('does not modify role, agentId, or orderIndex during status transition', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const member = repo.addMember(group.id, 'session-1', {
				role: 'security-auditor',
				agentId: 'agent-7',
				orderIndex: 3,
			});

			const updated = repo.updateMemberStatus(member.id, 'completed');
			expect(updated!.role).toBe('security-auditor');
			expect(updated!.agentId).toBe('agent-7');
			expect(updated!.orderIndex).toBe(3);
		});

		it('returns null for a non-existent member ID', () => {
			const result = repo.updateMemberStatus('nonexistent-id', 'completed');
			expect(result).toBeNull();
		});

		it('touches group updated_at on status transition', async () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const member = repo.addMember(group.id, 'session-1', { role: 'coder' });
			const before = repo.getGroup(group.id)!.updatedAt;

			await new Promise((r) => setTimeout(r, 5));
			repo.updateMemberStatus(member.id, 'completed');

			const after = repo.getGroup(group.id)!.updatedAt;
			expect(after).toBeGreaterThan(before);
		});
	});

	// ─── getGroupsByTask ────────────────────────────────────────────────────────

	describe('getGroupsByTask() using task_id column', () => {
		it('returns only groups matching the given taskId', () => {
			repo.createGroup({ spaceId, name: 'G1', taskId: 'task-1' });
			repo.createGroup({ spaceId, name: 'G2', taskId: 'task-2' });
			repo.createGroup({ spaceId, name: 'G3' }); // no taskId

			const results = repo.getGroupsByTask(spaceId, 'task-1');
			expect(results).toHaveLength(1);
			expect(results[0].taskId).toBe('task-1');
			expect(results[0].name).toBe('G1');
		});

		it('returns multiple groups when several share the same taskId', () => {
			repo.createGroup({ spaceId, name: 'Phase 1', taskId: 'task-multi' });
			repo.createGroup({ spaceId, name: 'Phase 2', taskId: 'task-multi' });
			repo.createGroup({ spaceId, name: 'Other', taskId: 'task-other' });

			const results = repo.getGroupsByTask(spaceId, 'task-multi');
			expect(results).toHaveLength(2);
			expect(results.every((g) => g.taskId === 'task-multi')).toBe(true);
		});

		it('returns empty array when no groups match the taskId', () => {
			repo.createGroup({ spaceId, name: 'G1', taskId: 'task-1' });
			expect(repo.getGroupsByTask(spaceId, 'task-99')).toHaveLength(0);
		});

		it('returns empty array when spaceId does not match', () => {
			repo.createGroup({ spaceId, name: 'G1', taskId: 'task-1' });
			expect(repo.getGroupsByTask('wrong-space', 'task-1')).toHaveLength(0);
		});

		it('returns groups ordered by created_at ascending', async () => {
			repo.createGroup({ spaceId, name: 'First', taskId: 'task-ord' });
			await new Promise((r) => setTimeout(r, 2));
			repo.createGroup({ spaceId, name: 'Second', taskId: 'task-ord' });

			const results = repo.getGroupsByTask(spaceId, 'task-ord');
			expect(results[0].name).toBe('First');
			expect(results[1].name).toBe('Second');
		});

		it('includes members in returned groups', () => {
			const group = repo.createGroup({ spaceId, name: 'G', taskId: 'task-m' });
			repo.addMember(group.id, 'session-1', { role: 'coder', agentId: 'agent-1' });

			const results = repo.getGroupsByTask(spaceId, 'task-m');
			expect(results[0].members).toHaveLength(1);
			expect(results[0].members[0].role).toBe('coder');
			expect(results[0].members[0].agentId).toBe('agent-1');
		});
	});

	// ─── Idempotent addMember ────────────────────────────────────────────────────

	describe('idempotent addMember() — updates existing member', () => {
		it('updates role when session is re-added', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', { role: 'worker' });
			const updated = repo.addMember(group.id, 'session-1', { role: 'reviewer' });

			expect(updated.role).toBe('reviewer');
		});

		it('updates agentId when session is re-added', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', { role: 'coder' });
			const updated = repo.addMember(group.id, 'session-1', {
				role: 'coder',
				agentId: 'agent-new',
			});

			expect(updated.agentId).toBe('agent-new');
		});

		it('updates status when session is re-added', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', { role: 'coder', status: 'active' });
			const updated = repo.addMember(group.id, 'session-1', {
				role: 'coder',
				status: 'completed',
			});

			expect(updated.status).toBe('completed');
		});

		it('updates all three fields (role, agentId, status) simultaneously', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', { role: 'worker' });
			const updated = repo.addMember(group.id, 'session-1', {
				role: 'reviewer',
				agentId: 'agent-5',
				status: 'completed',
				orderIndex: 1,
			});

			expect(updated.role).toBe('reviewer');
			expect(updated.agentId).toBe('agent-5');
			expect(updated.status).toBe('completed');
			expect(updated.orderIndex).toBe(1);
		});

		it('does not create a duplicate member record on re-add', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', { role: 'worker' });
			repo.addMember(group.id, 'session-1', { role: 'reviewer' });

			const found = repo.getGroup(group.id);
			expect(found!.members).toHaveLength(1);
		});

		it('re-add for different sessions creates separate records', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', { role: 'coder' });
			repo.addMember(group.id, 'session-2', { role: 'reviewer' });

			const found = repo.getGroup(group.id);
			expect(found!.members).toHaveLength(2);
		});

		it('touches group updated_at on idempotent re-add', async () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', { role: 'worker' });
			const before = repo.getGroup(group.id)!.updatedAt;

			await new Promise((r) => setTimeout(r, 5));
			repo.addMember(group.id, 'session-1', { role: 'reviewer' });

			const after = repo.getGroup(group.id)!.updatedAt;
			expect(after).toBeGreaterThan(before);
		});
	});

	// ─── rowToGroup / rowToMember field mapping ─────────────────────────────────

	describe('rowToGroup() and rowToMember() — field mapping', () => {
		it('rowToGroup maps all new fields: taskId, status', () => {
			const created = repo.createGroup({
				spaceId,
				name: 'Mapping Test',
				description: 'Desc',
				taskId: 'task-map',
				status: 'completed',
				workflowRunId: 'run-1',
				currentStepId: 'step-1',
			});

			const fetched = repo.getGroup(created.id);
			expect(fetched).not.toBeNull();
			expect(fetched!.id).toBe(created.id);
			expect(fetched!.spaceId).toBe(spaceId);
			expect(fetched!.name).toBe('Mapping Test');
			expect(fetched!.description).toBe('Desc');
			expect(fetched!.taskId).toBe('task-map');
			expect(fetched!.status).toBe('completed');
			expect(fetched!.workflowRunId).toBe('run-1');
			expect(fetched!.currentStepId).toBe('step-1');
			expect(fetched!.createdAt).toBeGreaterThan(0);
			expect(fetched!.updatedAt).toBeGreaterThan(0);
			expect(Array.isArray(fetched!.members)).toBe(true);
		});

		it('rowToGroup maps null taskId to undefined', () => {
			const group = repo.createGroup({ spaceId, name: 'No Task' });
			const fetched = repo.getGroup(group.id);
			expect(fetched!.taskId).toBeUndefined();
		});

		it('rowToGroup maps null status to active default', () => {
			// Status should always be set, but test the default mapping
			const group = repo.createGroup({ spaceId, name: 'G' });
			const fetched = repo.getGroup(group.id);
			expect(fetched!.status).toBe('active');
		});

		it('rowToMember maps all new fields: agentId, status', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const added = repo.addMember(group.id, 'session-map', {
				role: 'backend-engineer',
				agentId: 'agent-be-9',
				status: 'active',
				orderIndex: 5,
			});

			expect(added.id).toBeDefined();
			expect(added.groupId).toBe(group.id);
			expect(added.sessionId).toBe('session-map');
			expect(added.role).toBe('backend-engineer');
			expect(added.agentId).toBe('agent-be-9');
			expect(added.status).toBe('active');
			expect(added.orderIndex).toBe(5);
			expect(added.createdAt).toBeGreaterThan(0);
		});

		it('rowToMember maps null agentId to undefined', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const member = repo.addMember(group.id, 'session-1', { role: 'coder' });

			expect(member.agentId).toBeUndefined();
		});

		it('rowToMember maps null status to active default', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const member = repo.addMember(group.id, 'session-1', { role: 'coder' });

			// Default status when not provided
			expect(member.status).toBe('active');
		});

		it('getMember by ID maps all fields correctly', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const added = repo.addMember(group.id, 'session-x', {
				role: 'qa-tester',
				agentId: 'agent-qa',
				status: 'failed',
			});

			const fetched = repo.getMember(added.id);
			expect(fetched).not.toBeNull();
			expect(fetched!.id).toBe(added.id);
			expect(fetched!.role).toBe('qa-tester');
			expect(fetched!.agentId).toBe('agent-qa');
			expect(fetched!.status).toBe('failed');
		});
	});

	// ─── Backward compatibility with old 'worker'/'leader' roles ───────────────

	describe('backward compatibility — old-style worker/leader roles', () => {
		it("accepts 'worker' as a valid freeform role", () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const member = repo.addMember(group.id, 'session-1', { role: 'worker' });

			expect(member.role).toBe('worker');
		});

		it("accepts 'leader' as a valid freeform role", () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const member = repo.addMember(group.id, 'session-1', { role: 'leader' });

			expect(member.role).toBe('leader');
		});

		it('old-style roles coexist with new freeform roles in the same group', () => {
			const group = repo.createGroup({ spaceId, name: 'Mixed Group' });
			repo.addMember(group.id, 'session-worker', { role: 'worker' });
			repo.addMember(group.id, 'session-leader', { role: 'leader' });
			repo.addMember(group.id, 'session-coder', { role: 'coder' });
			repo.addMember(group.id, 'session-reviewer', { role: 'security-auditor' });

			const found = repo.getGroup(group.id);
			expect(found!.members).toHaveLength(4);

			const roles = found!.members.map((m) => m.role);
			expect(roles).toContain('worker');
			expect(roles).toContain('leader');
			expect(roles).toContain('coder');
			expect(roles).toContain('security-auditor');
		});

		it('old-style worker role supports agentId (new field)', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const member = repo.addMember(group.id, 'session-1', {
				role: 'worker',
				agentId: 'agent-legacy',
			});

			expect(member.role).toBe('worker');
			expect(member.agentId).toBe('agent-legacy');
		});

		it('old-style leader role supports status transitions (new field)', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const member = repo.addMember(group.id, 'session-1', { role: 'leader' });

			const updated = repo.updateMemberStatus(member.id, 'completed');
			expect(updated!.role).toBe('leader');
			expect(updated!.status).toBe('completed');
		});

		it('getGroupsByTask works for groups containing old-style role members', () => {
			const group = repo.createGroup({
				spaceId,
				name: 'Legacy Group',
				taskId: 'task-legacy',
			});
			repo.addMember(group.id, 'session-worker', { role: 'worker' });
			repo.addMember(group.id, 'session-leader', { role: 'leader' });

			const results = repo.getGroupsByTask(spaceId, 'task-legacy');
			expect(results).toHaveLength(1);
			expect(results[0].members).toHaveLength(2);
			expect(results[0].members.map((m) => m.role)).toContain('worker');
			expect(results[0].members.map((m) => m.role)).toContain('leader');
		});
	});

	// ─── Edge cases: null agentId ────────────────────────────────────────────────

	describe('edge cases — null agentId handling', () => {
		it('updateMember can clear agentId by passing null', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', { role: 'coder', agentId: 'agent-1' });

			const updated = repo.updateMember(group.id, 'session-1', { agentId: null });
			expect(updated!.agentId).toBeUndefined();
		});

		it('getMember returns undefined agentId for null DB value', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const member = repo.addMember(group.id, 'session-1', { role: 'coder' });

			const fetched = repo.getMember(member.id);
			expect(fetched!.agentId).toBeUndefined();
		});

		it('re-adding with agentId: undefined clears a previously set agentId', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			// First add with agentId
			repo.addMember(group.id, 'session-1', { role: 'coder', agentId: 'agent-1' });
			// Re-add with agentId: undefined — addMember always writes agentId ?? null, so it clears
			const updated = repo.addMember(group.id, 'session-1', {
				role: 'reviewer',
				agentId: undefined,
			});

			// agentId: undefined → stored as null → mapped back as undefined
			expect(updated.agentId).toBeUndefined();
		});
	});

	// ─── updateMember — comprehensive ───────────────────────────────────────────

	describe('updateMember() — comprehensive field updates', () => {
		it('updates status without touching role or agentId', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', { role: 'coder', agentId: 'agent-1' });

			const updated = repo.updateMember(group.id, 'session-1', { status: 'completed' });
			expect(updated!.status).toBe('completed');
			expect(updated!.role).toBe('coder');
			expect(updated!.agentId).toBe('agent-1');
		});

		it('updates role to a new freeform string', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', { role: 'worker' });

			const updated = repo.updateMember(group.id, 'session-1', {
				role: 'security-auditor',
			});
			expect(updated!.role).toBe('security-auditor');
		});

		it('returns null for non-existent session', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			expect(
				repo.updateMember(group.id, 'nonexistent-session', { status: 'completed' })
			).toBeNull();
		});

		it('returns current state when no fields provided', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', {
				role: 'coder',
				agentId: 'agent-1',
				status: 'active',
			});

			const result = repo.updateMember(group.id, 'session-1', {});
			expect(result).not.toBeNull();
			expect(result!.role).toBe('coder');
			expect(result!.agentId).toBe('agent-1');
			expect(result!.status).toBe('active');
		});
	});

	// ─── updateGroup with new fields ────────────────────────────────────────────

	describe('updateGroup() with new taskId and status fields', () => {
		it('updates taskId to a new value', () => {
			const group = repo.createGroup({ spaceId, name: 'G', taskId: 'task-old' });
			const updated = repo.updateGroup(group.id, { taskId: 'task-new' });
			expect(updated!.taskId).toBe('task-new');
		});

		it('clears taskId by passing null', () => {
			const group = repo.createGroup({ spaceId, name: 'G', taskId: 'task-1' });
			const updated = repo.updateGroup(group.id, { taskId: null });
			expect(updated!.taskId).toBeUndefined();
		});

		it('updates group status to completed', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			expect(group.status).toBe('active');

			const updated = repo.updateGroup(group.id, { status: 'completed' });
			expect(updated!.status).toBe('completed');
		});

		it('updates group status to failed', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const updated = repo.updateGroup(group.id, { status: 'failed' });
			expect(updated!.status).toBe('failed');
		});

		it('updates both taskId and status together', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const updated = repo.updateGroup(group.id, { taskId: 'task-done', status: 'completed' });
			expect(updated!.taskId).toBe('task-done');
			expect(updated!.status).toBe('completed');
		});

		it('preserves existing fields when only updating taskId', () => {
			const group = repo.createGroup({
				spaceId,
				name: 'My Group',
				description: 'Desc',
				taskId: 'task-orig',
				status: 'active',
			});
			const updated = repo.updateGroup(group.id, { taskId: 'task-new' });
			expect(updated!.name).toBe('My Group');
			expect(updated!.description).toBe('Desc');
			expect(updated!.status).toBe('active');
			expect(updated!.taskId).toBe('task-new');
		});

		it('returns null for unknown group ID', () => {
			expect(repo.updateGroup('nonexistent', { status: 'completed' })).toBeNull();
		});
	});

	// ─── deleteGroup ────────────────────────────────────────────────────────────

	describe('deleteGroup()', () => {
		it('deletes an existing group and returns true', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			expect(repo.deleteGroup(group.id)).toBe(true);
			expect(repo.getGroup(group.id)).toBeNull();
		});

		it('returns false for a non-existent group ID', () => {
			expect(repo.deleteGroup('nonexistent')).toBe(false);
		});

		it('cascades deletion to all members', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const m1 = repo.addMember(group.id, 'session-1', { role: 'coder' });
			const m2 = repo.addMember(group.id, 'session-2', { role: 'reviewer' });

			repo.deleteGroup(group.id);

			expect(repo.getMember(m1.id)).toBeNull();
			expect(repo.getMember(m2.id)).toBeNull();
		});

		it('does not affect other groups in the same space', () => {
			const g1 = repo.createGroup({ spaceId, name: 'G1' });
			const g2 = repo.createGroup({ spaceId, name: 'G2' });

			repo.deleteGroup(g1.id);

			expect(repo.getGroup(g1.id)).toBeNull();
			expect(repo.getGroup(g2.id)).not.toBeNull();
		});
	});

	// ─── getGroupsBySpace ────────────────────────────────────────────────────────

	describe('getGroupsBySpace()', () => {
		it('returns all groups for a space including new fields', () => {
			repo.createGroup({ spaceId, name: 'G1', taskId: 'task-1', status: 'active' });
			repo.createGroup({ spaceId, name: 'G2', taskId: 'task-2', status: 'completed' });

			const groups = repo.getGroupsBySpace(spaceId);
			expect(groups).toHaveLength(2);

			const names = groups.map((g) => g.name);
			expect(names).toContain('G1');
			expect(names).toContain('G2');
		});

		it('returns groups with their taskId and status populated', () => {
			repo.createGroup({ spaceId, name: 'G', taskId: 'task-x', status: 'failed' });
			const groups = repo.getGroupsBySpace(spaceId);
			expect(groups[0].taskId).toBe('task-x');
			expect(groups[0].status).toBe('failed');
		});

		it('includes members (with agentId and status) in each group', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', {
				role: 'coder',
				agentId: 'agent-42',
				status: 'completed',
			});

			const groups = repo.getGroupsBySpace(spaceId);
			expect(groups[0].members).toHaveLength(1);
			expect(groups[0].members[0].agentId).toBe('agent-42');
			expect(groups[0].members[0].status).toBe('completed');
		});

		it('returns empty array for an unknown space', () => {
			repo.createGroup({ spaceId, name: 'G' });
			expect(repo.getGroupsBySpace('unknown-space')).toHaveLength(0);
		});

		it('orders groups by created_at ascending', async () => {
			repo.createGroup({ spaceId, name: 'First' });
			await new Promise((r) => setTimeout(r, 2));
			repo.createGroup({ spaceId, name: 'Second' });

			const groups = repo.getGroupsBySpace(spaceId);
			expect(groups[0].name).toBe('First');
			expect(groups[1].name).toBe('Second');
		});
	});

	// ─── removeMember ───────────────────────────────────────────────────────────

	describe('removeMember()', () => {
		it('removes an existing member and returns true', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', { role: 'coder' });

			const removed = repo.removeMember(group.id, 'session-1');
			expect(removed).toBe(true);
			expect(repo.getGroup(group.id)!.members).toHaveLength(0);
		});

		it('returns false when member does not exist', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			expect(repo.removeMember(group.id, 'nonexistent-session')).toBe(false);
		});

		it('touches group updated_at on successful removal', async () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', { role: 'coder' });
			const before = repo.getGroup(group.id)!.updatedAt;

			await new Promise((r) => setTimeout(r, 5));
			repo.removeMember(group.id, 'session-1');

			const after = repo.getGroup(group.id)!.updatedAt;
			expect(after).toBeGreaterThan(before);
		});

		it('does not touch group updated_at when member does not exist', async () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			const before = repo.getGroup(group.id)!.updatedAt;

			await new Promise((r) => setTimeout(r, 5));
			repo.removeMember(group.id, 'nonexistent-session');

			const after = repo.getGroup(group.id)!.updatedAt;
			expect(after).toBe(before);
		});

		it('removes only the target member, leaving others intact', () => {
			const group = repo.createGroup({ spaceId, name: 'G' });
			repo.addMember(group.id, 'session-1', { role: 'coder' });
			repo.addMember(group.id, 'session-2', { role: 'reviewer' });

			repo.removeMember(group.id, 'session-1');

			const found = repo.getGroup(group.id)!;
			expect(found.members).toHaveLength(1);
			expect(found.members[0].sessionId).toBe('session-2');
		});
	});
});
