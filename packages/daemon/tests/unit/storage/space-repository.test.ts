/**
 * SpaceRepository Tests
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { createSpaceTables } from '../helpers/space-test-db';

describe('SpaceRepository', () => {
	let db: Database;
	let repo: SpaceRepository;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceTables(db);
		repo = new SpaceRepository(db as any);
	});

	afterEach(() => {
		db.close();
	});

	describe('createSpace', () => {
		it('creates a space with required fields', () => {
			const space = repo.createSpace({
				workspacePath: '/workspace/project',
				name: 'My Project',
			});

			expect(space.id).toBeDefined();
			expect(space.workspacePath).toBe('/workspace/project');
			expect(space.name).toBe('My Project');
			expect(space.description).toBe('');
			expect(space.backgroundContext).toBe('');
			expect(space.instructions).toBe('');
			expect(space.status).toBe('active');
			expect(space.sessionIds).toEqual([]);
			expect(space.config).toBeUndefined();
			expect(space.createdAt).toBeGreaterThan(0);
			expect(space.updatedAt).toBeGreaterThan(0);
		});

		it('creates a space with all optional fields', () => {
			const space = repo.createSpace({
				workspacePath: '/workspace/project',
				name: 'My Project',
				description: 'A description',
				backgroundContext: 'Some context',
				instructions: 'Do this',
				defaultModel: 'claude-opus',
				allowedModels: ['claude-opus', 'claude-sonnet'],
				config: { maxConcurrentTasks: 3 },
			});

			expect(space.description).toBe('A description');
			expect(space.backgroundContext).toBe('Some context');
			expect(space.instructions).toBe('Do this');
			expect(space.defaultModel).toBe('claude-opus');
			expect(space.allowedModels).toEqual(['claude-opus', 'claude-sonnet']);
			expect(space.config).toEqual({ maxConcurrentTasks: 3 });
		});

		it('enforces unique workspace_path', () => {
			repo.createSpace({ workspacePath: '/workspace/project', name: 'A' });
			expect(() => {
				repo.createSpace({ workspacePath: '/workspace/project', name: 'B' });
			}).toThrow();
		});
	});

	describe('getSpace', () => {
		it('returns space by ID', () => {
			const created = repo.createSpace({ workspacePath: '/workspace/a', name: 'A' });
			const found = repo.getSpace(created.id);
			expect(found).not.toBeNull();
			expect(found!.id).toBe(created.id);
		});

		it('returns null for unknown ID', () => {
			expect(repo.getSpace('nonexistent')).toBeNull();
		});
	});

	describe('getSpaceByPath', () => {
		it('returns space by workspace path', () => {
			const created = repo.createSpace({ workspacePath: '/workspace/a', name: 'A' });
			const found = repo.getSpaceByPath('/workspace/a');
			expect(found).not.toBeNull();
			expect(found!.id).toBe(created.id);
		});

		it('returns null for unknown path', () => {
			expect(repo.getSpaceByPath('/does/not/exist')).toBeNull();
		});
	});

	describe('listSpaces', () => {
		it('lists active spaces by default', () => {
			repo.createSpace({ workspacePath: '/workspace/a', name: 'A' });
			const b = repo.createSpace({ workspacePath: '/workspace/b', name: 'B' });
			repo.archiveSpace(b.id);

			const spaces = repo.listSpaces();
			expect(spaces).toHaveLength(1);
			expect(spaces[0].name).toBe('A');
		});

		it('includes archived spaces when requested', () => {
			repo.createSpace({ workspacePath: '/workspace/a', name: 'A' });
			const b = repo.createSpace({ workspacePath: '/workspace/b', name: 'B' });
			repo.archiveSpace(b.id);

			const spaces = repo.listSpaces(true);
			expect(spaces).toHaveLength(2);
		});
	});

	describe('updateSpace', () => {
		it('updates name and description', () => {
			const space = repo.createSpace({ workspacePath: '/workspace/a', name: 'A' });
			const updated = repo.updateSpace(space.id, { name: 'A Updated', description: 'New desc' });

			expect(updated).not.toBeNull();
			expect(updated!.name).toBe('A Updated');
			expect(updated!.description).toBe('New desc');
		});

		it('clears defaultModel when set to null', () => {
			const space = repo.createSpace({
				workspacePath: '/workspace/a',
				name: 'A',
				defaultModel: 'claude-opus',
			});
			const updated = repo.updateSpace(space.id, { defaultModel: null });
			expect(updated!.defaultModel).toBeUndefined();
		});

		it('returns null for unknown ID', () => {
			expect(repo.updateSpace('nonexistent', { name: 'X' })).toBeNull();
		});
	});

	describe('archiveSpace', () => {
		it('sets status to archived', () => {
			const space = repo.createSpace({ workspacePath: '/workspace/a', name: 'A' });
			const archived = repo.archiveSpace(space.id);
			expect(archived!.status).toBe('archived');
		});
	});

	describe('addSessionToSpace / removeSessionFromSpace', () => {
		it('adds and removes sessions idempotently', () => {
			const space = repo.createSpace({ workspacePath: '/workspace/a', name: 'A' });

			// Add
			const withSession = repo.addSessionToSpace(space.id, 'session-1');
			expect(withSession!.sessionIds).toContain('session-1');

			// Add again (idempotent)
			const again = repo.addSessionToSpace(space.id, 'session-1');
			expect(again!.sessionIds).toHaveLength(1);

			// Remove
			const without = repo.removeSessionFromSpace(space.id, 'session-1');
			expect(without!.sessionIds).not.toContain('session-1');

			// Remove again (idempotent)
			const noOp = repo.removeSessionFromSpace(space.id, 'session-1');
			expect(noOp!.sessionIds).toHaveLength(0);
		});

		it('returns null for unknown space', () => {
			expect(repo.addSessionToSpace('nonexistent', 's1')).toBeNull();
			expect(repo.removeSessionFromSpace('nonexistent', 's1')).toBeNull();
		});
	});

	describe('deleteSpace', () => {
		it('deletes a space', () => {
			const space = repo.createSpace({ workspacePath: '/workspace/a', name: 'A' });
			expect(repo.deleteSpace(space.id)).toBe(true);
			expect(repo.getSpace(space.id)).toBeNull();
		});

		it('returns false for unknown ID', () => {
			expect(repo.deleteSpace('nonexistent')).toBe(false);
		});
	});
});
