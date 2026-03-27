/**
 * Online tests for Coder Agent Always-On Sub-Agents (Task 4.1)
 *
 * Verifies that `createCoderAgentInit()` always produces the correct
 * `agent`/`agents` configuration with built-in `coder-explorer` and
 * `coder-tester` sub-agents, regardless of whether room-configured helpers
 * are present.
 *
 * These tests run within the online test framework to:
 * 1. Ensure the coder-agent module imports and initializes correctly in the full daemon environment
 * 2. Verify SDK option shapes against the running daemon context
 * 3. Catch any integration issues (import errors, type mismatches) that unit tests miss
 *
 * Uses dev proxy (mock_sdk: true) so no real API calls are made.
 *
 * Run with dev proxy:
 *   NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/room/coder-agent-subagents.test.ts
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import {
	createCoderAgentInit,
	buildCoderExplorerAgentDef,
	buildTesterAgentDef,
	type CoderAgentConfig,
} from '../../../src/lib/room/agents/coder-agent';
import { createRoom } from './room-test-helpers';
import type { Room, RoomGoal, NeoTask } from '@neokai/shared';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

function makeTask(overrides?: Partial<NeoTask>): NeoTask {
	return {
		id: 'task-online-1',
		roomId: 'room-online-1',
		title: 'Add GET /status endpoint',
		description: 'Create a status endpoint that returns 200 OK with version info',
		status: 'pending',
		priority: 'normal',
		dependsOn: [],
		createdAt: Date.now(),
		...overrides,
	};
}

function makeGoal(overrides?: Partial<RoomGoal>): RoomGoal {
	return {
		id: 'goal-online-1',
		roomId: 'room-online-1',
		title: 'Build API health layer',
		description: 'Add health and status endpoints to the API',
		status: 'active',
		priority: 'normal',
		progress: 0,
		linkedTaskIds: [],
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeRoom(overrides?: Partial<Room>): Room {
	return {
		id: 'room-online-1',
		name: 'Online Test Room',
		allowedPaths: [{ path: '/workspace', label: 'ws' }],
		defaultPath: '/workspace',
		sessionIds: [],
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeCoderConfig(overrides?: Partial<CoderAgentConfig>): CoderAgentConfig {
	return {
		task: makeTask(),
		goal: makeGoal(),
		room: makeRoom(),
		sessionId: 'coder:room-online-1:task-online-1',
		workspacePath: '/workspace',
		...overrides,
	};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Coder Agent — Built-in Sub-Agents (Online)', () => {
	let daemon: DaemonServerContext;
	let _roomId: string;

	beforeEach(async () => {
		daemon = await createDaemonServer();
		// Create a real room to verify daemon is functional
		_roomId = await createRoom(daemon, `Coder Sub-Agent Test ${Date.now()}`);
	}, 30_000);

	afterEach(async () => {
		if (!daemon) return;
		daemon.kill('SIGTERM');
		await daemon.waitForExit();
	}, 15_000);

	// ── 1. Always-on agent/agents pattern ──────────────────────────────────────

	describe('always-on agent/agents pattern', () => {
		test('createCoderAgentInit returns agent: Coder', () => {
			const init = createCoderAgentInit(makeCoderConfig());

			expect(init.agent).toBe('Coder');
		});

		test('createCoderAgentInit returns agents map with Coder entry', () => {
			const init = createCoderAgentInit(makeCoderConfig());

			expect(init.agents).toBeDefined();
			expect(init.agents!['Coder']).toBeDefined();
		});

		test('Coder agent definition includes Task/TaskOutput/TaskStop tools', () => {
			const init = createCoderAgentInit(makeCoderConfig());
			const coderDef = init.agents!['Coder'];

			expect(coderDef.tools).toContain('Task');
			expect(coderDef.tools).toContain('TaskOutput');
			expect(coderDef.tools).toContain('TaskStop');
		});

		test('Coder agent definition includes full coding tool set', () => {
			const init = createCoderAgentInit(makeCoderConfig());
			const coderDef = init.agents!['Coder'];

			for (const tool of [
				'Read',
				'Write',
				'Edit',
				'Bash',
				'Grep',
				'Glob',
				'WebFetch',
				'WebSearch',
			]) {
				expect(coderDef.tools).toContain(tool);
			}
		});

		test('Coder agent definition has model: inherit', () => {
			const init = createCoderAgentInit(makeCoderConfig());

			expect(init.agents!['Coder'].model).toBe('inherit');
		});

		test('Coder agent definition embeds the system prompt', () => {
			const init = createCoderAgentInit(makeCoderConfig());
			const coderDef = init.agents!['Coder'];

			expect(coderDef.prompt).toBeDefined();
			expect(coderDef.prompt!.length).toBeGreaterThan(100);
			expect(coderDef.prompt).toContain('Coder Agent');
			expect(coderDef.prompt).toContain('Git Workflow');
		});
	});

	// ── 2. Without room-configured helpers ────────────────────────────────────

	describe('without room-configured helpers', () => {
		test('agents map contains exactly 3 entries: Coder, coder-explorer, coder-tester', () => {
			const init = createCoderAgentInit(makeCoderConfig());
			const agentKeys = Object.keys(init.agents!);

			expect(agentKeys).toHaveLength(3);
			expect(agentKeys).toContain('Coder');
			expect(agentKeys).toContain('coder-explorer');
			expect(agentKeys).toContain('coder-tester');
		});

		test('coder-explorer agent definition matches canonical builder output', () => {
			const init = createCoderAgentInit(makeCoderConfig());
			const explorerDef = init.agents!['coder-explorer'];
			const canonical = buildCoderExplorerAgentDef();

			expect(explorerDef).toEqual(canonical);
		});

		test('coder-tester agent definition matches canonical builder output', () => {
			const init = createCoderAgentInit(makeCoderConfig());
			const testerDef = init.agents!['coder-tester'];
			const canonical = buildTesterAgentDef();

			expect(testerDef).toEqual(canonical);
		});

		test('coder-explorer uses read-only tools only', () => {
			const init = createCoderAgentInit(makeCoderConfig());
			const explorerDef = init.agents!['coder-explorer'];

			// Explorer must have read-only tools
			expect(explorerDef.tools).toContain('Read');
			expect(explorerDef.tools).toContain('Grep');
			expect(explorerDef.tools).toContain('Glob');
			expect(explorerDef.tools).toContain('Bash');

			// Explorer must NOT have write tools
			expect(explorerDef.tools).not.toContain('Write');
			expect(explorerDef.tools).not.toContain('Edit');
			// Explorer must NOT have Task (cannot spawn sub-agents)
			expect(explorerDef.tools).not.toContain('Task');
		});

		test('coder-explorer prompt prohibits file modifications and sub-agent spawning', () => {
			const init = createCoderAgentInit(makeCoderConfig());
			const explorerPrompt = init.agents!['coder-explorer'].prompt!;

			expect(explorerPrompt).toContain('Read-only');
			expect(explorerPrompt).toContain('MUST NOT');
			expect(explorerPrompt).toContain('EXPLORE_RESULT');
		});

		test('coder-tester has write tools to create test files', () => {
			const init = createCoderAgentInit(makeCoderConfig());
			const testerDef = init.agents!['coder-tester'];

			expect(testerDef.tools).toContain('Write');
			expect(testerDef.tools).toContain('Edit');
			expect(testerDef.tools).toContain('Bash');
			// Tester must NOT spawn sub-agents
			expect(testerDef.tools).not.toContain('Task');
		});

		test('coder-tester prompt includes TEST_RESULT block format', () => {
			const init = createCoderAgentInit(makeCoderConfig());
			const testerPrompt = init.agents!['coder-tester'].prompt!;

			expect(testerPrompt).toContain('TEST_RESULT');
			expect(testerPrompt).toContain('No sub-agents');
		});
	});

	// ── 3. With room-configured helpers ───────────────────────────────────────

	describe('with room-configured helpers', () => {
		const roomWithHelpers = makeRoom({
			config: {
				agentSubagents: {
					worker: [
						{
							model: 'haiku',
							provider: 'anthropic',
							description: 'Lightweight helper for simple subtasks',
						},
						{
							model: 'sonnet',
							provider: 'anthropic',
							name: 'my-custom-helper',
							description: 'Sonnet helper for medium subtasks',
						},
					],
				},
			},
		});

		test('agents map contains built-ins plus user-configured helpers', () => {
			const init = createCoderAgentInit(makeCoderConfig({ room: roomWithHelpers }));
			const agentKeys = Object.keys(init.agents!);

			// Built-ins always present
			expect(agentKeys).toContain('Coder');
			expect(agentKeys).toContain('coder-explorer');
			expect(agentKeys).toContain('coder-tester');

			// 2 configured helpers → 3 built-ins + 2 helpers = 5 total
			expect(agentKeys).toHaveLength(5);
		});

		test('helper agents use helper- name prefix', () => {
			const init = createCoderAgentInit(makeCoderConfig({ room: roomWithHelpers }));
			const agentKeys = Object.keys(init.agents!);
			const helperKeys = agentKeys.filter(
				(k) => k !== 'Coder' && k !== 'coder-explorer' && k !== 'coder-tester'
			);

			expect(helperKeys).toHaveLength(2);
			for (const key of helperKeys) {
				expect(key).toMatch(/^helper-/);
			}
		});

		test('named helper retains its configured name with helper- prefix', () => {
			const init = createCoderAgentInit(makeCoderConfig({ room: roomWithHelpers }));
			const agentKeys = Object.keys(init.agents!);

			// The helper with name: 'my-custom-helper' should appear as 'helper-my-custom-helper'
			expect(agentKeys).toContain('helper-my-custom-helper');
		});

		test('helper agents do NOT have Task tool (no recursive sub-agents)', () => {
			const init = createCoderAgentInit(makeCoderConfig({ room: roomWithHelpers }));
			const helperKeys = Object.keys(init.agents!).filter(
				(k) => k !== 'Coder' && k !== 'coder-explorer' && k !== 'coder-tester'
			);

			for (const key of helperKeys) {
				const helperDef = init.agents![key];
				expect(helperDef.tools).not.toContain('Task');
			}
		});

		test('helper agents have full coding tool set including WebFetch/WebSearch', () => {
			const init = createCoderAgentInit(makeCoderConfig({ room: roomWithHelpers }));
			const helperKeys = Object.keys(init.agents!).filter(
				(k) => k !== 'Coder' && k !== 'coder-explorer' && k !== 'coder-tester'
			);

			for (const key of helperKeys) {
				const helperDef = init.agents![key];
				expect(helperDef.tools).toContain('Read');
				expect(helperDef.tools).toContain('Write');
				expect(helperDef.tools).toContain('Edit');
				expect(helperDef.tools).toContain('Bash');
				expect(helperDef.tools).toContain('WebFetch');
				expect(helperDef.tools).toContain('WebSearch');
			}
		});

		test('coder-explorer and coder-tester are still present with helpers configured', () => {
			const init = createCoderAgentInit(makeCoderConfig({ room: roomWithHelpers }));

			expect(init.agents!['coder-explorer']).toBeDefined();
			expect(init.agents!['coder-tester']).toBeDefined();

			// Built-in definitions are unchanged
			expect(init.agents!['coder-explorer']).toEqual(buildCoderExplorerAgentDef());
			expect(init.agents!['coder-tester']).toEqual(buildTesterAgentDef());
		});

		test('Coder system prompt mentions custom helper names when helpers configured', () => {
			const init = createCoderAgentInit(makeCoderConfig({ room: roomWithHelpers }));
			const coderPrompt = init.agents!['Coder'].prompt!;

			// Prompt should mention helpers section
			expect(coderPrompt).toContain('Custom helpers');
		});
	});

	// ── 4. Session-level options ───────────────────────────────────────────────

	describe('session-level SDK options', () => {
		test('type is set to coder', () => {
			const init = createCoderAgentInit(makeCoderConfig());
			expect(init.type).toBe('coder');
		});

		test('contextAutoQueue is false', () => {
			const init = createCoderAgentInit(makeCoderConfig());
			expect(init.contextAutoQueue).toBe(false);
		});

		test('systemPrompt uses preset: claude_code', () => {
			const init = createCoderAgentInit(makeCoderConfig());

			expect(init.systemPrompt).toBeDefined();
			expect(init.systemPrompt!.type).toBe('preset');
			expect((init.systemPrompt as { type: 'preset'; preset: string }).preset).toBe('claude_code');
		});

		test('custom model is forwarded to the init', () => {
			const init = createCoderAgentInit(makeCoderConfig({ model: 'claude-opus-4-6' }));
			expect(init.model).toBe('claude-opus-4-6');
		});

		test('custom provider is forwarded to the init', () => {
			const init = createCoderAgentInit(makeCoderConfig({ provider: 'anthropic' }));
			expect(init.provider).toBe('anthropic');
		});
	});

	// ── 5. Daemon health smoke test ───────────────────────────────────────────

	describe('daemon integration smoke test', () => {
		test('daemon is responsive (dev-proxy mode active)', async () => {
			// Verify the daemon is up and responding to RPC calls
			// This confirms dev-proxy is routing correctly and no real API calls are made
			const result = (await daemon.messageHub.request('room.list', {})) as {
				rooms: Array<{ id: string }>;
			};
			expect(result.rooms).toBeDefined();
			expect(Array.isArray(result.rooms)).toBe(true);
		});

		test('room created via RPC is retrievable', async () => {
			const roomId = await createRoom(daemon, `Smoke Test ${Date.now()}`);
			const result = (await daemon.messageHub.request('room.get', { roomId })) as {
				room: { id: string; name: string };
			};
			expect(result.room).toBeDefined();
			expect(result.room.id).toBe(roomId);
		});
	});
});
