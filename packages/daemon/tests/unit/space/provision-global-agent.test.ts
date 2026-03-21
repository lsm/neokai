/**
 * provisionGlobalSpacesAgent — integration-style unit tests
 *
 * Verifies:
 * 1. After provisioning the runtime has a non-null notification sink (setter called)
 * 2. End-to-end flow: a tick that produces a notification event results in a message
 *    being injected into the global `spaces:global` session via sessionFactory.injectMessage()
 * 3. Wiring order: session created → sink created → setNotificationSink() called
 * 4. Provisioning also works on restart (session already exists)
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../src/storage/schema/index.ts';
import { provisionGlobalSpacesAgent } from '../../../src/lib/space/provision-global-agent.ts';
import type { ProvisionGlobalSpacesAgentDeps } from '../../../src/lib/space/provision-global-agent.ts';
import { SpaceRuntimeService } from '../../../src/lib/space/runtime/space-runtime-service.ts';
import { SpaceWorkflowRepository } from '../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository.ts';
import { SpaceAgentRepository } from '../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager } from '../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../src/lib/space/managers/space-manager.ts';
import type { SessionFactory } from '../../../src/lib/room/runtime/task-group-manager.ts';
import type { SessionManager } from '../../../src/lib/session-manager.ts';
import type { SpaceAgentManager as ISpaceAgentManager } from '../../../src/lib/space/managers/space-agent-manager.ts';
import type { SpaceWorkflowManager as ISpaceWorkflowManager } from '../../../src/lib/space/managers/space-workflow-manager.ts';
import type { SpaceTaskRepository as ISpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository.ts';
import type { SpaceWorkflowRunRepository as ISpaceWorkflowRunRepository } from '../../../src/storage/repositories/space-workflow-run-repository.ts';
import type { MessageDeliveryMode } from '@neokai/shared';
import type { GlobalSpacesState } from '../../../src/lib/space/tools/global-spaces-tools.ts';
import type { NotificationSink } from '../../../src/lib/space/runtime/notification-sink.ts';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-provision-global-agent',
		`t-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return { db, dir };
}

function seedSpaceRow(db: BunDatabase, spaceId: string): void {
	db.prepare(
		`INSERT INTO spaces (id, workspace_path, name, description, background_context, instructions,
     allowed_models, session_ids, status, created_at, updated_at)
     VALUES (?, ?, ?, '', '', '', '[]', '[]', 'active', ?, ?)`
	).run(spaceId, '/tmp/workspace', `Space ${spaceId}`, Date.now(), Date.now());
}

function seedAgentRow(db: BunDatabase, agentId: string, spaceId: string): void {
	db.prepare(
		`INSERT INTO space_agents (id, space_id, name, role, description, model, tools, system_prompt,
     config, created_at, updated_at)
     VALUES (?, ?, ?, ?, '', null, '[]', '', null, ?, ?)`
	).run(agentId, spaceId, `Agent ${agentId}`, 'coder', Date.now(), Date.now());
}

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

interface InjectedCall {
	sessionId: string;
	message: string;
	opts?: { deliveryMode?: MessageDeliveryMode };
}

function makeMockSessionFactory(opts?: {
	injectError?: Error;
}): SessionFactory & { calls: InjectedCall[] } {
	const calls: InjectedCall[] = [];
	return {
		calls,
		createAndStartSession: async () => {},
		injectMessage: async (
			sessionId: string,
			message: string,
			injectOpts?: { deliveryMode?: MessageDeliveryMode }
		) => {
			if (opts?.injectError) throw opts.injectError;
			calls.push({ sessionId, message, opts: injectOpts });
		},
		hasSession: () => true,
		answerQuestion: async () => false,
		createWorktree: async () => null,
		restoreSession: async () => false,
		startSession: async () => false,
		setSessionMcpServers: () => false,
		removeWorktree: async () => false,
	} as unknown as SessionFactory & { calls: InjectedCall[] };
}

/** Minimal AgentSession stub with just the methods provision-global-agent.ts calls. */
function makeAgentSessionStub() {
	return {
		setRuntimeMcpServers: mock(() => {}),
		setRuntimeSystemPrompt: mock(() => {}),
	};
}

function makeMockSessionManager(opts?: {
	sessionExistsOnFirstGet?: boolean;
}): SessionManager & { createCalls: number } {
	let getCallCount = 0;
	const sessionExistsOnFirstGet = opts?.sessionExistsOnFirstGet ?? false;
	const stub = makeAgentSessionStub();

	const mgr = {
		createCalls: 0,
		getSessionAsync: mock(async () => {
			getCallCount++;
			// First call: session may or may not exist; all subsequent calls return the stub
			if (getCallCount === 1 && !sessionExistsOnFirstGet) return null;
			return stub;
		}),
		createSession: mock(async () => {
			mgr.createCalls++;
		}),
	} as unknown as SessionManager & { createCalls: number };

	return mgr;
}

/** SpaceRuntimeService spy that tracks setNotificationSink calls. */
class SpySpaceRuntimeService extends SpaceRuntimeService {
	readonly sinkCalls: NotificationSink[] = [];

	override setNotificationSink(sink: NotificationSink): void {
		this.sinkCalls.push(sink);
		super.setNotificationSink(sink);
	}
}

// ---------------------------------------------------------------------------
// Shared fixture builder
// ---------------------------------------------------------------------------

function buildDeps(
	db: BunDatabase,
	opts: {
		sessionManager?: SessionManager & { createCalls: number };
		sessionFactory?: SessionFactory & { calls: InjectedCall[] };
		spyService?: SpySpaceRuntimeService;
	} = {}
): ProvisionGlobalSpacesAgentDeps & {
	sessionManager: SessionManager & { createCalls: number };
	sessionFactory: SessionFactory & { calls: InjectedCall[] };
	spyService: SpySpaceRuntimeService;
} {
	const workflowRunRepo = new SpaceWorkflowRunRepository(db);
	const taskRepo = new SpaceTaskRepository(db);
	const agentRepo = new SpaceAgentRepository(db);
	const agentManager = new SpaceAgentManager(agentRepo);
	const workflowRepo = new SpaceWorkflowRepository(db);

	const agentLookup = {
		getAgentById(spaceId: string, id: string) {
			const agent = agentRepo.getById(id);
			if (!agent || agent.spaceId !== spaceId) return null;
			return { id: agent.id, name: agent.name };
		},
	};
	const workflowManager = new SpaceWorkflowManager(workflowRepo, agentLookup);
	const spaceManager = new SpaceManager(db);

	const spyService =
		opts.spyService ??
		new SpySpaceRuntimeService({
			db,
			spaceManager,
			spaceAgentManager: agentManager,
			spaceWorkflowManager: workflowManager,
			workflowRunRepo,
			taskRepo,
			tickIntervalMs: 100_000, // won't auto-tick
		});

	const sessionManager = opts.sessionManager ?? makeMockSessionManager();
	const sessionFactory = opts.sessionFactory ?? makeMockSessionFactory();
	const state: GlobalSpacesState = { activeSpaceId: null };

	return {
		sessionManager,
		spaceManager,
		spaceAgentManager: agentManager,
		spaceWorkflowManager: workflowManager,
		spaceRuntimeService: spyService,
		sessionFactory,
		taskRepo,
		workflowRunRepo,
		state,
		spyService,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('provisionGlobalSpacesAgent', () => {
	let db: BunDatabase;
	let dir: string;

	beforeEach(() => {
		({ db, dir } = makeDb());
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
	// Core wiring
	// -------------------------------------------------------------------------

	test('calls setNotificationSink on SpaceRuntimeService after creating the session', async () => {
		const deps = buildDeps(db);

		await provisionGlobalSpacesAgent(deps);

		expect(deps.spyService.sinkCalls).toHaveLength(1);
	});

	test('wires a SessionNotificationSink (not null or NullNotificationSink)', async () => {
		const deps = buildDeps(db);

		await provisionGlobalSpacesAgent(deps);

		const sink = deps.spyService.sinkCalls[0];
		expect(sink).not.toBeNull();
		expect(sink).not.toBeUndefined();
		// SessionNotificationSink has a notify() method
		expect(typeof sink.notify).toBe('function');
	});

	test('creates the session before calling setNotificationSink (order check)', async () => {
		const callOrder: string[] = [];

		const sessionManager = {
			createCalls: 0,
			getSessionAsync: mock(async () => {
				let count = 0;
				return async () => {
					count++;
					return count === 1 ? null : makeAgentSessionStub();
				};
			}),
			createSession: mock(async () => {
				callOrder.push('createSession');
				sessionManager.createCalls++;
			}),
		} as unknown as SessionManager & { createCalls: number };

		// Reimplement getSessionAsync manually to capture order
		let getCount = 0;
		const stub = makeAgentSessionStub();
		(
			sessionManager as unknown as { getSessionAsync: (id: string) => Promise<unknown> }
		).getSessionAsync = mock(async (_id: string) => {
			getCount++;
			if (getCount === 1) return null;
			return stub;
		});

		const spyService = new SpySpaceRuntimeService({
			db,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: {} as ISpaceAgentManager,
			spaceWorkflowManager: new SpaceWorkflowManager(new SpaceWorkflowRepository(db), {
				getAgentById: () => null,
			}),
			workflowRunRepo: new SpaceWorkflowRunRepository(db),
			taskRepo: new SpaceTaskRepository(db),
			tickIntervalMs: 100_000,
		});

		const originalSetSink = spyService.setNotificationSink.bind(spyService);
		(
			spyService as unknown as { setNotificationSink: (s: NotificationSink) => void }
		).setNotificationSink = (sink: NotificationSink) => {
			callOrder.push('setNotificationSink');
			originalSetSink(sink);
			spyService.sinkCalls.push(sink);
		};

		const deps: ProvisionGlobalSpacesAgentDeps = {
			sessionManager,
			spaceManager: new SpaceManager(db),
			spaceAgentManager: {} as ISpaceAgentManager,
			spaceWorkflowManager: new SpaceWorkflowManager(new SpaceWorkflowRepository(db), {
				getAgentById: () => null,
			}),
			spaceRuntimeService: spyService,
			sessionFactory: makeMockSessionFactory(),
			taskRepo: new SpaceTaskRepository(db),
			workflowRunRepo: new SpaceWorkflowRunRepository(db),
			state: { activeSpaceId: null },
		};

		await provisionGlobalSpacesAgent(deps);

		expect(callOrder.indexOf('createSession')).toBeLessThan(
			callOrder.indexOf('setNotificationSink')
		);
	});

	test('wires sink even when session already exists (daemon restart path)', async () => {
		// Simulate a daemon restart: session already exists on first getSessionAsync call
		const stub = makeAgentSessionStub();
		const sessionManager = {
			createCalls: 0,
			getSessionAsync: mock(async () => stub), // always returns stub
			createSession: mock(async () => {
				sessionManager.createCalls++;
			}),
		} as unknown as SessionManager & { createCalls: number };

		const deps = buildDeps(db, { sessionManager });

		await provisionGlobalSpacesAgent(deps);

		// Session was NOT re-created
		expect(deps.sessionManager.createCalls).toBe(0);
		// But sink was still wired
		expect(deps.spyService.sinkCalls).toHaveLength(1);
	});

	// -------------------------------------------------------------------------
	// End-to-end: tick → notification → injectMessage
	// -------------------------------------------------------------------------

	test('end-to-end: a tick producing a task_needs_attention event injects a message into the global session', async () => {
		const SPACE_ID = 'space-provision-e2e';
		const AGENT_ID = 'agent-provision-e2e';
		const STEP_ID = 'step-provision-e2e';

		seedSpaceRow(db, SPACE_ID);
		seedAgentRow(db, AGENT_ID, SPACE_ID);

		const sessionFactory = makeMockSessionFactory();
		const deps = buildDeps(db, { sessionFactory });

		await provisionGlobalSpacesAgent(deps);

		const runtime = deps.spyService.getSharedRuntime();

		// Create a workflow with one step and start a run
		const workflowManager = deps.spaceWorkflowManager as SpaceWorkflowManager;
		const workflow = workflowManager.createWorkflow({
			spaceId: SPACE_ID,
			name: 'E2E Provision Test Workflow',
			description: '',
			steps: [{ id: STEP_ID, name: 'Code', agentId: AGENT_ID }],
			transitions: [],
			startStepId: STEP_ID,
			rules: [],
			tags: [],
		});

		const { tasks } = await runtime.startWorkflowRun(SPACE_ID, workflow.id, 'E2E Run');
		// Simulate task failure — set to needs_attention
		const taskRepo = deps.taskRepo as SpaceTaskRepository;
		taskRepo.updateTask(tasks[0].id, { status: 'needs_attention', error: 'Build failed' });

		// Trigger a manual tick — this should detect needs_attention tasks and emit notifications
		await runtime.executeTick();

		// The notification should have been injected into the spaces:global session
		expect(sessionFactory.calls.length).toBeGreaterThanOrEqual(1);
		const call = sessionFactory.calls[0];
		expect(call.sessionId).toBe('spaces:global');
		expect(call.message).toContain('[TASK_EVENT]');
		expect(call.opts?.deliveryMode).toBe('next_turn');
	});
});
