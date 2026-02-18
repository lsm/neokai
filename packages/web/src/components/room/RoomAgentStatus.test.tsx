// @ts-nocheck
/**
 * Tests for RoomAgentStatus Component
 */

import { render, cleanup } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RoomAgentStatus } from './RoomAgentStatus';
import type { RoomAgentState } from '@neokai/shared';

describe('RoomAgentStatus', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
	});

	afterEach(() => {
		cleanup();
	});

	describe('Stopped State (no state)', () => {
		it('should render "Agent stopped" when state is null', () => {
			const { container } = render(<RoomAgentStatus roomId="room-1" state={null} />);
			expect(container.textContent).toContain('Agent stopped');
		});

		it('should show Start button when onAction is provided and state is null', () => {
			const onAction = vi.fn();
			const { container } = render(
				<RoomAgentStatus roomId="room-1" state={null} onAction={onAction} />
			);
			const startButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent === 'Start'
			);
			expect(startButton).toBeTruthy();
		});

		it('should not show Start button when onAction is not provided', () => {
			const { container } = render(<RoomAgentStatus roomId="room-1" state={null} />);
			const buttons = container.querySelectorAll('button');
			expect(buttons.length).toBe(0);
		});

		it('should call onAction with "start" when Start button is clicked', () => {
			const onAction = vi.fn();
			const { container } = render(
				<RoomAgentStatus roomId="room-1" state={null} onAction={onAction} />
			);
			const startButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent === 'Start'
			);
			startButton?.click();
			expect(onAction).toHaveBeenCalledWith('start');
		});
	});

	describe('Lifecycle State Rendering', () => {
		const createMockState = (
			lifecycleState: RoomAgentState['lifecycleState'],
			overrides?: Partial<RoomAgentState>
		): RoomAgentState => ({
			roomId: 'room-1',
			lifecycleState,
			activeSessionPairIds: [],
			lastActivityAt: Date.now(),
			errorCount: 0,
			pendingActions: [],
			...overrides,
		});

		it('should render idle state with gray badge', () => {
			const state = createMockState('idle');
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			const badge = container.querySelector('.bg-gray-700');
			expect(badge).toBeTruthy();
			expect(badge?.textContent).toBe('Idle');
		});

		it('should render planning state with blue badge', () => {
			const state = createMockState('planning');
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			const badge = container.querySelector('.bg-blue-900\\/50');
			expect(badge).toBeTruthy();
			expect(badge?.textContent).toBe('Planning');
		});

		it('should render executing state with green badge', () => {
			const state = createMockState('executing');
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			const badge = container.querySelector('.bg-green-900\\/50');
			expect(badge).toBeTruthy();
			expect(badge?.textContent).toBe('Executing');
		});

		it('should render waiting state with yellow badge', () => {
			const state = createMockState('waiting');
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			const badge = container.querySelector('.bg-yellow-900\\/50');
			expect(badge).toBeTruthy();
			expect(badge?.textContent).toBe('Waiting');
		});

		it('should render reviewing state with purple badge', () => {
			const state = createMockState('reviewing');
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			const badge = container.querySelector('.bg-purple-900\\/50');
			expect(badge).toBeTruthy();
			expect(badge?.textContent).toBe('Reviewing');
		});

		it('should render error state with red badge', () => {
			const state = createMockState('error');
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			const badge = container.querySelector('.bg-red-900\\/50');
			expect(badge).toBeTruthy();
			expect(badge?.textContent).toBe('Error');
		});

		it('should render paused state with orange badge', () => {
			const state = createMockState('paused');
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			const badge = container.querySelector('.bg-orange-900\\/50');
			expect(badge).toBeTruthy();
			expect(badge?.textContent).toBe('Paused');
		});
	});

	describe('Activity Description', () => {
		const createMockState = (overrides?: Partial<RoomAgentState>): RoomAgentState => ({
			roomId: 'room-1',
			lifecycleState: 'executing',
			activeSessionPairIds: [],
			lastActivityAt: Date.now(),
			errorCount: 0,
			pendingActions: [],
			...overrides,
		});

		it('should show current task when currentTaskId is set', () => {
			const state = createMockState({ currentTaskId: 'task-12345678' });
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			expect(container.textContent).toContain('Working on task: task-123');
		});

		it('should truncate task ID to 8 characters', () => {
			const state = createMockState({ currentTaskId: 'verylongtaskid12345' });
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			expect(container.textContent).toContain('Working on task: verylong');
		});

		it('should show current goal when currentGoalId is set and no task', () => {
			const state = createMockState({ currentGoalId: 'goal-12345678' });
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			expect(container.textContent).toContain('Pursuing goal: goal-123');
		});

		it('should show active sessions when no task or goal', () => {
			const state = createMockState({ activeSessionPairIds: ['pair-1', 'pair-2'] });
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			expect(container.textContent).toContain('2 active sessions');
		});

		it('should show singular session count', () => {
			const state = createMockState({ activeSessionPairIds: ['pair-1'] });
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			expect(container.textContent).toContain('1 active session');
		});

		it('should show pending actions when no task, goal, or sessions', () => {
			const state = createMockState({ pendingActions: ['action1', 'action2', 'action3'] });
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			expect(container.textContent).toContain('3 pending actions');
		});

		it('should show singular pending action', () => {
			const state = createMockState({ pendingActions: ['action1'] });
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			expect(container.textContent).toContain('1 pending action');
		});

		it('should prioritize task over goal in description', () => {
			const state = createMockState({
				currentTaskId: 'task-123',
				currentGoalId: 'goal-456',
			});
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			expect(container.textContent).toContain('Working on task:');
			expect(container.textContent).not.toContain('Pursuing goal:');
		});
	});

	describe('Error Indicator', () => {
		const createMockState = (overrides?: Partial<RoomAgentState>): RoomAgentState => ({
			roomId: 'room-1',
			lifecycleState: 'executing',
			activeSessionPairIds: [],
			lastActivityAt: Date.now(),
			errorCount: 0,
			pendingActions: [],
			...overrides,
		});

		it('should not show error indicator when errorCount is 0', () => {
			const state = createMockState({ errorCount: 0 });
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			const errorIndicator = container.querySelector('.bg-red-900\\/50');
			expect(errorIndicator).toBeNull();
		});

		it('should show error indicator when errorCount > 0', () => {
			const state = createMockState({ errorCount: 3 });
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			expect(container.textContent).toContain('3');
		});

		it('should show lastError as title attribute', () => {
			const state = createMockState({
				errorCount: 1,
				lastError: 'Something went wrong',
			});
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			const errorElement = container.querySelector('[title="Something went wrong"]');
			expect(errorElement).toBeTruthy();
		});

		it('should show default title when lastError is not set', () => {
			const state = createMockState({ errorCount: 1 });
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			const errorElement = container.querySelector('[title="Errors occurred"]');
			expect(errorElement).toBeTruthy();
		});
	});

	describe('Action Buttons', () => {
		const createMockState = (overrides?: Partial<RoomAgentState>): RoomAgentState => ({
			roomId: 'room-1',
			lifecycleState: 'executing',
			activeSessionPairIds: [],
			lastActivityAt: Date.now(),
			errorCount: 0,
			pendingActions: [],
			...overrides,
		});

		it('should show Pause button when running (executing)', () => {
			const onAction = vi.fn();
			const state = createMockState({ lifecycleState: 'executing' });
			const { container } = render(
				<RoomAgentStatus roomId="room-1" state={state} onAction={onAction} />
			);
			const pauseButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent === 'Pause'
			);
			expect(pauseButton).toBeTruthy();
		});

		it('should show Pause button when planning', () => {
			const onAction = vi.fn();
			const state = createMockState({ lifecycleState: 'planning' });
			const { container } = render(
				<RoomAgentStatus roomId="room-1" state={state} onAction={onAction} />
			);
			const pauseButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent === 'Pause'
			);
			expect(pauseButton).toBeTruthy();
		});

		it('should show Resume button when paused', () => {
			const onAction = vi.fn();
			const state = createMockState({ lifecycleState: 'paused' });
			const { container } = render(
				<RoomAgentStatus roomId="room-1" state={state} onAction={onAction} />
			);
			const resumeButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent === 'Resume'
			);
			expect(resumeButton).toBeTruthy();
		});

		it('should not show action buttons for idle state', () => {
			const onAction = vi.fn();
			const state = createMockState({ lifecycleState: 'idle' });
			const { container } = render(
				<RoomAgentStatus roomId="room-1" state={state} onAction={onAction} />
			);
			const buttons = container.querySelectorAll('button');
			expect(buttons.length).toBe(0);
		});

		it('should not show action buttons when onAction is not provided', () => {
			const state = createMockState({ lifecycleState: 'executing' });
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			const buttons = container.querySelectorAll('button');
			expect(buttons.length).toBe(0);
		});

		it('should call onAction with "pause" when Pause is clicked', () => {
			const onAction = vi.fn();
			const state = createMockState({ lifecycleState: 'executing' });
			const { container } = render(
				<RoomAgentStatus roomId="room-1" state={state} onAction={onAction} />
			);
			const pauseButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent === 'Pause'
			);
			pauseButton?.click();
			expect(onAction).toHaveBeenCalledWith('pause');
		});

		it('should call onAction with "resume" when Resume is clicked', () => {
			const onAction = vi.fn();
			const state = createMockState({ lifecycleState: 'paused' });
			const { container } = render(
				<RoomAgentStatus roomId="room-1" state={state} onAction={onAction} />
			);
			const resumeButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent === 'Resume'
			);
			resumeButton?.click();
			expect(onAction).toHaveBeenCalledWith('resume');
		});
	});

	describe('Relative Time Formatting', () => {
		const createMockState = (lastActivityAt: number): RoomAgentState => ({
			roomId: 'room-1',
			lifecycleState: 'idle',
			activeSessionPairIds: [],
			lastActivityAt,
			errorCount: 0,
			pendingActions: [],
		});

		it('should show "Just now" for recent activity', () => {
			const state = createMockState(Date.now() - 30000); // 30 seconds ago
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			expect(container.textContent).toContain('Just now');
		});

		it('should show minutes ago for activity within an hour', () => {
			const state = createMockState(Date.now() - 5 * 60 * 1000); // 5 minutes ago
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			expect(container.textContent).toContain('5 min ago');
		});

		it('should show hours ago for activity within a day', () => {
			const state = createMockState(Date.now() - 3 * 60 * 60 * 1000); // 3 hours ago
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			expect(container.textContent).toContain('3h ago');
		});

		it('should show "Yesterday" for activity 1 day ago', () => {
			const state = createMockState(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			expect(container.textContent).toContain('Yesterday');
		});

		it('should show days ago for activity within a week', () => {
			const state = createMockState(Date.now() - 3 * 24 * 60 * 60 * 1000); // 3 days ago
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			expect(container.textContent).toContain('3d ago');
		});
	});

	describe('Styling', () => {
		const createMockState = (overrides?: Partial<RoomAgentState>): RoomAgentState => ({
			roomId: 'room-1',
			lifecycleState: 'executing',
			activeSessionPairIds: [],
			lastActivityAt: Date.now(),
			errorCount: 0,
			pendingActions: [],
			...overrides,
		});

		it('should have rounded-lg container', () => {
			const state = createMockState();
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			const mainContainer = container.querySelector('.rounded-lg');
			expect(mainContainer).toBeTruthy();
		});

		it('should have proper flex layout', () => {
			const state = createMockState();
			const { container } = render(<RoomAgentStatus roomId="room-1" state={state} />);
			const flexContainer = container.querySelector('.flex.items-center.justify-between');
			expect(flexContainer).toBeTruthy();
		});
	});
});
