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
import { renderHook } from '@testing-library/preact';

// ---------------------------------------------------------------------------
// Hoisted mock for useMessageHub
// ---------------------------------------------------------------------------

const { mockRequest, mockOnEvent } = vi.hoisted(() => ({
	mockRequest: vi.fn().mockResolvedValue(undefined),
	mockOnEvent: vi.fn(() => () => {}),
}));

vi.mock('../useMessageHub', () => ({
	useMessageHub: () => ({
		request: mockRequest,
		onEvent: mockOnEvent,
		isConnected: true,
	}),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { useSpaceTaskMessages } from '../useSpaceTaskMessages';

describe('useSpaceTaskMessages', () => {
	beforeEach(() => {
		mockRequest.mockClear();
		mockOnEvent.mockClear();
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
});
