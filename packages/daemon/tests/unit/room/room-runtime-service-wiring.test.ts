import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { Database as BunDatabase } from 'bun:sqlite';
import {
	RoomRuntimeService,
	type RoomRuntimeServiceConfig,
} from '../../../src/lib/room/runtime/room-runtime-service';
import { JobQueueRepository } from '../../../src/storage/repositories/job-queue-repository';
import { createRoomTickHandler } from '../../../src/lib/job-handlers/room-tick.handler';
import { ROOM_TICK } from '../../../src/lib/job-queue-constants';
import type { RoomRuntime } from '../../../src/lib/room/runtime/room-runtime';
import { Database as AppDatabase } from '../../../src/storage';
import { createReactiveDatabase } from '../../../src/storage/reactive-database';
import type { Room, RuntimeState, Session } from '@neokai/shared';

const CREATE_TABLE_SQL = `
	CREATE TABLE IF NOT EXISTS job_queue (
		id TEXT PRIMARY KEY,
		queue TEXT NOT NULL,
		status TEXT NOT NULL DEFAULT 'pending'
			CHECK(status IN ('pending', 'processing', 'completed', 'failed', 'dead')),
		payload TEXT NOT NULL DEFAULT '{}',
		result TEXT,
		error TEXT,
		priority INTEGER NOT NULL DEFAULT 0,
		max_retries INTEGER NOT NULL DEFAULT 3,
		retry_count INTEGER NOT NULL DEFAULT 0,
		run_at INTEGER NOT NULL,
		created_at INTEGER NOT NULL,
		started_at INTEGER,
		completed_at INTEGER
	);
	CREATE INDEX IF NOT EXISTS idx_job_queue_dequeue ON job_queue(queue, status, priority DESC, run_at ASC);
	CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status);
`;

/** Minimal daemonHub mock that supports on() subscriptions */
function makeDaemonHub() {
	return {
		on: () => () => {},
	};
}

/** Minimal roomManager mock with no rooms */
function makeRoomManager() {
	return {
		listRooms: () => [],
		getRoom: () => null,
	};
}

/** Minimal jobProcessor mock that records registered handler names */
function makeJobProcessor() {
	const registered: string[] = [];
	return {
		registered,
		register: (name: string) => {
			registered.push(name);
		},
	};
}

function makeConfig(overrides: Partial<RoomRuntimeServiceConfig> = {}): RoomRuntimeServiceConfig {
	return {
		db: {} as never,
		messageHub: {} as never,
		daemonHub: makeDaemonHub() as never,
		getApiKey: async () => null,
		roomManager: makeRoomManager() as never,
		sessionManager: {} as never,
		defaultWorkspacePath: '/tmp',
		defaultModel: 'test-model',
		getGlobalSettings: () => ({}) as never,
		settingsManager: { getEnabledMcpServersConfig: () => ({}) } as never,
		reactiveDb: {} as never,
		...overrides,
	};
}

function makeRoom(id: string, runtimeState?: RuntimeState): Room {
	const config = runtimeState ? { runtimeState } : undefined;
	return {
		id,
		name: `Room ${id}`,
		allowedPaths: [{ path: '/tmp' }],
		defaultPath: '/tmp',
		sessionIds: [],
		status: 'active',
		createdAt: Date.now(),
		updatedAt: Date.now(),
		config,
	};
}

function makeSession(id: string): Session {
	const now = new Date().toISOString();
	return {
		id,
		title: 'Test Session',
		workspacePath: '/tmp',
		createdAt: now,
		lastActiveAt: now,
		status: 'active',
		config: {
			model: 'test-model',
			maxTokens: 8192,
			temperature: 0.7,
		},
		metadata: {
			messageCount: 0,
			totalTokens: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalCost: 0,
			toolCallCount: 0,
		},
		type: 'worker',
	};
}

describe('RoomRuntimeService - handler registration', () => {
	it('registers room.tick handler on start() when jobProcessor and jobQueue are provided', async () => {
		const jobProcessor = makeJobProcessor();
		const jobQueue = {
			listJobs: () => [],
			enqueue: () => ({
				id: 'j1',
				queue: ROOM_TICK,
				status: 'pending',
				payload: {},
				result: null,
				error: null,
				priority: 0,
				maxRetries: 0,
				retryCount: 0,
				runAt: 0,
				createdAt: 0,
				startedAt: null,
				completedAt: null,
			}),
		};

		const service = new RoomRuntimeService(
			makeConfig({ jobProcessor: jobProcessor as never, jobQueue: jobQueue as never })
		);

		await service.start();

		expect(jobProcessor.registered).toContain(ROOM_TICK);
	});

	it('does NOT register room.tick handler on start() when jobProcessor is absent', async () => {
		const service = new RoomRuntimeService(makeConfig());

		// Should not throw even without jobProcessor
		await service.start();
		// No assertion needed — just verifying no error is thrown
	});

	it('does NOT register room.tick handler when jobQueue is absent', async () => {
		const jobProcessor = makeJobProcessor();

		const service = new RoomRuntimeService(makeConfig({ jobProcessor: jobProcessor as never }));

		await service.start();

		expect(jobProcessor.registered).not.toContain(ROOM_TICK);
	});
});

describe('RoomRuntimeService.stopRuntime()', () => {
	let service: RoomRuntimeService;

	beforeEach(() => {
		service = new RoomRuntimeService(makeConfig());
	});

	it('returns false when runtime does not exist', () => {
		expect(service.stopRuntime('non-existent')).toBe(false);
	});

	it('calls stop() on the runtime and removes it from the runtimes map', () => {
		let stopped = false;
		const mockRuntime = {
			stop: () => {
				stopped = true;
			},
			getState: () => 'running',
		} as unknown as RoomRuntime;

		// Inject directly into the private map
		(service as unknown as { runtimes: Map<string, RoomRuntime> }).runtimes.set(
			'room-1',
			mockRuntime
		);

		const result = service.stopRuntime('room-1');

		expect(result).toBe(true);
		expect(stopped).toBe(true);
		// Runtime must be removed so heartbeat liveness check works correctly
		expect(service.getRuntime('room-1')).toBeNull();
	});

	it('returns false on a second stopRuntime() call after the first removes the runtime', () => {
		const mockRuntime = {
			stop: () => {},
			getState: () => 'running',
		} as unknown as RoomRuntime;

		(service as unknown as { runtimes: Map<string, RoomRuntime> }).runtimes.set(
			'room-2',
			mockRuntime
		);

		service.stopRuntime('room-2');
		// Second call: runtime is already gone
		expect(service.stopRuntime('room-2')).toBe(false);
	});
});

describe('RoomRuntimeService.startRuntime()', () => {
	it('returns false when the room does not exist', () => {
		const service = new RoomRuntimeService(makeConfig());
		expect(service.startRuntime('non-existent')).toBe(false);
	});
});

describe('RoomRuntimeService startup runtime preferences', () => {
	it('does not auto-start paused/stopped rooms on daemon startup', async () => {
		const runningRoom = makeRoom('room-running', 'running');
		const pausedRoom = makeRoom('room-paused', 'paused');
		const stoppedRoom = makeRoom('room-stopped', 'stopped');
		const rooms = [runningRoom, pausedRoom, stoppedRoom];
		const byId = new Map(rooms.map((r) => [r.id, r]));

		const roomManager = {
			listRooms: () => rooms,
			getRoom: (id: string) => byId.get(id) ?? null,
			updateRoom: mock(() => null),
		};

		const service = new RoomRuntimeService(makeConfig({ roomManager: roomManager as never }));
		const createdRoomIds: string[] = [];
		const startedRoomIds: string[] = [];
		const recoverCalls: Array<{ roomId: string; resumeAgents: boolean }> = [];

		const serviceAny = service as unknown as {
			createOrGetRuntime: (room: Room, autoStart?: boolean) => RoomRuntime;
			recoverRoomRuntime: (
				roomId: string,
				runtime: RoomRuntime,
				observer: unknown,
				resumeAgents?: boolean
			) => Promise<void>;
			runtimes: Map<string, RoomRuntime>;
			observers: Map<string, unknown>;
		};

		serviceAny.createOrGetRuntime = ((room: Room) => {
			createdRoomIds.push(room.id);
			const runtime = {
				start: () => startedRoomIds.push(room.id),
				pause: () => {},
				stop: () => {},
				getState: () => 'paused',
			} as unknown as RoomRuntime;
			serviceAny.runtimes.set(room.id, runtime);
			serviceAny.observers.set(room.id, {});
			return runtime;
		}) as unknown as (room: Room, autoStart?: boolean) => RoomRuntime;

		serviceAny.recoverRoomRuntime = (async (
			roomId: string,
			_runtime: RoomRuntime,
			_observer: unknown,
			resumeAgents = true
		) => {
			recoverCalls.push({ roomId, resumeAgents });
		}) as unknown as (
			roomId: string,
			runtime: RoomRuntime,
			observer: unknown,
			resumeAgents?: boolean
		) => Promise<void>;

		await service.start();

		expect(createdRoomIds).toContain('room-running');
		expect(createdRoomIds).toContain('room-paused');
		expect(createdRoomIds).not.toContain('room-stopped');
		expect(startedRoomIds).toEqual(['room-running']);
		expect(recoverCalls).toEqual([
			{ roomId: 'room-running', resumeAgents: true },
			{ roomId: 'room-paused', resumeAgents: false },
		]);
	});
});

describe('RoomRuntimeService runtime state persistence', () => {
	it('persists paused runtime preference on pauseRuntime()', () => {
		const room = makeRoom('room-1');
		const updateRoom = mock(() => room);
		const roomManager = {
			getRoom: () => room,
			updateRoom,
			listRooms: () => [],
		};

		const service = new RoomRuntimeService(makeConfig({ roomManager: roomManager as never }));
		(service as unknown as { runtimes: Map<string, RoomRuntime> }).runtimes.set('room-1', {
			pause: () => {},
			resume: () => {},
			stop: () => {},
			start: () => {},
			getState: () => 'running',
		} as unknown as RoomRuntime);

		expect(service.pauseRuntime('room-1')).toBe(true);
		expect(updateRoom).toHaveBeenCalledWith('room-1', {
			config: { runtimeState: 'paused' },
		});
	});

	it('persists stopped runtime preference on stopRuntime()', () => {
		const room = makeRoom('room-1', 'running');
		const updateRoom = mock(() => room);
		const roomManager = {
			getRoom: () => room,
			updateRoom,
			listRooms: () => [],
		};

		const service = new RoomRuntimeService(makeConfig({ roomManager: roomManager as never }));
		(service as unknown as { runtimes: Map<string, RoomRuntime> }).runtimes.set('room-1', {
			pause: () => {},
			resume: () => {},
			stop: () => {},
			start: () => {},
			getState: () => 'running',
		} as unknown as RoomRuntime);

		expect(service.stopRuntime('room-1')).toBe(true);
		expect(updateRoom).toHaveBeenCalledWith('room-1', {
			config: { runtimeState: 'stopped' },
		});
	});
});

describe('RoomRuntimeService message persistence reactivity', () => {
	it('injectMessage persists via reactive db facade and bumps sdk_messages version', async () => {
		const tmpBase = (process.env.TMPDIR || '/tmp').replace(/\/$/, '');
		const dbPath = `${tmpBase}/room-runtime-reactive-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
		const appDb = new AppDatabase(dbPath);
		const reactiveDb = createReactiveDatabase(appDb);
		await appDb.initialize(reactiveDb);

		try {
			// Insert the session row first (sdk_messages has FK -> sessions.id)
			reactiveDb.db.createSession(makeSession('session-reactive-1'));

			const roomManager = {
				listRooms: () => [],
				getRoom: () => null,
				updateRoom: () => null,
			};

			const service = new RoomRuntimeService(
				makeConfig({
					db: reactiveDb.db as never,
					reactiveDb: reactiveDb as never,
					roomManager: roomManager as never,
				})
			);

			const serviceAny = service as unknown as {
				createSessionFactory: () => {
					injectMessage: (sessionId: string, message: string) => Promise<void>;
				};
				agentSessions: Map<string, unknown>;
			};

			serviceAny.agentSessions.set('session-reactive-1', {
				getProcessingState: () => ({ status: 'idle' }),
				ensureQueryStarted: async () => {},
				messageQueue: {
					enqueueWithId: async () => {},
				},
			});

			const sessionFactory = serviceAny.createSessionFactory();
			const before = reactiveDb.getTableVersion('sdk_messages');
			await sessionFactory.injectMessage('session-reactive-1', 'hello from reactive runtime');
			const after = reactiveDb.getTableVersion('sdk_messages');

			expect(after).toBeGreaterThan(before);
			const queued = reactiveDb.db.getMessagesByStatus('session-reactive-1', 'queued');
			expect(queued).toHaveLength(1);
			expect(queued[0]?.type).toBe('user');
		} finally {
			appDb.close();
			try {
				require('fs').unlinkSync(dbPath);
			} catch {
				// best-effort cleanup
			}
		}
	});
});

describe('stopRuntime() + room.tick handler interaction', () => {
	it('tick handler returns { skipped, reason } for a room whose runtime was deleted by stopRuntime()', async () => {
		// Set up an in-memory job queue so we can build a real handler
		const db = new BunDatabase(':memory:');
		db.exec(CREATE_TABLE_SQL);
		const jobQueue = new JobQueueRepository(db as never);

		const service = new RoomRuntimeService(makeConfig());

		// Inject a running runtime into the map
		const mockRuntime = {
			stop: () => {},
			getState: () => 'running',
		} as unknown as RoomRuntime;
		(service as unknown as { runtimes: Map<string, RoomRuntime> }).runtimes.set(
			'room-stop',
			mockRuntime
		);

		// Stop the runtime — this deletes it from the map
		service.stopRuntime('room-stop');
		expect(service.getRuntime('room-stop')).toBeNull();

		// Build the handler using the same runtime-lookup closure as RoomRuntimeService.start()
		const handler = createRoomTickHandler((roomId) => service.getRuntime(roomId), jobQueue);

		// Simulate a tick job that was already in-flight when stopRuntime() was called
		const job = {
			id: 'test-tick-job',
			queue: ROOM_TICK,
			status: 'processing' as const,
			payload: { roomId: 'room-stop' },
			result: null,
			error: null,
			priority: 0,
			maxRetries: 0,
			retryCount: 0,
			runAt: Date.now(),
			createdAt: Date.now(),
			startedAt: Date.now(),
			completedAt: null,
		};

		const result = await handler(job);

		// Handler must skip and not re-schedule — the loop is terminated
		expect(result).toEqual({ skipped: true, reason: 'not running' });
		const pending = jobQueue.listJobs({ queue: ROOM_TICK, status: ['pending'] });
		expect(pending).toHaveLength(0);
	});
});
