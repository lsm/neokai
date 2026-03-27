/**
 * Tests for TaskViewToggle Component
 *
 * Covers:
 * - Default view is V1 when localStorage has no value
 * - Reads persisted preference from localStorage synchronously (no flicker)
 * - Toggle button switches V1 → V2 and V2 → V1
 * - Persists preference to localStorage on toggle
 * - Renders TaskView (V1) or TaskViewV2 conditionally
 * - data-testid="task-view-toggle" present on button
 * - aria-label updates based on current version
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { TaskViewToggle } from '../TaskViewToggle';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../TaskView', () => ({
	TaskView: ({ roomId, taskId }: { roomId: string; taskId: string }) => (
		<div data-testid="task-view-v1" data-room-id={roomId} data-task-id={taskId}>
			TaskView V1
		</div>
	),
}));

vi.mock('../TaskViewV2', () => ({
	TaskViewV2: ({ roomId, taskId }: { roomId: string; taskId: string }) => (
		<div data-testid="task-view-v2" data-room-id={roomId} data-task-id={taskId}>
			TaskViewV2
		</div>
	),
}));

// ---------------------------------------------------------------------------
// localStorage mock
// ---------------------------------------------------------------------------

const localStorageMock = (() => {
	let store: Record<string, string> = {};
	return {
		getItem: vi.fn((key: string) => store[key] ?? null),
		setItem: vi.fn((key: string, value: string) => {
			store[key] = value;
		}),
		removeItem: vi.fn((key: string) => {
			delete store[key];
		}),
		clear: vi.fn(() => {
			store = {};
		}),
	};
})();

Object.defineProperty(window, 'localStorage', { value: localStorageMock });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskViewToggle', () => {
	beforeEach(() => {
		localStorageMock.clear();
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders TaskView (V1) by default when no localStorage entry', () => {
		const { getByTestId, queryByTestId } = render(
			<TaskViewToggle roomId="room-1" taskId="task-1" />
		);
		expect(getByTestId('task-view-v1')).toBeTruthy();
		expect(queryByTestId('task-view-v2')).toBeNull();
	});

	it('renders toggle button with data-testid="task-view-toggle"', () => {
		const { getByTestId } = render(<TaskViewToggle roomId="room-1" taskId="task-1" />);
		expect(getByTestId('task-view-toggle')).toBeTruthy();
	});

	it('reads V2 preference from localStorage synchronously on mount', () => {
		localStorageMock.getItem.mockReturnValueOnce('v2');
		const { getByTestId, queryByTestId } = render(
			<TaskViewToggle roomId="room-1" taskId="task-1" />
		);
		expect(getByTestId('task-view-v2')).toBeTruthy();
		expect(queryByTestId('task-view-v1')).toBeNull();
	});

	it('reads V1 preference from localStorage synchronously on mount', () => {
		localStorageMock.getItem.mockReturnValueOnce('v1');
		const { getByTestId, queryByTestId } = render(
			<TaskViewToggle roomId="room-1" taskId="task-1" />
		);
		expect(getByTestId('task-view-v1')).toBeTruthy();
		expect(queryByTestId('task-view-v2')).toBeNull();
	});

	it('toggles from V1 to V2 on button click', () => {
		const { getByTestId, queryByTestId } = render(
			<TaskViewToggle roomId="room-1" taskId="task-1" />
		);
		expect(getByTestId('task-view-v1')).toBeTruthy();

		fireEvent.click(getByTestId('task-view-toggle'));

		expect(getByTestId('task-view-v2')).toBeTruthy();
		expect(queryByTestId('task-view-v1')).toBeNull();
	});

	it('toggles from V2 back to V1 on second click', () => {
		const { getByTestId, queryByTestId } = render(
			<TaskViewToggle roomId="room-1" taskId="task-1" />
		);
		fireEvent.click(getByTestId('task-view-toggle'));
		expect(getByTestId('task-view-v2')).toBeTruthy();

		fireEvent.click(getByTestId('task-view-toggle'));
		expect(getByTestId('task-view-v1')).toBeTruthy();
		expect(queryByTestId('task-view-v2')).toBeNull();
	});

	it('persists V2 to localStorage when toggled from V1', () => {
		const { getByTestId } = render(<TaskViewToggle roomId="room-1" taskId="task-1" />);
		fireEvent.click(getByTestId('task-view-toggle'));
		expect(localStorageMock.setItem).toHaveBeenCalledWith('neokai:taskViewVersion', 'v2');
	});

	it('persists V1 to localStorage when toggled from V2', () => {
		localStorageMock.getItem.mockReturnValueOnce('v2');
		const { getByTestId } = render(<TaskViewToggle roomId="room-1" taskId="task-1" />);
		fireEvent.click(getByTestId('task-view-toggle'));
		expect(localStorageMock.setItem).toHaveBeenCalledWith('neokai:taskViewVersion', 'v1');
	});

	it('passes roomId and taskId to V1 view', () => {
		const { getByTestId } = render(<TaskViewToggle roomId="my-room" taskId="my-task" />);
		const v1 = getByTestId('task-view-v1');
		expect(v1.getAttribute('data-room-id')).toBe('my-room');
		expect(v1.getAttribute('data-task-id')).toBe('my-task');
	});

	it('passes roomId and taskId to V2 view', () => {
		localStorageMock.getItem.mockReturnValueOnce('v2');
		const { getByTestId } = render(<TaskViewToggle roomId="my-room" taskId="my-task" />);
		const v2 = getByTestId('task-view-v2');
		expect(v2.getAttribute('data-room-id')).toBe('my-room');
		expect(v2.getAttribute('data-task-id')).toBe('my-task');
	});

	it('aria-label indicates switching to V2 when in V1 mode', () => {
		const { getByTestId } = render(<TaskViewToggle roomId="room-1" taskId="task-1" />);
		const btn = getByTestId('task-view-toggle');
		expect(btn.getAttribute('aria-label')).toContain('V2');
	});

	it('aria-label indicates switching to V1 when in V2 mode', () => {
		localStorageMock.getItem.mockReturnValueOnce('v2');
		const { getByTestId } = render(<TaskViewToggle roomId="room-1" taskId="task-1" />);
		const btn = getByTestId('task-view-toggle');
		expect(btn.getAttribute('aria-label')).toContain('V1');
	});

	it('uses storage key "neokai:taskViewVersion"', () => {
		render(<TaskViewToggle roomId="room-1" taskId="task-1" />);
		// getItem is called during lazy init
		expect(localStorageMock.getItem).toHaveBeenCalledWith('neokai:taskViewVersion');
	});
});
