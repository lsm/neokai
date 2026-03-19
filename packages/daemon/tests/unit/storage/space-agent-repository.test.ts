/**
 * SpaceAgentRepository Unit Tests
 *
 * Tests for CRUD operations, JSON serialization, batch lookup, deletion protection,
 * and the DB-level name uniqueness check.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository';
import {
	createSpaceAgentSchema,
	insertSpace,
	insertWorkflow,
	insertWorkflowStep,
} from '../helpers/space-agent-schema';

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
			expect(agent.description).toBe('');
			expect(agent.tools).toEqual([]);
			expect(agent.systemPrompt).toBe('');
			expect(agent.role).toBe('worker');
			expect(agent.model).toBeUndefined();
			expect(agent.provider).toBeUndefined();
			expect(agent.config).toBeUndefined();
			expect(agent.createdAt).toBeGreaterThan(0);
			expect(agent.updatedAt).toBeGreaterThan(0);
		});

		it('creates an agent with all optional fields', () => {
			const agent = repo.create({
				spaceId: 'space-1',
				name: 'Reviewer',
				description: 'Reviews PRs',
				model: 'claude-opus-4-6',
				provider: 'anthropic',
				tools: ['Read', 'Write'],
				systemPrompt: 'You are a reviewer',
				role: 'reviewer',
				config: { maxRounds: 3 },
			});

			expect(agent.name).toBe('Reviewer');
			expect(agent.description).toBe('Reviews PRs');
			expect(agent.model).toBe('claude-opus-4-6');
			expect(agent.provider).toBe('anthropic');
			expect(agent.tools).toEqual(['Read', 'Write']);
			expect(agent.systemPrompt).toBe('You are a reviewer');
			expect(agent.role).toBe('reviewer');
			expect(agent.config).toEqual({ maxRounds: 3 });
		});

		it('serializes tools as JSON', () => {
			repo.create({ spaceId: 'space-1', name: 'Agent', tools: ['Bash', 'Grep', 'Glob'] });
			const raw = db.prepare(`SELECT tools FROM space_agents WHERE name = 'Agent'`).get() as {
				tools: string;
			};
			expect(raw.tools).toBe('["Bash","Grep","Glob"]');
		});

		it('serializes config as JSON', () => {
			repo.create({ spaceId: 'space-1', name: 'Agent', config: { key: 'value', num: 42 } });
			const raw = db.prepare(`SELECT config FROM space_agents WHERE name = 'Agent'`).get() as {
				config: string;
			};
			expect(JSON.parse(raw.config)).toEqual({ key: 'value', num: 42 });
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
			const agent = repo.create({ spaceId: 'space-1', name: 'Original', role: 'worker' });

			const updated = repo.update(agent.id, {
				name: 'Renamed',
				role: 'orchestrator',
				tools: ['Bash'],
			});

			expect(updated?.name).toBe('Renamed');
			expect(updated?.role).toBe('orchestrator');
			expect(updated?.tools).toEqual(['Bash']);
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

		it('sets config to null', () => {
			const agent = repo.create({ spaceId: 'space-1', name: 'Agent', config: { k: 'v' } });
			const updated = repo.update(agent.id, { config: null });
			expect(updated?.config).toBeUndefined();
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
		it('returns not-referenced when no steps reference the agent', () => {
			const agent = repo.create({ spaceId: 'space-1', name: 'Agent' });
			const result = repo.isAgentReferenced(agent.id);
			expect(result.referenced).toBe(false);
			expect(result.workflowNames).toEqual([]);
		});

		it('returns referenced with workflow names when steps use the agent', () => {
			const agent = repo.create({ spaceId: 'space-1', name: 'Agent' });
			insertWorkflow(db, 'wf-1', 'space-1', 'Deploy Workflow');
			insertWorkflowStep(db, 'step-1', 'wf-1', agent.id);

			const result = repo.isAgentReferenced(agent.id);
			expect(result.referenced).toBe(true);
			expect(result.workflowNames).toContain('Deploy Workflow');
		});

		it('returns unique workflow names even with multiple steps from same workflow', () => {
			const agent = repo.create({ spaceId: 'space-1', name: 'Agent' });
			insertWorkflow(db, 'wf-2', 'space-1', 'CI Workflow');
			insertWorkflowStep(db, 'step-a', 'wf-2', agent.id);
			insertWorkflowStep(db, 'step-b', 'wf-2', agent.id);

			const result = repo.isAgentReferenced(agent.id);
			expect(result.workflowNames).toHaveLength(1);
			expect(result.workflowNames[0]).toBe('CI Workflow');
		});
	});
});
