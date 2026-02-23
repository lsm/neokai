import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import { WorkerManager } from '../../../src/lib/room/worker-manager';

describe('WorkerManager', () => {
	let db: BunDatabase;

	beforeEach(() => {
		db = new BunDatabase(':memory:');
		db.exec(`
			CREATE TABLE tasks (
				id TEXT PRIMARY KEY,
				room_id TEXT NOT NULL,
				title TEXT NOT NULL,
				description TEXT NOT NULL,
				session_id TEXT,
				status TEXT NOT NULL,
				priority TEXT NOT NULL,
				depends_on TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				started_at INTEGER,
				completed_at INTEGER,
				progress INTEGER,
				current_step TEXT,
				result TEXT,
				error TEXT,
				session_ids TEXT,
				execution_mode TEXT,
				sessions TEXT,
				recurring_job_id TEXT
			);

			CREATE TABLE worker_sessions (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				room_id TEXT NOT NULL,
				room_session_id TEXT NOT NULL,
				room_session_type TEXT NOT NULL,
				task_id TEXT NOT NULL,
				status TEXT NOT NULL,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				completed_at INTEGER
			);
		`);
	});

	afterEach(() => {
		db.close();
	});

	it('terminateWorkersForRoom marks workers/tasks failed and emits worker.failed', async () => {
		const emitMock = mock(async () => {});
		const cleanupMock = mock(async () => {});
		const unassignSessionMock = mock(() => null);

		const daemonHub = {
			emit: emitMock,
		} as unknown as import('../../../src/lib/daemon-hub').DaemonHub;
		const sessionLifecycle = {
			getAgentSession: mock(() => ({ cleanup: cleanupMock })),
		} as unknown as import('../../../src/lib/session/session-lifecycle').SessionLifecycle;
		const roomManager = {
			getRoom: mock(() => null),
			assignSession: mock(() => null),
			unassignSession: unassignSessionMock,
		} as unknown as import('../../../src/lib/room/room-manager').RoomManager;

		const workerManager = new WorkerManager(db, daemonHub, sessionLifecycle, roomManager);

		const now = Date.now();
		db.prepare(
			`INSERT INTO tasks (
				id, room_id, title, description, session_id, status, priority, depends_on, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run('task-1', 'room-1', 'Task', 'Task description', null, 'in_progress', 'normal', '[]', now);

		db.prepare(
			`INSERT INTO worker_sessions (
				id, session_id, room_id, room_session_id, room_session_type,
				task_id, status, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			'worker-row-1',
			'worker-session-1',
			'room-1',
			'room:self:room-1',
			'room_self',
			'task-1',
			'running',
			now,
			now
		);

		await workerManager.terminateWorkersForRoom('room-1');

		const workerRow = db
			.prepare(`SELECT status FROM worker_sessions WHERE session_id = ?`)
			.get('worker-session-1') as { status: string } | null;
		expect(workerRow?.status).toBe('failed');

		const taskRow = db.prepare(`SELECT status, error FROM tasks WHERE id = ?`).get('task-1') as {
			status: string;
			error: string | null;
		} | null;
		expect(taskRow?.status).toBe('failed');
		expect(taskRow?.error).toBe('Worker terminated due to room shutdown');

		expect(cleanupMock).toHaveBeenCalledTimes(1);
		expect(unassignSessionMock).toHaveBeenCalledWith('room-1', 'worker-session-1');
		expect(emitMock).toHaveBeenCalledWith('worker.failed', {
			sessionId: 'worker-session-1',
			taskId: 'task-1',
			error: 'Worker terminated due to room shutdown',
		});
	});

	it('terminateWorkersForRoom skips workers already completed/failed', async () => {
		const emitMock = mock(async () => {});
		const cleanupMock = mock(async () => {});

		const daemonHub = {
			emit: emitMock,
		} as unknown as import('../../../src/lib/daemon-hub').DaemonHub;
		const sessionLifecycle = {
			getAgentSession: mock(() => ({ cleanup: cleanupMock })),
		} as unknown as import('../../../src/lib/session/session-lifecycle').SessionLifecycle;
		const roomManager = {
			getRoom: mock(() => null),
			assignSession: mock(() => null),
			unassignSession: mock(() => null),
		} as unknown as import('../../../src/lib/room/room-manager').RoomManager;

		const workerManager = new WorkerManager(db, daemonHub, sessionLifecycle, roomManager);

		const now = Date.now();
		db.prepare(
			`INSERT INTO tasks (
				id, room_id, title, description, session_id, status, priority, depends_on, created_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run('task-2', 'room-1', 'Task 2', 'Task description', null, 'completed', 'normal', '[]', now);

		db.prepare(
			`INSERT INTO worker_sessions (
				id, session_id, room_id, room_session_id, room_session_type,
				task_id, status, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			'worker-row-2',
			'worker-session-2',
			'room-1',
			'room:self:room-1',
			'room_self',
			'task-2',
			'completed',
			now,
			now
		);

		await workerManager.terminateWorkersForRoom('room-1');

		expect(cleanupMock).not.toHaveBeenCalled();
		expect(emitMock).not.toHaveBeenCalled();
	});
});
