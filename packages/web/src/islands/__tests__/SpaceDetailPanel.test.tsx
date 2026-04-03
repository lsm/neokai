/**
 * Tests for SpaceDetailPanel.
 *
 * Covers overview/agent navigation, task tab defaults, counters, and sessions behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@testing-library/preact';
import { signal, type Signal } from '@preact/signals';
import type { SpaceTask, Space } from '@neokai/shared';

const {
	mockNavigateToSpace,
	mockNavigateToSpaceAgent,
	mockNavigateToSpaceSession,
	mockNavigateToSpaceTask,
} = vi.hoisted(() => ({
	mockNavigateToSpace: vi.fn(),
	mockNavigateToSpaceAgent: vi.fn(),
	mockNavigateToSpaceSession: vi.fn(),
	mockNavigateToSpaceTask: vi.fn(),
}));

let mockTasksSignal!: Signal<SpaceTask[]>;
let mockSpaceSignal!: Signal<Space | null>;
let mockLoadingSignal!: Signal<boolean>;
let mockSpaceIdSignal!: Signal<string | null>;
let mockCurrentSpaceSessionIdSignal!: Signal<string | null>;
let mockCurrentSpaceTaskIdSignal!: Signal<string | null>;

function initSignals() {
	mockTasksSignal = signal([]);
	mockSpaceSignal = signal(null);
	mockLoadingSignal = signal(false);
	mockSpaceIdSignal = signal('space-1');
	mockCurrentSpaceSessionIdSignal = signal(null);
	mockCurrentSpaceTaskIdSignal = signal(null);
}

initSignals();

vi.mock('../../lib/space-store.ts', () => ({
	get spaceStore() {
		return {
			tasks: mockTasksSignal,
			space: mockSpaceSignal,
			loading: mockLoadingSignal,
			spaceId: mockSpaceIdSignal,
		};
	},
}));

vi.mock('../../lib/router.ts', () => ({
	navigateToSpace: mockNavigateToSpace,
	navigateToSpaceAgent: mockNavigateToSpaceAgent,
	navigateToSpaceSession: mockNavigateToSpaceSession,
	navigateToSpaceTask: mockNavigateToSpaceTask,
}));

vi.mock('../../lib/signals.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/signals.ts')>();
	return {
		...actual,
		get currentSpaceSessionIdSignal() {
			return mockCurrentSpaceSessionIdSignal;
		},
		get currentSpaceTaskIdSignal() {
			return mockCurrentSpaceTaskIdSignal;
		},
	};
});

import { SpaceDetailPanel } from '../SpaceDetailPanel';

function makeTask(
	id: string,
	title: string,
	status: SpaceTask['status'] = 'open',
	overrides: Partial<SpaceTask> = {}
): SpaceTask {
	return {
		id,
		spaceId: 'space-1',
		taskNumber: 1,
		title,
		description: '',
		status,
		priority: 'normal',
		labels: [],
		dependsOn: [],
		result: null,
		startedAt: null,
		completedAt: null,
		archivedAt: null,
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	} as SpaceTask;
}

function makeSpace(id: string, overrides: Partial<Space> = {}): Space {
	return {
		id,
		name: `Space ${id}`,
		status: 'active',
		workspacePath: '/workspace',
		sessionIds: [],
		createdAt: 0,
		updatedAt: 0,
		...overrides,
	} as unknown as Space;
}

describe('SpaceDetailPanel', () => {
	beforeEach(() => {
		cleanup();
		vi.clearAllMocks();
		initSignals();
	});

	afterEach(() => {
		cleanup();
	});

	it('shows loading state when spaceStore is loading', () => {
		mockLoadingSignal.value = true;
		render(<SpaceDetailPanel spaceId="space-1" />);
		expect(screen.getByText('Loading…')).toBeTruthy();
		expect(screen.queryByText('Overview')).toBeNull();
	});

	it('shows loading state when store spaceId does not match prop', () => {
		mockSpaceIdSignal.value = 'other-space';
		render(<SpaceDetailPanel spaceId="space-1" />);
		expect(screen.getByText('Loading…')).toBeTruthy();
	});

	it('renders Overview and Space Agent buttons', () => {
		render(<SpaceDetailPanel spaceId="space-1" />);
		expect(screen.getByText('Overview')).toBeTruthy();
		expect(screen.getByText('Space Agent')).toBeTruthy();
	});

	it('removes the old Space Activity header block', () => {
		mockSpaceSignal.value = makeSpace('space-1', { workspacePath: '/tmp/workspace' });
		render(<SpaceDetailPanel spaceId="space-1" />);
		expect(screen.queryByText('Space Activity')).toBeNull();
		expect(screen.queryByText('/tmp/workspace')).toBeNull();
	});

	it('navigates to space overview and calls onNavigate', () => {
		const onNavigate = vi.fn();
		render(<SpaceDetailPanel spaceId="space-1" onNavigate={onNavigate} />);
		fireEvent.click(screen.getByText('Overview'));
		expect(mockNavigateToSpace).toHaveBeenCalledWith('space-1');
		expect(onNavigate).toHaveBeenCalledOnce();
	});

	it('navigates to the space agent and calls onNavigate', () => {
		const onNavigate = vi.fn();
		render(<SpaceDetailPanel spaceId="space-1" onNavigate={onNavigate} />);
		fireEvent.click(screen.getByText('Space Agent'));
		expect(mockNavigateToSpaceAgent).toHaveBeenCalledWith('space-1');
		expect(onNavigate).toHaveBeenCalledOnce();
	});

	it('highlights Overview when neither session nor task is selected', () => {
		render(<SpaceDetailPanel spaceId="space-1" />);
		const button = screen.getByText('Overview').closest('button');
		expect(button?.className).toContain('bg-dark-700');
	});

	it('highlights Space Agent when its synthetic session is selected', () => {
		mockCurrentSpaceSessionIdSignal.value = 'space:chat:space-1';
		render(<SpaceDetailPanel spaceId="space-1" />);
		const button = screen.getByText('Space Agent').closest('button');
		expect(button?.className).toContain('bg-dark-700');
	});

	it('shows Review tasks by default and includes counters on task tabs', () => {
		mockTasksSignal.value = [
			makeTask('t1', 'Queued Task', 'open'),
			makeTask('t2', 'In Progress Task', 'in_progress'),
			makeTask('t3', 'Blocked Task', 'blocked'),
		];
		render(<SpaceDetailPanel spaceId="space-1" />);

		expect(screen.getByText('Blocked Task')).toBeTruthy();
		expect(screen.queryByText('Queued Task')).toBeNull();
		expect(screen.getByText('Active')).toBeTruthy();
		expect(screen.getByText('Review')).toBeTruthy();
		expect(screen.getByText('2')).toBeTruthy();
		expect(screen.getByText('1')).toBeTruthy();
	});

	it('switches to Active tasks when the Active tab is clicked', () => {
		mockTasksSignal.value = [
			makeTask('t1', 'Queued Task', 'open'),
			makeTask('t2', 'Blocked Task', 'blocked'),
		];
		render(<SpaceDetailPanel spaceId="space-1" />);

		fireEvent.click(screen.getByRole('button', { name: /Active/i }));
		expect(screen.getByText('Queued Task')).toBeTruthy();
		expect(screen.queryByText('Blocked Task')).toBeNull();
	});

	it('keeps the selected task visible even when it does not match the current tab', () => {
		mockTasksSignal.value = [
			makeTask('t1', 'Queued Task', 'open'),
			makeTask('t2', 'Done Task', 'done'),
		];
		mockCurrentSpaceTaskIdSignal.value = 't2';
		render(<SpaceDetailPanel spaceId="space-1" />);

		expect(screen.getByText('Done Task')).toBeTruthy();
	});

	it('navigates to a task on click and calls onNavigate', () => {
		const onNavigate = vi.fn();
		mockTasksSignal.value = [makeTask('t1', 'Blocked Task', 'blocked')];
		render(<SpaceDetailPanel spaceId="space-1" onNavigate={onNavigate} />);

		fireEvent.click(screen.getByText('Blocked Task'));
		expect(mockNavigateToSpaceTask).toHaveBeenCalledWith('space-1', 't1');
		expect(onNavigate).toHaveBeenCalledOnce();
	});

	it('renders Sessions expanded by default', () => {
		mockSpaceSignal.value = makeSpace('space-1', { sessionIds: ['manual-session-abc123'] });
		render(<SpaceDetailPanel spaceId="space-1" />);
		expect(screen.getByText('manual-s')).toBeTruthy();
	});

	it('filters out system sessions from the Sessions section', () => {
		mockSpaceSignal.value = makeSpace('space-1', {
			sessionIds: [
				'space:chat:space-1',
				'space:space-1:task:task-123',
				'space:space-1:workflow:run-1',
				'manual-session-abc123',
			],
		});
		render(<SpaceDetailPanel spaceId="space-1" />);

		expect(screen.queryByText('space:cha')).toBeNull();
		expect(screen.queryByText('space:spa')).toBeNull();
		expect(screen.getByText('manual-s')).toBeTruthy();
	});

	it('navigates to a session on click and calls onNavigate', () => {
		const onNavigate = vi.fn();
		mockSpaceSignal.value = makeSpace('space-1', { sessionIds: ['manual-session-abc123'] });
		render(<SpaceDetailPanel spaceId="space-1" onNavigate={onNavigate} />);

		fireEvent.click(screen.getByText('manual-s'));
		expect(mockNavigateToSpaceSession).toHaveBeenCalledWith('space-1', 'manual-session-abc123');
		expect(onNavigate).toHaveBeenCalledOnce();
	});
});
