/**
 * Tests for RoomMcpStore and Room MCP Enablement
 *
 * RoomMcpStore tests verify:
 * - LiveQuery snapshot populates overrides signal
 * - LiveQuery delta (added/removed/updated) updates signal correctly
 * - WebSocket reconnect re-subscribes automatically
 * - unsubscribe() calls liveQuery.unsubscribe and resets state
 * - Idempotent subscribe/unsubscribe behavior
 * - Stale-event guard discards events after unsubscribe
 * - getEffectiveEnabled returns override or global default
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LiveQuerySnapshotEvent, LiveQueryDeltaEvent } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

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
				if (list) {
					const i = list.indexOf(handler as EventHandler);
					if (i >= 0) list.splice(i, 1);
				}
			};
		},
		onConnection: (handler: EventHandler<string>) => {
			_connectionHandlers.push(handler as EventHandler);
			return () => {
				const i = _connectionHandlers.indexOf(handler as EventHandler);
				if (i >= 0) _connectionHandlers.splice(i, 1);
			};
		},
		request: vi.fn(),
		fire: <T>(method: string, data: T) => {
			for (const h of _handlers.get(method) ?? []) h(data);
		},
		fireConnection: (state: string) => {
			for (const h of _connectionHandlers) h(state);
		},
	};
}

vi.mock('../connection-manager.ts', () => ({
	connectionManager: {
		getHub: vi.fn(),
		getHubIfConnected: vi.fn(),
	},
}));

import { connectionManager } from '../connection-manager.js';
import { roomMcpStore, type RoomMcpOverride } from '../room-mcp-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOverride(serverId: string, overrides: Partial<RoomMcpOverride> = {}): RoomMcpOverride {
	return {
		serverId,
		enabled: true,
		name: `Server ${serverId}`,
		sourceType: 'stdio',
		...overrides,
	};
}

const ROOM_ID = 'room-1';
const SUBSCRIPTION_ID = `mcpEnablement-${ROOM_ID}`;

// ---------------------------------------------------------------------------
// RoomMcpStore Tests
// ---------------------------------------------------------------------------

describe('RoomMcpStore', () => {
	let mockHub: MockHub;

	beforeEach(() => {
		vi.clearAllMocks();
		mockHub = createMockHub();

		// Reset store signals
		roomMcpStore.overrides.value = new Map();
		roomMcpStore.loading.value = false;
		roomMcpStore.error.value = null;

		vi.mocked(connectionManager.getHub).mockResolvedValue(mockHub as never);
		vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
		vi.mocked(mockHub.request).mockResolvedValue({ ok: true });
	});

	afterEach(() => {
		roomMcpStore.unsubscribe();
	});

	// ---------------------------------------------------------------------------
	// subscribe()
	// ---------------------------------------------------------------------------

	describe('subscribe()', () => {
		it('should send liveQuery.subscribe request with mcpEnablement.byRoom query', async () => {
			await roomMcpStore.subscribe(ROOM_ID);
			expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
				queryName: 'mcpEnablement.byRoom',
				params: [ROOM_ID],
				subscriptionId: SUBSCRIPTION_ID,
			});
		});

		it('should set loading true while awaiting snapshot', async () => {
			let resolveHub: (hub: MockHub) => void;
			const hubPromise = new Promise<MockHub>((resolve) => {
				resolveHub = (hub) => resolve(hub);
			});
			vi.mocked(connectionManager.getHub).mockReturnValue(hubPromise as never);

			const loadingValues: boolean[] = [];
			const unsub = roomMcpStore.loading.subscribe((v) => loadingValues.push(v));

			const subPromise = roomMcpStore.subscribe(ROOM_ID);

			resolveHub!(mockHub);
			await Promise.resolve();

			expect(roomMcpStore.loading.value).toBe(true);

			mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
				subscriptionId: SUBSCRIPTION_ID,
				rows: [],
				version: 1,
			});

			await subPromise;
			expect(roomMcpStore.loading.value).toBe(false);

			unsub();
		});

		it('should populate overrides from snapshot rows', async () => {
			const overrides = [makeOverride('srv-1'), makeOverride('srv-2', { enabled: false })];

			await roomMcpStore.subscribe(ROOM_ID);
			mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
				subscriptionId: SUBSCRIPTION_ID,
				rows: overrides,
				version: 1,
			});

			expect(roomMcpStore.overrides.value.size).toBe(2);
			expect(roomMcpStore.overrides.value.get('srv-1')?.enabled).toBe(true);
			expect(roomMcpStore.overrides.value.get('srv-2')?.enabled).toBe(false);
		});

		it('should be idempotent — second subscribe() with same roomId is no-op', async () => {
			await roomMcpStore.subscribe(ROOM_ID);
			mockHub.request.mockClear();
			await roomMcpStore.subscribe(ROOM_ID);
			expect(mockHub.request).not.toHaveBeenCalled();
		});

		it('should unsubscribe and resubscribe when roomId changes', async () => {
			await roomMcpStore.subscribe(ROOM_ID);

			// Second subscribe with different roomId should unsubscribe first
			const newRoomId = 'room-2';
			const newSubscriptionId = `mcpEnablement-${newRoomId}`;
			await roomMcpStore.subscribe(newRoomId);

			// Should have called unsubscribe for the old subscription
			expect(mockHub.request).toHaveBeenCalledWith('liveQuery.unsubscribe', {
				subscriptionId: SUBSCRIPTION_ID,
			});
			// Should have subscribed to the new room
			expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
				queryName: 'mcpEnablement.byRoom',
				params: [newRoomId],
				subscriptionId: newSubscriptionId,
			});
		});

		it('should set error signal and re-throw when hub subscription fails', async () => {
			vi.mocked(mockHub.request).mockRejectedValue(new Error('subscribe failed'));

			await expect(roomMcpStore.subscribe(ROOM_ID)).rejects.toThrow('subscribe failed');
			expect(roomMcpStore.error.value).toBe('subscribe failed');
			expect(roomMcpStore.loading.value).toBe(false);
		});
	});

	// ---------------------------------------------------------------------------
	// liveQuery.delta handling
	// ---------------------------------------------------------------------------

	describe('delta handling', () => {
		beforeEach(async () => {
			await roomMcpStore.subscribe(ROOM_ID);
			mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
				subscriptionId: SUBSCRIPTION_ID,
				rows: [makeOverride('srv-1'), makeOverride('srv-2')],
				version: 1,
			});
			expect(roomMcpStore.overrides.value.size).toBe(2);
		});

		it('should add new overrides from delta.added', () => {
			mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
				subscriptionId: SUBSCRIPTION_ID,
				added: [makeOverride('srv-3')],
				version: 2,
			});

			expect(roomMcpStore.overrides.value.size).toBe(3);
			expect(roomMcpStore.overrides.value.has('srv-3')).toBe(true);
		});

		it('should remove overrides from delta.removed', () => {
			mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
				subscriptionId: SUBSCRIPTION_ID,
				removed: [makeOverride('srv-1')],
				version: 2,
			});

			expect(roomMcpStore.overrides.value.size).toBe(1);
			expect(roomMcpStore.overrides.value.has('srv-1')).toBe(false);
		});

		it('should update existing overrides from delta.updated', () => {
			mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
				subscriptionId: SUBSCRIPTION_ID,
				updated: [makeOverride('srv-1', { enabled: false })],
				version: 2,
			});

			expect(roomMcpStore.overrides.value.get('srv-1')?.enabled).toBe(false);
		});

		it('should ignore delta with wrong subscriptionId', () => {
			mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
				subscriptionId: 'other-subscription',
				added: [makeOverride('srv-99')],
				version: 2,
			});

			expect(roomMcpStore.overrides.value.size).toBe(2);
			expect(roomMcpStore.overrides.value.has('srv-99')).toBe(false);
		});
	});

	// ---------------------------------------------------------------------------
	// Stale-event guard
	// ---------------------------------------------------------------------------

	describe('stale-event guard', () => {
		it('should discard snapshot event fired after unsubscribe', async () => {
			await roomMcpStore.subscribe(ROOM_ID);

			mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
				subscriptionId: SUBSCRIPTION_ID,
				rows: [makeOverride('pre-1')],
				version: 1,
			});
			expect(roomMcpStore.overrides.value.size).toBe(1);

			roomMcpStore.unsubscribe();

			mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
				subscriptionId: SUBSCRIPTION_ID,
				rows: [makeOverride('stale-server')],
				version: 2,
			});

			expect(roomMcpStore.overrides.value.size).toBe(0);
		});

		it('should discard delta event fired after unsubscribe', async () => {
			await roomMcpStore.subscribe(ROOM_ID);
			mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
				subscriptionId: SUBSCRIPTION_ID,
				rows: [makeOverride('srv-1')],
				version: 1,
			});
			expect(roomMcpStore.overrides.value.size).toBe(1);

			roomMcpStore.unsubscribe();

			mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
				subscriptionId: SUBSCRIPTION_ID,
				added: [makeOverride('stale-add')],
				version: 2,
			});

			expect(roomMcpStore.overrides.value.size).toBe(0);
		});
	});

	// ---------------------------------------------------------------------------
	// WebSocket reconnect
	// ---------------------------------------------------------------------------

	describe('WebSocket reconnect', () => {
		it('should re-subscribe with same subscriptionId on reconnect', async () => {
			await roomMcpStore.subscribe(ROOM_ID);

			mockHub.fireConnection('connected');

			expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
				queryName: 'mcpEnablement.byRoom',
				params: [ROOM_ID],
				subscriptionId: SUBSCRIPTION_ID,
			});
		});

		it('should set loading true before re-subscribe on reconnect', async () => {
			await roomMcpStore.subscribe(ROOM_ID);
			mockHub.request.mockClear();

			const loadingValues: boolean[] = [];
			const unsub = roomMcpStore.loading.subscribe((v) => loadingValues.push(v));

			mockHub.fireConnection('connected');

			expect(loadingValues).toContain(true);

			unsub();
		});
	});

	// ---------------------------------------------------------------------------
	// unsubscribe()
	// ---------------------------------------------------------------------------

	describe('unsubscribe()', () => {
		it('should call liveQuery.unsubscribe', async () => {
			await roomMcpStore.subscribe(ROOM_ID);
			mockHub.request.mockClear();

			roomMcpStore.unsubscribe();

			expect(mockHub.request).toHaveBeenCalledWith('liveQuery.unsubscribe', {
				subscriptionId: SUBSCRIPTION_ID,
			});
		});

		it('should clear overrides signal', async () => {
			await roomMcpStore.subscribe(ROOM_ID);
			mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
				subscriptionId: SUBSCRIPTION_ID,
				rows: [makeOverride('srv-1')],
				version: 1,
			});
			expect(roomMcpStore.overrides.value.size).toBe(1);

			roomMcpStore.unsubscribe();

			expect(roomMcpStore.overrides.value.size).toBe(0);
		});

		it('should clear error signal', async () => {
			vi.mocked(mockHub.request).mockRejectedValue(new Error('fail'));
			await expect(roomMcpStore.subscribe(ROOM_ID)).rejects.toThrow();
			expect(roomMcpStore.error.value).not.toBeNull();

			roomMcpStore.unsubscribe();
			expect(roomMcpStore.error.value).toBeNull();
		});

		it('should be idempotent — second unsubscribe() call is no-op', async () => {
			await roomMcpStore.subscribe(ROOM_ID);
			roomMcpStore.unsubscribe();
			mockHub.request.mockClear();

			roomMcpStore.unsubscribe();

			expect(mockHub.request).not.toHaveBeenCalled();
		});

		it('should be safe to call before subscribe()', () => {
			expect(() => roomMcpStore.unsubscribe()).not.toThrow();
		});
	});

	// ---------------------------------------------------------------------------
	// getEffectiveEnabled()
	// ---------------------------------------------------------------------------

	describe('getEffectiveEnabled()', () => {
		beforeEach(async () => {
			await roomMcpStore.subscribe(ROOM_ID);
			mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
				subscriptionId: SUBSCRIPTION_ID,
				rows: [makeOverride('srv-1', { enabled: false }), makeOverride('srv-2', { enabled: true })],
				version: 1,
			});
		});

		it('should return per-room override when present', () => {
			// srv-1 has override enabled=false
			expect(roomMcpStore.getEffectiveEnabled('srv-1', true)).toBe(false);
			// srv-2 has override enabled=true
			expect(roomMcpStore.getEffectiveEnabled('srv-2', false)).toBe(true);
		});

		it('should return global default when no override', () => {
			// srv-3 has no override, should return global default
			expect(roomMcpStore.getEffectiveEnabled('srv-3', true)).toBe(true);
			expect(roomMcpStore.getEffectiveEnabled('srv-3', false)).toBe(false);
		});

		it('should handle empty overrides map', () => {
			roomMcpStore.overrides.value = new Map();
			expect(roomMcpStore.getEffectiveEnabled('srv-1', true)).toBe(true);
		});
	});
});
