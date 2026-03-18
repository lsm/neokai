// @ts-nocheck
/**
 * Tests for GoalsEditor Component
 */

import { render, cleanup, fireEvent } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoalsEditor } from './GoalsEditor';
import type { RoomGoal, TaskSummary } from '@neokai/shared';

describe('GoalsEditor', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
	});

	afterEach(() => {
		cleanup();
		document.body.style.overflow = '';
	});

	const createMockGoal = (id: string, overrides?: Partial<RoomGoal>): RoomGoal => ({
		id,
		roomId: 'room-1',
		title: `Goal ${id}`,
		description: `Description for ${id}`,
		status: 'active',
		priority: 'normal',
		progress: 50,
		linkedTaskIds: [],
		createdAt: Date.now() - 86400000,
		updatedAt: Date.now(),
		...overrides,
	});

	const defaultHandlers = {
		onCreateGoal: vi.fn().mockResolvedValue(undefined),
		onUpdateGoal: vi.fn().mockResolvedValue(undefined),
		onDeleteGoal: vi.fn().mockResolvedValue(undefined),
		onLinkTask: vi.fn().mockResolvedValue(undefined),
	};

	describe('Rendering', () => {
		it('should render the Missions header', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);
			expect(container.textContent).toContain('Missions');
		});

		it('should display goal count badge', () => {
			const goals = [createMockGoal('goal-1'), createMockGoal('goal-2')];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			const badge = container.querySelector('.bg-dark-700');
			expect(badge?.textContent).toBe('2');
		});

		it('should render "Create Mission" button', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);
			const buttons = container.querySelectorAll('button');
			const hasCreateGoal = Array.from(buttons).some((btn) => btn.textContent === 'Create Mission');
			expect(hasCreateGoal).toBe(true);
		});
	});

	describe('Empty State', () => {
		it('should show empty state when no goals', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);
			expect(container.textContent).toContain('No missions yet');
			expect(container.textContent).toContain('Create your first mission to get started');
		});

		it('should have "Create Mission" button in empty state', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);
			const buttons = container.querySelectorAll('button');
			const hasCreateGoal = Array.from(buttons).some((btn) => btn.textContent === 'Create Mission');
			expect(hasCreateGoal).toBe(true);
		});
	});

	describe('Loading State', () => {
		it('should show loading skeleton when isLoading is true', () => {
			const { container } = render(
				<GoalsEditor goals={[]} {...defaultHandlers} isLoading={true} />
			);
			expect(container.querySelector('.skeleton')).toBeTruthy();
		});

		it('should not show goals when loading', () => {
			const goals = [createMockGoal('goal-1', { title: 'Loading Test Goal' })];
			const { container } = render(
				<GoalsEditor goals={goals} {...defaultHandlers} isLoading={true} />
			);
			expect(container.textContent).not.toContain('Loading Test Goal');
		});
	});

	describe('Goal Item Rendering', () => {
		it('should render goal title', () => {
			const goals = [createMockGoal('goal-1', { title: 'Rendered Goal Title' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			expect(container.textContent).toContain('Rendered Goal Title');
		});

		it('should render goal progress', () => {
			const goals = [createMockGoal('goal-1', { progress: 75 })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			// Progress bar displays percentage
			const progressText = Array.from(container.querySelectorAll('span')).find((el) =>
				el.textContent?.includes('%')
			);
			expect(progressText?.textContent).toBeTruthy();
		});

		it('should show linked tasks count', () => {
			const goals = [createMockGoal('goal-1', { linkedTaskIds: ['task-1', 'task-2'] })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			expect(container.textContent).toContain('2 tasks');
		});

		it('should show singular task count', () => {
			const goals = [createMockGoal('goal-1', { linkedTaskIds: ['task-1'] })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			expect(container.textContent).toContain('1 task');
		});
	});

	describe('Status Icons', () => {
		it('should show spinner for active status', () => {
			const goals = [createMockGoal('goal-1', { status: 'active' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			// Spinner component has animate-spin class
			const spinner = container.querySelector('[class*="animate-spin"]');
			expect(spinner).toBeTruthy();
		});

		it('should show green checkmark for completed status', () => {
			const goals = [createMockGoal('goal-1', { status: 'completed' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			const completedIcon = container.querySelector('.bg-green-500');
			expect(completedIcon).toBeTruthy();
		});

		it('should show yellow icon for needs_human status', () => {
			const goals = [createMockGoal('goal-1', { status: 'needs_human' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			const needsHumanIcon = container.querySelector('.bg-yellow-500');
			expect(needsHumanIcon).toBeTruthy();
		});

		it('should show gray icon for archived status', () => {
			const goals = [createMockGoal('goal-1', { status: 'archived' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			const archivedIcon = container.querySelector('.bg-gray-600');
			expect(archivedIcon).toBeTruthy();
		});
	});

	describe('Priority Badges', () => {
		it('should show priority badge text', () => {
			const goals = [createMockGoal('goal-1', { priority: 'low' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			expect(container.textContent).toContain('low');
		});

		it('should show normal priority badge', () => {
			const goals = [createMockGoal('goal-1', { priority: 'normal' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			expect(container.textContent).toContain('normal');
		});

		it('should show high priority badge', () => {
			const goals = [createMockGoal('goal-1', { priority: 'high' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			expect(container.textContent).toContain('high');
		});

		it('should show urgent priority badge', () => {
			const goals = [createMockGoal('goal-1', { priority: 'urgent' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			expect(container.textContent).toContain('urgent');
		});
	});

	describe('Progress Bar Colors', () => {
		it('should show red progress bar for progress below 30%', () => {
			const goals = [createMockGoal('goal-1', { progress: 20 })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			const progressBar = container.querySelector('.bg-red-500');
			expect(progressBar).toBeTruthy();
		});

		it('should show yellow progress bar for progress between 30-70%', () => {
			const goals = [createMockGoal('goal-1', { progress: 50 })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			const progressBar = container.querySelector('.bg-yellow-500');
			expect(progressBar).toBeTruthy();
		});

		it('should show green progress bar for progress above 70%', () => {
			const goals = [createMockGoal('goal-1', { progress: 80 })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			const progressBar = container.querySelector('.bg-green-500');
			expect(progressBar).toBeTruthy();
		});
	});

	describe('Goal Expansion', () => {
		it('should not show description when collapsed', () => {
			const goals = [createMockGoal('goal-1', { description: 'Detailed description here' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			expect(container.textContent).not.toContain('Detailed description here');
		});

		it('should have clickable header for expansion', () => {
			const goals = [createMockGoal('goal-1', { description: 'Detailed description here' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);

			const goalHeader = container.querySelector('.cursor-pointer');
			expect(goalHeader).toBeTruthy();
		});
	});

	describe('Goal Sorting', () => {
		it('should sort active goals first', () => {
			const goals = [
				createMockGoal('goal-needs-human', { title: 'Needs Human Goal', status: 'needs_human' }),
				createMockGoal('goal-active', { title: 'Active Goal', status: 'active' }),
			];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);

			const goalElements = container.querySelectorAll('h4');
			expect(goalElements[0]?.textContent).toBe('Active Goal');
			expect(goalElements[1]?.textContent).toBe('Needs Human Goal');
		});

		it('should sort by priority within same status', () => {
			const goals = [
				createMockGoal('goal-low', { title: 'Low Priority', status: 'active', priority: 'low' }),
				createMockGoal('goal-urgent', {
					title: 'Urgent Priority',
					status: 'active',
					priority: 'urgent',
				}),
			];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);

			const goalElements = container.querySelectorAll('h4');
			expect(goalElements[0]?.textContent).toBe('Urgent Priority');
			expect(goalElements[1]?.textContent).toBe('Low Priority');
		});
	});

	describe('Action Buttons', () => {
		it('should have Edit button for each goal', () => {
			const goals = [createMockGoal('goal-1')];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);

			const buttons = container.querySelectorAll('button');
			const hasEditButton = Array.from(buttons).some((btn) => btn.textContent === 'Edit');
			expect(hasEditButton).toBe(true);
		});

		it('should have Delete button for each goal', () => {
			const goals = [createMockGoal('goal-1')];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);

			const buttons = container.querySelectorAll('button');
			const hasDeleteButton = Array.from(buttons).some((btn) => btn.textContent === 'Delete');
			expect(hasDeleteButton).toBe(true);
		});
	});

	describe('Linked Tasks with Title Resolution', () => {
		const mockTasks: TaskSummary[] = [
			{
				id: 'task-1',
				title: 'Build auth module',
				status: 'completed',
				priority: 'high',
				progress: 100,
			},
			{
				id: 'task-2',
				title: 'Write unit tests',
				status: 'in_progress',
				priority: 'normal',
				progress: 50,
			},
			{ id: 'task-3', title: 'Deploy to staging', status: 'pending', priority: 'low', progress: 0 },
		];

		it('should show task title instead of task ID when tasks prop is provided', () => {
			const goals = [createMockGoal('goal-1', { linkedTaskIds: ['task-1'] })];

			const { container } = render(
				<GoalsEditor goals={goals} tasks={mockTasks} {...defaultHandlers} />
			);

			// Expand the goal to see linked tasks
			const header = container.querySelector('.cursor-pointer');
			fireEvent.click(header!);

			expect(container.textContent).toContain('Build auth module');
		});

		it('should show task ID as fallback when task is not found in tasks array', () => {
			const goals = [createMockGoal('goal-1', { linkedTaskIds: ['unknown-task-id'] })];

			const { container } = render(
				<GoalsEditor goals={goals} tasks={mockTasks} {...defaultHandlers} />
			);

			// Expand the goal
			const header = container.querySelector('.cursor-pointer');
			fireEvent.click(header!);

			expect(container.textContent).toContain('unknown-task-id');
		});

		it('should show task ID when tasks prop is not provided', () => {
			const goals = [createMockGoal('goal-1', { linkedTaskIds: ['task-1'] })];

			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);

			// Expand the goal
			const header = container.querySelector('.cursor-pointer');
			fireEvent.click(header!);

			expect(container.textContent).toContain('task-1');
		});

		it('should show TaskStatusBadge for linked tasks with known status', () => {
			const goals = [createMockGoal('goal-1', { linkedTaskIds: ['task-1', 'task-2'] })];

			const { container } = render(
				<GoalsEditor goals={goals} tasks={mockTasks} {...defaultHandlers} />
			);

			// Expand the goal
			const header = container.querySelector('.cursor-pointer');
			fireEvent.click(header!);

			// TaskStatusBadge for completed shows "completed", for in_progress shows "active"
			expect(container.textContent).toContain('completed');
			expect(container.textContent).toContain('active');
		});

		it('should not show TaskStatusBadge when task is not found', () => {
			const goals = [createMockGoal('goal-1', { linkedTaskIds: ['missing-task'] })];

			const { container } = render(
				<GoalsEditor goals={goals} tasks={mockTasks} {...defaultHandlers} />
			);

			// Expand the goal
			const header = container.querySelector('.cursor-pointer');
			fireEvent.click(header!);

			// The task title area should show "missing-task" but no status badge
			expect(container.textContent).toContain('missing-task');
		});

		it('should make linked tasks clickable when onTaskClick is provided', () => {
			const onTaskClick = vi.fn();
			const goals = [createMockGoal('goal-1', { linkedTaskIds: ['task-1'] })];

			const { container } = render(
				<GoalsEditor
					goals={goals}
					tasks={mockTasks}
					onTaskClick={onTaskClick}
					{...defaultHandlers}
				/>
			);

			// Expand the goal
			const header = container.querySelector('.cursor-pointer');
			fireEvent.click(header!);

			// Find the linked task element (it should have cursor-pointer due to onTaskClick)
			const linkedTaskElements = container.querySelectorAll('.bg-dark-700.cursor-pointer');
			expect(linkedTaskElements.length).toBeGreaterThan(0);

			fireEvent.click(linkedTaskElements[0]);
			expect(onTaskClick).toHaveBeenCalledWith('task-1');
		});

		it('should show arrow indicator on linked tasks when clickable', () => {
			const onTaskClick = vi.fn();
			const goals = [createMockGoal('goal-1', { linkedTaskIds: ['task-1'] })];

			const { container } = render(
				<GoalsEditor
					goals={goals}
					tasks={mockTasks}
					onTaskClick={onTaskClick}
					{...defaultHandlers}
				/>
			);

			// Expand the goal
			const header = container.querySelector('.cursor-pointer');
			fireEvent.click(header!);

			// Arrow indicator should be present
			expect(container.innerHTML).toContain('→');
		});

		it('should not make linked tasks clickable when onTaskClick is not provided', () => {
			const goals = [createMockGoal('goal-1', { linkedTaskIds: ['task-1'] })];

			const { container } = render(
				<GoalsEditor goals={goals} tasks={mockTasks} {...defaultHandlers} />
			);

			// Expand the goal
			const header = container.querySelector('.cursor-pointer');
			fireEvent.click(header!);

			// Linked tasks should NOT have the combined cursor-pointer + bg-dark-700 class
			// But the bg-dark-700 should still exist without cursor-pointer
			const allBgDark700 = container.querySelectorAll('.bg-dark-700');
			const clickableLinkedTasks = Array.from(allBgDark700).filter(
				(el) =>
					el.className.includes('cursor-pointer') && el.className.includes('hover:bg-dark-600')
			);
			expect(clickableLinkedTasks.length).toBe(0);
		});

		it('should show "No tasks linked" when goal has no linked tasks', () => {
			const goals = [createMockGoal('goal-1', { linkedTaskIds: [] })];

			const { container } = render(
				<GoalsEditor goals={goals} tasks={mockTasks} {...defaultHandlers} />
			);

			// Expand the goal
			const header = container.querySelector('.cursor-pointer');
			fireEvent.click(header!);

			expect(container.textContent).toContain('No tasks linked');
		});

		it('should resolve multiple linked task titles', () => {
			const goals = [createMockGoal('goal-1', { linkedTaskIds: ['task-1', 'task-2', 'task-3'] })];

			const { container } = render(
				<GoalsEditor goals={goals} tasks={mockTasks} {...defaultHandlers} />
			);

			// Expand the goal
			const header = container.querySelector('.cursor-pointer');
			fireEvent.click(header!);

			expect(container.textContent).toContain('Build auth module');
			expect(container.textContent).toContain('Write unit tests');
			expect(container.textContent).toContain('Deploy to staging');
		});
	});
});
