/**
 * seedPresetAgents Unit Tests
 *
 * Verifies that the four preset SpaceAgent records are created with correct
 * defaults (role, tools, description) and that seeding is idempotent (errors
 * on name collision are captured but do not abort remaining seeds).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository';
import { SpaceAgentManager } from '../../../src/lib/space/managers/space-agent-manager';
import { seedPresetAgents } from '../../../src/lib/space/agents/seed-agents';
import { setModelsCache } from '../../../src/lib/model-service';
import { createSpaceAgentSchema, insertSpace } from '../helpers/space-agent-schema';

describe('seedPresetAgents', () => {
	let db: Database;
	let manager: SpaceAgentManager;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceAgentSchema(db);
		insertSpace(db);
		const repo = new SpaceAgentRepository(db as any);
		manager = new SpaceAgentManager(repo);
		setModelsCache(new Map()); // skip model validation
	});

	afterEach(() => {
		db.close();
		setModelsCache(new Map());
	});

	it('creates exactly four preset agents', async () => {
		const result = await seedPresetAgents('space-1', manager);

		expect(result.seeded).toHaveLength(4);
		expect(result.errors).toHaveLength(0);
	});

	it('creates agents with correct roles', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);

		const roles = seeded.map((a) => a.role).sort();
		expect(roles).toEqual(['coder', 'general', 'planner', 'reviewer']);
	});

	it('creates agents with correct names', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);

		const names = seeded.map((a) => a.name).sort();
		expect(names).toEqual(['Coder', 'General', 'Planner', 'Reviewer']);
	});

	it('sets tools on each preset agent', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);

		for (const agent of seeded) {
			expect(Array.isArray(agent.tools)).toBe(true);
			expect((agent.tools?.length ?? 0) > 0).toBe(true);
		}
	});

	it('reviewer has restricted tools (no Write or Edit)', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const reviewer = seeded.find((a) => a.role === 'reviewer');

		expect(reviewer).toBeDefined();
		expect(reviewer?.tools).not.toContain('Write');
		expect(reviewer?.tools).not.toContain('Edit');
		expect(reviewer?.tools).toContain('Read');
		expect(reviewer?.tools).toContain('Bash');
	});

	it('coder has full coding toolset', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const coder = seeded.find((a) => a.role === 'coder');

		expect(coder?.tools).toContain('Read');
		expect(coder?.tools).toContain('Write');
		expect(coder?.tools).toContain('Edit');
		expect(coder?.tools).toContain('Bash');
	});

	it('sets descriptions on all preset agents', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);

		for (const agent of seeded) {
			expect(typeof agent.description).toBe('string');
			expect((agent.description?.length ?? 0) > 0).toBe(true);
		}
	});

	it('assigns agents to the correct spaceId', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);

		for (const agent of seeded) {
			expect(agent.spaceId).toBe('space-1');
		}
	});

	it('is idempotent — records errors but seeds remaining agents on name collision', async () => {
		// Seed once
		await seedPresetAgents('space-1', manager);

		// Seed again — all four names are now taken
		const second = await seedPresetAgents('space-1', manager);

		expect(second.seeded).toHaveLength(0);
		expect(second.errors).toHaveLength(4);
		for (const err of second.errors) {
			expect(err.error).toMatch(/already exists/i);
		}
	});

	it('seeds different spaces independently', async () => {
		insertSpace(db, 'space-2');

		const r1 = await seedPresetAgents('space-1', manager);
		const r2 = await seedPresetAgents('space-2', manager);

		expect(r1.seeded).toHaveLength(4);
		expect(r2.seeded).toHaveLength(4);
		expect(r1.errors).toHaveLength(0);
		expect(r2.errors).toHaveLength(0);

		// Each space has its own independent set
		for (const a of r1.seeded) expect(a.spaceId).toBe('space-1');
		for (const a of r2.seeded) expect(a.spaceId).toBe('space-2');
	});

	it('partial collision — seeds succeed for non-conflicting names', async () => {
		// Pre-create just the 'Coder' agent
		await manager.create({ spaceId: 'space-1', name: 'Coder', role: 'coder' });

		const result = await seedPresetAgents('space-1', manager);

		// Coder fails, others succeed
		expect(result.seeded).toHaveLength(3);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].name).toBe('Coder');
	});

	it('Planner preset has injectWorkflowContext: true', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const planner = seeded.find((a) => a.role === 'planner');

		expect(planner).toBeDefined();
		expect(planner?.injectWorkflowContext).toBe(true);
	});

	it('non-planner presets do not have injectWorkflowContext set', async () => {
		const { seeded } = await seedPresetAgents('space-1', manager);
		const nonPlanners = seeded.filter((a) => a.role !== 'planner');

		for (const agent of nonPlanners) {
			expect(agent.injectWorkflowContext).toBeUndefined();
		}
	});
});
