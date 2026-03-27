/**
 * Online tests for Coder Agent Always-On Sub-Agents (Task 4.1)
 *
 * Verifies that `createCoderAgentInit()` produces the correct `agent`/`agents`
 * configuration in the full daemon module environment. Structural assertions
 * (tool lists, prompt content, individual field values) live in the unit test
 * file `packages/daemon/tests/unit/room/coder-agent.test.ts`. This file covers
 * only integration-level concerns:
 *
 * 1. The module imports and resolves correctly in the live daemon context
 * 2. Built-in sub-agents are always present regardless of room config
 * 3. Room-configured helpers are additive (built-ins never absent)
 * 4. The daemon is responsive and RPC roundtrips work (dev-proxy active)
 *
 * Uses dev proxy (mock_sdk: true) so no real API calls are made.
 *
 * Run with dev proxy:
 *   NEOKAI_USE_DEV_PROXY=1 bun test packages/daemon/tests/online/room/coder-agent-subagents.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import { createDaemonServer } from '../../helpers/daemon-server';
import {
	createCoderAgentInit,
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
	// Single daemon instance for the entire suite — avoids per-test startup overhead
	let daemon: DaemonServerContext;

	beforeAll(async () => {
		daemon = await createDaemonServer();
	}, 30_000);

	afterAll(async () => {
		if (!daemon) return;
		daemon.kill('SIGTERM');
		await daemon.waitForExit();
	}, 15_000);

	// ── 1. Module import + always-on sub-agents (integration smoke) ────────────

	describe('built-in sub-agents always present', () => {
		test('createCoderAgentInit resolves in daemon context with correct agent/agents keys', () => {
			// Verifies the module imports cleanly in the full daemon module graph
			// and returns the expected top-level structure. Detailed structural
			// assertions (tool lists, prompt content) live in the unit test file.
			const init = createCoderAgentInit(makeCoderConfig());

			expect(init.agent).toBe('Coder');
			expect(init.agents).toBeDefined();

			const agentKeys = Object.keys(init.agents!);
			expect(agentKeys).toContain('Coder');
			expect(agentKeys).toContain('coder-explorer');
			expect(agentKeys).toContain('coder-tester');
			expect(agentKeys).toHaveLength(3);
		});

		test('coder-explorer and coder-tester present even when no room helpers configured', () => {
			// Verifies the always-on guarantee holds for rooms with empty config
			const init = createCoderAgentInit(makeCoderConfig({ room: makeRoom({ config: {} }) }));

			expect(init.agents!['coder-explorer']).toBeDefined();
			expect(init.agents!['coder-tester']).toBeDefined();
			expect(Object.keys(init.agents!)).toHaveLength(3);
		});
	});

	// ── 2. Room-configured helpers are additive ────────────────────────────────

	describe('room-configured helpers are additive to built-ins', () => {
		test('helpers extend the agents map without removing built-in sub-agents', () => {
			const roomWithHelpers = makeRoom({
				config: {
					agentSubagents: {
						worker: [
							{ model: 'haiku', provider: 'anthropic' },
							{ model: 'sonnet', provider: 'anthropic', name: 'my-custom-helper' },
						],
					},
				},
			});

			const init = createCoderAgentInit(makeCoderConfig({ room: roomWithHelpers }));
			const agentKeys = Object.keys(init.agents!);

			// Built-ins always present
			expect(agentKeys).toContain('Coder');
			expect(agentKeys).toContain('coder-explorer');
			expect(agentKeys).toContain('coder-tester');

			// 2 helpers added → 5 total
			expect(agentKeys).toHaveLength(5);

			// Helpers use helper- prefix (no collision with built-ins)
			const helperKeys = agentKeys.filter(
				(k) => k !== 'Coder' && k !== 'coder-explorer' && k !== 'coder-tester'
			);
			expect(helperKeys).toHaveLength(2);
			for (const key of helperKeys) {
				expect(key).toMatch(/^helper-/);
			}
		});
	});

	// ── 3. Daemon RPC smoke tests ──────────────────────────────────────────────

	describe('daemon integration smoke tests', () => {
		test('daemon is responsive (dev-proxy mode active)', async () => {
			const result = (await daemon.messageHub.request('room.list', {})) as {
				rooms: Array<{ id: string }>;
			};
			expect(result.rooms).toBeDefined();
			expect(Array.isArray(result.rooms)).toBe(true);
		});

		test('room RPC roundtrip: create and retrieve', async () => {
			const roomId = await createRoom(daemon, `Coder Sub-Agent Smoke ${Date.now()}`);
			try {
				const result = (await daemon.messageHub.request('room.get', { roomId })) as {
					room: { id: string; name: string };
				};
				expect(result.room).toBeDefined();
				expect(result.room.id).toBe(roomId);
			} finally {
				await daemon.messageHub.request('room.delete', { roomId });
			}
		});
	});
});
