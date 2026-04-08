/**
 * SpaceAgentRepository Unit Tests
 *
 * Tests for CRUD operations, JSON serialization, batch lookup, deletion protection,
 * and the DB-level name uniqueness check.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import {
	createSpaceAgentSchema,
	insertSpace,
	insertWorkflow,
	insertWorkflowNode,
} from '../../helpers/space-agent-schema';

describe('SpaceAgentRepository', () => {
	let db: Database;
	let repo: SpaceAgentRepository;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceAgentSchema(db);
		insertSpace(db);
		repo = new SpaceAgentRepository(db as any);
	});

	afterEach(() => {
		db.close();
	});

	describe('create', () => {
		it('creates an agent with required fields', () => {
			const agent = repo.create({ spaceId: 'space-1', name: 'Coder' });

			expect(agent.id).toBeDefined();
			expect(agent.spaceId).toBe('space-1');
			expect(agent.name).toBe('Coder');
			expect(agent.description).toBeUndefined();
			expect(agent.systemPrompt).toBeUndefined();
			expect(agent.instructions).toBeNull();
			expect(agent.model).toBeUndefined();
			expect(agent.provider).toBeUndefined();
			expect(agent.createdAt).toBeGreaterThan(0);
			expect(agent.updatedAt).toBeGreaterThan(0);
		});

		it('creates an agent with all optional fields', () => {
			const agent = repo.create({
				spaceId: 'space-1',
				name: 'Planner',
				description: 'Plans tasks',
				model: 'claude-opus-4-6',
				provider: 'anthropic',
				systemPrompt: 'You are a planner',
				instructions: 'Follow these steps...',
			});

			expect(agent.name).toBe('Planner');
			expect(agent.description).toBe('Plans tasks');
			expect(agent.model).toBe('claude-opus-4-6');
			expect(agent.provider).toBe('anthropic');
			expect(agent.systemPrompt).toBe('You are a planner');
			expect(agent.instructions).toBe('Follow these steps...');
		});

		it('stores tools as JSON array', () => {
			repo.create({
				spaceId: 'space-1',
				name: 'Agent',
				tools: ['Bash', 'Read'],
			});
			const raw = db.prepare(`SELECT tools FROM space_agents WHERE name = 'Agent'`).get() as {
				tools: string;
			};
			expect(JSON.parse(raw.tools)).toEqual(['Bash', 'Read']);
		});
	});

	describe('getById', () => {
		it('returns agent by id', () => {
			const created = repo.create({ spaceId: 'space-1', name: 'Agent' });
			const found = repo.getById(created.id);
			expect(found?.id).toBe(created.id);
		});

		it('returns null for unknown id', () => {
			expect(repo.getById('nonexistent')).toBeNull();
		});
	});

	describe('getBySpaceId', () => {
		it('returns all agents for a space in creation order', () => {
			repo.create({ spaceId: 'space-1', name: 'A' });
			repo.create({ spaceId: 'space-1', name: 'B' });
			const agents = repo.getBySpaceId('space-1');
			expect(agents).toHaveLength(2);
			expect(agents[0].name).toBe('A');
			expect(agents[1].name).toBe('B');
		});

		it('returns empty array for space with no agents', () => {
			insertSpace(db, 'space-2');
			expect(repo.getBySpaceId('space-2')).toEqual([]);
		});
	});

	describe('isNameTaken', () => {
		it('returns false when no agent with that name exists', () => {
			expect(repo.isNameTaken('space-1', 'Coder')).toBe(false);
		});

		it('returns true when an agent with that name exists', () => {
			repo.create({ spaceId: 'space-1', name: 'Coder' });
			expect(repo.isNameTaken('space-1', 'Coder')).toBe(true);
		});

		it('is case-insensitive', () => {
			repo.create({ spaceId: 'space-1', name: 'Coder' });
			expect(repo.isNameTaken('space-1', 'CODER')).toBe(true);
			expect(repo.isNameTaken('space-1', 'coder')).toBe(true);
		});

		it('excludes the specified agent id (update scenario)', () => {
			const agent = repo.create({ spaceId: 'space-1', name: 'Coder' });
			// Same name, same id — should not count as taken
			expect(repo.isNameTaken('space-1', 'Coder', agent.id)).toBe(false);
		});

		it('is scoped to the space', () => {
			insertSpace(db, 'space-2');
			repo.create({ spaceId: 'space-1', name: 'Coder' });
			// Name exists in space-1 but not space-2
			expect(repo.isNameTaken('space-2', 'Coder')).toBe(false);
		});
	});

	describe('getAgentsByIds', () => {
		it('returns only the requested agents', () => {
			const a = repo.create({ spaceId: 'space-1', name: 'A' });
			const b = repo.create({ spaceId: 'space-1', name: 'B' });
			repo.create({ spaceId: 'space-1', name: 'C' });

			const result = repo.getAgentsByIds([a.id, b.id]);
			expect(result).toHaveLength(2);
			const names = result.map((r) => r.name).sort();
			expect(names).toEqual(['A', 'B']);
		});

		it('returns empty array for empty ids', () => {
			expect(repo.getAgentsByIds([])).toEqual([]);
		});

		it('skips unknown ids without error', () => {
			const a = repo.create({ spaceId: 'space-1', name: 'A' });
			const result = repo.getAgentsByIds([a.id, 'nonexistent']);
			expect(result).toHaveLength(1);
		});
	});

	describe('update', () => {
		it('updates individual fields', () => {
			const agent = repo.create({ spaceId: 'space-1', name: 'Original' });

			const updated = repo.update(agent.id, {
				name: 'Renamed',
				systemPrompt: 'Updated prompt',
			});

			expect(updated?.name).toBe('Renamed');
			expect(updated?.systemPrompt).toBe('Updated prompt');
		});

		it('sets model and provider to null', () => {
			const agent = repo.create({
				spaceId: 'space-1',
				name: 'Agent',
				model: 'opus',
				provider: 'anthropic',
			});

			const updated = repo.update(agent.id, { model: null, provider: null });
			expect(updated?.model).toBeUndefined();
			expect(updated?.provider).toBeUndefined();
		});

		it('clears description and systemPrompt to undefined via null (NOT NULL roundtrip)', () => {
			// Verifies the NOT NULL '' → null → undefined coercion chain introduced in the P0 fix:
			//   update stores '' for null inputs (avoids NOT NULL violation)
			//   rowToAgent maps '' back to undefined (consistent with SpaceAgent optional fields)
			const agent = repo.create({
				spaceId: 'space-1',
				name: 'Agent',
				description: 'Some description',
				systemPrompt: 'Some prompt',
			});
			expect(agent.description).toBe('Some description');
			expect(agent.systemPrompt).toBe('Some prompt');

			const updated = repo.update(agent.id, { description: null, systemPrompt: null });
			expect(updated?.description).toBeUndefined();
			expect(updated?.systemPrompt).toBeUndefined();
		});

		it('sets and clears instructions', () => {
			const agent = repo.create({
				spaceId: 'space-1',
				name: 'Agent',
				instructions: 'Do step 1, then step 2.',
			});
			expect(agent.instructions).toBe('Do step 1, then step 2.');

			const updated = repo.update(agent.id, { instructions: null });
			expect(updated?.instructions).toBeNull();
		});

		it('returns null for unknown id', () => {
			expect(repo.update('nonexistent', { name: 'X' })).toBeNull();
		});

		it('no-op update returns unchanged agent', () => {
			const agent = repo.create({ spaceId: 'space-1', name: 'Agent' });
			const updated = repo.update(agent.id, {});
			expect(updated?.name).toBe('Agent');
		});
	});

	describe('delete', () => {
		it('removes the agent', () => {
			const agent = repo.create({ spaceId: 'space-1', name: 'Agent' });
			repo.delete(agent.id);
			expect(repo.getById(agent.id)).toBeNull();
		});

		it('is idempotent for unknown ids', () => {
			expect(() => repo.delete('nonexistent')).not.toThrow();
		});
	});

	describe('isAgentReferenced', () => {
		it('returns not-referenced when no nodes reference the agent', () => {
			const agent = repo.create({ spaceId: 'space-1', name: 'Agent' });
			const result = repo.isAgentReferenced(agent.id);
			expect(result.referenced).toBe(false);
			expect(result.workflowNames).toEqual([]);
		});

		it('returns referenced with workflow names when nodes use the agent', () => {
			const agent = repo.create({ spaceId: 'space-1', name: 'Agent' });
			insertWorkflow(db, 'wf-1', 'space-1', 'Deploy Workflow');
			insertWorkflowNode(db, 'node-1', 'wf-1', agent.id);

			const result = repo.isAgentReferenced(agent.id);
			expect(result.referenced).toBe(true);
			expect(result.workflowNames).toContain('Deploy Workflow');
		});

		it('returns unique workflow names even with multiple nodes from same workflow', () => {
			const agent = repo.create({ spaceId: 'space-1', name: 'Agent' });
			insertWorkflow(db, 'wf-2', 'space-1', 'CI Workflow');
			insertWorkflowNode(db, 'node-a', 'wf-2', agent.id);
			insertWorkflowNode(db, 'node-b', 'wf-2', agent.id);

			const result = repo.isAgentReferenced(agent.id);
			expect(result.workflowNames).toHaveLength(1);
			expect(result.workflowNames[0]).toBe('CI Workflow');
		});
	});
});
