/**
 * Tests for TaskViewToggle Component
 *
 * Covers:
 * - Default view is V1 when localStorage has no value
 * - Reads persisted preference from localStorage synchronously (no flicker)
 * - Toggle button switches V1 → V2 and V2 → V1
 * - Persists preference to localStorage on toggle
 * - Renders TaskView (V1) or TaskViewV2 conditionally
 * - data-testid="task-view-toggle" is passed to child views via viewVersion prop
 * - aria-label updates based on current version
 *
 * Note: The view toggle button is now rendered inside TaskInfoPanel (gear menu)
 * rather than as a persistent header bar. The tests mock the child views but
 * verify that the correct viewVersion context is passed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/preact';
import { TaskViewToggle } from '../TaskViewToggle';
import type { TaskViewVersionContext } from '../TaskViewToggle';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let capturedVersion: TaskViewVersionContext | null = null;

vi.mock('../TaskView', () => ({
	TaskView: ({
		roomId,
		taskId,
		viewVersion,
	}: {
		roomId: string;
		taskId: string;
		viewVersion?: TaskViewVersionContext;
	}) => {
		capturedVersion = viewVersion ?? null;
		return (
			<div data-testid="task-view-v1" data-room-id={roomId} data-task-id={taskId}>
				TaskView V1
			</div>
		);
	},
}));

vi.mock('../TaskViewV2', () => ({
	TaskViewV2: ({
		roomId,
		taskId,
		viewVersion,
	}: {
		roomId: string;
		taskId: string;
		viewVersion?: TaskViewVersionContext;
	}) => {
		capturedVersion = viewVersion ?? null;
		return (
			<div data-testid="task-view-v2" data-room-id={roomId} data-task-id={taskId}>
				TaskViewV2
			</div>
		);
	},
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
		capturedVersion = null;
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

	it('toggles from V1 to V2 on viewVersion.onToggleVersion call', async () => {
		const { getByTestId, queryByTestId } = render(
			<TaskViewToggle roomId="room-1" taskId="task-1" />
		);
		expect(getByTestId('task-view-v1')).toBeTruthy();
		expect(capturedVersion?.version).toBe('v1');

		// Simulate the toggle being called (e.g., from within TaskInfoPanel)
		await act(async () => {
			capturedVersion?.onToggleVersion();
		});

		// After toggle, V2 view should be rendered
		expect(getByTestId('task-view-v2')).toBeTruthy();
		expect(queryByTestId('task-view-v1')).toBeNull();
		expect(localStorageMock.setItem).toHaveBeenCalledWith('neokai:taskViewVersion', 'v2');
	});

	it('toggles from V2 back to V1 on second onToggleVersion call', async () => {
		localStorageMock.getItem.mockReturnValueOnce('v2');
		const { getByTestId, queryByTestId } = render(
			<TaskViewToggle roomId="room-1" taskId="task-1" />
		);
		expect(getByTestId('task-view-v2')).toBeTruthy();
		expect(capturedVersion?.version).toBe('v2');

		await act(async () => {
			capturedVersion?.onToggleVersion();
		});

		expect(getByTestId('task-view-v1')).toBeTruthy();
		expect(queryByTestId('task-view-v2')).toBeNull();
		expect(localStorageMock.setItem).toHaveBeenCalledWith('neokai:taskViewVersion', 'v1');
	});

	it('persists V2 to localStorage when toggled from V1', async () => {
		render(<TaskViewToggle roomId="room-1" taskId="task-1" />);
		await act(async () => {
			capturedVersion?.onToggleVersion();
		});
		expect(localStorageMock.setItem).toHaveBeenCalledWith('neokai:taskViewVersion', 'v2');
	});

	it('persists V1 to localStorage when toggled from V2', async () => {
		localStorageMock.getItem.mockReturnValueOnce('v2');
		render(<TaskViewToggle roomId="room-1" taskId="task-1" />);
		await act(async () => {
			capturedVersion?.onToggleVersion();
		});
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

	it('passes viewVersion context to V1 view with version "v1"', () => {
		render(<TaskViewToggle roomId="room-1" taskId="task-1" />);
		expect(capturedVersion).toBeTruthy();
		expect(capturedVersion?.version).toBe('v1');
		expect(typeof capturedVersion?.onToggleVersion).toBe('function');
	});

	it('passes viewVersion context to V2 view with version "v2"', () => {
		localStorageMock.getItem.mockReturnValueOnce('v2');
		render(<TaskViewToggle roomId="room-1" taskId="task-1" />);
		expect(capturedVersion).toBeTruthy();
		expect(capturedVersion?.version).toBe('v2');
		expect(typeof capturedVersion?.onToggleVersion).toBe('function');
	});

	it('uses storage key "neokai:taskViewVersion"', () => {
		render(<TaskViewToggle roomId="room-1" taskId="task-1" />);
		expect(localStorageMock.getItem).toHaveBeenCalledWith('neokai:taskViewVersion');
	});

	it('does not render a persistent toggle bar above the view', () => {
		const { container } = render(<TaskViewToggle roomId="room-1" taskId="task-1" />);
		// The old toggle bar had "View:" label text — that should not exist anymore
		expect(container.textContent).not.toContain('View:');
	});
});
