/**
 * SpaceAgentManager Unit Tests
 *
 * Tests for business-logic validation: name uniqueness (DB-level), tool validation,
 * provider-aware model validation, model clearing, and deletion protection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository';
import { SpaceAgentManager } from '../../../src/lib/space/managers/space-agent-manager';
import { setModelsCache } from '../../../src/lib/model-service';
import { KNOWN_TOOLS } from '@neokai/shared';
import type { ModelInfo } from '@neokai/shared';
import {
	createSpaceAgentSchema,
	insertSpace,
	insertWorkflow,
	insertWorkflowStep,
} from '../helpers/space-agent-schema';

function makeModelInfo(id: string, alias: string, provider = 'anthropic'): ModelInfo {
	return {
		id,
		alias,
		name: id,
		family: 'claude' as const,
		provider,
		contextWindow: 200000,
		description: '',
		releaseDate: '2025-01-01',
		available: true,
	};
}

describe('SpaceAgentManager', () => {
	let db: Database;
	let repo: SpaceAgentRepository;
	let manager: SpaceAgentManager;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceAgentSchema(db);
		insertSpace(db);
		repo = new SpaceAgentRepository(db as any);
		manager = new SpaceAgentManager(repo);
		// Clear models cache so model validation is skipped by default
		setModelsCache(new Map());
	});

	afterEach(() => {
		db.close();
		setModelsCache(new Map());
	});

	// -------------------------------------------------------------------------
	// create
	// -------------------------------------------------------------------------

	describe('create', () => {
		it('creates an agent with minimal params', async () => {
			const result = await manager.create({ spaceId: 'space-1', name: 'Coder' });
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error('expected ok');
			expect(result.value.name).toBe('Coder');
			expect(result.value.role).toBe('worker');
		});

		it('creates agents with different roles', async () => {
			const roles = ['worker', 'reviewer', 'orchestrator'] as const;
			for (const role of roles) {
				const result = await manager.create({ spaceId: 'space-1', name: `Agent-${role}`, role });
				expect(result.ok).toBe(true);
				if (result.ok) expect(result.value.role).toBe(role);
			}
		});

		it('rejects duplicate name (case-insensitive) within same space', async () => {
			await manager.create({ spaceId: 'space-1', name: 'Coder' });
			const dup = await manager.create({ spaceId: 'space-1', name: 'coder' });
			expect(dup.ok).toBe(false);
			if (!dup.ok) expect(dup.error).toMatch(/already exists/i);
		});

		it('allows same name in different spaces', async () => {
			insertSpace(db, 'space-2');
			await manager.create({ spaceId: 'space-1', name: 'Coder' });
			const result = await manager.create({ spaceId: 'space-2', name: 'Coder' });
			expect(result.ok).toBe(true);
		});

		it('rejects unknown tools', async () => {
			const result = await manager.create({
				spaceId: 'space-1',
				name: 'Agent',
				tools: ['Read', 'FlyToDaMoon'],
			});
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toMatch(/FlyToDaMoon/);
				expect(result.details).toBeDefined();
			}
		});

		it('accepts all KNOWN_TOOLS', async () => {
			const result = await manager.create({
				spaceId: 'space-1',
				name: 'AllTools',
				tools: [...KNOWN_TOOLS],
			});
			expect(result.ok).toBe(true);
		});

		it('skips model validation when models cache is empty', async () => {
			const result = await manager.create({
				spaceId: 'space-1',
				name: 'Agent',
				model: 'some-future-model',
			});
			expect(result.ok).toBe(true);
		});

		it('validates model when models cache is populated (no provider)', async () => {
			const cache = new Map([['global', [makeModelInfo('claude-sonnet-4-6', 'sonnet')]]]);
			setModelsCache(cache);

			const bad = await manager.create({ spaceId: 'space-1', name: 'Agent', model: 'gpt-4' });
			expect(bad.ok).toBe(false);
			if (!bad.ok) expect(bad.error).toMatch(/Unrecognized model/);

			const good = await manager.create({
				spaceId: 'space-1',
				name: 'Agent2',
				model: 'sonnet',
			});
			expect(good.ok).toBe(true);
		});

		it('uses provider-aware validation when provider is supplied', async () => {
			const cache = new Map([
				[
					'global',
					[
						makeModelInfo('claude-sonnet-4-6', 'sonnet', 'anthropic'),
						makeModelInfo('glm-4-flash', 'glm-4-flash', 'glm'),
					],
				],
			]);
			setModelsCache(cache);

			// GLM model with Anthropic provider should fail
			const bad = await manager.create({
				spaceId: 'space-1',
				name: 'Agent',
				model: 'glm-4-flash',
				provider: 'anthropic',
			});
			expect(bad.ok).toBe(false);
			if (!bad.ok) expect(bad.error).toMatch(/anthropic/);

			// GLM model with GLM provider should pass
			const good = await manager.create({
				spaceId: 'space-1',
				name: 'Agent2',
				model: 'glm-4-flash',
				provider: 'glm',
			});
			expect(good.ok).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// update
	// -------------------------------------------------------------------------

	describe('update', () => {
		it('updates fields', async () => {
			const created = await manager.create({ spaceId: 'space-1', name: 'Agent' });
			if (!created.ok) throw new Error('create failed');

			const result = await manager.update(created.value.id, {
				name: 'Renamed',
				description: 'New desc',
				tools: ['Bash'],
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.value.name).toBe('Renamed');
				expect(result.value.description).toBe('New desc');
				expect(result.value.tools).toEqual(['Bash']);
			}
		});

		it('allows keeping the same name on update', async () => {
			const created = await manager.create({ spaceId: 'space-1', name: 'Agent' });
			if (!created.ok) throw new Error('create failed');
			const result = await manager.update(created.value.id, { name: 'Agent' });
			expect(result.ok).toBe(true);
		});

		it('rejects renaming to an existing name', async () => {
			await manager.create({ spaceId: 'space-1', name: 'Agent A' });
			const b = await manager.create({ spaceId: 'space-1', name: 'Agent B' });
			if (!b.ok) throw new Error('create failed');

			const result = await manager.update(b.value.id, { name: 'Agent A' });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toMatch(/already exists/i);
		});

		it('rejects unknown tools on update', async () => {
			const created = await manager.create({ spaceId: 'space-1', name: 'Agent' });
			if (!created.ok) throw new Error('create failed');

			const result = await manager.update(created.value.id, { tools: ['BadTool'] });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toMatch(/BadTool/);
		});

		it('accepts model: null (clearing model) without validation error', async () => {
			const created = await manager.create({
				spaceId: 'space-1',
				name: 'Agent',
				model: 'opus',
				provider: 'anthropic',
			});
			if (!created.ok) throw new Error('create failed');

			// Clearing model to null should always succeed
			const result = await manager.update(created.value.id, { model: null });
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.value.model).toBeUndefined();
		});

		it('uses existing agent provider for model validation when provider not in update params', async () => {
			const cache = new Map([
				['global', [makeModelInfo('claude-sonnet-4-6', 'sonnet', 'anthropic')]],
			]);
			setModelsCache(cache);

			// Create agent with anthropic provider
			const created = await manager.create({
				spaceId: 'space-1',
				name: 'Agent',
				model: 'sonnet',
				provider: 'anthropic',
			});
			if (!created.ok) throw new Error('create failed');

			// Updating model without specifying provider should use existing provider (anthropic)
			const bad = await manager.update(created.value.id, { model: 'gpt-4' });
			expect(bad.ok).toBe(false);
			if (!bad.ok) expect(bad.error).toMatch(/anthropic/);
		});

		it('returns error for unknown agent id', async () => {
			const result = await manager.update('no-such-id', { name: 'X' });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toMatch(/not found/i);
		});
	});

	// -------------------------------------------------------------------------
	// delete
	// -------------------------------------------------------------------------

	describe('delete', () => {
		it('deletes an unreferenced agent', async () => {
			const created = await manager.create({ spaceId: 'space-1', name: 'Agent' });
			if (!created.ok) throw new Error('create failed');

			const result = manager.delete(created.value.id);
			expect(result.ok).toBe(true);
			expect(manager.getById(created.value.id)).toBeNull();
		});

		it('blocks deletion when agent is referenced by workflow steps', async () => {
			const created = await manager.create({ spaceId: 'space-1', name: 'Agent' });
			if (!created.ok) throw new Error('create failed');

			insertWorkflow(db, 'wf-1', 'space-1', 'Release Workflow');
			insertWorkflowStep(db, 'step-1', 'wf-1', created.value.id);

			const result = manager.delete(created.value.id);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error).toMatch(/referenced/i);
				expect(result.details).toBeDefined();
				expect(result.details?.some((d) => d.includes('Release Workflow'))).toBe(true);
			}
		});

		it('returns error for unknown agent id', () => {
			const result = manager.delete('no-such-id');
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toMatch(/not found/i);
		});
	});

	// -------------------------------------------------------------------------
	// listBySpaceId / getAgentsByIds
	// -------------------------------------------------------------------------

	describe('listBySpaceId', () => {
		it('returns all agents for a space', async () => {
			await manager.create({ spaceId: 'space-1', name: 'A' });
			await manager.create({ spaceId: 'space-1', name: 'B' });
			const agents = manager.listBySpaceId('space-1');
			expect(agents).toHaveLength(2);
		});
	});

	describe('getAgentsByIds', () => {
		it('returns only requested agents', async () => {
			const a = await manager.create({ spaceId: 'space-1', name: 'A' });
			await manager.create({ spaceId: 'space-1', name: 'B' });
			if (!a.ok) throw new Error('create failed');

			const result = manager.getAgentsByIds([a.value.id]);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('A');
		});
	});
});
