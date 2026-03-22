/**
 * Space Export/Import RPC Handler Unit Tests
 *
 * Tests for:
 * - spaceExport.agents, spaceExport.workflows, spaceExport.bundle
 * - spaceImport.preview (conflict detection, validation, cross-ref checking)
 * - spaceImport.execute (all conflict resolutions, agent name→UUID mapping, step ID remapping)
 *
 * Uses in-memory SQLite with real repositories and managers so the full
 * business-logic path (including SpaceWorkflowManager validation) is exercised.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { MessageHub, SpaceAgent, SpaceWorkflow } from '@neokai/shared';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository';
import { SpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager';
import type { SpaceAgentLookup } from '../../../src/lib/space/managers/space-workflow-manager';
import type { SpaceManager } from '../../../src/lib/space/managers/space-manager';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import {
	setupSpaceExportImportHandlers,
	type ImportPreviewResult,
	type ImportExecuteResult,
} from '../../../src/lib/rpc-handlers/space-export-import-handlers';
import { exportBundle } from '../../../src/lib/space/export-format';

// ─── DB schema ────────────────────────────────────────────────────────────────

function createSchema(db: Database): void {
	db.exec('PRAGMA foreign_keys = ON');

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
			role TEXT NOT NULL DEFAULT 'coder',
			config TEXT,
			inject_workflow_context INTEGER NOT NULL DEFAULT 0,
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
			start_step_id TEXT,
			config TEXT,
			layout TEXT,
			max_iterations INTEGER,
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

	db.exec(`
		CREATE TABLE space_workflow_transitions (
			id TEXT PRIMARY KEY,
			workflow_id TEXT NOT NULL,
			from_step_id TEXT NOT NULL,
			to_step_id TEXT NOT NULL,
			condition TEXT,
			order_index INTEGER NOT NULL DEFAULT 0,
			is_cyclic INTEGER,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			FOREIGN KEY (workflow_id) REFERENCES space_workflows(id) ON DELETE CASCADE,
			FOREIGN KEY (from_step_id) REFERENCES space_workflow_steps(id) ON DELETE CASCADE,
			FOREIGN KEY (to_step_id) REFERENCES space_workflow_steps(id) ON DELETE CASCADE
		)
	`);
}

function insertSpace(db: Database, id: string, name = `Space ${id}`): void {
	const now = Date.now();
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
	).run(id, `/workspace/${id}`, name, now, now);
}

// ─── Mock helpers ─────────────────────────────────────────────────────────────

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

function createMockHub(): { hub: MessageHub; handlers: Map<string, RequestHandler> } {
	const handlers = new Map<string, RequestHandler>();
	const hub = {
		onRequest: mock((method: string, handler: RequestHandler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		}),
		onEvent: mock(() => () => {}),
		request: mock(async () => {}),
		event: mock(() => {}),
		joinChannel: mock(async () => {}),
		leaveChannel: mock(async () => {}),
		isConnected: mock(() => true),
		getState: mock(() => 'connected' as const),
		onConnection: mock(() => () => {}),
		onMessage: mock(() => () => {}),
		cleanup: mock(() => {}),
		registerTransport: mock(() => () => {}),
		registerRouter: mock(() => {}),
		getRouter: mock(() => null),
		getPendingCallCount: mock(() => 0),
	} as unknown as MessageHub;
	return { hub, handlers };
}

function createMockDaemonHub(): {
	hub: DaemonHub;
	emittedEvents: Array<{ name: string; data: unknown }>;
} {
	const emittedEvents: Array<{ name: string; data: unknown }> = [];
	const hub = {
		emit: mock(async (name: string, data: unknown) => {
			emittedEvents.push({ name, data });
		}),
	} as unknown as DaemonHub;
	return { hub, emittedEvents };
}

function createMockSpaceManager(spaceId: string, spaceName = 'Test Space'): SpaceManager {
	return {
		getSpace: mock(async (id: string) => {
			if (id === spaceId) {
				return { id, name: spaceName, workspacePath: '/ws', status: 'active' } as any;
			}
			return null;
		}),
	} as unknown as SpaceManager;
}

async function call<T>(
	handlers: Map<string, RequestHandler>,
	method: string,
	params: unknown
): Promise<T> {
	const handler = handlers.get(method);
	if (!handler) throw new Error(`Handler not registered: ${method}`);
	return (await handler(params, {})) as T;
}

// ─── Test setup ───────────────────────────────────────────────────────────────

const SPACE_ID = 'space-1';
const OTHER_SPACE_ID = 'space-2';

describe('Space Export/Import RPC Handlers', () => {
	let db: Database;
	let agentRepo: SpaceAgentRepository;
	let workflowRepo: SpaceWorkflowRepository;
	let workflowManager: SpaceWorkflowManager;
	let spaceManager: SpaceManager;
	let handlers: Map<string, RequestHandler>;
	let daemonHub: DaemonHub;
	let emittedEvents: Array<{ name: string; data: unknown }>;

	beforeEach(() => {
		db = new Database(':memory:');
		createSchema(db);
		insertSpace(db, SPACE_ID, 'My Space');
		insertSpace(db, OTHER_SPACE_ID, 'Other Space');

		agentRepo = new SpaceAgentRepository(db as any);
		workflowRepo = new SpaceWorkflowRepository(db as any);

		const agentLookup: SpaceAgentLookup = {
			getAgentById(spaceId: string, id: string) {
				const agent = agentRepo.getById(id);
				if (!agent || agent.spaceId !== spaceId) return null;
				return { id: agent.id, name: agent.name, role: agent.role };
			},
		};
		workflowManager = new SpaceWorkflowManager(workflowRepo, agentLookup);
		spaceManager = createMockSpaceManager(SPACE_ID);

		const mockHub = createMockHub();
		handlers = mockHub.handlers;

		const mockDaemonHub = createMockDaemonHub();
		daemonHub = mockDaemonHub.hub;
		emittedEvents = mockDaemonHub.emittedEvents;

		setupSpaceExportImportHandlers(
			mockHub.hub,
			spaceManager,
			agentRepo,
			workflowRepo,
			workflowManager,
			db as any,
			daemonHub
		);
	});

	// ─── Handler registration ────────────────────────────────────────────────

	it('registers all 5 handlers', () => {
		expect(handlers.has('spaceExport.agents')).toBe(true);
		expect(handlers.has('spaceExport.workflows')).toBe(true);
		expect(handlers.has('spaceExport.bundle')).toBe(true);
		expect(handlers.has('spaceImport.preview')).toBe(true);
		expect(handlers.has('spaceImport.execute')).toBe(true);
	});

	// ─── spaceId validation ───────────────────────────────────────────────────

	describe('spaceId validation', () => {
		it.each([
			'spaceExport.agents',
			'spaceExport.workflows',
			'spaceExport.bundle',
		])('%s: throws if spaceId missing', async (method) => {
			await expect(call(handlers, method, {})).rejects.toThrow('spaceId is required');
		});

		it.each([
			'spaceExport.agents',
			'spaceExport.workflows',
			'spaceExport.bundle',
		])('%s: throws if space not found', async (method) => {
			await expect(call(handlers, method, { spaceId: 'nonexistent' })).rejects.toThrow(
				'Space not found: nonexistent'
			);
		});

		it('spaceImport.preview: throws if spaceId missing', async () => {
			await expect(call(handlers, 'spaceImport.preview', { bundle: {} })).rejects.toThrow(
				'spaceId is required'
			);
		});

		it('spaceImport.execute: throws if spaceId missing', async () => {
			await expect(call(handlers, 'spaceImport.execute', { bundle: {} })).rejects.toThrow(
				'spaceId is required'
			);
		});

		it('spaceImport.execute: throws if space not found', async () => {
			await expect(
				call(handlers, 'spaceImport.execute', { spaceId: 'ghost', bundle: {} })
			).rejects.toThrow('Space not found: ghost');
		});
	});

	// ─── spaceExport.agents ───────────────────────────────────────────────────

	describe('spaceExport.agents', () => {
		it('exports all agents when no filter provided', async () => {
			agentRepo.create({ spaceId: SPACE_ID, name: 'Alpha', role: 'coder' });
			agentRepo.create({ spaceId: SPACE_ID, name: 'Beta', role: 'planner' });

			const { bundle } = await call<{ bundle: any }>(handlers, 'spaceExport.agents', {
				spaceId: SPACE_ID,
			});

			expect(bundle.type).toBe('bundle');
			expect(bundle.agents).toHaveLength(2);
			expect(bundle.agents.map((a: any) => a.name)).toEqual(
				expect.arrayContaining(['Alpha', 'Beta'])
			);
			expect(bundle.workflows).toHaveLength(0);
		});

		it('filters agents by agentIds', async () => {
			const a1 = agentRepo.create({ spaceId: SPACE_ID, name: 'Alpha', role: 'coder' });
			agentRepo.create({ spaceId: SPACE_ID, name: 'Beta', role: 'planner' });

			const { bundle } = await call<{ bundle: any }>(handlers, 'spaceExport.agents', {
				spaceId: SPACE_ID,
				agentIds: [a1.id],
			});

			expect(bundle.agents).toHaveLength(1);
			expect(bundle.agents[0].name).toBe('Alpha');
		});

		it('exported agent preserves fields and strips id/spaceId', async () => {
			agentRepo.create({
				spaceId: SPACE_ID,
				name: 'Coder',
				role: 'coder',
				model: 'claude-3',
				systemPrompt: 'You code.',
				tools: ['read_file'],
			});

			const { bundle } = await call<{ bundle: any }>(handlers, 'spaceExport.agents', {
				spaceId: SPACE_ID,
			});

			const exported = bundle.agents[0];
			expect(exported.name).toBe('Coder');
			expect(exported.role).toBe('coder');
			expect(exported.model).toBe('claude-3');
			expect(exported.systemPrompt).toBe('You code.');
			expect(exported.tools).toEqual(['read_file']);
			expect(exported.id).toBeUndefined();
			expect(exported.spaceId).toBeUndefined();
			expect(exported.version).toBe(1);
			expect(exported.type).toBe('agent');
		});

		it('sets exportedFrom to spaceId', async () => {
			agentRepo.create({ spaceId: SPACE_ID, name: 'A', role: 'coder' });
			const { bundle } = await call<{ bundle: any }>(handlers, 'spaceExport.agents', {
				spaceId: SPACE_ID,
			});
			expect(bundle.exportedFrom).toBe(SPACE_ID);
		});

		it('returns empty agents array when no agents exist', async () => {
			const { bundle } = await call<{ bundle: any }>(handlers, 'spaceExport.agents', {
				spaceId: SPACE_ID,
			});
			expect(bundle.agents).toHaveLength(0);
		});

		it('exports injectWorkflowContext: true when set on agent', async () => {
			agentRepo.create({
				spaceId: SPACE_ID,
				name: 'Planner',
				role: 'planner',
				injectWorkflowContext: true,
			});

			const { bundle } = await call<{ bundle: any }>(handlers, 'spaceExport.agents', {
				spaceId: SPACE_ID,
			});

			expect(bundle.agents[0].injectWorkflowContext).toBe(true);
		});

		it('omits injectWorkflowContext from export when not set', async () => {
			agentRepo.create({ spaceId: SPACE_ID, name: 'Coder', role: 'coder' });

			const { bundle } = await call<{ bundle: any }>(handlers, 'spaceExport.agents', {
				spaceId: SPACE_ID,
			});

			expect(bundle.agents[0].injectWorkflowContext).toBeUndefined();
		});
	});

	// ─── spaceExport.workflows ────────────────────────────────────────────────

	describe('spaceExport.workflows', () => {
		it('exports workflow with agentRef resolved to agent name', async () => {
			const agent = agentRepo.create({ spaceId: SPACE_ID, name: 'Coder', role: 'coder' });
			workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: 'Pipeline',
				steps: [{ name: 'Code', agentId: agent.id }],
				transitions: [],
			});

			const { bundle } = await call<{ bundle: any }>(handlers, 'spaceExport.workflows', {
				spaceId: SPACE_ID,
			});

			expect(bundle.workflows).toHaveLength(1);
			const wf = bundle.workflows[0];
			expect(wf.name).toBe('Pipeline');
			expect(wf.steps[0].agentRef).toBe('Coder'); // UUID resolved to name
			expect(wf.steps[0].name).toBe('Code');
		});

		it('includes only referenced agents in the bundle', async () => {
			const coder = agentRepo.create({ spaceId: SPACE_ID, name: 'Coder', role: 'coder' });
			agentRepo.create({ spaceId: SPACE_ID, name: 'Reviewer', role: 'reviewer' });
			workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: 'Pipeline',
				steps: [{ name: 'Code', agentId: coder.id }],
				transitions: [],
			});

			const { bundle } = await call<{ bundle: any }>(handlers, 'spaceExport.workflows', {
				spaceId: SPACE_ID,
			});

			// Only Coder is referenced, Reviewer should NOT be included
			expect(bundle.agents).toHaveLength(1);
			expect(bundle.agents[0].name).toBe('Coder');
		});

		it('filters workflows by workflowIds', async () => {
			const agent = agentRepo.create({ spaceId: SPACE_ID, name: 'A', role: 'coder' });
			const wf1 = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: 'WF1',
				steps: [{ name: 'S1', agentId: agent.id }],
				transitions: [],
			});
			workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: 'WF2',
				steps: [{ name: 'S2', agentId: agent.id }],
				transitions: [],
			});

			const { bundle } = await call<{ bundle: any }>(handlers, 'spaceExport.workflows', {
				spaceId: SPACE_ID,
				workflowIds: [wf1.id],
			});

			expect(bundle.workflows).toHaveLength(1);
			expect(bundle.workflows[0].name).toBe('WF1');
		});

		it('exports transition step names instead of UUIDs', async () => {
			const agent = agentRepo.create({ spaceId: SPACE_ID, name: 'A', role: 'coder' });
			workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: 'TwoStep',
				steps: [
					{ id: 'step-1', name: 'First', agentId: agent.id },
					{ id: 'step-2', name: 'Second', agentId: agent.id },
				],
				transitions: [{ from: 'step-1', to: 'step-2' }],
			});

			const { bundle } = await call<{ bundle: any }>(handlers, 'spaceExport.workflows', {
				spaceId: SPACE_ID,
			});

			const wf = bundle.workflows[0];
			expect(wf.transitions[0].fromStep).toBe('First');
			expect(wf.transitions[0].toStep).toBe('Second');
		});
	});

	// ─── spaceExport.bundle ───────────────────────────────────────────────────

	describe('spaceExport.bundle', () => {
		it('exports all agents and workflows', async () => {
			const agent = agentRepo.create({ spaceId: SPACE_ID, name: 'A', role: 'coder' });
			workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: 'W',
				steps: [{ name: 'S', agentId: agent.id }],
				transitions: [],
			});

			const { bundle } = await call<{ bundle: any }>(handlers, 'spaceExport.bundle', {
				spaceId: SPACE_ID,
			});

			expect(bundle.type).toBe('bundle');
			expect(bundle.agents).toHaveLength(1);
			expect(bundle.workflows).toHaveLength(1);
		});

		it('filters by agentIds and workflowIds', async () => {
			const a1 = agentRepo.create({ spaceId: SPACE_ID, name: 'A1', role: 'coder' });
			agentRepo.create({ spaceId: SPACE_ID, name: 'A2', role: 'coder' });
			const wf1 = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: 'W1',
				steps: [{ name: 'S', agentId: a1.id }],
				transitions: [],
			});
			workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: 'W2',
				steps: [{ name: 'S', agentId: a1.id }],
				transitions: [],
			});

			const { bundle } = await call<{ bundle: any }>(handlers, 'spaceExport.bundle', {
				spaceId: SPACE_ID,
				agentIds: [a1.id],
				workflowIds: [wf1.id],
			});

			expect(bundle.agents).toHaveLength(1);
			expect(bundle.agents[0].name).toBe('A1');
			expect(bundle.workflows).toHaveLength(1);
			expect(bundle.workflows[0].name).toBe('W1');
		});
	});

	// ─── spaceImport.preview ─────────────────────────────────────────────────

	describe('spaceImport.preview', () => {
		it('returns validation error for invalid bundle', async () => {
			const result = await call<ImportPreviewResult>(handlers, 'spaceImport.preview', {
				spaceId: SPACE_ID,
				bundle: { not: 'a bundle' },
			});

			expect(result.agents).toHaveLength(0);
			expect(result.workflows).toHaveLength(0);
			expect(result.validationErrors.length).toBeGreaterThan(0);
		});

		it('returns create action for non-conflicting items', async () => {
			const bundle = makeBundle([{ name: 'Coder', role: 'coder' }], []);

			const result = await call<ImportPreviewResult>(handlers, 'spaceImport.preview', {
				spaceId: SPACE_ID,
				bundle,
			});

			expect(result.agents).toHaveLength(1);
			expect(result.agents[0]).toEqual({ name: 'Coder', action: 'create' });
			expect(result.validationErrors).toHaveLength(0);
		});

		it('detects agent name conflict', async () => {
			const existing = agentRepo.create({ spaceId: SPACE_ID, name: 'Coder', role: 'coder' });
			const bundle = makeBundle([{ name: 'Coder', role: 'coder' }], []);

			const result = await call<ImportPreviewResult>(handlers, 'spaceImport.preview', {
				spaceId: SPACE_ID,
				bundle,
			});

			expect(result.agents[0]).toEqual({
				name: 'Coder',
				action: 'conflict',
				existingId: existing.id,
			});
		});

		it('detects workflow name conflict', async () => {
			const agent = agentRepo.create({ spaceId: SPACE_ID, name: 'A', role: 'coder' });
			const existing = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: 'Pipeline',
				steps: [{ name: 'S', agentId: agent.id }],
				transitions: [],
			});

			const bundle = makeBundle(
				[{ name: 'A', role: 'coder' }],
				[{ name: 'Pipeline', steps: [{ agentRef: 'A', name: 'S' }] }]
			);

			const result = await call<ImportPreviewResult>(handlers, 'spaceImport.preview', {
				spaceId: SPACE_ID,
				bundle,
			});

			expect(result.workflows[0]).toEqual({
				name: 'Pipeline',
				action: 'conflict',
				existingId: existing.id,
			});
		});

		it('flags unresolved agent ref as validation error', async () => {
			const bundle = makeBundle(
				[],
				[{ name: 'Pipeline', steps: [{ agentRef: 'Ghost', name: 'S' }] }]
			);

			const result = await call<ImportPreviewResult>(handlers, 'spaceImport.preview', {
				spaceId: SPACE_ID,
				bundle,
			});

			expect(result.validationErrors.length).toBeGreaterThan(0);
			expect(result.validationErrors[0]).toContain('Ghost');
			expect(result.validationErrors[0]).toContain('Pipeline');
		});

		it('resolves agent ref from existing space agents', async () => {
			agentRepo.create({ spaceId: SPACE_ID, name: 'ExistingAgent', role: 'coder' });
			// Bundle has no agents but workflow references ExistingAgent (from target space)
			const bundle = makeBundle(
				[],
				[{ name: 'Pipeline', steps: [{ agentRef: 'ExistingAgent', name: 'S' }] }]
			);

			const result = await call<ImportPreviewResult>(handlers, 'spaceImport.preview', {
				spaceId: SPACE_ID,
				bundle,
			});

			expect(result.validationErrors).toHaveLength(0);
		});

		it('flags condition transition without expression as error', async () => {
			const bundle = makeBundleWithCondition('condition', ''); // empty expression

			const result = await call<ImportPreviewResult>(handlers, 'spaceImport.preview', {
				spaceId: SPACE_ID,
				bundle,
			});

			expect(result.validationErrors.length).toBeGreaterThan(0);
			expect(result.validationErrors[0]).toContain('non-empty expression');
		});

		it('passes validation for always condition', async () => {
			const bundle = makeBundleWithCondition('always', undefined);

			const result = await call<ImportPreviewResult>(handlers, 'spaceImport.preview', {
				spaceId: SPACE_ID,
				bundle,
			});

			expect(result.validationErrors).toHaveLength(0);
		});
	});

	// ─── spaceImport.execute ─────────────────────────────────────────────────

	describe('spaceImport.execute', () => {
		it('throws for invalid bundle', async () => {
			await expect(
				call(handlers, 'spaceImport.execute', { spaceId: SPACE_ID, bundle: { bad: true } })
			).rejects.toThrow('Invalid bundle');
		});

		it('creates agents and workflows with no conflicts', async () => {
			const bundle = makeBundle(
				[{ name: 'Coder', role: 'coder', systemPrompt: 'You code.' }],
				[{ name: 'Pipeline', steps: [{ agentRef: 'Coder', name: 'Code' }] }]
			);

			const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
				spaceId: SPACE_ID,
				bundle,
			});

			expect(result.agents).toHaveLength(1);
			expect(result.agents[0]).toMatchObject({ name: 'Coder', action: 'created' });
			expect(result.workflows).toHaveLength(1);
			expect(result.workflows[0]).toMatchObject({ name: 'Pipeline', action: 'created' });

			// Verify data persisted
			const agents = agentRepo.getBySpaceId(SPACE_ID);
			expect(agents.find((a) => a.name === 'Coder')?.systemPrompt).toBe('You code.');
			const workflows = workflowRepo.listWorkflows(SPACE_ID);
			expect(workflows.find((w) => w.name === 'Pipeline')).toBeTruthy();
		});

		describe('conflict resolution: skip', () => {
			it('skips conflicting agent and uses existing UUID for workflow cross-refs', async () => {
				const existing = agentRepo.create({ spaceId: SPACE_ID, name: 'Coder', role: 'coder' });

				const bundle = makeBundle(
					[{ name: 'Coder', role: 'reviewer' }], // different role
					[{ name: 'Pipeline', steps: [{ agentRef: 'Coder', name: 'Code' }] }]
				);

				const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
					spaceId: SPACE_ID,
					bundle,
					conflictResolution: { agents: { Coder: 'skip' } },
				});

				expect(result.agents[0]).toMatchObject({
					name: 'Coder',
					action: 'skipped',
					id: existing.id,
				});

				// Agent role should NOT have changed (skipped)
				const agent = agentRepo.getById(existing.id)!;
				expect(agent.role).toBe('coder'); // unchanged

				// Workflow should still be importable and reference the existing agent UUID
				expect(result.workflows[0].action).toBe('created');
				const wf = workflowRepo.getWorkflow(result.workflows[0].id)!;
				expect(wf.steps[0].agentId).toBe(existing.id);
			});

			it('skips conflicting workflow', async () => {
				const agent = agentRepo.create({ spaceId: SPACE_ID, name: 'A', role: 'coder' });
				const existingWf = workflowManager.createWorkflow({
					spaceId: SPACE_ID,
					name: 'Pipeline',
					steps: [{ name: 'S', agentId: agent.id }],
					transitions: [],
				});

				const bundle = makeBundle(
					[{ name: 'A', role: 'coder' }],
					[{ name: 'Pipeline', steps: [{ agentRef: 'A', name: 'S' }] }]
				);

				const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
					spaceId: SPACE_ID,
					bundle,
					conflictResolution: { agents: { A: 'skip' }, workflows: { Pipeline: 'skip' } },
				});

				expect(result.workflows[0]).toMatchObject({
					name: 'Pipeline',
					action: 'skipped',
					id: existingWf.id,
				});

				// Only one workflow should exist (no duplicate)
				const all = workflowRepo.listWorkflows(SPACE_ID);
				expect(all).toHaveLength(1);
			});
		});

		describe('conflict resolution: rename', () => {
			it('renames conflicting agent with unique name', async () => {
				agentRepo.create({ spaceId: SPACE_ID, name: 'Coder', role: 'coder' });
				agentRepo.create({ spaceId: SPACE_ID, name: 'Coder (1)', role: 'coder' });

				const bundle = makeBundle([{ name: 'Coder', role: 'reviewer' }], []);

				const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
					spaceId: SPACE_ID,
					bundle,
					conflictResolution: { agents: { Coder: 'rename' } },
				});

				expect(result.agents[0]).toMatchObject({ name: 'Coder (2)', action: 'renamed' });

				// Both old and new should exist
				const agents = agentRepo.getBySpaceId(SPACE_ID);
				expect(agents.map((a) => a.name)).toContain('Coder');
				expect(agents.map((a) => a.name)).toContain('Coder (2)');
			});

			it('renames conflicting workflow', async () => {
				const agent = agentRepo.create({ spaceId: SPACE_ID, name: 'A', role: 'coder' });
				workflowManager.createWorkflow({
					spaceId: SPACE_ID,
					name: 'Pipeline',
					steps: [{ name: 'S', agentId: agent.id }],
					transitions: [],
				});

				const bundle = makeBundle(
					[{ name: 'A', role: 'coder' }],
					[{ name: 'Pipeline', steps: [{ agentRef: 'A', name: 'S2' }] }]
				);

				const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
					spaceId: SPACE_ID,
					bundle,
					conflictResolution: { agents: { A: 'skip' }, workflows: { Pipeline: 'rename' } },
				});

				expect(result.workflows[0]).toMatchObject({ name: 'Pipeline (1)', action: 'renamed' });

				const all = workflowRepo.listWorkflows(SPACE_ID);
				expect(all).toHaveLength(2);
				expect(all.map((w) => w.name)).toContain('Pipeline (1)');
			});
		});

		describe('conflict resolution: replace', () => {
			it('replaces conflicting agent in place (preserves UUID)', async () => {
				const existing = agentRepo.create({ spaceId: SPACE_ID, name: 'Coder', role: 'coder' });

				const bundle = makeBundle([{ name: 'Coder', role: 'reviewer', model: 'claude-new' }], []);

				const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
					spaceId: SPACE_ID,
					bundle,
					conflictResolution: { agents: { Coder: 'replace' } },
				});

				expect(result.agents[0]).toMatchObject({
					name: 'Coder',
					action: 'replaced',
					id: existing.id,
				});

				const agent = agentRepo.getById(existing.id)!;
				expect(agent.role).toBe('reviewer');
				expect(agent.model).toBe('claude-new');
			});

			it('replaces conflicting workflow (delete + create)', async () => {
				const agent = agentRepo.create({ spaceId: SPACE_ID, name: 'A', role: 'coder' });
				workflowManager.createWorkflow({
					spaceId: SPACE_ID,
					name: 'Pipeline',
					steps: [{ name: 'OldStep', agentId: agent.id }],
					transitions: [],
				});

				const bundle = makeBundle(
					[{ name: 'A', role: 'coder' }],
					[{ name: 'Pipeline', steps: [{ agentRef: 'A', name: 'NewStep' }] }]
				);

				const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
					spaceId: SPACE_ID,
					bundle,
					conflictResolution: { agents: { A: 'skip' }, workflows: { Pipeline: 'replace' } },
				});

				expect(result.workflows[0]).toMatchObject({ name: 'Pipeline', action: 'replaced' });

				const all = workflowRepo.listWorkflows(SPACE_ID);
				expect(all).toHaveLength(1);
				expect(all[0].steps[0].name).toBe('NewStep');
			});
		});

		// ─── Cross-reference mapping ───────────────────────────────────────

		describe('cross-reference mapping', () => {
			it('resolves agent name→UUID from bundle agents', async () => {
				const bundle = makeBundle(
					[{ name: 'BundleAgent', role: 'coder' }],
					[{ name: 'Pipeline', steps: [{ agentRef: 'BundleAgent', name: 'S' }] }]
				);

				const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
					spaceId: SPACE_ID,
					bundle,
				});

				const importedAgentId = result.agents[0].id;
				const wf = workflowRepo.getWorkflow(result.workflows[0].id)!;
				expect(wf.steps[0].agentId).toBe(importedAgentId);
			});

			it('resolves agent name→UUID from existing space agents (not in bundle)', async () => {
				const existing = agentRepo.create({ spaceId: SPACE_ID, name: 'LocalAgent', role: 'coder' });

				// Bundle has workflow referencing LocalAgent but does not include LocalAgent as agent
				const bundle = makeBundle(
					[],
					[{ name: 'Pipeline', steps: [{ agentRef: 'LocalAgent', name: 'S' }] }]
				);

				const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
					spaceId: SPACE_ID,
					bundle,
				});

				const wf = workflowRepo.getWorkflow(result.workflows[0].id)!;
				expect(wf.steps[0].agentId).toBe(existing.id);
			});

			it('prefers bundle agent over existing space agent of same name', async () => {
				const existingAgent = agentRepo.create({ spaceId: SPACE_ID, name: 'Agent', role: 'coder' });

				// Bundle includes Agent → will be renamed (conflict resolution: rename)
				const bundle = makeBundle(
					[{ name: 'Agent', role: 'reviewer' }],
					[{ name: 'Pipeline', steps: [{ agentRef: 'Agent', name: 'S' }] }]
				);

				const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
					spaceId: SPACE_ID,
					bundle,
					conflictResolution: { agents: { Agent: 'skip' } },
				});

				// When Agent is skipped, bundle cross-ref maps to the existing agent UUID
				const wf = workflowRepo.getWorkflow(result.workflows[0].id)!;
				expect(wf.steps[0].agentId).toBe(existingAgent.id);
			});

			it('throws when agent ref cannot be resolved', async () => {
				const bundle = makeBundle(
					[],
					[{ name: 'Pipeline', steps: [{ agentRef: 'GhostAgent', name: 'S' }] }]
				);

				await expect(
					call(handlers, 'spaceImport.execute', { spaceId: SPACE_ID, bundle })
				).rejects.toThrow('unresolved agent reference');
			});

			it('remaps rule appliesTo from step names to new step UUIDs', async () => {
				const bundleWithRules = makeBundleWithRules();

				const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
					spaceId: SPACE_ID,
					bundle: bundleWithRules,
				});

				const wf = workflowRepo.getWorkflow(result.workflows[0].id)!;
				expect(wf.rules).toHaveLength(1);
				const rule = wf.rules[0];
				// appliesTo should contain step UUIDs (not step names)
				expect(rule.appliesTo).toHaveLength(1);
				// The step UUID should correspond to the 'Code' step
				const codeStep = wf.steps.find((s) => s.name === 'Code')!;
				expect(rule.appliesTo![0]).toBe(codeStep.id);
			});

			it('assigns fresh step UUIDs (not re-using exported names as IDs)', async () => {
				const bundle = makeBundle(
					[{ name: 'A', role: 'coder' }],
					[{ name: 'W', steps: [{ agentRef: 'A', name: 'MyStep' }] }]
				);

				const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
					spaceId: SPACE_ID,
					bundle,
				});

				const wf = workflowRepo.getWorkflow(result.workflows[0].id)!;
				// Step ID should be a UUID (not 'MyStep' or any string from the bundle)
				const stepId = wf.steps[0].id;
				expect(stepId).toMatch(/^[0-9a-f-]{36}$/i);
				expect(stepId).not.toBe('MyStep');
			});
		});

		// ─── Multi-agent workflow ──────────────────────────────────────────

		it('imports workflow with multiple steps and transitions', async () => {
			const bundle = makeTwoStepBundle();

			const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
				spaceId: SPACE_ID,
				bundle,
			});

			expect(result.agents).toHaveLength(2);
			const wf = workflowRepo.getWorkflow(result.workflows[0].id)!;
			expect(wf.steps).toHaveLength(2);
			expect(wf.transitions).toHaveLength(1);

			// Transition should reference correct step UUIDs
			const step1 = wf.steps.find((s) => s.name === 'Code')!;
			const step2 = wf.steps.find((s) => s.name === 'Review')!;
			expect(wf.transitions[0].from).toBe(step1.id);
			expect(wf.transitions[0].to).toBe(step2.id);
		});

		it('returns empty warnings array on clean import', async () => {
			const bundle = makeBundle(
				[{ name: 'A', role: 'coder' }],
				[{ name: 'W', steps: [{ agentRef: 'A', name: 'S' }] }]
			);

			const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
				spaceId: SPACE_ID,
				bundle,
			});

			expect(result.warnings).toHaveLength(0);
		});

		// ─── Transaction atomicity ─────────────────────────────────────────

		describe('transaction atomicity', () => {
			it('rolls back agent creation when workflow import fails (unresolved agent ref)', async () => {
				// Bundle: first workflow imports fine, second has an unresolved agent ref.
				// After failure, neither agent nor workflow should exist.
				const bundle = {
					version: 1,
					type: 'bundle',
					name: 'Atomic Test',
					agents: [{ version: 1, type: 'agent', name: 'NewAgent', role: 'coder' }],
					workflows: [
						{
							version: 1,
							type: 'workflow',
							name: 'BadWorkflow',
							steps: [{ agentRef: 'GhostAgent', name: 'S' }],
							transitions: [],
							startStep: 'S',
							rules: [],
							tags: [],
						},
					],
					exportedAt: Date.now(),
				};

				await expect(
					call(handlers, 'spaceImport.execute', { spaceId: SPACE_ID, bundle })
				).rejects.toThrow('unresolved agent reference');

				// Nothing should have been committed — NewAgent must not exist
				const agents = agentRepo.getBySpaceId(SPACE_ID);
				expect(agents.find((a) => a.name === 'NewAgent')).toBeUndefined();
			});

			it('rolls back workflow deletion when replacement creation fails', async () => {
				// A workflow that exists in the target space should NOT be deleted
				// if the replacement creation fails.
				const existingAgent = agentRepo.create({ spaceId: SPACE_ID, name: 'A', role: 'coder' });
				const existingWf = workflowManager.createWorkflow({
					spaceId: SPACE_ID,
					name: 'ToReplace',
					steps: [{ name: 'S', agentId: existingAgent.id }],
					transitions: [],
				});

				// Bundle: replace "ToReplace" but the replacement references a ghost agent
				const bundle = {
					version: 1,
					type: 'bundle',
					name: 'Replace Test',
					agents: [],
					workflows: [
						{
							version: 1,
							type: 'workflow',
							name: 'ToReplace',
							steps: [{ agentRef: 'GhostAgent', name: 'S2' }],
							transitions: [],
							startStep: 'S2',
							rules: [],
							tags: [],
						},
					],
					exportedAt: Date.now(),
				};

				await expect(
					call(handlers, 'spaceImport.execute', {
						spaceId: SPACE_ID,
						bundle,
						conflictResolution: { workflows: { ToReplace: 'replace' } },
					})
				).rejects.toThrow('unresolved agent reference');

				// The original workflow must still exist (deletion was rolled back)
				const wf = workflowRepo.getWorkflow(existingWf.id);
				expect(wf).not.toBeNull();
				expect(wf!.name).toBe('ToReplace');
			});
		});

		// ─── replace agent field clearing ─────────────────────────────────

		describe('replace agent: unset fields are cleared', () => {
			it('clears model when not present in exported agent', async () => {
				const existing = agentRepo.create({
					spaceId: SPACE_ID,
					name: 'Coder',
					role: 'coder',
					model: 'old-model',
				});

				// Exported agent has no model field
				const bundle = makeBundle([{ name: 'Coder', role: 'reviewer' }], []);

				await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
					spaceId: SPACE_ID,
					bundle,
					conflictResolution: { agents: { Coder: 'replace' } },
				});

				// model should be cleared (not preserved from the existing agent)
				const agent = agentRepo.getById(existing.id)!;
				expect(agent.model).toBeUndefined();
			});

			it('clears systemPrompt when not present in exported agent', async () => {
				const existing = agentRepo.create({
					spaceId: SPACE_ID,
					name: 'Coder',
					role: 'coder',
					systemPrompt: 'Old prompt.',
				});

				const bundle = makeBundle([{ name: 'Coder', role: 'coder' }], []);

				await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
					spaceId: SPACE_ID,
					bundle,
					conflictResolution: { agents: { Coder: 'replace' } },
				});

				const agent = agentRepo.getById(existing.id)!;
				expect(agent.systemPrompt).toBeUndefined();
			});

			it('clears injectWorkflowContext when not present in exported agent', async () => {
				const existing = agentRepo.create({
					spaceId: SPACE_ID,
					name: 'Planner',
					role: 'planner',
					injectWorkflowContext: true,
				});

				const bundle = makeBundle([{ name: 'Planner', role: 'planner' }], []);

				await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
					spaceId: SPACE_ID,
					bundle,
					conflictResolution: { agents: { Planner: 'replace' } },
				});

				const agent = agentRepo.getById(existing.id)!;
				expect(agent.injectWorkflowContext).toBeUndefined();
			});
		});

		it('imports injectWorkflowContext: true from exported agent', async () => {
			const bundle = {
				version: 1,
				type: 'bundle',
				name: 'Test Bundle',
				agents: [
					{
						version: 1,
						type: 'agent',
						name: 'Planner',
						role: 'planner',
						injectWorkflowContext: true,
					},
				],
				workflows: [],
				exportedAt: Date.now(),
			};

			const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
				spaceId: SPACE_ID,
				bundle,
			});

			expect(result.agents).toHaveLength(1);
			const created = agentRepo.getBySpaceId(SPACE_ID).find((a) => a.name === 'Planner')!;
			expect(created.injectWorkflowContext).toBe(true);
		});
	});

	// ─── Event emission ──────────────────────────────────────────────────────

	describe('event emission after spaceImport.execute', () => {
		it('emits spaceAgent.created for each newly created agent', async () => {
			const bundle = makeBundle([{ name: 'NewAgent', role: 'coder' }], []);

			await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
				spaceId: SPACE_ID,
				bundle,
			});

			// Allow micro-task queue to flush (emit is async)
			await Promise.resolve();

			const agentCreated = emittedEvents.filter((e) => e.name === 'spaceAgent.created');
			expect(agentCreated).toHaveLength(1);
			expect((agentCreated[0].data as { spaceId: string }).spaceId).toBe(SPACE_ID);
			expect((agentCreated[0].data as { agent: { name: string } }).agent.name).toBe('NewAgent');
		});

		it('emits spaceAgent.updated for replaced agent', async () => {
			agentRepo.create({ spaceId: SPACE_ID, name: 'Coder', role: 'coder' });
			const bundle = makeBundle([{ name: 'Coder', role: 'coder', model: 'claude-haiku-4-5' }], []);

			await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
				spaceId: SPACE_ID,
				bundle,
				conflictResolution: { agents: { Coder: 'replace' } },
			});

			await Promise.resolve();

			const agentUpdated = emittedEvents.filter((e) => e.name === 'spaceAgent.updated');
			expect(agentUpdated).toHaveLength(1);
			expect((agentUpdated[0].data as { agent: { name: string } }).agent.name).toBe('Coder');
		});

		it('does not emit event for skipped agent', async () => {
			agentRepo.create({ spaceId: SPACE_ID, name: 'Coder', role: 'coder' });
			const bundle = makeBundle([{ name: 'Coder', role: 'coder' }], []);

			await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
				spaceId: SPACE_ID,
				bundle,
				conflictResolution: { agents: { Coder: 'skip' } },
			});

			await Promise.resolve();

			const agentEvents = emittedEvents.filter((e) => e.name.startsWith('spaceAgent'));
			expect(agentEvents).toHaveLength(0);
		});

		it('emits spaceWorkflow.created for each newly created workflow', async () => {
			const bundle = makeBundle(
				[{ name: 'Coder', role: 'coder' }],
				[{ name: 'Pipe', steps: [{ agentRef: 'Coder', name: 's1' }] }]
			);

			await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
				spaceId: SPACE_ID,
				bundle,
			});

			await Promise.resolve();

			const wfCreated = emittedEvents.filter((e) => e.name === 'spaceWorkflow.created');
			expect(wfCreated).toHaveLength(1);
			expect((wfCreated[0].data as { workflow: { name: string } }).workflow.name).toBe('Pipe');
		});

		it('emits spaceWorkflow.deleted (old id) + spaceWorkflow.created (new id) for replaced workflow', async () => {
			// Create an agent and workflow that will be replaced
			const existingAgent = agentRepo.create({ spaceId: SPACE_ID, name: 'Coder', role: 'coder' });
			const existingAgentId = existingAgent.id;
			const existingWf = workflowManager.createWorkflow({
				spaceId: SPACE_ID,
				name: 'Pipe',
				steps: [{ name: 's1', agentId: existingAgentId }],
				transitions: [],
			});
			const oldWorkflowId = existingWf.id;

			const bundle = makeBundle(
				[{ name: 'Coder', role: 'coder' }],
				[{ name: 'Pipe', steps: [{ agentRef: 'Coder', name: 's1' }] }]
			);

			await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
				spaceId: SPACE_ID,
				bundle,
				conflictResolution: { workflows: { Pipe: 'replace' } },
			});

			await Promise.resolve();

			const deletedEvents = emittedEvents.filter((e) => e.name === 'spaceWorkflow.deleted');
			expect(deletedEvents).toHaveLength(1);
			expect((deletedEvents[0].data as { workflowId: string }).workflowId).toBe(oldWorkflowId);

			const createdEvents = emittedEvents.filter((e) => e.name === 'spaceWorkflow.created');
			expect(createdEvents).toHaveLength(1);
			const newId = (createdEvents[0].data as { workflow: { id: string } }).workflow.id;
			expect(newId).not.toBe(oldWorkflowId);
		});

		it('emits spaceAgent.created and spaceWorkflow.created for bundle with both', async () => {
			const bundle = makeBundle(
				[{ name: 'AgentA', role: 'coder' }],
				[{ name: 'WfA', steps: [{ agentRef: 'AgentA', name: 'step' }] }]
			);

			await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
				spaceId: SPACE_ID,
				bundle,
			});

			await Promise.resolve();

			expect(emittedEvents.some((e) => e.name === 'spaceAgent.created')).toBe(true);
			expect(emittedEvents.some((e) => e.name === 'spaceWorkflow.created')).toBe(true);
		});
	});
});

// ─── Multi-agent step import tests ────────────────────────────────────────────

describe('multi-agent step import', () => {
	let db: Database;
	let agentRepo: SpaceAgentRepository;
	let workflowRepo: SpaceWorkflowRepository;
	let workflowManager: SpaceWorkflowManager;
	let spaceManager: SpaceManager;
	let handlers: Map<string, RequestHandler>;
	let daemonHub: DaemonHub;

	beforeEach(() => {
		db = new Database(':memory:');
		createSchema(db);
		insertSpace(db, SPACE_ID, 'My Space');

		agentRepo = new SpaceAgentRepository(db as any);
		workflowRepo = new SpaceWorkflowRepository(db as any);

		const agentLookup: SpaceAgentLookup = {
			getAgentById(spaceId: string, id: string) {
				const agent = agentRepo.getById(id);
				if (!agent || agent.spaceId !== spaceId) return null;
				return { id: agent.id, name: agent.name, role: agent.role };
			},
		};
		workflowManager = new SpaceWorkflowManager(workflowRepo, agentLookup);
		spaceManager = createMockSpaceManager(SPACE_ID);
		const mockHub = createMockHub();
		handlers = mockHub.handlers;
		const mockDaemonHub = createMockDaemonHub();
		daemonHub = mockDaemonHub.hub;

		setupSpaceExportImportHandlers(
			mockHub.hub,
			spaceManager,
			agentRepo,
			workflowRepo,
			workflowManager,
			db as any,
			daemonHub
		);
	});

	it('imports multi-agent step and resolves each agentRef → agentId', async () => {
		const bundle = makeMultiAgentBundle(
			[
				{ name: 'Coder', role: 'coder' },
				{ name: 'Reviewer', role: 'reviewer' },
			],
			[
				{
					name: 'Collab Pipeline',
					steps: [
						{
							multiAgentStep: {
								name: 'Parallel',
								agents: [
									{ agentRef: 'Coder', instructions: 'Write code' },
									{ agentRef: 'Reviewer' },
								],
							},
						},
					],
				},
			]
		);

		const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
			spaceId: SPACE_ID,
			bundle,
		});

		expect(result.agents).toHaveLength(2);
		const wf = workflowRepo.getWorkflow(result.workflows[0].id)!;
		const step = wf.steps[0];

		// Multi-agent step should have agents array, not single agentId
		expect(step.agents).toHaveLength(2);
		expect(step.agentId).toBeUndefined();

		// Each agent should be resolved to its UUID
		const coderAgent = agentRepo.getById(result.agents.find((a) => a.name === 'Coder')!.id)!;
		const reviewerAgent = agentRepo.getById(result.agents.find((a) => a.name === 'Reviewer')!.id)!;
		const agentIds = step.agents!.map((a) => a.agentId);
		expect(agentIds).toContain(coderAgent.id);
		expect(agentIds).toContain(reviewerAgent.id);
	});

	it('preserves per-agent instructions in imported multi-agent step', async () => {
		const bundle = makeMultiAgentBundle(
			[
				{ name: 'Coder', role: 'coder' },
				{ name: 'Reviewer', role: 'reviewer' },
			],
			[
				{
					name: 'Pipeline',
					steps: [
						{
							multiAgentStep: {
								name: 'Parallel',
								agents: [
									{ agentRef: 'Coder', instructions: 'Implement the feature' },
									{ agentRef: 'Reviewer', instructions: 'Review thoroughly' },
								],
							},
						},
					],
				},
			]
		);

		const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
			spaceId: SPACE_ID,
			bundle,
		});

		const wf = workflowRepo.getWorkflow(result.workflows[0].id)!;
		const agentEntries = wf.steps[0].agents!;
		const byAgentId = new Map(agentEntries.map((a) => [a.agentId, a]));

		const coderId = result.agents.find((a) => a.name === 'Coder')!.id;
		const reviewerId = result.agents.find((a) => a.name === 'Reviewer')!.id;
		expect(byAgentId.get(coderId)?.instructions).toBe('Implement the feature');
		expect(byAgentId.get(reviewerId)?.instructions).toBe('Review thoroughly');
	});

	it('imports channels as-is in multi-agent step', async () => {
		const bundle = makeMultiAgentBundle(
			[
				{ name: 'Coder', role: 'coder' },
				{ name: 'Reviewer', role: 'reviewer' },
			],
			[
				{
					name: 'Pipeline',
					steps: [
						{
							multiAgentStep: {
								name: 'Parallel',
								agents: [{ agentRef: 'Coder' }, { agentRef: 'Reviewer' }],
								channels: [
									{ from: 'coder', to: 'reviewer', direction: 'bidirectional', label: 'feedback' },
								],
							},
						},
					],
				},
			]
		);

		const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
			spaceId: SPACE_ID,
			bundle,
		});

		const wf = workflowRepo.getWorkflow(result.workflows[0].id)!;
		const step = wf.steps[0];
		expect(step.channels).toHaveLength(1);
		expect(step.channels![0].from).toBe('coder');
		expect(step.channels![0].to).toBe('reviewer');
		expect(step.channels![0].direction).toBe('bidirectional');
		expect(step.channels![0].label).toBe('feedback');
	});

	it('throws when multi-agent step has unresolved agent ref', async () => {
		const bundle = makeMultiAgentBundle(
			[{ name: 'Coder', role: 'coder' }],
			[
				{
					name: 'Pipeline',
					steps: [
						{
							multiAgentStep: {
								name: 'Parallel',
								agents: [
									{ agentRef: 'Coder' },
									{ agentRef: 'GhostAgent' }, // not in bundle or space
								],
							},
						},
					],
				},
			]
		);

		await expect(
			call(handlers, 'spaceImport.execute', { spaceId: SPACE_ID, bundle })
		).rejects.toThrow('unresolved agent reference');
	});

	it('preview: flags unresolved agent ref in multi-agent step', async () => {
		const bundle = makeMultiAgentBundle(
			[{ name: 'Coder', role: 'coder' }],
			[
				{
					name: 'Pipeline',
					steps: [
						{
							multiAgentStep: {
								name: 'Parallel',
								agents: [{ agentRef: 'Coder' }, { agentRef: 'Missing' }],
							},
						},
					],
				},
			]
		);

		const result = await call<ImportPreviewResult>(handlers, 'spaceImport.preview', {
			spaceId: SPACE_ID,
			bundle,
		});

		expect(result.validationErrors.some((e) => e.includes('Missing'))).toBe(true);
	});

	it('backward compat: single agentRef step still imports as agentId', async () => {
		const bundle = makeSingleAgentBundle('Coder', 'coder', 'Legacy Step');

		const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
			spaceId: SPACE_ID,
			bundle,
		});

		const wf = workflowRepo.getWorkflow(result.workflows[0].id)!;
		const step = wf.steps[0];
		// Single-agent step uses agentId field, not agents[]
		const coderId = result.agents[0].id;
		expect(step.agentId).toBe(coderId);
		expect(step.agents).toBeUndefined();
	});

	it('preview: flags invalid channel role that does not match any step agent', async () => {
		const bundle = makeMultiAgentBundle(
			[
				{ name: 'Coder', role: 'coder' },
				{ name: 'Reviewer', role: 'reviewer' },
			],
			[
				{
					name: 'Pipeline',
					steps: [
						{
							multiAgentStep: {
								name: 'Parallel',
								agents: [{ agentRef: 'Coder' }, { agentRef: 'Reviewer' }],
								channels: [
									// 'typo-role' is not matched by coder or reviewer
									{ from: 'typo-role', to: 'reviewer', direction: 'one-way' as const },
								],
							},
						},
					],
				},
			]
		);

		const result = await call<ImportPreviewResult>(handlers, 'spaceImport.preview', {
			spaceId: SPACE_ID,
			bundle,
		});

		expect(result.validationErrors.some((e) => e.includes('typo-role'))).toBe(true);
	});

	it('preview: wildcard channel role is always valid', async () => {
		const bundle = makeMultiAgentBundle(
			[{ name: 'Coder', role: 'coder' }],
			[
				{
					name: 'Pipeline',
					steps: [
						{
							multiAgentStep: {
								name: 'Solo',
								agents: [{ agentRef: 'Coder' }],
								channels: [{ from: '*', to: '*', direction: 'bidirectional' as const }],
							},
						},
					],
				},
			]
		);

		const result = await call<ImportPreviewResult>(handlers, 'spaceImport.preview', {
			spaceId: SPACE_ID,
			bundle,
		});

		// '*' wildcard should not produce a channel role validation error
		expect(result.validationErrors.filter((e) => e.includes('channel'))).toHaveLength(0);
	});

	it('preview: validates channel roles from existing space agents', async () => {
		agentRepo.create({ spaceId: SPACE_ID, name: 'LocalCoder', role: 'coder' });

		// Bundle has no agents — refs resolve from existing space agents
		const bundle = makeMultiAgentBundle(
			[],
			[
				{
					name: 'Pipeline',
					steps: [
						{
							multiAgentStep: {
								name: 'Step',
								agents: [{ agentRef: 'LocalCoder' }],
								channels: [
									// 'bad-role' is not matched by LocalCoder (role='coder')
									{ from: 'bad-role', to: 'coder', direction: 'one-way' as const },
								],
							},
						},
					],
				},
			]
		);

		const result = await call<ImportPreviewResult>(handlers, 'spaceImport.preview', {
			spaceId: SPACE_ID,
			bundle,
		});

		expect(result.validationErrors.some((e) => e.includes('bad-role'))).toBe(true);
	});

	it('resolves multi-agent step refs from existing space agents', async () => {
		const existing1 = agentRepo.create({ spaceId: SPACE_ID, name: 'LocalCoder', role: 'coder' });
		const existing2 = agentRepo.create({
			spaceId: SPACE_ID,
			name: 'LocalReviewer',
			role: 'reviewer',
		});

		// Bundle has no agents — refs resolve from existing space agents
		const bundle = makeMultiAgentBundle(
			[],
			[
				{
					name: 'Pipeline',
					steps: [
						{
							multiAgentStep: {
								name: 'Parallel',
								agents: [{ agentRef: 'LocalCoder' }, { agentRef: 'LocalReviewer' }],
							},
						},
					],
				},
			]
		);

		const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
			spaceId: SPACE_ID,
			bundle,
		});

		const wf = workflowRepo.getWorkflow(result.workflows[0].id)!;
		const agentIds = wf.steps[0].agents!.map((a) => a.agentId);
		expect(agentIds).toContain(existing1.id);
		expect(agentIds).toContain(existing2.id);
	});
});

// ─── Bundle builder helpers ───────────────────────────────────────────────────

type BundleAgent = { name: string; role: string; systemPrompt?: string; model?: string };
type BundleWorkflow = {
	name: string;
	steps: Array<{ agentRef: string; name: string; instructions?: string }>;
};

function makeBundle(agents: BundleAgent[], workflows: BundleWorkflow[]): object {
	return {
		version: 1,
		type: 'bundle',
		name: 'Test Bundle',
		agents: agents.map((a) => ({
			version: 1,
			type: 'agent',
			name: a.name,
			role: a.role,
			...(a.systemPrompt ? { systemPrompt: a.systemPrompt } : {}),
			...(a.model ? { model: a.model } : {}),
		})),
		workflows: workflows.map((w) => ({
			version: 1,
			type: 'workflow',
			name: w.name,
			steps: w.steps.map((s) => ({
				agentRef: s.agentRef,
				name: s.name,
				...(s.instructions ? { instructions: s.instructions } : {}),
			})),
			transitions: [],
			startStep: w.steps[0]?.name ?? '',
			rules: [],
			tags: [],
		})),
		exportedAt: Date.now(),
	};
}

function makeBundleWithCondition(type: string, expression: string | undefined): object {
	return {
		version: 1,
		type: 'bundle',
		name: 'Condition Bundle',
		agents: [{ version: 1, type: 'agent', name: 'A', role: 'coder' }],
		workflows: [
			{
				version: 1,
				type: 'workflow',
				name: 'ConditionWF',
				steps: [
					{ agentRef: 'A', name: 'S1' },
					{ agentRef: 'A', name: 'S2' },
				],
				transitions: [
					{
						fromStep: 'S1',
						toStep: 'S2',
						condition: expression !== undefined ? { type, expression } : { type },
					},
				],
				startStep: 'S1',
				rules: [],
				tags: [],
			},
		],
		exportedAt: Date.now(),
	};
}

function makeBundleWithRules(): object {
	return {
		version: 1,
		type: 'bundle',
		name: 'Rules Bundle',
		agents: [{ version: 1, type: 'agent', name: 'Coder', role: 'coder' }],
		workflows: [
			{
				version: 1,
				type: 'workflow',
				name: 'RulesWF',
				steps: [{ agentRef: 'Coder', name: 'Code' }],
				transitions: [],
				startStep: 'Code',
				rules: [
					{
						name: 'No hacks',
						content: 'Do not write hacks.',
						appliesTo: ['Code'], // step name — should be remapped to step UUID
					},
				],
				tags: [],
			},
		],
		exportedAt: Date.now(),
	};
}

function makeTwoStepBundle(): object {
	return {
		version: 1,
		type: 'bundle',
		name: 'Two Step Bundle',
		agents: [
			{ version: 1, type: 'agent', name: 'Coder', role: 'coder' },
			{ version: 1, type: 'agent', name: 'Reviewer', role: 'reviewer' },
		],
		workflows: [
			{
				version: 1,
				type: 'workflow',
				name: 'CodingPipeline',
				steps: [
					{ agentRef: 'Coder', name: 'Code' },
					{ agentRef: 'Reviewer', name: 'Review' },
				],
				transitions: [{ fromStep: 'Code', toStep: 'Review' }],
				startStep: 'Code',
				rules: [],
				tags: [],
			},
		],
		exportedAt: Date.now(),
	};
}

// ─── Multi-agent bundle builder helpers ──────────────────────────────────────

type MultiAgentStepEntry =
	| { agentRef: string; name: string; instructions?: string }
	| {
			multiAgentStep: {
				name: string;
				agents: Array<{ agentRef: string; instructions?: string }>;
				channels?: Array<{
					from: string;
					to: string | string[];
					direction: 'one-way' | 'bidirectional';
					label?: string;
				}>;
				instructions?: string;
			};
	  };

function makeMultiAgentBundle(
	agents: BundleAgent[],
	workflows: Array<{
		name: string;
		steps: MultiAgentStepEntry[];
	}>
): object {
	return {
		version: 1,
		type: 'bundle',
		name: 'Multi-Agent Bundle',
		agents: agents.map((a) => ({
			version: 1,
			type: 'agent',
			name: a.name,
			role: a.role,
		})),
		workflows: workflows.map((w) => ({
			version: 1,
			type: 'workflow',
			name: w.name,
			steps: w.steps.map((s) => {
				if ('multiAgentStep' in s) {
					const ms = s.multiAgentStep;
					const step: Record<string, unknown> = {
						name: ms.name,
						agents: ms.agents,
					};
					if (ms.channels) step.channels = ms.channels;
					if (ms.instructions) step.instructions = ms.instructions;
					return step;
				}
				return {
					agentRef: s.agentRef,
					name: s.name,
					...(s.instructions ? { instructions: s.instructions } : {}),
				};
			}),
			transitions: [],
			startStep: w.steps[0]
				? 'multiAgentStep' in w.steps[0]
					? w.steps[0].multiAgentStep.name
					: w.steps[0].name
				: '',
			rules: [],
			tags: [],
		})),
		exportedAt: Date.now(),
	};
}

function makeSingleAgentBundle(agentName: string, agentRole: string, stepName: string): object {
	return {
		version: 1,
		type: 'bundle',
		name: 'Single Agent Bundle',
		agents: [{ version: 1, type: 'agent', name: agentName, role: agentRole }],
		workflows: [
			{
				version: 1,
				type: 'workflow',
				name: 'Legacy Workflow',
				steps: [{ agentRef: agentName, name: stepName }],
				transitions: [],
				startStep: stepName,
				rules: [],
				tags: [],
			},
		],
		exportedAt: Date.now(),
	};
}

// ─── Full export→import round-trip tests ────────────────────────────────────
//
// These tests use exportBundle() to produce a real exported bundle from
// SpaceAgent/SpaceWorkflow objects and then feed it into spaceImport.execute,
// verifying that the imported workflow is equivalent to the original.

describe('full export→import round-trip', () => {
	let db: Database;
	let agentRepo: SpaceAgentRepository;
	let workflowRepo: SpaceWorkflowRepository;
	let workflowManager: SpaceWorkflowManager;
	let spaceManager: SpaceManager;
	let handlers: Map<string, RequestHandler>;
	let daemonHub: DaemonHub;
	let emittedEvents: Array<{ name: string; data: unknown }>;

	beforeEach(() => {
		db = new Database(':memory:');
		createSchema(db);
		insertSpace(db, SPACE_ID, 'Round Trip Space');

		agentRepo = new SpaceAgentRepository(db as any);
		workflowRepo = new SpaceWorkflowRepository(db as any);

		const agentLookup: SpaceAgentLookup = {
			getAgentById(spaceId: string, id: string) {
				const agent = agentRepo.getById(id);
				if (!agent || agent.spaceId !== spaceId) return null;
				return { id: agent.id, name: agent.name, role: agent.role };
			},
		};
		workflowManager = new SpaceWorkflowManager(workflowRepo, agentLookup);
		spaceManager = createMockSpaceManager(SPACE_ID);

		const mockHub = createMockHub();
		handlers = mockHub.handlers;
		const mockDaemonHub = createMockDaemonHub();
		daemonHub = mockDaemonHub.hub;
		emittedEvents = mockDaemonHub.emittedEvents;

		setupSpaceExportImportHandlers(
			mockHub.hub,
			spaceManager,
			agentRepo,
			workflowRepo,
			workflowManager,
			db as any,
			daemonHub
		);
	});

	it('single-agent workflow round-trip: export → import produces equivalent workflow', async () => {
		// Build source agents and workflow
		const coderAgent: SpaceAgent = {
			id: 'src-agent-1',
			spaceId: 'other-space',
			name: 'My Coder',
			role: 'coder',
			systemPrompt: 'You write code.',
			tools: ['bash', 'read_file'],
			createdAt: 1000,
			updatedAt: 2000,
		};
		const workflow: SpaceWorkflow = {
			id: 'src-wf-1',
			spaceId: 'other-space',
			name: 'Code Pipeline',
			description: 'A simple coder workflow',
			steps: [
				{
					id: 'src-step-1',
					name: 'Code',
					agentId: 'src-agent-1',
					instructions: 'Write clean code',
				},
			],
			transitions: [],
			startStepId: 'src-step-1',
			rules: [
				{
					id: 'src-rule-1',
					name: 'Tests must pass',
					content: 'Run bun test before completing.',
					appliesTo: ['src-step-1'],
				},
			],
			tags: ['coding'],
			config: { maxRuntime: 3600 },
			createdAt: 1000,
			updatedAt: 2000,
		};

		const bundle = exportBundle([coderAgent], [workflow], 'Test Export');

		const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
			spaceId: SPACE_ID,
			bundle,
		});

		expect(result.agents).toHaveLength(1);
		expect(result.agents[0].name).toBe('My Coder');
		expect(result.agents[0].action).toBe('created');

		expect(result.workflows).toHaveLength(1);
		expect(result.workflows[0].name).toBe('Code Pipeline');
		expect(result.workflows[0].action).toBe('created');

		// Verify imported workflow structure
		const importedWf = workflowRepo.getWorkflow(result.workflows[0].id)!;
		expect(importedWf.name).toBe('Code Pipeline');
		expect(importedWf.description).toBe('A simple coder workflow');
		expect(importedWf.tags).toEqual(['coding']);
		expect(importedWf.config).toEqual({ maxRuntime: 3600 });

		// Step resolved to correct agentId UUID (new, not source UUID)
		const importedAgent = agentRepo.getById(result.agents[0].id)!;
		expect(importedAgent.name).toBe('My Coder');
		expect(importedAgent.role).toBe('coder');
		expect(importedAgent.systemPrompt).toBe('You write code.');
		expect(importedAgent.tools).toEqual(['bash', 'read_file']);

		const step = importedWf.steps[0];
		expect(step.name).toBe('Code');
		expect(step.agentId).toBe(importedAgent.id);
		// Must NOT be the original source UUID
		expect(step.agentId).not.toBe('src-agent-1');
		expect(step.instructions).toBe('Write clean code');

		// Rule appliesTo remapped from step name → new step UUID
		const rule = importedWf.rules[0];
		expect(rule.name).toBe('Tests must pass');
		expect(rule.appliesTo).toEqual([step.id]);

		// Events emitted for real-time frontend updates
		const agentCreatedEvents = emittedEvents.filter((e) => e.name === 'spaceAgent.created');
		const wfCreatedEvents = emittedEvents.filter((e) => e.name === 'spaceWorkflow.created');
		expect(agentCreatedEvents).toHaveLength(1);
		expect(wfCreatedEvents).toHaveLength(1);
		expect((agentCreatedEvents[0].data as any).agent.name).toBe('My Coder');
		expect((wfCreatedEvents[0].data as any).workflow.name).toBe('Code Pipeline');
	});

	it('multi-agent step round-trip: export → import preserves agents array and channels', async () => {
		const coderAgent: SpaceAgent = {
			id: 'src-coder',
			spaceId: 'other-space',
			name: 'Senior Coder',
			role: 'coder',
			createdAt: 1000,
			updatedAt: 2000,
		};
		const reviewerAgent: SpaceAgent = {
			id: 'src-reviewer',
			spaceId: 'other-space',
			name: 'Code Reviewer',
			role: 'reviewer',
			createdAt: 1000,
			updatedAt: 2000,
		};

		const workflow: SpaceWorkflow = {
			id: 'src-wf-ma',
			spaceId: 'other-space',
			name: 'Collab Workflow',
			steps: [
				{
					id: 'step-ma',
					name: 'Code and Review',
					agents: [
						{ agentId: 'src-coder', instructions: 'Implement the feature' },
						{ agentId: 'src-reviewer', instructions: 'Review thoroughly' },
					],
					channels: [
						{ from: 'coder', to: 'reviewer', direction: 'bidirectional', label: 'feedback' },
					],
					instructions: 'Collaborate on the task',
				},
			],
			transitions: [],
			startStepId: 'step-ma',
			rules: [],
			tags: ['collab'],
			createdAt: 1000,
			updatedAt: 2000,
		};

		const bundle = exportBundle([coderAgent, reviewerAgent], [workflow], 'MA Export');
		const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
			spaceId: SPACE_ID,
			bundle,
		});

		expect(result.agents).toHaveLength(2);
		expect(result.workflows).toHaveLength(1);

		const importedWf = workflowRepo.getWorkflow(result.workflows[0].id)!;
		const importedStep = importedWf.steps[0];

		// Multi-agent step preserved
		expect(importedStep.agents).toHaveLength(2);
		expect(importedStep.agentId).toBeUndefined();

		// AgentIds resolved to new UUIDs (not source UUIDs)
		const coderImported = agentRepo.getById(
			result.agents.find((a) => a.name === 'Senior Coder')!.id
		)!;
		const reviewerImported = agentRepo.getById(
			result.agents.find((a) => a.name === 'Code Reviewer')!.id
		)!;
		const importedAgentIds = importedStep.agents!.map((a) => a.agentId);
		expect(importedAgentIds).toContain(coderImported.id);
		expect(importedAgentIds).toContain(reviewerImported.id);
		expect(importedAgentIds).not.toContain('src-coder');
		expect(importedAgentIds).not.toContain('src-reviewer');

		// Per-agent instructions preserved
		const coderEntry = importedStep.agents!.find((a) => a.agentId === coderImported.id)!;
		const reviewerEntry = importedStep.agents!.find((a) => a.agentId === reviewerImported.id)!;
		expect(coderEntry.instructions).toBe('Implement the feature');
		expect(reviewerEntry.instructions).toBe('Review thoroughly');

		// Shared step instructions preserved
		expect(importedStep.instructions).toBe('Collaborate on the task');

		// Channels preserved (role strings, not UUIDs)
		expect(importedStep.channels).toHaveLength(1);
		expect(importedStep.channels![0].from).toBe('coder');
		expect(importedStep.channels![0].to).toBe('reviewer');
		expect(importedStep.channels![0].direction).toBe('bidirectional');
		expect(importedStep.channels![0].label).toBe('feedback');
	});

	it('channel topology round-trip: one-way channel preserved', async () => {
		const agentA: SpaceAgent = {
			id: 'src-a',
			spaceId: 'other-space',
			name: 'Agent Alpha',
			role: 'alpha',
			createdAt: 1000,
			updatedAt: 2000,
		};
		const agentB: SpaceAgent = {
			id: 'src-b',
			spaceId: 'other-space',
			name: 'Agent Beta',
			role: 'beta',
			createdAt: 1000,
			updatedAt: 2000,
		};

		const workflow: SpaceWorkflow = {
			id: 'src-wf-ow',
			spaceId: 'other-space',
			name: 'One-Way Workflow',
			steps: [
				{
					id: 'step-ow',
					name: 'Directed',
					agents: [{ agentId: 'src-a' }, { agentId: 'src-b' }],
					channels: [{ from: 'alpha', to: 'beta', direction: 'one-way' }],
				},
			],
			transitions: [],
			startStepId: 'step-ow',
			rules: [],
			tags: [],
			createdAt: 1000,
			updatedAt: 2000,
		};

		const bundle = exportBundle([agentA, agentB], [workflow], 'One-Way Export');
		const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
			spaceId: SPACE_ID,
			bundle,
		});

		const importedWf = workflowRepo.getWorkflow(result.workflows[0].id)!;
		const ch = importedWf.steps[0].channels![0];
		expect(ch.from).toBe('alpha');
		expect(ch.to).toBe('beta');
		expect(ch.direction).toBe('one-way');
	});

	it('channel topology round-trip: fan-out (array `to`) preserved', async () => {
		const hub: SpaceAgent = {
			id: 'src-hub',
			spaceId: 'other-space',
			name: 'Hub Agent',
			role: 'hub',
			createdAt: 1000,
			updatedAt: 2000,
		};
		const spoke1: SpaceAgent = {
			id: 'src-spoke1',
			spaceId: 'other-space',
			name: 'Spoke One',
			role: 'spoke1',
			createdAt: 1000,
			updatedAt: 2000,
		};
		const spoke2: SpaceAgent = {
			id: 'src-spoke2',
			spaceId: 'other-space',
			name: 'Spoke Two',
			role: 'spoke2',
			createdAt: 1000,
			updatedAt: 2000,
		};

		const workflow: SpaceWorkflow = {
			id: 'src-wf-fanout',
			spaceId: 'other-space',
			name: 'Fan-Out Workflow',
			steps: [
				{
					id: 'step-fo',
					name: 'Fan Out',
					agents: [{ agentId: 'src-hub' }, { agentId: 'src-spoke1' }, { agentId: 'src-spoke2' }],
					channels: [{ from: 'hub', to: ['spoke1', 'spoke2'], direction: 'one-way' }],
				},
			],
			transitions: [],
			startStepId: 'step-fo',
			rules: [],
			tags: [],
			createdAt: 1000,
			updatedAt: 2000,
		};

		const bundle = exportBundle([hub, spoke1, spoke2], [workflow], 'Fan-Out Export');
		const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
			spaceId: SPACE_ID,
			bundle,
		});

		const importedWf = workflowRepo.getWorkflow(result.workflows[0].id)!;
		const ch = importedWf.steps[0].channels![0];
		expect(ch.from).toBe('hub');
		expect(ch.to).toEqual(['spoke1', 'spoke2']);
		expect(ch.direction).toBe('one-way');
	});

	it('channel topology round-trip: wildcard (*) preserved', async () => {
		const a: SpaceAgent = {
			id: 'src-wa',
			spaceId: 'other-space',
			name: 'Wild Agent',
			role: 'wild',
			createdAt: 1000,
			updatedAt: 2000,
		};

		const workflow: SpaceWorkflow = {
			id: 'src-wf-wc',
			spaceId: 'other-space',
			name: 'Wildcard Workflow',
			steps: [
				{
					id: 'step-wc',
					name: 'Broadcast',
					agents: [{ agentId: 'src-wa' }],
					channels: [{ from: '*', to: '*', direction: 'bidirectional' }],
				},
			],
			transitions: [],
			startStepId: 'step-wc',
			rules: [],
			tags: [],
			createdAt: 1000,
			updatedAt: 2000,
		};

		const bundle = exportBundle([a], [workflow], 'Wildcard Export');
		const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
			spaceId: SPACE_ID,
			bundle,
		});

		const importedWf = workflowRepo.getWorkflow(result.workflows[0].id)!;
		const ch = importedWf.steps[0].channels![0];
		expect(ch.from).toBe('*');
		expect(ch.to).toBe('*');
		expect(ch.direction).toBe('bidirectional');
	});

	it('mixed single/multi-agent workflow round-trip preserves both step types', async () => {
		const plannerAgent: SpaceAgent = {
			id: 'src-planner',
			spaceId: 'other-space',
			name: 'Planner',
			role: 'planner',
			createdAt: 1000,
			updatedAt: 2000,
		};
		const coderAgent2: SpaceAgent = {
			id: 'src-coder2',
			spaceId: 'other-space',
			name: 'Coder2',
			role: 'coder',
			createdAt: 1000,
			updatedAt: 2000,
		};
		const reviewAgent: SpaceAgent = {
			id: 'src-review',
			spaceId: 'other-space',
			name: 'Reviewer2',
			role: 'reviewer',
			createdAt: 1000,
			updatedAt: 2000,
		};

		const workflow: SpaceWorkflow = {
			id: 'src-wf-mix',
			spaceId: 'other-space',
			name: 'Mixed Workflow',
			steps: [
				{
					id: 'step-plan',
					name: 'Plan',
					agentId: 'src-planner',
					instructions: 'Create a plan',
				},
				{
					id: 'step-collab',
					name: 'Implement and Review',
					agents: [
						{ agentId: 'src-coder2', instructions: 'Implement' },
						{ agentId: 'src-review', instructions: 'Review' },
					],
					channels: [{ from: 'coder', to: 'reviewer', direction: 'one-way' }],
				},
			],
			transitions: [{ id: 'trans-1', from: 'step-plan', to: 'step-collab' }],
			startStepId: 'step-plan',
			rules: [],
			tags: ['mixed'],
			createdAt: 1000,
			updatedAt: 2000,
		};

		const bundle = exportBundle(
			[plannerAgent, coderAgent2, reviewAgent],
			[workflow],
			'Mixed Export'
		);
		const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
			spaceId: SPACE_ID,
			bundle,
		});

		const importedWf = workflowRepo.getWorkflow(result.workflows[0].id)!;
		expect(importedWf.steps).toHaveLength(2);

		// Step 0: single-agent (plan)
		const planStep = importedWf.steps.find((s) => s.name === 'Plan')!;
		expect(planStep.agentId).toBeDefined();
		expect(planStep.agents).toBeUndefined();
		expect(planStep.instructions).toBe('Create a plan');

		// Step 1: multi-agent (implement and review)
		const collabStep = importedWf.steps.find((s) => s.name === 'Implement and Review')!;
		expect(collabStep.agents).toHaveLength(2);
		expect(collabStep.agentId).toBeUndefined();
		expect(collabStep.channels).toHaveLength(1);
		expect(collabStep.channels![0].direction).toBe('one-way');

		// Transition preserved with remapped step UUID endpoints
		expect(importedWf.transitions).toHaveLength(1);
		const transition = importedWf.transitions[0];
		expect(transition.from).toBe(planStep.id);
		expect(transition.to).toBe(collabStep.id);
		expect(importedWf.startStepId).toBe(planStep.id);

		// Tags preserved
		expect(importedWf.tags).toEqual(['mixed']);
	});

	it('backward compat: single agentRef export → import via exportBundle', async () => {
		// Simulates exporting an old-style workflow (single agentId, no agents[])
		// using exportBundle and importing it back — must produce agentId, not agents[]
		const agentSrc: SpaceAgent = {
			id: 'src-legacy',
			spaceId: 'other-space',
			name: 'Legacy Coder',
			role: 'coder',
			createdAt: 1000,
			updatedAt: 2000,
		};
		const wfSrc: SpaceWorkflow = {
			id: 'src-wf-legacy',
			spaceId: 'other-space',
			name: 'Legacy Workflow',
			steps: [{ id: 'step-l', name: 'Code', agentId: 'src-legacy' }],
			transitions: [],
			startStepId: 'step-l',
			rules: [],
			tags: [],
			createdAt: 1000,
			updatedAt: 2000,
		};

		const bundle = exportBundle([agentSrc], [wfSrc], 'Legacy Export');
		const result = await call<ImportExecuteResult>(handlers, 'spaceImport.execute', {
			spaceId: SPACE_ID,
			bundle,
		});

		const importedWf = workflowRepo.getWorkflow(result.workflows[0].id)!;
		const step = importedWf.steps[0];
		// Old-style single agentId must be preserved as scalar agentId
		expect(step.agentId).toBeDefined();
		expect(step.agents).toBeUndefined();
		// Must map to the imported agent's UUID, not the original
		const importedAgentId = result.agents[0].id;
		expect(step.agentId).toBe(importedAgentId);
	});

	it('error: import with unknown agentRef in multi-agent step throws and rolls back', async () => {
		const agentSrc: SpaceAgent = {
			id: 'src-known',
			spaceId: 'other-space',
			name: 'Known Agent',
			role: 'coder',
			createdAt: 1000,
			updatedAt: 2000,
		};
		// Deliberately reference an agent that is NOT in the bundle
		const wfSrc: SpaceWorkflow = {
			id: 'src-wf-err',
			spaceId: 'other-space',
			name: 'Bad Workflow',
			steps: [
				{
					id: 'step-bad',
					name: 'Parallel',
					agents: [
						{ agentId: 'src-known' },
						{ agentId: 'src-ghost' }, // not in bundle
					],
				},
			],
			transitions: [],
			startStepId: 'step-bad',
			rules: [],
			tags: [],
			createdAt: 1000,
			updatedAt: 2000,
		};

		// Only include known agent in export, so ghost UUID falls back to UUID string
		const bundle = exportBundle([agentSrc], [wfSrc], 'Bad Export');

		// The ghost agent's UUID (src-ghost) will be used as the agentRef in the export
		// since it cannot be resolved to a name. On import it will be an unknown ref.
		await expect(
			call(handlers, 'spaceImport.execute', { spaceId: SPACE_ID, bundle })
		).rejects.toThrow('unresolved agent reference');

		// Transaction rolled back: no agents or workflows created
		expect(agentRepo.getBySpaceId(SPACE_ID)).toHaveLength(0);
		expect(workflowRepo.listWorkflows(SPACE_ID)).toHaveLength(0);
	});

	it('error: channel role not present in imported agents produces preview validation error', async () => {
		const agentSrc: SpaceAgent = {
			id: 'src-solo',
			spaceId: 'other-space',
			name: 'Solo Coder',
			role: 'coder',
			createdAt: 1000,
			updatedAt: 2000,
		};
		const wfSrc: SpaceWorkflow = {
			id: 'src-wf-badch',
			spaceId: 'other-space',
			name: 'Bad Channel Workflow',
			steps: [
				{
					id: 'step-bc',
					name: 'Work',
					agents: [{ agentId: 'src-solo' }],
					channels: [
						// 'nonexistent-role' is not the role of Solo Coder
						{ from: 'nonexistent-role', to: 'coder', direction: 'one-way' },
					],
				},
			],
			transitions: [],
			startStepId: 'step-bc',
			rules: [],
			tags: [],
			createdAt: 1000,
			updatedAt: 2000,
		};

		const bundle = exportBundle([agentSrc], [wfSrc], 'Bad Channel Export');
		const preview = await call<ImportPreviewResult>(handlers, 'spaceImport.preview', {
			spaceId: SPACE_ID,
			bundle,
		});

		expect(preview.validationErrors.length).toBeGreaterThan(0);
		expect(preview.validationErrors.some((e) => e.includes('nonexistent-role'))).toBe(true);
	});

	it('error: execute rejects workflow with invalid channel role and rolls back', async () => {
		// This test verifies that spaceImport.execute — not just preview — enforces
		// channel role validation via SpaceWorkflowManager.createWorkflow().
		// A regression that bypasses validateChannelRoleRef in the execute path
		// would leave the DB in a partial state; this test catches that.
		const agentSrc: SpaceAgent = {
			id: 'src-exec-solo',
			spaceId: 'other-space',
			name: 'Exec Coder',
			role: 'coder',
			createdAt: 1000,
			updatedAt: 2000,
		};
		const wfSrc: SpaceWorkflow = {
			id: 'src-wf-exec-badch',
			spaceId: 'other-space',
			name: 'Exec Bad Channel Workflow',
			steps: [
				{
					id: 'step-exec-bc',
					name: 'Work',
					agents: [{ agentId: 'src-exec-solo' }],
					channels: [
						// 'bad-exec-role' does not match the agent's role 'coder'
						{ from: 'bad-exec-role', to: 'coder', direction: 'one-way' },
					],
				},
			],
			transitions: [],
			startStepId: 'step-exec-bc',
			rules: [],
			tags: [],
			createdAt: 1000,
			updatedAt: 2000,
		};

		const bundle = exportBundle([agentSrc], [wfSrc], 'Exec Bad Channel Export');

		// execute must throw — WorkflowValidationError from validateChannelRoleRef
		await expect(
			call(handlers, 'spaceImport.execute', { spaceId: SPACE_ID, bundle })
		).rejects.toThrow();

		// Transaction rolled back: agent was created then rolled back along with workflow
		expect(agentRepo.getBySpaceId(SPACE_ID)).toHaveLength(0);
		expect(workflowRepo.listWorkflows(SPACE_ID)).toHaveLength(0);
	});
});
