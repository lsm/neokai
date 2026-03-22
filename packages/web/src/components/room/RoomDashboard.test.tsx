// @ts-nocheck
/**
 * Tests for RoomDashboard Component
 *
 * Tests runtime state indicator, pause/resume/stop/start controls,
 * confirmation dialogs, loading state,
 * stats overview grid (sessions, pending, active, completed, failed),
 * and tasks/sessions list rendering.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { TaskSummary, RuntimeState } from '@neokai/shared';

// Define signals for store mock
let mockTasks: ReturnType<typeof signal<TaskSummary[]>>;
let mockGoalByTaskId: ReturnType<typeof signal<Map<string, unknown>>>;
let mockSessions: ReturnType<typeof signal<{ id: string; title: string; status: string }[]>>;
let mockRoomId: ReturnType<typeof signal<string | null>>;
let mockRuntimeState: ReturnType<typeof signal<RuntimeState | null>>;
let mockRuntimeModels: ReturnType<
	typeof signal<{ leaderModel: string | null; workerModel: string | null }>
>;
const mockPauseRuntime = vi.fn().mockResolvedValue(undefined);
const mockResumeRuntime = vi.fn().mockResolvedValue(undefined);
const mockStopRuntime = vi.fn().mockResolvedValue(undefined);
const mockStartRuntime = vi.fn().mockResolvedValue(undefined);

vi.mock('../../lib/room-store.ts', () => ({
	get roomStore() {
		return {
			tasks: mockTasks,
			goalByTaskId: mockGoalByTaskId,
			sessions: mockSessions,
			roomId: mockRoomId,
			runtimeState: mockRuntimeState,
			runtimeModels: mockRuntimeModels,
			pauseRuntime: mockPauseRuntime,
			resumeRuntime: mockResumeRuntime,
			stopRuntime: mockStopRuntime,
			startRuntime: mockStartRuntime,
			archiveRoom: vi.fn().mockResolvedValue(undefined),
		};
	},
}));

vi.mock('../../lib/signals.ts', () => ({
	currentRoomTabSignal: { value: null },
}));

const mockNavigateToRoomTask = vi.fn();

vi.mock('../../lib/router.ts', () => ({
	get navigateToRoomTask() {
		return mockNavigateToRoomTask;
	},
}));

vi.mock('../../lib/utils.ts', () => ({
	cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

// Initialize signals after mocks
mockTasks = signal<TaskSummary[]>([]);
mockGoalByTaskId = signal(new Map());
mockSessions = signal([]);
mockRoomId = signal<string | null>('room-1');
mockRuntimeState = signal<RuntimeState | null>(null);
mockRuntimeModels = signal<{ leaderModel: string | null; workerModel: string | null }>({
	leaderModel: null,
	workerModel: null,
});

import { RoomDashboard } from './RoomDashboard';

describe('RoomDashboard', () => {
	beforeEach(() => {
		cleanup();
		mockTasks.value = [];
		mockGoalByTaskId.value = new Map();
		mockSessions.value = [];
		mockRoomId.value = 'room-1';
		mockRuntimeState.value = null;
		mockRuntimeModels.value = { leaderModel: null, workerModel: null };
		mockPauseRuntime.mockClear();
		mockResumeRuntime.mockClear();
		mockStopRuntime.mockClear();
		mockStartRuntime.mockClear();
		mockNavigateToRoomTask.mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	const createTask = (
		id: string,
		status: string,
		overrides?: Partial<TaskSummary>
	): TaskSummary => ({
		id,
		title: `Task ${id}`,
		status: status as TaskSummary['status'],
		priority: 'normal',
		progress: 0,
		...overrides,
	});

	const selectReviewTab = async (container: Element) => {
		const reviewTab = Array.from(container.querySelectorAll('button')).find((b) =>
			b.textContent?.includes('Review')
		);
		if (reviewTab) {
			await fireEvent.click(reviewTab);
		}
	};

	describe('Runtime State Indicator', () => {
		it('should not show runtime controls when state is null', () => {
			mockRuntimeState.value = null;

			const { container } = render(<RoomDashboard />);

			expect(container.textContent).not.toContain('running');
			expect(container.textContent).not.toContain('paused');
			expect(container.textContent).not.toContain('stopped');
		});

		it('should show running state with green indicator', () => {
			mockRuntimeState.value = 'running';

			const { container } = render(<RoomDashboard />);

			expect(container.textContent).toContain('running');
			const greenDot = container.querySelector('.bg-green-500');
			expect(greenDot).toBeTruthy();
		});

		it('should show pulse animation for running state', () => {
			mockRuntimeState.value = 'running';

			const { container } = render(<RoomDashboard />);

			const pulseDot = container.querySelector('.animate-pulse');
			expect(pulseDot).toBeTruthy();
		});

		it('should show paused state with yellow indicator', () => {
			mockRuntimeState.value = 'paused';

			const { container } = render(<RoomDashboard />);

			expect(container.textContent).toContain('paused');
			const yellowDot = container.querySelector('.bg-yellow-500');
			expect(yellowDot).toBeTruthy();
		});

		it('should not pulse when paused', () => {
			mockRuntimeState.value = 'paused';

			const { container } = render(<RoomDashboard />);

			const indicator = container.querySelector('.bg-yellow-500');
			expect(indicator?.className).not.toContain('animate-pulse');
		});

		it('should show stopped state with red indicator', () => {
			mockRuntimeState.value = 'stopped';

			const { container } = render(<RoomDashboard />);

			expect(container.textContent).toContain('stopped');
			const redDot = container.querySelector('.bg-red-500');
			expect(redDot).toBeTruthy();
		});
	});

	describe('Runtime Control Buttons', () => {
		it('should show Pause button when running', () => {
			mockRuntimeState.value = 'running';

			const { container } = render(<RoomDashboard />);

			const buttons = Array.from(container.querySelectorAll('button'));
			const pauseBtn = buttons.find((b) => b.textContent === 'Pause');
			expect(pauseBtn).toBeTruthy();
		});

		it('should not show Resume button when running', () => {
			mockRuntimeState.value = 'running';

			const { container } = render(<RoomDashboard />);

			const buttons = Array.from(container.querySelectorAll('button'));
			const resumeBtn = buttons.find((b) => b.textContent === 'Resume');
			expect(resumeBtn).toBeFalsy();
		});

		it('should show Stop button when running', () => {
			mockRuntimeState.value = 'running';

			const { container } = render(<RoomDashboard />);

			const buttons = Array.from(container.querySelectorAll('button'));
			const stopBtn = buttons.find((b) => b.textContent === 'Stop');
			expect(stopBtn).toBeTruthy();
		});

		it('should show Resume button when paused', () => {
			mockRuntimeState.value = 'paused';

			const { container } = render(<RoomDashboard />);

			const buttons = Array.from(container.querySelectorAll('button'));
			const resumeBtn = buttons.find((b) => b.textContent === 'Resume');
			expect(resumeBtn).toBeTruthy();
		});

		it('should not show Pause button when paused', () => {
			mockRuntimeState.value = 'paused';

			const { container } = render(<RoomDashboard />);

			const buttons = Array.from(container.querySelectorAll('button'));
			const pauseBtn = buttons.find((b) => b.textContent === 'Pause');
			expect(pauseBtn).toBeFalsy();
		});

		it('should show Stop button when paused', () => {
			mockRuntimeState.value = 'paused';

			const { container } = render(<RoomDashboard />);

			const buttons = Array.from(container.querySelectorAll('button'));
			const stopBtn = buttons.find((b) => b.textContent === 'Stop');
			expect(stopBtn).toBeTruthy();
		});

		it('should show Start button when stopped', () => {
			mockRuntimeState.value = 'stopped';

			const { container } = render(<RoomDashboard />);

			const buttons = Array.from(container.querySelectorAll('button'));
			const startBtn = buttons.find((b) => b.textContent === 'Start');
			expect(startBtn).toBeTruthy();
		});

		it('should not show Pause/Resume/Stop when stopped', () => {
			mockRuntimeState.value = 'stopped';

			const { container } = render(<RoomDashboard />);

			const buttons = Array.from(container.querySelectorAll('button'));
			const pauseBtn = buttons.find((b) => b.textContent === 'Pause');
			const resumeBtn = buttons.find((b) => b.textContent === 'Resume');
			const stopBtn = buttons.find((b) => b.textContent === 'Stop');
			expect(pauseBtn).toBeFalsy();
			expect(resumeBtn).toBeFalsy();
			expect(stopBtn).toBeFalsy();
		});

		it('should call resumeRuntime when Resume is clicked', async () => {
			mockRuntimeState.value = 'paused';

			const { container } = render(<RoomDashboard />);

			const buttons = Array.from(container.querySelectorAll('button'));
			const resumeBtn = buttons.find((b) => b.textContent === 'Resume')!;
			await fireEvent.click(resumeBtn);

			expect(mockResumeRuntime).toHaveBeenCalledTimes(1);
		});

		it('should call startRuntime when Start is clicked', async () => {
			mockRuntimeState.value = 'stopped';

			const { container } = render(<RoomDashboard />);

			const buttons = Array.from(container.querySelectorAll('button'));
			const startBtn = buttons.find((b) => b.textContent === 'Start')!;
			await fireEvent.click(startBtn);

			expect(mockStartRuntime).toHaveBeenCalledTimes(1);
		});
	});

	describe('Confirmation Dialogs', () => {
		it('should show pause confirmation dialog when Pause is clicked', async () => {
			mockRuntimeState.value = 'running';

			const { container } = render(<RoomDashboard />);

			const buttons = Array.from(container.querySelectorAll('button'));
			const pauseBtn = buttons.find((b) => b.textContent === 'Pause')!;
			await fireEvent.click(pauseBtn);

			// Modal renders via portal to document.body
			expect(document.body.textContent).toContain('Pause Room');
			expect(document.body.textContent).toContain('prevent the room from starting new tasks');
		});

		it('should not call pauseRuntime until confirmation is accepted', async () => {
			mockRuntimeState.value = 'running';

			const { container } = render(<RoomDashboard />);

			const buttons = Array.from(container.querySelectorAll('button'));
			const pauseBtn = buttons.find((b) => b.textContent === 'Pause')!;
			await fireEvent.click(pauseBtn);

			// pauseRuntime should NOT have been called yet (only dialog shown)
			expect(mockPauseRuntime).not.toHaveBeenCalled();
		});

		it('should show stop confirmation dialog when Stop is clicked', async () => {
			mockRuntimeState.value = 'running';

			const { container } = render(<RoomDashboard />);

			const buttons = Array.from(container.querySelectorAll('button'));
			const stopBtn = buttons.find((b) => b.textContent === 'Stop')!;
			await fireEvent.click(stopBtn);

			// Modal renders via portal to document.body
			expect(document.body.textContent).toContain('Stop Room');
			expect(document.body.textContent).toContain('completely shut down the room runtime');
		});

		it('should not call stopRuntime until confirmation is accepted', async () => {
			mockRuntimeState.value = 'running';

			const { container } = render(<RoomDashboard />);

			const buttons = Array.from(container.querySelectorAll('button'));
			const stopBtn = buttons.find((b) => b.textContent === 'Stop')!;
			await fireEvent.click(stopBtn);

			// stopRuntime should NOT have been called yet (only dialog shown)
			expect(mockStopRuntime).not.toHaveBeenCalled();
		});

		it('should call pauseRuntime when pause confirmation is accepted', async () => {
			mockRuntimeState.value = 'running';

			const { container } = render(<RoomDashboard />);

			// Open pause confirmation
			const pauseBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent === 'Pause'
			)!;
			await fireEvent.click(pauseBtn);

			// Accept confirmation - the confirm button is in the portal (document.body)
			const confirmBtn = Array.from(document.body.querySelectorAll('button')).find(
				(b) => b.textContent === 'Pause' && b !== pauseBtn
			)!;
			await fireEvent.click(confirmBtn);

			expect(mockPauseRuntime).toHaveBeenCalledTimes(1);
		});

		it('should call stopRuntime when stop confirmation is accepted', async () => {
			mockRuntimeState.value = 'running';

			const { container } = render(<RoomDashboard />);

			// Open stop confirmation
			const stopBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent === 'Stop'
			)!;
			await fireEvent.click(stopBtn);

			// Accept confirmation - the confirm button is in the portal (document.body)
			const confirmBtn = Array.from(document.body.querySelectorAll('button')).find(
				(b) => b.textContent === 'Stop Room'
			)!;
			await fireEvent.click(confirmBtn);

			expect(mockStopRuntime).toHaveBeenCalledTimes(1);
		});
	});

	describe('Loading State', () => {
		it('should show Processing text during action', async () => {
			// Make the mock hang to keep loading state active
			mockPauseRuntime.mockReturnValue(new Promise(() => {}));
			mockRuntimeState.value = 'running';

			const { container } = render(<RoomDashboard />);

			// Open pause confirmation
			const pauseBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent === 'Pause'
			)!;
			await fireEvent.click(pauseBtn);

			// Accept the confirmation (find the confirm button in the portal)
			const confirmBtn = Array.from(document.body.querySelectorAll('button')).find(
				(b) => b.textContent === 'Pause' && b !== pauseBtn
			)!;
			await fireEvent.click(confirmBtn);

			// The dialog should show "Processing..." on the confirm button (in portal)
			expect(document.body.textContent).toContain('Processing...');
		});
	});

	describe('Tasks Section', () => {
		it('should show Tasks heading', () => {
			const { container } = render(<RoomDashboard />);

			expect(container.textContent).toContain('Tasks');
		});

		it('should call navigateToRoomTask when View button is clicked on a review task', async () => {
			mockTasks.value = [createTask('task-99', 'review', { title: 'Review Task' })];

			const { container } = render(<RoomDashboard />);
			await selectReviewTab(container);

			const viewBtn = Array.from(container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('View details')
			)!;
			expect(viewBtn).toBeTruthy();

			await fireEvent.click(viewBtn);

			expect(mockNavigateToRoomTask).toHaveBeenCalledWith('room-1', 'task-99');
		});

		it('should NOT call onTaskClick row handler when View button is clicked', async () => {
			mockTasks.value = [createTask('task-99', 'review', { title: 'Review Task' })];

			const { container } = render(<RoomDashboard />);
			await selectReviewTab(container);

			const viewBtn = Array.from(container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('View details')
			)!;
			await fireEvent.click(viewBtn);

			// navigateToRoomTask should be called exactly once (from onView), not twice
			expect(mockNavigateToRoomTask).toHaveBeenCalledTimes(1);
		});
	});

	describe('Sessions Section', () => {
		it('should show Sessions heading', () => {
			const { container } = render(<RoomDashboard />);

			const headings = container.querySelectorAll('h2');
			const sessionsHeading = Array.from(headings).find((h) => h.textContent === 'Sessions');
			expect(sessionsHeading).toBeTruthy();
		});
	});
});
