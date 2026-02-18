// @ts-nocheck
/**
 * Tests for GoalsEditor Component
 */

import { render, cleanup, fireEvent } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GoalsEditor } from './GoalsEditor';
import type { RoomGoal } from '@neokai/shared';

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
		status: 'pending',
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
		it('should render the Goals header', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);
			expect(container.textContent).toContain('Goals');
		});

		it('should display goal count badge', () => {
			const goals = [createMockGoal('goal-1'), createMockGoal('goal-2')];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			const badge = container.querySelector('.bg-dark-700');
			expect(badge?.textContent).toBe('2');
		});

		it('should render "Create Goal" button', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);
			const buttons = container.querySelectorAll('button');
			const hasCreateGoal = Array.from(buttons).some((btn) => btn.textContent === 'Create Goal');
			expect(hasCreateGoal).toBe(true);
		});
	});

	describe('Empty State', () => {
		it('should show empty state when no goals', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);
			expect(container.textContent).toContain('No goals yet');
			expect(container.textContent).toContain('Create your first goal to get started');
		});

		it('should have "Create Goal" button in empty state', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);
			const buttons = container.querySelectorAll('button');
			const hasCreateGoal = Array.from(buttons).some((btn) => btn.textContent === 'Create Goal');
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
		it('should show empty circle for pending status', () => {
			const goals = [createMockGoal('goal-1', { status: 'pending' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			const pendingIcon = container.querySelector('.border-gray-500');
			expect(pendingIcon).toBeTruthy();
		});

		it('should show spinner for in_progress status', () => {
			const goals = [createMockGoal('goal-1', { status: 'in_progress' })];
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

		it('should show red X for blocked status', () => {
			const goals = [createMockGoal('goal-1', { status: 'blocked' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			const blockedIcon = container.querySelector('.bg-red-500');
			expect(blockedIcon).toBeTruthy();
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
		it('should sort in_progress goals first', () => {
			const goals = [
				createMockGoal('goal-pending', { title: 'Pending Goal', status: 'pending' }),
				createMockGoal('goal-progress', { title: 'In Progress Goal', status: 'in_progress' }),
			];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);

			const goalElements = container.querySelectorAll('h4');
			expect(goalElements[0]?.textContent).toBe('In Progress Goal');
			expect(goalElements[1]?.textContent).toBe('Pending Goal');
		});

		it('should sort by priority within same status', () => {
			const goals = [
				createMockGoal('goal-low', { title: 'Low Priority', status: 'pending', priority: 'low' }),
				createMockGoal('goal-urgent', {
					title: 'Urgent Priority',
					status: 'pending',
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
});
