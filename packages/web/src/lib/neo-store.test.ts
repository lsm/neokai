/**
 * Tests for NeoStore
 *
 * Verifies:
 * - subscribe() sends liveQuery.subscribe for both neo.messages and neo.activity
 * - LiveQuery snapshot populates messages / activity signals
 * - LiveQuery delta (added/removed/updated) updates signals correctly
 * - WebSocket reconnect re-subscribes both feeds
 * - unsubscribe() calls liveQuery.unsubscribe for both feeds and resets state
 * - Idempotent subscribe/unsubscribe behaviour
 * - Stale-event guard discards events after unsubscribe
 * - Post-await unsubscribe race guard
 * - openPanel / closePanel / togglePanel update panelOpen signal
 * - panelOpen state persists in localStorage
 * - sendMessage() calls neo.send RPC
 * - loadHistory() calls neo.history RPC and hydrates messages
 * - clearSession() calls neo.clearSession RPC and resets messages signal
 * - confirmAction() / cancelAction() call RPC and clear pendingConfirmation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LiveQuerySnapshotEvent, LiveQueryDeltaEvent } from '@neokai/shared';
import type { NeoMessage, NeoActivityEntry } from './neo-store.js';

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

vi.mock('./connection-manager.ts', () => ({
	connectionManager: {
		getHub: vi.fn(),
		getHubIfConnected: vi.fn(),
	},
}));

import { connectionManager } from './connection-manager.js';
import { neoStore } from './neo-store.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeMessage(id: string, overrides: Partial<NeoMessage> = {}): NeoMessage {
	return {
		id,
		sessionId: 'neo:global',
		messageType: 'user',
		messageSubtype: null,
		content: '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}',
		createdAt: Date.now(),
		sendStatus: null,
		origin: null,
		...overrides,
	};
}

function makeActivity(id: string, overrides: Partial<NeoActivityEntry> = {}): NeoActivityEntry {
	return {
		id,
		toolName: 'list_rooms',
		input: null,
		output: null,
		status: 'success',
		error: null,
		targetType: null,
		targetId: null,
		undoable: false,
		undoData: null,
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

const MESSAGES_SUB_ID = 'neo-messages-global';
const ACTIVITY_SUB_ID = 'neo-activity-global';

// ---------------------------------------------------------------------------
// NeoStore Tests
// ---------------------------------------------------------------------------

describe('NeoStore', () => {
	let mockHub: MockHub;
	// eslint-disable-next-line no-unused-vars
	let localStorageMock: Record<string, string>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockHub = createMockHub();

		// Force-reset singleton internal state so tests are fully isolated.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const store = neoStore as any;
		store.refCount = 0;
		store.subscribed = false;
		store.cleanups = [];
		store.activeSubscriptionIds = new Set();

		// Reset signals
		neoStore.messages.value = [];
		neoStore.activity.value = [];
		neoStore.loading.value = false;
		neoStore.panelOpen.value = false;
		neoStore.activeTab.value = 'chat';
		neoStore.pendingConfirmation.value = null;

		vi.mocked(connectionManager.getHub).mockResolvedValue(mockHub as never);
		vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
		vi.mocked(mockHub.request).mockResolvedValue({ ok: true });

		// Mock localStorage
		localStorageMock = {};
		vi.spyOn(Storage.prototype, 'getItem').mockImplementation(
			(key: string) => localStorageMock[key] ?? null
		);
		vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string, value: string) => {
			localStorageMock[key] = value;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// ---------------------------------------------------------------------------
	// subscribe()
	// ---------------------------------------------------------------------------

	describe('subscribe()', () => {
		it('should send liveQuery.subscribe for neo.messages', async () => {
			await neoStore.subscribe();
			expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
				queryName: 'neo.messages',
				params: [100, 0],
				subscriptionId: MESSAGES_SUB_ID,
			});
		});

		it('should send liveQuery.subscribe for neo.activity', async () => {
			await neoStore.subscribe();
			expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
				queryName: 'neo.activity',
				params: [50, 0],
				subscriptionId: ACTIVITY_SUB_ID,
			});
		});

		it('should set loading true while awaiting subscriptions', async () => {
			let resolveHub: (hub: MockHub) => void;
			const hubPromise = new Promise<MockHub>((resolve) => {
				resolveHub = resolve;
			});
			vi.mocked(connectionManager.getHub).mockReturnValue(hubPromise as never);

			const subPromise = neoStore.subscribe();

			resolveHub!(mockHub);
			await Promise.resolve();

			expect(neoStore.loading.value).toBe(true);

			// Fire snapshot to finish loading
			mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
				subscriptionId: MESSAGES_SUB_ID,
				rows: [],
				version: 1,
			});

			await subPromise;
			expect(neoStore.loading.value).toBe(false);
		});

		it('should be idempotent — second call is no-op', async () => {
			await neoStore.subscribe();
			mockHub.request.mockClear();
			await neoStore.subscribe();
			expect(mockHub.request).not.toHaveBeenCalled();
		});

		it('should re-throw and reset subscribed flag on error', async () => {
			vi.mocked(mockHub.request).mockRejectedValue(new Error('subscribe failed'));

			await expect(neoStore.subscribe()).rejects.toThrow('subscribe failed');
			expect(neoStore.loading.value).toBe(false);
		});
	});

	// ---------------------------------------------------------------------------
	// Snapshot handling
	// ---------------------------------------------------------------------------

	describe('snapshot handling', () => {
		it('should populate messages from neo.messages snapshot', async () => {
			await neoStore.subscribe();
			mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
				subscriptionId: MESSAGES_SUB_ID,
				rows: [makeMessage('m1'), makeMessage('m2')],
				version: 1,
			});
			expect(neoStore.messages.value).toHaveLength(2);
			expect(neoStore.messages.value[0].id).toBe('m1');
		});

		it('should set loading to false after messages snapshot', async () => {
			await neoStore.subscribe();
			expect(neoStore.loading.value).toBe(true);

			mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
				subscriptionId: MESSAGES_SUB_ID,
				rows: [],
				version: 1,
			});
			expect(neoStore.loading.value).toBe(false);
		});

		it('should populate activity from neo.activity snapshot', async () => {
			await neoStore.subscribe();
			mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
				subscriptionId: ACTIVITY_SUB_ID,
				rows: [makeActivity('a1'), makeActivity('a2')],
				version: 1,
			});
			expect(neoStore.activity.value).toHaveLength(2);
			expect(neoStore.activity.value[0].id).toBe('a1');
		});

		it('should ignore snapshot with unknown subscriptionId', async () => {
			await neoStore.subscribe();
			mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
				subscriptionId: 'unknown-id',
				rows: [makeMessage('stale')],
				version: 1,
			});
			expect(neoStore.messages.value).toHaveLength(0);
			expect(neoStore.activity.value).toHaveLength(0);
		});
	});

	// ---------------------------------------------------------------------------
	// Delta handling — messages
	// ---------------------------------------------------------------------------

	describe('delta handling — messages', () => {
		beforeEach(async () => {
			await neoStore.subscribe();
			mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
				subscriptionId: MESSAGES_SUB_ID,
				rows: [makeMessage('m1'), makeMessage('m2')],
				version: 1,
			});
		});

		it('should add messages from delta.added', () => {
			mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
				subscriptionId: MESSAGES_SUB_ID,
				added: [makeMessage('m3')],
				version: 2,
			});
			expect(neoStore.messages.value).toHaveLength(3);
			expect(neoStore.messages.value.find((m) => m.id === 'm3')).toBeDefined();
		});

		it('should remove messages from delta.removed', () => {
			mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
				subscriptionId: MESSAGES_SUB_ID,
				removed: [makeMessage('m1')],
				version: 2,
			});
			expect(neoStore.messages.value).toHaveLength(1);
			expect(neoStore.messages.value.find((m) => m.id === 'm1')).toBeUndefined();
		});

		it('should update messages from delta.updated', () => {
			mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
				subscriptionId: MESSAGES_SUB_ID,
				updated: [makeMessage('m1', { messageType: 'assistant' })],
				version: 2,
			});
			const m1 = neoStore.messages.value.find((m) => m.id === 'm1');
			expect(m1?.messageType).toBe('assistant');
		});

		it('should ignore delta with wrong subscriptionId', () => {
			mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
				subscriptionId: 'wrong-id',
				added: [makeMessage('stale')],
				version: 2,
			});
			expect(neoStore.messages.value).toHaveLength(2);
		});
	});

	// ---------------------------------------------------------------------------
	// Delta handling — activity
	// ---------------------------------------------------------------------------

	describe('delta handling — activity', () => {
		beforeEach(async () => {
			await neoStore.subscribe();
			mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
				subscriptionId: ACTIVITY_SUB_ID,
				rows: [makeActivity('a1'), makeActivity('a2')],
				version: 1,
			});
		});

		it('should add activity entries from delta.added', () => {
			mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
				subscriptionId: ACTIVITY_SUB_ID,
				added: [makeActivity('a3')],
				version: 2,
			});
			expect(neoStore.activity.value).toHaveLength(3);
		});

		it('should remove activity entries from delta.removed', () => {
			mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
				subscriptionId: ACTIVITY_SUB_ID,
				removed: [makeActivity('a1')],
				version: 2,
			});
			expect(neoStore.activity.value).toHaveLength(1);
		});

		it('should update activity entries from delta.updated', () => {
			mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
				subscriptionId: ACTIVITY_SUB_ID,
				updated: [makeActivity('a1', { status: 'error', error: 'oops' })],
				version: 2,
			});
			const a1 = neoStore.activity.value.find((a) => a.id === 'a1');
			expect(a1?.status).toBe('error');
			expect(a1?.error).toBe('oops');
		});
	});

	// ---------------------------------------------------------------------------
	// Stale-event guard
	// ---------------------------------------------------------------------------

	describe('stale-event guard', () => {
		it('should discard snapshot after unsubscribe', async () => {
			await neoStore.subscribe();
			neoStore.unsubscribe();

			mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
				subscriptionId: MESSAGES_SUB_ID,
				rows: [makeMessage('stale')],
				version: 1,
			});

			expect(neoStore.messages.value).toHaveLength(0);
		});

		it('should discard delta after unsubscribe', async () => {
			await neoStore.subscribe();
			mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
				subscriptionId: MESSAGES_SUB_ID,
				rows: [makeMessage('m1')],
				version: 1,
			});
			expect(neoStore.messages.value).toHaveLength(1);

			neoStore.unsubscribe();

			mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
				subscriptionId: MESSAGES_SUB_ID,
				added: [makeMessage('stale')],
				version: 2,
			});

			expect(neoStore.messages.value).toHaveLength(0);
		});
	});

	// ---------------------------------------------------------------------------
	// Post-await race guard
	// ---------------------------------------------------------------------------

	describe('post-await race guard', () => {
		it('should not leave dangling handlers when unsubscribe races with hub resolution', async () => {
			let resolveRequest!: () => void;
			const requestPromise = new Promise<void>((resolve) => {
				resolveRequest = resolve;
			});
			vi.mocked(mockHub.request).mockReturnValue(requestPromise as never);
			vi.mocked(connectionManager.getHub).mockResolvedValue(mockHub as never);

			const subPromise = neoStore.subscribe();
			neoStore.unsubscribe();
			resolveRequest();
			await subPromise;

			expect(neoStore.loading.value).toBe(false);
			expect(neoStore.messages.value).toHaveLength(0);
		});
	});

	// ---------------------------------------------------------------------------
	// Reconnect handling
	// ---------------------------------------------------------------------------

	describe('WebSocket reconnect', () => {
		it('should re-subscribe both feeds on reconnect', async () => {
			await neoStore.subscribe();
			mockHub.request.mockClear();

			mockHub.fireConnection('connected');

			expect(mockHub.request).toHaveBeenCalledWith(
				'liveQuery.subscribe',
				expect.objectContaining({ subscriptionId: MESSAGES_SUB_ID })
			);
			expect(mockHub.request).toHaveBeenCalledWith(
				'liveQuery.subscribe',
				expect.objectContaining({ subscriptionId: ACTIVITY_SUB_ID })
			);
		});

		it('should not re-subscribe for non-connected state changes', async () => {
			await neoStore.subscribe();
			mockHub.request.mockClear();

			mockHub.fireConnection('disconnected');

			expect(mockHub.request).not.toHaveBeenCalled();
		});
	});

	// ---------------------------------------------------------------------------
	// unsubscribe()
	// ---------------------------------------------------------------------------

	describe('unsubscribe()', () => {
		it('should call liveQuery.unsubscribe for both feeds', async () => {
			await neoStore.subscribe();
			mockHub.request.mockClear();

			neoStore.unsubscribe();

			expect(mockHub.request).toHaveBeenCalledWith('liveQuery.unsubscribe', {
				subscriptionId: MESSAGES_SUB_ID,
			});
			expect(mockHub.request).toHaveBeenCalledWith('liveQuery.unsubscribe', {
				subscriptionId: ACTIVITY_SUB_ID,
			});
		});

		it('should clear messages and activity signals', async () => {
			await neoStore.subscribe();
			mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
				subscriptionId: MESSAGES_SUB_ID,
				rows: [makeMessage('m1')],
				version: 1,
			});
			mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
				subscriptionId: ACTIVITY_SUB_ID,
				rows: [makeActivity('a1')],
				version: 1,
			});

			neoStore.unsubscribe();

			expect(neoStore.messages.value).toHaveLength(0);
			expect(neoStore.activity.value).toHaveLength(0);
		});

		it('should be idempotent', async () => {
			await neoStore.subscribe();
			neoStore.unsubscribe();
			mockHub.request.mockClear();

			neoStore.unsubscribe();

			expect(mockHub.request).not.toHaveBeenCalled();
		});

		it('should be safe to call before subscribe()', () => {
			expect(() => neoStore.unsubscribe()).not.toThrow();
		});
	});

	// ---------------------------------------------------------------------------
	// Panel helpers
	// ---------------------------------------------------------------------------

	describe('openPanel() / closePanel() / togglePanel()', () => {
		it('openPanel sets panelOpen to true', () => {
			neoStore.panelOpen.value = false;
			neoStore.openPanel();
			expect(neoStore.panelOpen.value).toBe(true);
		});

		it('closePanel sets panelOpen to false', () => {
			neoStore.panelOpen.value = true;
			neoStore.closePanel();
			expect(neoStore.panelOpen.value).toBe(false);
		});

		it('togglePanel flips panelOpen from false to true', () => {
			neoStore.panelOpen.value = false;
			neoStore.togglePanel();
			expect(neoStore.panelOpen.value).toBe(true);
		});

		it('togglePanel flips panelOpen from true to false', () => {
			neoStore.panelOpen.value = true;
			neoStore.togglePanel();
			expect(neoStore.panelOpen.value).toBe(false);
		});

		it('openPanel persists true in localStorage', () => {
			neoStore.openPanel();
			expect(localStorage.setItem).toHaveBeenCalledWith('neo:panelOpen', 'true');
		});

		it('closePanel persists false in localStorage', () => {
			neoStore.closePanel();
			expect(localStorage.setItem).toHaveBeenCalledWith('neo:panelOpen', 'false');
		});
	});

	// ---------------------------------------------------------------------------
	// sendMessage()
	// ---------------------------------------------------------------------------

	describe('sendMessage()', () => {
		it('should call neo.send RPC with message text', async () => {
			vi.mocked(mockHub.request).mockResolvedValue({ success: true });

			const result = await neoStore.sendMessage('Hello Neo');

			expect(mockHub.request).toHaveBeenCalledWith('neo.send', { message: 'Hello Neo' });
			expect(result.success).toBe(true);
		});

		it('should return error response on failure', async () => {
			vi.mocked(mockHub.request).mockResolvedValue({
				success: false,
				error: 'Neo unavailable',
				errorCode: 'PROVIDER_ERROR',
			});

			const result = await neoStore.sendMessage('hi');

			expect(result.success).toBe(false);
			expect(result.errorCode).toBe('PROVIDER_ERROR');
		});

		it('should propagate errors thrown by the hub', async () => {
			vi.mocked(mockHub.request).mockRejectedValue(new Error('hub error'));

			await expect(neoStore.sendMessage('hi')).rejects.toThrow('hub error');
		});
	});

	// ---------------------------------------------------------------------------
	// loadHistory()
	// ---------------------------------------------------------------------------

	describe('loadHistory()', () => {
		it('should call neo.history RPC', async () => {
			vi.mocked(mockHub.request).mockResolvedValue({ messages: [], hasMore: false });

			await neoStore.loadHistory();

			expect(mockHub.request).toHaveBeenCalledWith('neo.history', { limit: 100 });
		});

		it('should populate messages when signal is empty', async () => {
			const msgs = [makeMessage('h1'), makeMessage('h2')];
			vi.mocked(mockHub.request).mockResolvedValue({ messages: msgs, hasMore: false });

			await neoStore.loadHistory();

			expect(neoStore.messages.value).toHaveLength(2);
		});

		it('should not overwrite messages already populated by LiveQuery', async () => {
			neoStore.messages.value = [makeMessage('live1')];
			vi.mocked(mockHub.request).mockResolvedValue({
				messages: [makeMessage('h1')],
				hasMore: false,
			});

			await neoStore.loadHistory();

			expect(neoStore.messages.value).toHaveLength(1);
			expect(neoStore.messages.value[0].id).toBe('live1');
		});

		it('should silently ignore errors', async () => {
			vi.mocked(mockHub.request).mockRejectedValue(new Error('history failed'));

			await expect(neoStore.loadHistory()).resolves.toBeUndefined();
		});
	});

	// ---------------------------------------------------------------------------
	// clearSession()
	// ---------------------------------------------------------------------------

	describe('clearSession()', () => {
		it('should call neo.clearSession RPC', async () => {
			vi.mocked(mockHub.request).mockResolvedValue({ success: true });

			await neoStore.clearSession();

			expect(mockHub.request).toHaveBeenCalledWith('neo.clearSession', {});
		});

		it('should clear messages signal on success', async () => {
			neoStore.messages.value = [makeMessage('m1')];
			vi.mocked(mockHub.request).mockResolvedValue({ success: true });

			await neoStore.clearSession();

			expect(neoStore.messages.value).toHaveLength(0);
		});

		it('should not clear messages signal on failure', async () => {
			neoStore.messages.value = [makeMessage('m1')];
			vi.mocked(mockHub.request).mockResolvedValue({ success: false, error: 'failed' });

			await neoStore.clearSession();

			expect(neoStore.messages.value).toHaveLength(1);
		});

		it('should return success flag and error from RPC', async () => {
			vi.mocked(mockHub.request).mockResolvedValue({ success: false, error: 'some error' });

			const result = await neoStore.clearSession();

			expect(result.success).toBe(false);
			expect(result.error).toBe('some error');
		});
	});

	// ---------------------------------------------------------------------------
	// confirmAction()
	// ---------------------------------------------------------------------------

	describe('confirmAction()', () => {
		it('should call neo.confirmAction RPC with actionId', async () => {
			vi.mocked(mockHub.request).mockResolvedValue({ success: true });
			neoStore.pendingConfirmation.value = { actionId: 'act-1', description: 'Do something' };

			await neoStore.confirmAction('act-1');

			expect(mockHub.request).toHaveBeenCalledWith('neo.confirmAction', { actionId: 'act-1' });
		});

		it('should clear pendingConfirmation on success', async () => {
			vi.mocked(mockHub.request).mockResolvedValue({ success: true });
			neoStore.pendingConfirmation.value = { actionId: 'act-1', description: 'test' };

			await neoStore.confirmAction('act-1');

			expect(neoStore.pendingConfirmation.value).toBeNull();
		});

		it('should clear pendingConfirmation on RPC error', async () => {
			vi.mocked(mockHub.request).mockRejectedValue(new Error('rpc error'));
			neoStore.pendingConfirmation.value = { actionId: 'act-1', description: 'test' };

			const result = await neoStore.confirmAction('act-1');

			expect(neoStore.pendingConfirmation.value).toBeNull();
			expect(result.success).toBe(false);
			expect(result.error).toBe('rpc error');
		});
	});

	// ---------------------------------------------------------------------------
	// cancelAction()
	// ---------------------------------------------------------------------------

	describe('cancelAction()', () => {
		it('should call neo.cancelAction RPC with actionId', async () => {
			vi.mocked(mockHub.request).mockResolvedValue({ success: true });
			neoStore.pendingConfirmation.value = { actionId: 'act-2', description: 'Cancel me' };

			await neoStore.cancelAction('act-2');

			expect(mockHub.request).toHaveBeenCalledWith('neo.cancelAction', { actionId: 'act-2' });
		});

		it('should clear pendingConfirmation on success', async () => {
			vi.mocked(mockHub.request).mockResolvedValue({ success: true });
			neoStore.pendingConfirmation.value = { actionId: 'act-2', description: 'test' };

			await neoStore.cancelAction('act-2');

			expect(neoStore.pendingConfirmation.value).toBeNull();
		});

		it('should clear pendingConfirmation on RPC error', async () => {
			vi.mocked(mockHub.request).mockRejectedValue(new Error('cancel error'));
			neoStore.pendingConfirmation.value = { actionId: 'act-2', description: 'test' };

			const result = await neoStore.cancelAction('act-2');

			expect(neoStore.pendingConfirmation.value).toBeNull();
			expect(result.success).toBe(false);
			expect(result.error).toBe('cancel error');
		});
	});
});
