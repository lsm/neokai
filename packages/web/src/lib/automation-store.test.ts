import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AutomationTask, LiveQueryDeltaEvent, LiveQuerySnapshotEvent } from '@neokai/shared';

type EventHandler<T = unknown> = (data: T) => void;

interface MockHub {
	_handlers: Map<string, EventHandler[]>;
	_connectionHandlers: EventHandler[];
	onEvent: <T>(method: string, handler: EventHandler<T>) => () => void;
	onConnection: (handler: EventHandler<string>) => () => void;
	request: ReturnType<typeof vi.fn>;
	fire: <T>(method: string, data: T) => void;
	fireConnection: (state: string) => void;
}

function createMockHub(): MockHub {
	const _handlers = new Map<string, EventHandler[]>();
	const _connectionHandlers: EventHandler[] = [];
	return {
		_handlers,
		_connectionHandlers,
		onEvent: <T>(method: string, handler: EventHandler<T>) => {
			if (!_handlers.has(method)) _handlers.set(method, []);
			_handlers.get(method)!.push(handler as EventHandler);
			return () => {
				const list = _handlers.get(method);
				if (!list) return;
				const index = list.indexOf(handler as EventHandler);
				if (index >= 0) list.splice(index, 1);
			};
		},
		onConnection: (handler: EventHandler<string>) => {
			_connectionHandlers.push(handler as EventHandler);
			return () => {
				const index = _connectionHandlers.indexOf(handler as EventHandler);
				if (index >= 0) _connectionHandlers.splice(index, 1);
			};
		},
		request: vi.fn(),
		fire: <T>(method: string, data: T) => {
			for (const handler of _handlers.get(method) ?? []) handler(data);
		},
		fireConnection: (state: string) => {
			for (const handler of _connectionHandlers) handler(state);
		},
	};
}

vi.mock('./connection-manager.ts', () => ({
	connectionManager: {
		getHub: vi.fn(),
		getHubIfConnected: vi.fn(),
	},
}));

import { connectionManager } from './connection-manager.js';
import { automationStore } from './automation-store.js';

function makeAutomation(id: string, overrides: Partial<AutomationTask> = {}): AutomationTask {
	return {
		id,
		ownerType: 'room',
		ownerId: 'room-1',
		title: `Automation ${id}`,
		description: '',
		status: 'active',
		triggerType: 'manual',
		triggerConfig: {},
		targetType: 'room_task',
		targetConfig: {
			roomId: 'room-1',
			titleTemplate: 'Check',
			descriptionTemplate: 'Check progress.',
		},
		conditionConfig: null,
		concurrencyPolicy: 'skip',
		notifyPolicy: 'done_only',
		maxRetries: 3,
		timeoutMs: null,
		nextRunAt: null,
		lastRunAt: null,
		lastCheckedAt: null,
		lastConditionResult: null,
		conditionFailureCount: 0,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		archivedAt: null,
		...overrides,
	};
}

describe('AutomationStore', () => {
	let mockHub: MockHub;

	beforeEach(() => {
		vi.clearAllMocks();
		mockHub = createMockHub();
		vi.mocked(connectionManager.getHub).mockResolvedValue(mockHub as never);
		vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
		vi.mocked(mockHub.request).mockResolvedValue({ ok: true });
		automationStore.unsubscribe();
	});

	afterEach(() => {
		automationStore.unsubscribe();
	});

	it('subscribes to owner-scoped automations LiveQuery', async () => {
		await automationStore.subscribeOwner({ ownerType: 'room', ownerId: 'room-1' });

		expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
			queryName: 'automations.byOwner',
			params: ['room', 'room-1'],
			subscriptionId: 'automations-room-room-1',
		});
	});

	it('applies snapshots and deltas', async () => {
		await automationStore.subscribeOwner({ ownerType: 'room', ownerId: 'room-1' });
		const first = makeAutomation('auto-1');
		const second = makeAutomation('auto-2');

		mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
			subscriptionId: 'automations-room-room-1',
			rows: [first],
			version: 1,
		});

		expect(automationStore.automations.value).toEqual([first]);

		mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
			subscriptionId: 'automations-room-room-1',
			added: [second],
			updated: [{ ...first, status: 'paused' }],
			removed: [],
			version: 2,
		});

		expect(automationStore.automations.value.map((automation) => automation.id)).toEqual([
			'auto-1',
			'auto-2',
		]);
		expect(automationStore.automationStore.getById('auto-1')?.status).toBe('paused');
	});

	it('unsubscribes and clears owner state', async () => {
		await automationStore.subscribeOwner({ ownerType: 'room', ownerId: 'room-1' });
		mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
			subscriptionId: 'automations-room-room-1',
			rows: [makeAutomation('auto-1')],
			version: 1,
		});

		automationStore.unsubscribe();

		expect(mockHub.request).toHaveBeenCalledWith('liveQuery.unsubscribe', {
			subscriptionId: 'automations-room-room-1',
		});
		expect(automationStore.currentOwner.value).toBeNull();
		expect(automationStore.automations.value).toEqual([]);
	});

	it('uses automation RPC commands for mutations', async () => {
		const automation = makeAutomation('auto-1');
		vi.mocked(mockHub.request).mockResolvedValueOnce({ automation });

		const created = await automationStore.create({
			ownerType: 'room',
			ownerId: 'room-1',
			title: 'Check OKR',
			triggerType: 'manual',
			targetType: 'room_task',
			targetConfig: {
				roomId: 'room-1',
				titleTemplate: 'Check',
				descriptionTemplate: 'Check progress.',
			},
		});

		expect(created).toBe(automation);
		expect(mockHub.request).toHaveBeenCalledWith('automation.create', {
			ownerType: 'room',
			ownerId: 'room-1',
			title: 'Check OKR',
			triggerType: 'manual',
			targetType: 'room_task',
			targetConfig: {
				roomId: 'room-1',
				titleTemplate: 'Check',
				descriptionTemplate: 'Check progress.',
			},
		});
	});
});
