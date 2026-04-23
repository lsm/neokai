/**
 * Tests for useSpaceTaskMessages hook
 *
 * Verifies the hook subscribes to the correct LiveQuery name based on its
 * variant argument:
 *
 *   - default/undefined → `spaceTaskMessages.byTask.compact` (row-sliced + count)
 *   - 'compact'         → `spaceTaskMessages.byTask.compact`
 *   - 'full'            → `spaceTaskMessages.byTask` (legacy, unbounded)
 *
 * The compact variant is the UI default because the compact event feed only
 * needs the last N messages per session; the full variant exists for any
 * renderer that genuinely needs the unbounded history (e.g. the verbose feed).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/preact';

// ---------------------------------------------------------------------------
// Hoisted mock for useMessageHub
// ---------------------------------------------------------------------------

const { mockRequest, mockOnEvent, mockIsConnected } = vi.hoisted(() => ({
	mockRequest: vi.fn().mockResolvedValue(undefined),
	mockOnEvent: vi.fn<(method: string, handler: (event: unknown) => void) => () => void>(
		() => () => {}
	),
	mockIsConnected: { value: true },
}));

vi.mock('../useMessageHub', () => ({
	useMessageHub: () => ({
		request: mockRequest,
		onEvent: mockOnEvent,
		get isConnected() {
			return mockIsConnected.value;
		},
	}),
}));

// Handler registry used by the empty-state flash tests to simulate LiveQuery
// snapshot delivery.
type EventHandler = (event: unknown) => void;
let eventHandlers: Record<string, EventHandler[]> = {};

function fireEvent(method: string, payload: unknown): void {
	(eventHandlers[method] ?? []).forEach((h) => h(payload));
}

function lastSubscribeSubId(): string {
	const subscribeCalls = mockRequest.mock.calls.filter((call) => call[0] === 'liveQuery.subscribe');
	return subscribeCalls[subscribeCalls.length - 1][1].subscriptionId;
}

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { useSpaceTaskMessages } from '../useSpaceTaskMessages';

describe('useSpaceTaskMessages', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		mockOnEvent.mockReset();
		mockRequest.mockResolvedValue(undefined);
		mockIsConnected.value = true;
		eventHandlers = {};
		mockOnEvent.mockImplementation((method: string, handler: EventHandler) => {
			if (!eventHandlers[method]) eventHandlers[method] = [];
			eventHandlers[method].push(handler);
			return () => {
				eventHandlers[method] = (eventHandlers[method] ?? []).filter((h) => h !== handler);
			};
		});
	});

	it('subscribes to the compact query name by default', () => {
		renderHook(() => useSpaceTaskMessages('task-abc'));

		const subscribe = mockRequest.mock.calls.find(([method]) => method === 'liveQuery.subscribe');
		expect(subscribe).toBeDefined();
		expect(subscribe![1]).toMatchObject({
			queryName: 'spaceTaskMessages.byTask.compact',
			params: ['task-abc'],
		});
	});

	it('subscribes to the compact query name when variant="compact"', () => {
		renderHook(() => useSpaceTaskMessages('task-abc', 'compact'));

		const subscribe = mockRequest.mock.calls.find(([method]) => method === 'liveQuery.subscribe');
		expect(subscribe![1]).toMatchObject({
			queryName: 'spaceTaskMessages.byTask.compact',
		});
	});

	it('subscribes to the legacy full query name when variant="full"', () => {
		renderHook(() => useSpaceTaskMessages('task-abc', 'full'));

		const subscribe = mockRequest.mock.calls.find(([method]) => method === 'liveQuery.subscribe');
		expect(subscribe![1]).toMatchObject({
			queryName: 'spaceTaskMessages.byTask',
			params: ['task-abc'],
		});
	});

	it('does not subscribe when taskId is null', () => {
		renderHook(() => useSpaceTaskMessages(null));

		const subscribe = mockRequest.mock.calls.find(([method]) => method === 'liveQuery.subscribe');
		expect(subscribe).toBeUndefined();
	});

	// Regression coverage for the empty-state flash reported against
	// SpaceTaskUnifiedThread. The consumer renders "No task-agent activity
	// yet." when `rows.length === 0 && !isLoading`. On slow networks the old
	// hook briefly exposed that exact combination on first render and on
	// task switch, so the empty-state flashed before the LiveQuery snapshot
	// arrived.
	describe('isLoading (empty-state flash prevention)', () => {
		it('reports isLoading=true on the very first render when a taskId is provided', () => {
			const { result } = renderHook(() => useSpaceTaskMessages('task-1'));

			expect(result.current.isLoading).toBe(true);
			expect(result.current.rows).toEqual([]);
		});

		it('reports isLoading=false when no taskId is provided', () => {
			const { result } = renderHook(() => useSpaceTaskMessages(null));

			expect(result.current.isLoading).toBe(false);
		});

		it('flips isLoading to false once the LiveQuery snapshot arrives', () => {
			const { result } = renderHook(() => useSpaceTaskMessages('task-1'));

			const subId = lastSubscribeSubId();
			expect(result.current.isLoading).toBe(true);

			act(() => {
				fireEvent('liveQuery.snapshot', {
					subscriptionId: subId,
					rows: [],
					version: 1,
				});
			});

			expect(result.current.isLoading).toBe(false);
		});

		it('stays isLoading=true after switching taskId until the new snapshot arrives', () => {
			const { result, rerender } = renderHook(
				({ taskId }: { taskId: string }) => useSpaceTaskMessages(taskId),
				{ initialProps: { taskId: 'task-1' } }
			);

			// Finish loading task-1.
			const firstSubId = lastSubscribeSubId();
			act(() => {
				fireEvent('liveQuery.snapshot', {
					subscriptionId: firstSubId,
					rows: [],
					version: 1,
				});
			});
			expect(result.current.isLoading).toBe(false);

			// Switch to task-2 — isLoading must be true again on the very next
			// render, not one render later after the effect fires.
			rerender({ taskId: 'task-2' });
			expect(result.current.isLoading).toBe(true);

			// Snapshot for task-2 closes the gate.
			const secondSubId = lastSubscribeSubId();
			expect(secondSubId).not.toBe(firstSubId);
			act(() => {
				fireEvent('liveQuery.snapshot', {
					subscriptionId: secondSubId,
					rows: [],
					version: 1,
				});
			});
			expect(result.current.isLoading).toBe(false);
		});

		it('releases the loading gate on subscribe failure', async () => {
			mockRequest.mockRejectedValueOnce(new Error('subscribe failed'));

			const { result } = renderHook(() => useSpaceTaskMessages('task-1'));

			expect(result.current.isLoading).toBe(true);

			// Drain the rejection microtask.
			await act(async () => {
				await Promise.resolve();
			});

			expect(result.current.isLoading).toBe(false);
		});
	});
});
