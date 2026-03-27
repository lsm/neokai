/**
 * Tests verifying that getCurrentModel() reads from the DB (source of truth)
 * and that trySwitchToFallbackModel() uses the DB model when computing the fallback chain.
 *
 * These tests use a real in-memory SQLite DB (not mocks) to verify the DB-read behavior.
 */

import { describe, expect, it, afterEach } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { SessionRepository } from '../../../src/storage/repositories/session-repository';
import { RoomRuntimeService } from '../../../src/lib/room/runtime/room-runtime-service';
import type { RoomRuntimeServiceConfig } from '../../../src/lib/room/runtime/room-runtime-service';
import {
	createRuntimeTestContext,
	createGoalAndTask,
	type RuntimeTestContext,
} from './room-runtime-test-helpers';
import type { GlobalSettings, Session } from '@neokai/shared';

// Minimal sessions table schema required by SessionRepository
const SESSIONS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL,
    status TEXT NOT NULL,
    config TEXT NOT NULL,
    metadata TEXT NOT NULL,
    is_worktree INTEGER DEFAULT 0,
    worktree_path TEXT,
    main_repo_path TEXT,
    worktree_branch TEXT,
    git_branch TEXT,
    sdk_session_id TEXT,
    available_commands TEXT,
    processing_state TEXT,
    archived_at TEXT,
    parent_id TEXT,
    type TEXT DEFAULT 'worker',
    session_context TEXT
  )
`;

function makeSession(id: string, model: string, provider?: string): Session {
	return {
		id,
		title: 'Test Session',
		workspacePath: '/workspace',
		createdAt: new Date().toISOString(),
		lastActiveAt: new Date().toISOString(),
		status: 'active',
		config: {
			model,
			...(provider !== undefined ? { provider } : {}),
		},
		metadata: {},
		type: 'worker',
	};
}

function buildServiceConfig(db: BunDatabase): RoomRuntimeServiceConfig {
	const sessionRepo = new SessionRepository(db);
	return {
		db: {
			getSession: (id: string) => sessionRepo.getSession(id),
		} as never,
		messageHub: {} as never,
		daemonHub: {} as never,
		getApiKey: async () => null,
		roomManager: { getRoom: () => null } as never,
		sessionManager: {
			registerSession: () => {},
			unregisterSession: () => {},
		} as never,
		defaultWorkspacePath: '/tmp',
		defaultModel: 'default',
		getGlobalSettings: () => ({}) as never,
		settingsManager: { getEnabledMcpServersConfig: () => ({}) } as never,
		reactiveDb: {} as never,
	};
}

describe('getCurrentModel — DB as source of truth', () => {
	describe('basic DB read behavior (real SQLite)', () => {
		it('returns model and provider from DB record', async () => {
			const rawDb = new BunDatabase(':memory:');
			rawDb.exec(SESSIONS_SCHEMA);
			const sessionRepo = new SessionRepository(rawDb);
			sessionRepo.createSession(makeSession('sess-1', 'claude-sonnet-4-5', 'anthropic'));

			const config = buildServiceConfig(rawDb);
			const service = new RoomRuntimeService(config);
			const factory = (
				service as unknown as {
					createSessionFactory: () => {
						getCurrentModel: (
							id: string
						) => Promise<{ currentModel: string; provider: string } | null>;
					};
				}
			).createSessionFactory();

			const result = await factory.getCurrentModel('sess-1');
			expect(result).toEqual({ currentModel: 'claude-sonnet-4-5', provider: 'anthropic' });

			rawDb.close();
		});

		it('returns null for a session that does not exist in DB', async () => {
			const rawDb = new BunDatabase(':memory:');
			rawDb.exec(SESSIONS_SCHEMA);

			const config = buildServiceConfig(rawDb);
			const service = new RoomRuntimeService(config);
			const factory = (
				service as unknown as {
					createSessionFactory: () => {
						getCurrentModel: (
							id: string
						) => Promise<{ currentModel: string; provider: string } | null>;
					};
				}
			).createSessionFactory();

			const result = await factory.getCurrentModel('does-not-exist');
			expect(result).toBeNull();

			rawDb.close();
		});

		it('defaults provider to "anthropic" when the session config has no provider', async () => {
			const rawDb = new BunDatabase(':memory:');
			rawDb.exec(SESSIONS_SCHEMA);
			const sessionRepo = new SessionRepository(rawDb);
			// Create session without provider field
			sessionRepo.createSession(makeSession('sess-2', 'glm-5-turbo'));

			const config = buildServiceConfig(rawDb);
			const service = new RoomRuntimeService(config);
			const factory = (
				service as unknown as {
					createSessionFactory: () => {
						getCurrentModel: (
							id: string
						) => Promise<{ currentModel: string; provider: string } | null>;
					};
				}
			).createSessionFactory();

			const result = await factory.getCurrentModel('sess-2');
			expect(result).toEqual({ currentModel: 'glm-5-turbo', provider: 'anthropic' });

			rawDb.close();
		});

		it('reflects an externally-applied DB update (model switch) — not the original value', async () => {
			const rawDb = new BunDatabase(':memory:');
			rawDb.exec(SESSIONS_SCHEMA);
			const sessionRepo = new SessionRepository(rawDb);
			sessionRepo.createSession(makeSession('sess-3', 'model-a', 'anthropic'));

			const config = buildServiceConfig(rawDb);
			const service = new RoomRuntimeService(config);
			const factory = (
				service as unknown as {
					createSessionFactory: () => {
						getCurrentModel: (
							id: string
						) => Promise<{ currentModel: string; provider: string } | null>;
					};
				}
			).createSessionFactory();

			// First read returns model-a
			expect(await factory.getCurrentModel('sess-3')).toEqual({
				currentModel: 'model-a',
				provider: 'anthropic',
			});

			// Simulate external model switch: update the DB directly (no in-memory cache change)
			sessionRepo.updateSession('sess-3', { config: { model: 'model-b', provider: 'glm' } });

			// Second read must reflect the DB update, not the stale original value
			expect(await factory.getCurrentModel('sess-3')).toEqual({
				currentModel: 'model-b',
				provider: 'glm',
			});

			rawDb.close();
		});
	});
});

describe('trySwitchToFallbackModel — fallback chain uses DB model, not in-memory cache', () => {
	let ctx: RuntimeTestContext;

	afterEach(() => {
		ctx.runtime.stop();
		ctx.db.close();
	});

	const USAGE_LIMIT_MSG = "You've hit your limit · resets 11pm (America/New_York)";

	function makeGlobalSettings(overrides: Partial<GlobalSettings>): () => GlobalSettings {
		return () => overrides as unknown as GlobalSettings;
	}

	/**
	 * Full scenario: session starts with model A; an external process updates the DB to model B
	 * (without touching any in-memory cache). When a usage limit is hit, trySwitchToFallbackModel
	 * should consult the DB-backed getCurrentModel and compute the fallback chain for model B,
	 * not for model A.
	 */
	it('computes fallback chain from DB model after external model switch', async () => {
		// Real DB backing getCurrentModel so we can simulate an external update
		const rawDb = new BunDatabase(':memory:');
		rawDb.exec(SESSIONS_SCHEMA);
		const sessionRepo = new SessionRepository(rawDb);

		ctx = createRuntimeTestContext({
			getWorkerMessages: () => [{ id: 'msg-1', text: USAGE_LIMIT_MSG, toolCallNames: [] }],
			getGlobalSettings: makeGlobalSettings({
				// Fallback chain for model-a → haiku (what would be used if reading from cache)
				// Fallback chain for model-b → glm-4 (what should be used after the DB switch)
				modelFallbackMap: {
					'anthropic/model-a': [{ model: 'haiku', provider: 'anthropic' }],
					'glm/model-b': [{ model: 'glm-4', provider: 'glm' }],
				},
			}),
			// getCurrentModel reads from the real DB — this is the DB-first contract under test
			getCurrentModelImpl: async (sessionId: string) => {
				const session = sessionRepo.getSession(sessionId);
				if (!session) return null;
				return {
					currentModel: session.config.model as string,
					provider: (session.config.provider as string | undefined) ?? 'anthropic',
				};
			},
		});

		// Create task + spawn group
		const { task } = await createGoalAndTask(ctx);
		ctx.runtime.start();
		await ctx.runtime.tick();

		const groups = ctx.groupRepo.getActiveGroups('room-1');
		const group = groups[0];
		await ctx.taskManager.updateTaskStatus(task.id, 'in_progress');

		// Insert session record with model-a into DB (simulates the session that was started)
		sessionRepo.createSession(makeSession(group.workerSessionId, 'model-a', 'anthropic'));

		// Route worker to leader first so the group is in a state where usage_limit triggers fallback
		await ctx.runtime.onWorkerTerminalState(group.id, {
			sessionId: group.workerSessionId,
			kind: 'idle',
		});

		// At this point no fallback switch should have been triggered yet (worker went idle, not usage limited)
		// Now simulate the external model switch: update DB to model-b without any in-memory update
		sessionRepo.updateSession(group.workerSessionId, {
			config: { model: 'model-b', provider: 'glm' },
		});

		// Re-spawn the group for the next iteration to test usage limit path
		const task2 = await ctx.taskManager.createTask({
			title: 'Follow-up task',
			description: 'Triggers usage limit',
			assignedAgent: 'general',
		});
		await ctx.runtime.tick();

		const groups2 = ctx.groupRepo.getActiveGroups('room-1');
		const group2 = groups2[0];
		if (!group2) {
			// If no new group spawned, test the fallback directly by calling through runtime internals
			// Access trySwitchToFallbackModel via the private method for direct verification
			const runtimeAny = ctx.runtime as unknown as {
				trySwitchToFallbackModel: (
					groupId: string,
					sessionId: string,
					role: 'worker' | 'leader'
				) => Promise<boolean>;
			};

			const switched = await runtimeAny.trySwitchToFallbackModel(
				group.id,
				group.workerSessionId,
				'worker'
			);

			expect(switched).toBe(true);
			const switchCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'switchModel');
			expect(switchCalls.length).toBeGreaterThanOrEqual(1);
			// The last switch call must use model-b's fallback (glm-4), NOT model-a's fallback (haiku)
			const lastSwitch = switchCalls[switchCalls.length - 1];
			expect(lastSwitch.args[1]).toBe('glm-4');
			expect(lastSwitch.args[2]).toBe('glm');
		} else {
			await ctx.taskManager.updateTaskStatus(task2.id, 'in_progress');
			await ctx.runtime.onWorkerTerminalState(group2.id, {
				sessionId: group2.workerSessionId,
				kind: 'idle',
			});

			const switchCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'switchModel');
			expect(switchCalls.length).toBeGreaterThanOrEqual(1);
			const lastSwitch = switchCalls[switchCalls.length - 1];
			expect(lastSwitch.args[1]).toBe('glm-4');
			expect(lastSwitch.args[2]).toBe('glm');
		}

		rawDb.close();
	});

	/**
	 * Direct invocation of trySwitchToFallbackModel to verify that the fallback lookup
	 * uses the current DB state, not a stale in-memory value.
	 */
	it('uses DB model when trySwitchToFallbackModel is called directly after external DB update', async () => {
		const rawDb = new BunDatabase(':memory:');
		rawDb.exec(SESSIONS_SCHEMA);
		const sessionRepo = new SessionRepository(rawDb);

		ctx = createRuntimeTestContext({
			getWorkerMessages: () => [],
			getGlobalSettings: makeGlobalSettings({
				modelFallbackMap: {
					'anthropic/original-model': [{ model: 'stale-fallback', provider: 'anthropic' }],
					'glm/switched-model': [{ model: 'correct-fallback', provider: 'glm' }],
				},
			}),
			getCurrentModelImpl: async (sessionId: string) => {
				const session = sessionRepo.getSession(sessionId);
				if (!session) return null;
				return {
					currentModel: session.config.model as string,
					provider: (session.config.provider as string | undefined) ?? 'anthropic',
				};
			},
		});

		await createGoalAndTask(ctx);
		ctx.runtime.start();
		await ctx.runtime.tick();

		const groups = ctx.groupRepo.getActiveGroups('room-1');
		const group = groups[0];

		// Insert session with the original model
		const sessionId = group.workerSessionId;
		sessionRepo.createSession(makeSession(sessionId, 'original-model', 'anthropic'));

		// Externally switch the model in DB (simulating another process or prior RPC call)
		sessionRepo.updateSession(sessionId, { config: { model: 'switched-model', provider: 'glm' } });

		// Call trySwitchToFallbackModel directly — it must read from DB and get switched-model
		const runtimeAny = ctx.runtime as unknown as {
			trySwitchToFallbackModel: (
				groupId: string,
				sessionId: string,
				role: 'worker' | 'leader'
			) => Promise<boolean>;
		};

		const switched = await runtimeAny.trySwitchToFallbackModel(group.id, sessionId, 'worker');

		expect(switched).toBe(true);
		const switchCalls = ctx.sessionFactory.calls.filter((c) => c.method === 'switchModel');
		expect(switchCalls.length).toBe(1);
		// Must use the DB model (switched-model → correct-fallback), NOT the stale original-model → stale-fallback
		expect(switchCalls[0].args[1]).toBe('correct-fallback');
		expect(switchCalls[0].args[2]).toBe('glm');

		rawDb.close();
	});
});
