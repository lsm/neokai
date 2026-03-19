/**
 * SpaceAgentManager Unit Tests
 *
 * Tests for business-logic validation: name uniqueness, tool validation,
 * model validation, and deletion protection.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository';
import { SpaceAgentManager } from '../../../src/lib/space/managers/space-agent-manager';
import { setModelsCache } from '../../../src/lib/model-service';
import { KNOWN_TOOLS } from '@neokai/shared';
import type { ModelInfo } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Minimal schema for tests
// ---------------------------------------------------------------------------
function createSchema(db: Database): void {
	db.exec(`PRAGMA foreign_keys = ON`);
	db.exec(`
		CREATE TABLE spaces (
			id TEXT PRIMARY KEY,
			workspace_path TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			background_context TEXT NOT NULL DEFAULT '',
			instructions TEXT NOT NULL DEFAULT '',
			default_model TEXT,
			allowed_models TEXT NOT NULL DEFAULT '[]',
			session_ids TEXT NOT NULL DEFAULT '[]',
			status TEXT NOT NULL DEFAULT 'active',
			config TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);

	db.exec(`
		CREATE TABLE space_agents (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			model TEXT,
			provider TEXT,
			tools TEXT NOT NULL DEFAULT '[]',
			system_prompt TEXT NOT NULL DEFAULT '',
			role TEXT NOT NULL DEFAULT 'worker'
				CHECK(role IN ('worker', 'reviewer', 'orchestrator')),
			config TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);

	db.exec(`
		CREATE TABLE space_workflows (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			config TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
		)
	`);

	db.exec(`
		CREATE TABLE space_workflow_steps (
			id TEXT PRIMARY KEY,
			workflow_id TEXT NOT NULL,
			name TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			agent_id TEXT,
			order_index INTEGER NOT NULL,
			config TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE
		)
	`);
}

function insertSpace(db: Database, id = 'space-1'): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
	).run(id, `/workspace/${id}`, `Space ${id}`, now, now);
}

function insertWorkflow(db: Database, id: string, spaceId: string, name: string): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
	).run(id, spaceId, name, now, now);
}

function insertStep(db: Database, id: string, workflowId: string, agentId: string): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO space_workflow_steps (id, workflow_id, name, agent_id, order_index, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
	).run(id, workflowId, `Step ${id}`, agentId, 0, now, now);
}

function makeModelInfo(id: string, alias: string): ModelInfo {
	return {
		id,
		alias,
		name: id,
		family: 'claude' as const,
		provider: 'anthropic',
		contextWindow: 200000,
		description: '',
		releaseDate: '2025-01-01',
		available: true,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SpaceAgentManager', () => {
	let db: Database;
	let repo: SpaceAgentRepository;
	let manager: SpaceAgentManager;

	beforeEach(() => {
		db = new Database(':memory:');
		createSchema(db);
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
		it('creates an agent with minimal params', () => {
			const result = manager.create({ spaceId: 'space-1', name: 'Coder' });
			expect(result.ok).toBe(true);
			if (!result.ok) throw new Error('expected ok');
			expect(result.value.name).toBe('Coder');
			expect(result.value.role).toBe('worker');
		});

		it('creates agents with different roles', () => {
			const roles = ['worker', 'reviewer', 'orchestrator'] as const;
			for (const role of roles) {
				const result = manager.create({ spaceId: 'space-1', name: `Agent-${role}`, role });
				expect(result.ok).toBe(true);
				if (result.ok) expect(result.value.role).toBe(role);
			}
		});

		it('rejects duplicate name (case-insensitive) within same space', () => {
			manager.create({ spaceId: 'space-1', name: 'Coder' });
			const dup = manager.create({ spaceId: 'space-1', name: 'coder' });
			expect(dup.ok).toBe(false);
			if (!dup.ok) expect(dup.error).toMatch(/already exists/i);
		});

		it('allows same name in different spaces', () => {
			insertSpace(db, 'space-2');
			manager.create({ spaceId: 'space-1', name: 'Coder' });
			const result = manager.create({ spaceId: 'space-2', name: 'Coder' });
			expect(result.ok).toBe(true);
		});

		it('rejects unknown tools', () => {
			const result = manager.create({
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

		it('accepts all KNOWN_TOOLS', () => {
			const result = manager.create({
				spaceId: 'space-1',
				name: 'AllTools',
				tools: [...KNOWN_TOOLS],
			});
			expect(result.ok).toBe(true);
		});

		it('skips model validation when models cache is empty', () => {
			const result = manager.create({
				spaceId: 'space-1',
				name: 'Agent',
				model: 'some-future-model',
			});
			expect(result.ok).toBe(true);
		});

		it('validates model when models cache is populated', () => {
			const cache = new Map([['global', [makeModelInfo('claude-sonnet-4-6', 'sonnet')]]]);
			setModelsCache(cache);

			const bad = manager.create({ spaceId: 'space-1', name: 'Agent', model: 'gpt-4' });
			expect(bad.ok).toBe(false);
			if (!bad.ok) expect(bad.error).toMatch(/Unrecognized model/);

			const good = manager.create({ spaceId: 'space-1', name: 'Agent2', model: 'sonnet' });
			expect(good.ok).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// update
	// -------------------------------------------------------------------------

	describe('update', () => {
		it('updates fields', () => {
			const created = manager.create({ spaceId: 'space-1', name: 'Agent' });
			if (!created.ok) throw new Error('create failed');

			const result = manager.update(created.value.id, {
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

		it('allows keeping the same name on update', () => {
			const created = manager.create({ spaceId: 'space-1', name: 'Agent' });
			if (!created.ok) throw new Error('create failed');
			// Updating to the same name should not trigger uniqueness error
			const result = manager.update(created.value.id, { name: 'Agent' });
			expect(result.ok).toBe(true);
		});

		it('rejects renaming to an existing name', () => {
			manager.create({ spaceId: 'space-1', name: 'Agent A' });
			const b = manager.create({ spaceId: 'space-1', name: 'Agent B' });
			if (!b.ok) throw new Error('create failed');

			const result = manager.update(b.value.id, { name: 'Agent A' });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toMatch(/already exists/i);
		});

		it('rejects unknown tools on update', () => {
			const created = manager.create({ spaceId: 'space-1', name: 'Agent' });
			if (!created.ok) throw new Error('create failed');

			const result = manager.update(created.value.id, { tools: ['BadTool'] });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toMatch(/BadTool/);
		});

		it('returns error for unknown agent id', () => {
			const result = manager.update('no-such-id', { name: 'X' });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toMatch(/not found/i);
		});
	});

	// -------------------------------------------------------------------------
	// delete
	// -------------------------------------------------------------------------

	describe('delete', () => {
		it('deletes an unreferenced agent', () => {
			const created = manager.create({ spaceId: 'space-1', name: 'Agent' });
			if (!created.ok) throw new Error('create failed');

			const result = manager.delete(created.value.id);
			expect(result.ok).toBe(true);
			expect(manager.getById(created.value.id)).toBeNull();
		});

		it('blocks deletion when agent is referenced by workflow steps', () => {
			const created = manager.create({ spaceId: 'space-1', name: 'Agent' });
			if (!created.ok) throw new Error('create failed');

			insertWorkflow(db, 'wf-1', 'space-1', 'Release Workflow');
			insertStep(db, 'step-1', 'wf-1', created.value.id);

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
		it('returns all agents for a space', () => {
			manager.create({ spaceId: 'space-1', name: 'A' });
			manager.create({ spaceId: 'space-1', name: 'B' });
			const agents = manager.listBySpaceId('space-1');
			expect(agents).toHaveLength(2);
		});
	});

	describe('getAgentsByIds', () => {
		it('returns only requested agents', () => {
			const a = manager.create({ spaceId: 'space-1', name: 'A' });
			manager.create({ spaceId: 'space-1', name: 'B' });
			if (!a.ok) throw new Error('create failed');

			const result = manager.getAgentsByIds([a.value.id]);
			expect(result).toHaveLength(1);
			expect(result[0].name).toBe('A');
		});
	});
});
