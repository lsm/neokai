/**
 * Tests for provisionGlobalSpacesAgent + AppMcpLifecycleManager integration (Task 3.4).
 *
 * Verifies that:
 * 1. Registry-sourced MCP servers are merged alongside the in-process
 *    'global-spaces-tools' server in the setRuntimeMcpServers() call.
 * 2. The in-process 'global-spaces-tools' server takes precedence over a registry
 *    entry with the same name.
 * 3. appMcpManager is optional — omitting it does not throw; only the in-process
 *    server is injected.
 * 4. Multiple registry servers are all included in the merged map.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database as BunDatabase } from 'bun:sqlite';
import { runMigrations } from '../../../../src/storage/schema/index.ts';
import {
	provisionGlobalSpacesAgent,
	type ProvisionGlobalSpacesAgentDeps,
} from '../../../../src/lib/space/provision-global-agent.ts';
import { SpaceRuntimeService } from '../../../../src/lib/space/runtime/space-runtime-service.ts';
import { SpaceWorkflowRepository } from '../../../../src/storage/repositories/space-workflow-repository.ts';
import { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository.ts';
import { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import type { McpServerConfig } from '@neokai/shared';
import type { SessionManager } from '../../../../src/lib/session-manager.ts';
import type { SessionFactory } from '../../../../src/lib/room/runtime/task-group-manager.ts';
import type { GlobalSpacesState } from '../../../../src/lib/space/tools/global-spaces-tools.ts';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

function makeDb(): { db: BunDatabase; dir: string } {
	const dir = join(
		process.cwd(),
		'tmp',
		'test-provision-global-mcp',
		`t-${Date.now()}-${Math.random().toString(36).slice(2)}`
	);
	mkdirSync(dir, { recursive: true });
	const db = new BunDatabase(join(dir, 'test.db'));
	db.exec('PRAGMA foreign_keys = ON');
	runMigrations(db, () => {});
	return { db, dir };
}

// ---------------------------------------------------------------------------
// Session stub that captures setRuntimeMcpServers calls
// ---------------------------------------------------------------------------

interface SessionStub {
	setRuntimeMcpServers: ReturnType<typeof mock>;
	setRuntimeSystemPrompt: ReturnType<typeof mock>;
	/** All maps passed to setRuntimeMcpServers, in call order */
	capturedMcpMaps: Array<Record<string, McpServerConfig>>;
}

function makeSessionStub(): SessionStub {
	const capturedMcpMaps: Array<Record<string, McpServerConfig>> = [];
	return {
		capturedMcpMaps,
		setRuntimeMcpServers: mock((map: Record<string, McpServerConfig>) => {
			capturedMcpMaps.push(map);
		}),
		setRuntimeSystemPrompt: mock(() => {}),
	};
}

// ---------------------------------------------------------------------------
// Session manager that returns a controlled stub
// ---------------------------------------------------------------------------

function makeSessionManager(stub: SessionStub): SessionManager {
	let callCount = 0;
	return {
		getSessionAsync: mock(async () => {
			callCount++;
			// First call: session does not exist (trigger createSession)
			if (callCount === 1) return null;
			// Subsequent calls: return stub
			return stub as never;
		}),
		createSession: mock(async () => {}),
	} as unknown as SessionManager;
}

// ---------------------------------------------------------------------------
// Minimal session factory
// ---------------------------------------------------------------------------

function makeSessionFactory(): SessionFactory {
	return {
		createAndStartSession: async () => {},
		injectMessage: async () => {},
		hasSession: () => true,
		answerQuestion: async () => false as const,
		createWorktree: async () => null,
		restoreSession: async () => false as const,
		startSession: async () => false as const,
		setSessionMcpServers: () => false as const,
		removeWorktree: async () => null,
		getProcessingState: () => undefined,
	} as unknown as SessionFactory;
}

// ---------------------------------------------------------------------------
// Build minimal deps for provisionGlobalSpacesAgent
// ---------------------------------------------------------------------------

function buildDeps(
	db: BunDatabase,
	opts: {
		registryMcpServers?: Record<string, McpServerConfig>;
		hasAppMcpManager?: boolean;
		stub?: SessionStub;
	} = {}
): { deps: ProvisionGlobalSpacesAgentDeps; stub: SessionStub } {
	const { registryMcpServers = {}, hasAppMcpManager = true } = opts;
	const stub = opts.stub ?? makeSessionStub();

	const workflowRunRepo = new SpaceWorkflowRunRepository(db);
	const nodeExecutionRepo = new NodeExecutionRepository(db);
	const taskRepo = new SpaceTaskRepository(db);
	const agentRepo = new SpaceAgentRepository(db);
	const agentManager = new SpaceAgentManager(agentRepo);
	const workflowRepo = new SpaceWorkflowRepository(db);
	const workflowManager = new SpaceWorkflowManager(workflowRepo);
	const spaceManager = new SpaceManager(db);

	const spaceRuntimeService = new SpaceRuntimeService({
		db,
		spaceManager,
		spaceAgentManager: agentManager,
		spaceWorkflowManager: workflowManager,
		workflowRunRepo,
		taskRepo,
		tickIntervalMs: 100_000,
	});

	const appMcpManager = hasAppMcpManager
		? { getEnabledMcpConfigs: () => registryMcpServers }
		: undefined;

	const state: GlobalSpacesState = { activeSpaceId: null };

	const deps: ProvisionGlobalSpacesAgentDeps = {
		sessionManager: makeSessionManager(stub),
		spaceManager,
		spaceAgentManager: agentManager,
		spaceWorkflowManager: workflowManager,
		spaceRuntimeService,
		sessionFactory: makeSessionFactory(),
		taskRepo,
		workflowRunRepo,
		nodeExecutionRepo,
		db,
		state,
		appMcpManager: appMcpManager as never,
	};

	return { deps, stub };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('provisionGlobalSpacesAgent — registry MCP merge (Task 3.4)', () => {
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
			rmSync(dir, { recursive: true });
		} catch {
			/* ignore */
		}
	});

	test('registry servers are merged into setRuntimeMcpServers alongside global-spaces-tools', async () => {
		const registryServer: McpServerConfig = { type: 'stdio', command: 'registry-cmd' };
		const { deps, stub } = buildDeps(db, {
			registryMcpServers: { 'registry-mcp': registryServer },
		});

		await provisionGlobalSpacesAgent(deps);

		expect(stub.capturedMcpMaps.length).toBe(1);
		const merged = stub.capturedMcpMaps[0]!;
		expect(merged['registry-mcp']).toBeDefined();
		expect(merged['global-spaces-tools']).toBeDefined();
	});

	test('in-process global-spaces-tools takes precedence over registry entry with same name', async () => {
		// A registry entry named 'global-spaces-tools' must NOT override the in-process server.
		const impostor: McpServerConfig = { type: 'stdio', command: 'impostor' };
		const { deps, stub } = buildDeps(db, {
			registryMcpServers: { 'global-spaces-tools': impostor },
		});

		await provisionGlobalSpacesAgent(deps);

		expect(stub.capturedMcpMaps.length).toBe(1);
		const merged = stub.capturedMcpMaps[0]!;
		const server = merged['global-spaces-tools'] as McpServerConfig & { command?: string };
		// The impostor has command: 'impostor'; the real in-process server is an MCP SDK Server
		// object (no .command property), so if command is missing or different the real server won.
		expect(server.command).not.toBe('impostor');
	});

	test('works without appMcpManager — only global-spaces-tools is injected', async () => {
		const { deps, stub } = buildDeps(db, { hasAppMcpManager: false });

		await provisionGlobalSpacesAgent(deps);

		expect(stub.capturedMcpMaps.length).toBe(1);
		const merged = stub.capturedMcpMaps[0]!;
		expect(merged['global-spaces-tools']).toBeDefined();
		expect(Object.keys(merged)).toEqual(['global-spaces-tools']);
	});

	test('multiple registry servers are all present in the merged map', async () => {
		const serverA: McpServerConfig = { type: 'stdio', command: 'cmd-a' };
		const serverB: McpServerConfig = { type: 'stdio', command: 'cmd-b' };
		const { deps, stub } = buildDeps(db, {
			registryMcpServers: { 'mcp-a': serverA, 'mcp-b': serverB },
		});

		await provisionGlobalSpacesAgent(deps);

		expect(stub.capturedMcpMaps.length).toBe(1);
		const merged = stub.capturedMcpMaps[0]!;
		expect(merged['mcp-a']).toBeDefined();
		expect(merged['mcp-b']).toBeDefined();
		expect(merged['global-spaces-tools']).toBeDefined();
	});
});
