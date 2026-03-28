/**
 * Shared test helpers for Neo integration tests.
 *
 * Provides:
 * - DB setup: makeDb(), makeLogger()
 * - Entity fixtures: makeRoom(), makeGoal(), makeNeoTask(), NOW constant
 * - Manager mocks used across multiple integration test files
 *
 * Manager mocks that need extra instrumentation (_callLog, injectedMessages, etc.)
 * are defined per-file; only the base versions live here.
 */

import { Database as BunDatabase } from 'bun:sqlite';
import { createTables } from '../../../src/storage/schema';
import { NeoActivityLogRepository } from '../../../src/storage/repositories/neo-activity-log-repository';
import { NeoActivityLogger } from '../../../src/lib/neo/activity-logger';
import type {
	NeoActionRoomManager,
	NeoActionGoalManager,
	NeoActionManagerFactory,
} from '../../../src/lib/neo/tools/neo-action-tools';
import type { Room, RoomGoal, NeoTask } from '@neokai/shared';

// ---------------------------------------------------------------------------
// DB / logger setup
// ---------------------------------------------------------------------------

/** Create an in-memory SQLite database with the full NeoKai schema applied. */
export function makeDb(): BunDatabase {
	const db = new BunDatabase(':memory:');
	createTables(db);
	return db;
}

/** Create a NeoActivityLogger backed by the given in-memory database. */
export function makeLogger(db: BunDatabase): NeoActivityLogger {
	return new NeoActivityLogger(new NeoActivityLogRepository(db));
}

// ---------------------------------------------------------------------------
// Entity fixtures
// ---------------------------------------------------------------------------

/** Stable timestamp used across entity fixtures — avoids time-dependent drift. */
export const NOW = 1_700_000_000_000;

export function makeRoom(overrides: Partial<Room> = {}): Room {
	return {
		id: 'room-1',
		name: 'Test Room',
		status: 'active',
		sessionIds: [],
		allowedPaths: [],
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

export function makeGoal(overrides: Partial<RoomGoal> = {}): RoomGoal {
	return {
		id: 'goal-1',
		roomId: 'room-1',
		title: 'Test Goal',
		description: '',
		status: 'active',
		priority: 'normal',
		progress: 0,
		linkedTaskIds: [],
		metrics: {},
		createdAt: NOW,
		updatedAt: NOW,
		missionType: 'one_shot',
		autonomyLevel: 'supervised',
		...overrides,
	};
}

export function makeNeoTask(overrides: Partial<NeoTask> = {}): NeoTask {
	return {
		id: 'task-1',
		roomId: 'room-1',
		title: 'Test Task',
		description: '',
		status: 'pending',
		priority: 'normal',
		progress: 0,
		dependsOn: [],
		createdAt: NOW,
		updatedAt: NOW,
		taskType: 'coding',
		assignedAgent: 'coder',
		...overrides,
	} as NeoTask;
}

// ---------------------------------------------------------------------------
// Base manager mocks (no call-log instrumentation)
//
// Tests that need to verify call ordering should wrap these or define their
// own instrumented versions.
// ---------------------------------------------------------------------------

/** Simple NeoActionRoomManager backed by an in-memory Map. */
export function makeRoomManager(rooms: Room[] = []): NeoActionRoomManager {
	const store = new Map<string, Room>(rooms.map((r) => [r.id, r]));
	return {
		createRoom: (params) => {
			const room = makeRoom({ id: `room-${Date.now()}`, name: params.name });
			store.set(room.id, room);
			return room;
		},
		deleteRoom: (id) => store.delete(id),
		getRoom: (id) => store.get(id) ?? null,
		updateRoom: (id, params) => {
			const room = store.get(id);
			if (!room) return null;
			const updated = { ...room, ...params, updatedAt: NOW + 1 } as Room;
			store.set(id, updated);
			return updated;
		},
		getActiveSessionCount: () => 0,
	};
}

/** Simple NeoActionGoalManager backed by an in-memory Map. */
export function makeGoalManager(goals: RoomGoal[] = []): NeoActionGoalManager {
	const store = new Map<string, RoomGoal>(goals.map((g) => [g.id, g]));
	return {
		createGoal: async (params) => {
			const goal = makeGoal({ id: `goal-${Date.now()}`, ...params });
			store.set(goal.id, goal);
			return goal;
		},
		getGoal: async (id) => store.get(id) ?? null,
		patchGoal: async (id, patch) => {
			const goal = store.get(id);
			if (!goal) throw new Error(`Goal not found: ${id}`);
			return { ...goal, ...patch, updatedAt: NOW + 1 };
		},
		updateGoalStatus: async (id, status) => {
			const goal = store.get(id);
			if (!goal) throw new Error(`Goal not found: ${id}`);
			return { ...goal, status, updatedAt: NOW + 1 };
		},
	};
}

/** Simple NeoActionManagerFactory that delegates to provided goal/task managers. */
export function makeManagerFactory(
	goalManager?: NeoActionGoalManager,
	taskManager?: ReturnType<typeof makeTaskManagerStub>
): NeoActionManagerFactory {
	const gm = goalManager ?? makeGoalManager();
	const tm = taskManager ?? makeTaskManagerStub();
	return {
		getGoalManager: () => gm,
		getTaskManager: () => tm,
	};
}

/** Minimal NeoActionTaskManager stub (not-implemented, safe for goal-only tests). */
export function makeTaskManagerStub() {
	return {
		createTask: async (): Promise<never> => {
			throw new Error('not implemented');
		},
		getTask: async () => null,
		updateTaskFields: async (): Promise<never> => {
			throw new Error('not implemented');
		},
		setTaskStatus: async (): Promise<never> => {
			throw new Error('not implemented');
		},
	};
}
