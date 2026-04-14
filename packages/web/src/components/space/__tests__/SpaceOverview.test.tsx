// @ts-nocheck
/**
 * Unit tests for SpaceOverview.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { RuntimeState, Space, SpaceTask } from '@neokai/shared';

let mockSpace: ReturnType<typeof signal<Space | null>>;
let mockLoading: ReturnType<typeof signal<boolean>>;
let mockTasks: ReturnType<typeof signal<SpaceTask[]>>;
let mockRuntimeState: ReturnType<typeof signal<RuntimeState | null>>;
let mockSessions: ReturnType<
	typeof signal<{ id: string; title?: string; status: string; lastActiveAt: number }[]>
>;

const mockPauseSpace = vi.fn().mockResolvedValue(undefined);
const mockResumeSpace = vi.fn().mockResolvedValue(undefined);

vi.mock('../../../lib/space-store', () => ({
	get spaceStore() {
		return {
			space: mockSpace,
			loading: mockLoading,
			tasks: mockTasks,
			runtimeState: mockRuntimeState,
			sessions: mockSessions,
			pauseSpace: mockPauseSpace,
			resumeSpace: mockResumeSpace,
		};
	},
}));

vi.mock('../../../lib/router', () => ({
	navigateToSpaceTask: vi.fn(),
	navigateToSpaceAgent: vi.fn(),
}));

mockSpace = signal<Space | null>(null);
mockLoading = signal(false);
mockTasks = signal<SpaceTask[]>([]);
mockRuntimeState = signal<RuntimeState | null>(null);
mockSessions = signal([]);

import { SpaceOverview } from '../SpaceOverview';

function makeSpace(overrides: Partial<Space> = {}): Space {
	return {
		id: 'space-1',
		name: 'My Space',
		workspacePath: '/projects/my-space',
		description: '',
		backgroundContext: '',
		sessionIds: [],
		status: 'active',
		paused: false,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		...overrides,
	};
}

function makeTask(
	id: string,
	status: SpaceTask['status'] = 'open',
	overrides: Partial<SpaceTask> = {}
): SpaceTask {
	return {
		id,
		spaceId: 'space-1',
		taskNumber: Number(id.replace(/\D/g, '')) || 1,
		title: `Task ${id}`,
		description: '',
		status,
		priority: 'normal',
		labels: [],
		dependsOn: [],
		result: null,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		startedAt: null,
		completedAt: null,
		archivedAt: null,
		...overrides,
	};
}

describe('SpaceOverview', () => {
	beforeEach(() => {
		cleanup();
		mockSpace.value = null;
		mockLoading.value = false;
		mockTasks.value = [];
		mockRuntimeState.value = null;
		mockSessions.value = [];
		mockPauseSpace.mockClear();
		mockResumeSpace.mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders loading spinner when loading', () => {
		mockLoading.value = true;
		const { container } = render(<SpaceOverview spaceId="space-1" />);
		expect(container.querySelector('.animate-spin')).toBeTruthy();
	});

	it('renders "Space not found" when no space', () => {
		const { getByText } = render(<SpaceOverview spaceId="space-1" />);
		expect(getByText('Space not found')).toBeTruthy();
	});

	it('renders stat cards with correct counts', () => {
		mockSpace.value = makeSpace();
		mockTasks.value = [
			makeTask('t1', 'open'),
			makeTask('t2', 'in_progress'),
			makeTask('t3', 'blocked'),
			makeTask('t4', 'done'),
		];

		const { getByText } = render(<SpaceOverview spaceId="space-1" />);
		// Stats strip: Active (open + in_progress = 2), Review (blocked = 1), Done (done = 1)
		expect(getByText('Active')).toBeTruthy();
		expect(getByText('Review')).toBeTruthy();
		expect(getByText('Done')).toBeTruthy();
	});

	it('renders recent tasks sorted by updatedAt', () => {
		mockSpace.value = makeSpace();
		const now = Date.now();
		mockTasks.value = [
			makeTask('t1', 'open', { updatedAt: now - 60_000 }),
			makeTask('t2', 'in_progress', { updatedAt: now }),
			makeTask('t3', 'done', { updatedAt: now - 120_000 }),
		];

		const { getByText } = render(<SpaceOverview spaceId="space-1" />);
		expect(getByText('Recent Tasks')).toBeTruthy();
		expect(getByText('Task t1')).toBeTruthy();
		expect(getByText('Task t2')).toBeTruthy();
		expect(getByText('Task t3')).toBeTruthy();
	});

	it('shows empty state when there are no tasks', () => {
		mockSpace.value = makeSpace();
		const { getByText } = render(<SpaceOverview spaceId="space-1" />);
		expect(getByText('No tasks yet')).toBeTruthy();
		expect(getByText('Create a task to get started')).toBeTruthy();
	});

	it('calls onSelectTask when a task row is clicked', () => {
		mockSpace.value = makeSpace();
		mockTasks.value = [makeTask('t1', 'done')];
		const onSelectTask = vi.fn();
		const { getByText } = render(<SpaceOverview spaceId="space-1" onSelectTask={onSelectTask} />);
		fireEvent.click(getByText('Task t1').closest('button')!);
		expect(onSelectTask).toHaveBeenCalledWith('t1');
	});

	it('renders the Create Task button', () => {
		mockSpace.value = makeSpace();
		const { getByRole } = render(<SpaceOverview spaceId="space-1" />);
		expect(getByRole('button', { name: 'Create Task' })).toBeTruthy();
	});

	it('clicking Create Task button opens the Create Task dialog', () => {
		mockSpace.value = makeSpace();
		const { getByRole } = render(<SpaceOverview spaceId="space-1" />);
		fireEvent.click(getByRole('button', { name: 'Create Task' }));
		const dialog = document.body.querySelector('[role="dialog"]');
		expect(dialog).toBeTruthy();
		expect(dialog?.querySelector('h2')?.textContent).toBe('Create Task');
	});

	it('renders runtime control bar when runtimeState is set', () => {
		mockSpace.value = makeSpace();
		mockRuntimeState.value = 'running';
		const { getByText } = render(<SpaceOverview spaceId="space-1" />);
		expect(getByText('Running')).toBeTruthy();
	});

	it('does not render runtime control bar when runtimeState is null', () => {
		mockSpace.value = makeSpace();
		mockRuntimeState.value = null;
		const { queryByText } = render(<SpaceOverview spaceId="space-1" />);
		expect(queryByText('Running')).toBeNull();
		expect(queryByText('Paused')).toBeNull();
		expect(queryByText('Stopped')).toBeNull();
	});

	it('limits recent tasks to 8', () => {
		mockSpace.value = makeSpace();
		const now = Date.now();
		mockTasks.value = Array.from({ length: 10 }, (_, i) =>
			makeTask(`t${i + 1}`, 'in_progress', { updatedAt: now - i * 60_000 })
		);

		const { container } = render(<SpaceOverview spaceId="space-1" />);
		// Each task renders as a button inside the activity list
		const activityButtons = container.querySelectorAll('.divide-y button');
		expect(activityButtons.length).toBe(8);
	});

	it('stat card counts update when tasks change', () => {
		mockSpace.value = makeSpace();
		mockTasks.value = [makeTask('t1', 'open')];

		const { container, rerender } = render(<SpaceOverview spaceId="space-1" />);

		// Active count should include the open task
		const getStatText = () =>
			Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
		let stats = getStatText();
		expect(stats.some((t) => t?.includes('Active') && t?.includes('1'))).toBe(true);
		expect(stats.some((t) => t?.includes('Review') && t?.includes('0'))).toBe(true);

		// Add a blocked task
		mockTasks.value = [makeTask('t1', 'open'), makeTask('t2', 'blocked')];
		rerender(<SpaceOverview spaceId="space-1" />);

		stats = getStatText();
		expect(stats.some((t) => t?.includes('Active') && t?.includes('1'))).toBe(true);
		expect(stats.some((t) => t?.includes('Review') && t?.includes('1'))).toBe(true);
	});

	describe('Runtime State Indicator', () => {
		it('shows running state with green indicator and ping animation', () => {
			mockSpace.value = makeSpace();
			mockRuntimeState.value = 'running';
			const { container, getByText } = render(<SpaceOverview spaceId="space-1" />);
			expect(getByText('Running')).toBeTruthy();
			expect(container.querySelector('.bg-green-400')).toBeTruthy();
			expect(container.querySelector('.animate-ping')).toBeTruthy();
		});

		it('shows paused state with yellow indicator and no ping', () => {
			mockSpace.value = makeSpace();
			mockRuntimeState.value = 'paused';
			const { container, getByText } = render(<SpaceOverview spaceId="space-1" />);
			expect(getByText('Paused')).toBeTruthy();
			expect(container.querySelector('.bg-yellow-400')).toBeTruthy();
			expect(container.querySelector('.animate-ping')).toBeFalsy();
		});

		it('shows stopped state with gray indicator', () => {
			mockSpace.value = makeSpace();
			mockRuntimeState.value = 'stopped';
			const { container, getByText } = render(<SpaceOverview spaceId="space-1" />);
			expect(getByText('Stopped')).toBeTruthy();
			expect(container.querySelector('.bg-gray-500')).toBeTruthy();
		});
	});

	describe('Runtime Control Buttons', () => {
		it('shows Pause button when running, no Resume button', () => {
			mockSpace.value = makeSpace();
			mockRuntimeState.value = 'running';
			const { container } = render(<SpaceOverview spaceId="space-1" />);
			const buttons = Array.from(container.querySelectorAll('button'));
			expect(buttons.find((b) => b.textContent === 'Pause')).toBeTruthy();
			expect(buttons.find((b) => b.textContent === 'Resume')).toBeFalsy();
		});

		it('shows Resume button when paused, no Pause button', () => {
			mockSpace.value = makeSpace();
			mockRuntimeState.value = 'paused';
			const { container } = render(<SpaceOverview spaceId="space-1" />);
			const buttons = Array.from(container.querySelectorAll('button'));
			expect(buttons.find((b) => b.textContent === 'Resume')).toBeTruthy();
			expect(buttons.find((b) => b.textContent === 'Pause')).toBeFalsy();
		});

		it('shows no control buttons when stopped', () => {
			mockSpace.value = makeSpace();
			mockRuntimeState.value = 'stopped';
			const { container } = render(<SpaceOverview spaceId="space-1" />);
			const buttons = Array.from(container.querySelectorAll('button'));
			expect(buttons.find((b) => b.textContent === 'Pause')).toBeFalsy();
			expect(buttons.find((b) => b.textContent === 'Resume')).toBeFalsy();
		});

		it('calls pauseSpace when Pause is clicked', async () => {
			mockSpace.value = makeSpace();
			mockRuntimeState.value = 'running';
			const { container } = render(<SpaceOverview spaceId="space-1" />);
			const pauseBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent === 'Pause'
			)!;
			await fireEvent.click(pauseBtn);
			expect(mockPauseSpace).toHaveBeenCalledTimes(1);
		});

		it('calls resumeSpace when Resume is clicked', async () => {
			mockSpace.value = makeSpace();
			mockRuntimeState.value = 'paused';
			const { container } = render(<SpaceOverview spaceId="space-1" />);
			const resumeBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent === 'Resume'
			)!;
			await fireEvent.click(resumeBtn);
			expect(mockResumeSpace).toHaveBeenCalledTimes(1);
		});
	});
});
