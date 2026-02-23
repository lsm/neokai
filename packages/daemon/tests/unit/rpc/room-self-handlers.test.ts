import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from '../../../src/storage/database';
import { RoomManager } from '../../../src/lib/room/room-manager';
import { RoomSelfManager } from '../../../src/lib/rpc-handlers/room-self-handlers';
import { RoomSelfStateRepository } from '../../../src/storage/repositories/room-self-state-repository';
import type { DaemonHub } from '../../../src/lib/daemon-hub';
import type { MessageHub } from '@neokai/shared';
import type { WorkerManager } from '../../../src/lib/room/worker-manager';
import type { PromptTemplateManager } from '../../../src/lib/prompts/prompt-template-manager';
import type { SettingsManager } from '../../../src/lib/settings-manager';

describe('RoomSelfManager run intent autostart', () => {
	let db: Database;
	let roomManager: RoomManager;

	beforeEach(async () => {
		db = new Database(':memory:');
		await db.initialize();
		roomManager = new RoomManager(db.getDatabase());
	});

	afterEach(() => {
		db.close();
	});

	function createManager(): RoomSelfManager {
		const daemonHub = {
			emit: mock(async () => {}),
			on: mock(() => () => {}),
			off: mock(() => {}),
			once: mock(async () => {}),
		} as unknown as DaemonHub;
		const messageHub = {
			onRequest: mock(() => () => {}),
			onEvent: mock(() => () => {}),
			event: mock(() => {}),
			request: mock(async () => ({})),
		} as unknown as MessageHub;
		const workerManager = {} as unknown as WorkerManager;
		const promptTemplateManager = {} as unknown as PromptTemplateManager;
		const settingsManager = {
			getGlobalSettings: mock(() => ({})),
		} as unknown as SettingsManager;

		return new RoomSelfManager({
			db,
			daemonHub,
			messageHub,
			roomManager,
			workerManager,
			taskManagerFactory: mock(() => ({})) as unknown as (roomId: string) => never,
			goalManagerFactory: mock(() => ({})) as unknown as (roomId: string) => never,
			scheduler: {} as never,
			getApiKey: async () => null,
			promptTemplateManager,
			settingsManager,
			workspaceRoot: '/tmp',
		});
	}

	it('autostarts rooms marked with run intent', async () => {
		const room = roomManager.createRoom({
			name: 'Autostart Room',
			allowedPaths: [{ path: '/tmp' }],
			defaultPath: '/tmp',
		});
		const stateRepo = new RoomSelfStateRepository(db.getDatabase());
		stateRepo.setRunIntent(room.id, true, { createIfMissing: true });

		const manager = createManager();
		const startAgentMock = mock(async () => {});
		(manager as unknown as { startAgent: typeof startAgentMock }).startAgent = startAgentMock;

		await manager.startAgentsWithRunIntent();

		expect(startAgentMock).toHaveBeenCalledWith(room.id, { persistRunIntent: false });
	});

	it('does not autostart rooms without run intent', async () => {
		const room = roomManager.createRoom({
			name: 'Manual Room',
			allowedPaths: [{ path: '/tmp' }],
			defaultPath: '/tmp',
		});
		const stateRepo = new RoomSelfStateRepository(db.getDatabase());
		stateRepo.setRunIntent(room.id, false, { createIfMissing: true });

		const manager = createManager();
		const startAgentMock = mock(async () => {});
		(manager as unknown as { startAgent: typeof startAgentMock }).startAgent = startAgentMock;

		await manager.startAgentsWithRunIntent();

		expect(startAgentMock).not.toHaveBeenCalled();
	});

	it('does not autostart archived rooms and clears persisted run intent', async () => {
		const room = roomManager.createRoom({
			name: 'Archived Room',
			allowedPaths: [{ path: '/tmp' }],
			defaultPath: '/tmp',
		});
		roomManager.archiveRoom(room.id);

		const stateRepo = new RoomSelfStateRepository(db.getDatabase());
		stateRepo.setRunIntent(room.id, true, { createIfMissing: true });

		const manager = createManager();
		const startAgentMock = mock(async () => {});
		(manager as unknown as { startAgent: typeof startAgentMock }).startAgent = startAgentMock;

		await manager.startAgentsWithRunIntent();

		expect(startAgentMock).not.toHaveBeenCalled();
		expect(stateRepo.getRunIntent(room.id)).toBe(false);
	});

	it('rejects manual start for archived rooms', async () => {
		const room = roomManager.createRoom({
			name: 'Archived Start',
			allowedPaths: [{ path: '/tmp' }],
			defaultPath: '/tmp',
		});
		roomManager.archiveRoom(room.id);

		const manager = createManager();

		await expect(manager.startAgent(room.id)).rejects.toThrow(
			`Cannot start room agent for archived room: ${room.id}`
		);
	});
});
