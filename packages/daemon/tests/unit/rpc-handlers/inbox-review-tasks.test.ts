/**
 * Tests for inbox.reviewTasks RPC Handler
 *
 * Covers:
 * - Returns only review-status tasks across active rooms
 * - Skips non-review tasks (in_progress, pending, completed, etc.)
 * - Sorts results by updatedAt descending
 * - Returns empty array when no review tasks exist
 * - Skips archived rooms (via listRooms(false))
 */

import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { MessageHub } from '@neokai/shared';
import { setupTaskHandlers } from '../../../src/lib/rpc-handlers/task-handlers';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { RoomManager } from '../../../src/lib/room/managers/room-manager';
import type { Database } from '../../../src/storage/database';

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

function createMockMessageHub(): {
	hub: MessageHub;
	handlers: Map<string, RequestHandler>;
} {
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

function createMockDaemonHub(): DaemonHub {
	return {
		emit: mock(async () => {}),
		on: mock(() => () => {}),
		off: mock(() => () => {}),
		once: mock(async () => {}),
	} as unknown as DaemonHub;
}

function makeTaskRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: '00000000-0000-4000-8000-000000000001',
		room_id: 'room-1',
		short_id: null,
		title: 'Test Task',
		description: '',
		status: 'review',
		priority: 'normal',
		task_type: 'coding',
		assigned_agent: 'coder',
		created_by_task_id: null,
		progress: null,
		current_step: null,
		result: null,
		error: null,
		depends_on: '[]',
		input_draft: null,
		created_at: 1000,
		started_at: null,
		completed_at: null,
		archived_at: null,
		active_session: null,
		pr_url: null,
		pr_number: null,
		pr_created_at: null,
		restrictions: null,
		updated_at: 2000,
		...overrides,
	};
}

describe('inbox.reviewTasks RPC handler', () => {
	let hub: MessageHub;
	let handlers: Map<string, RequestHandler>;
	let mockRoomManager: RoomManager;
	let taskRowsByRoom: Map<string, Record<string, unknown>[]>;

	beforeEach(() => {
		const result = createMockMessageHub();
		hub = result.hub;
		handlers = result.handlers;
		taskRowsByRoom = new Map();

		const roomList = [
			{ id: 'room-a', name: 'Room A' },
			{ id: 'room-b', name: 'Room B' },
		];

		mockRoomManager = {
			listRooms: mock(() => roomList),
			getRoomOverview: mock(() => null),
		} as unknown as RoomManager;

		const allFn = mock((...params: unknown[]) => {
			const roomId = params[0] as string;
			return taskRowsByRoom.get(roomId) ?? [];
		});

		const stmt = {
			get: mock(() => null),
			run: mock(() => ({ lastInsertRowid: 1 })),
			all: allFn,
		};
		const rawDb = { prepare: mock(() => stmt) };
		const mockDb = { getDatabase: mock(() => rawDb) } as unknown as Database;

		setupTaskHandlers(hub, mockRoomManager, createMockDaemonHub(), mockDb, {
			notifyChange: () => {},
		} as never);
	});

	it('should return only review-status tasks across all rooms', async () => {
		taskRowsByRoom.set('room-a', [
			makeTaskRow({ id: 't1', room_id: 'room-a', status: 'review', updated_at: 3000 }),
			makeTaskRow({ id: 't2', room_id: 'room-a', status: 'in_progress', updated_at: 4000 }),
		]);
		taskRowsByRoom.set('room-b', [
			makeTaskRow({ id: 't3', room_id: 'room-b', status: 'review', updated_at: 2000 }),
			makeTaskRow({ id: 't4', room_id: 'room-b', status: 'completed', updated_at: 5000 }),
		]);

		const handler = handlers.get('inbox.reviewTasks')!;
		const result = (await handler({}, {})) as { tasks: Array<{ task: { id: string } }> };

		expect(result.tasks).toHaveLength(2);
		const ids = result.tasks.map((t) => t.task.id);
		expect(ids).toContain('t1');
		expect(ids).toContain('t3');
	});

	it('should sort results by updatedAt descending', async () => {
		taskRowsByRoom.set('room-a', [
			makeTaskRow({ id: 'old', room_id: 'room-a', status: 'review', updated_at: 1000 }),
			makeTaskRow({ id: 'new', room_id: 'room-a', status: 'review', updated_at: 5000 }),
		]);
		taskRowsByRoom.set('room-b', [
			makeTaskRow({ id: 'mid', room_id: 'room-b', status: 'review', updated_at: 3000 }),
		]);

		const handler = handlers.get('inbox.reviewTasks')!;
		const result = (await handler({}, {})) as { tasks: Array<{ task: { id: string } }> };

		const ids = result.tasks.map((t) => t.task.id);
		expect(ids).toEqual(['new', 'mid', 'old']);
	});

	it('should include room metadata (roomId, roomTitle) with each task', async () => {
		taskRowsByRoom.set('room-a', [
			makeTaskRow({ id: 't1', room_id: 'room-a', status: 'review', updated_at: 1000 }),
		]);
		taskRowsByRoom.set('room-b', [
			makeTaskRow({ id: 't2', room_id: 'room-b', status: 'review', updated_at: 2000 }),
		]);

		const handler = handlers.get('inbox.reviewTasks')!;
		const result = (await handler({}, {})) as {
			tasks: Array<{ task: { id: string }; roomId: string; roomTitle: string }>;
		};

		const task1 = result.tasks.find((t) => t.task.id === 't1');
		expect(task1?.roomId).toBe('room-a');
		expect(task1?.roomTitle).toBe('Room A');

		const task2 = result.tasks.find((t) => t.task.id === 't2');
		expect(task2?.roomId).toBe('room-b');
		expect(task2?.roomTitle).toBe('Room B');
	});

	it('should return empty array when no review tasks exist', async () => {
		taskRowsByRoom.set('room-a', [
			makeTaskRow({ id: 't1', room_id: 'room-a', status: 'in_progress' }),
		]);
		taskRowsByRoom.set('room-b', [makeTaskRow({ id: 't2', room_id: 'room-b', status: 'pending' })]);

		const handler = handlers.get('inbox.reviewTasks')!;
		const result = (await handler({}, {})) as { tasks: unknown[] };

		expect(result.tasks).toHaveLength(0);
	});

	it('should return empty array when rooms have no tasks', async () => {
		taskRowsByRoom.set('room-a', []);
		taskRowsByRoom.set('room-b', []);

		const handler = handlers.get('inbox.reviewTasks')!;
		const result = (await handler({}, {})) as { tasks: unknown[] };

		expect(result.tasks).toHaveLength(0);
	});

	it('should include all TaskSummary fields in the response', async () => {
		taskRowsByRoom.set('room-a', [
			makeTaskRow({
				id: 't1',
				room_id: 'room-a',
				status: 'review',
				title: 'Fix login bug',
				priority: 'high',
				progress: 75,
				current_step: 'Writing tests',
				depends_on: JSON.stringify(['dep-1']),
				error: null,
				active_session: 'worker',
				pr_url: 'https://github.com/example/pr/1',
				pr_number: 42,
				updated_at: 3000,
			}),
		]);

		const handler = handlers.get('inbox.reviewTasks')!;
		const result = (await handler({}, {})) as {
			tasks: Array<{ task: Record<string, unknown>; roomId: string }>;
		};

		expect(result.tasks).toHaveLength(1);
		const task = result.tasks[0].task;
		expect(task.id).toBe('t1');
		expect(task.title).toBe('Fix login bug');
		expect(task.status).toBe('review');
		expect(task.priority).toBe('high');
		expect(task.progress).toBe(75);
		expect(task.currentStep).toBe('Writing tests');
		expect(task.dependsOn).toEqual(['dep-1']);
		expect(task.activeSession).toBe('worker');
		expect(task.prUrl).toBe('https://github.com/example/pr/1');
		expect(task.prNumber).toBe(42);
	});
});
