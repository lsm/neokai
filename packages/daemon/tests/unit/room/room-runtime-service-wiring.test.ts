import { describe, expect, it, beforeEach } from 'bun:test';
import {
	RoomRuntimeService,
	type RoomRuntimeServiceConfig,
} from '../../../src/lib/room/runtime/room-runtime-service';
import { ROOM_TICK } from '../../../src/lib/job-queue-constants';
import type { RoomRuntime } from '../../../src/lib/room/runtime/room-runtime';

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
		reactiveDb: {} as never,
		...overrides,
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
