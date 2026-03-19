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

	describe('Mission Type Badge', () => {
		it('should show MissionTypeBadge for measurable missions', () => {
			const goals = [createMockGoal('goal-1', { missionType: 'measurable' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			expect(container.textContent).toContain('Measurable');
		});

		it('should show MissionTypeBadge for recurring missions', () => {
			const goals = [createMockGoal('goal-1', { missionType: 'recurring' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			expect(container.textContent).toContain('Recurring');
		});

		it('should not show MissionTypeBadge for one-shot missions', () => {
			const goals = [createMockGoal('goal-1', { missionType: 'one_shot' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			// One-shot is the default, so no badge is shown
			const typeBadges = container.querySelectorAll('[data-testid="mission-type-badge"]');
			expect(typeBadges.length).toBe(0);
		});
	});

	describe('Autonomy Badge', () => {
		it('should show Semi-Autonomous badge when autonomyLevel is semi_autonomous', () => {
			const goals = [createMockGoal('goal-1', { autonomyLevel: 'semi_autonomous' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			expect(container.textContent).toContain('Semi-Autonomous');
		});

		it('should not show autonomy badge for supervised (default)', () => {
			const goals = [createMockGoal('goal-1', { autonomyLevel: 'supervised' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			const badges = container.querySelectorAll('[data-testid="autonomy-badge"]');
			// supervised badge is only shown in expanded detail, not in header
			expect(badges.length).toBe(0);
		});
	});

	describe('Metric Progress Display', () => {
		it('should show metric progress bars for measurable missions when expanded', () => {
			const goals = [
				createMockGoal('goal-1', {
					missionType: 'measurable',
					structuredMetrics: [
						{ name: 'Test Coverage', target: 100, current: 75, unit: '%' },
						{ name: 'Bugs Fixed', target: 20, current: 10 },
					],
				}),
			];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);

			// Expand the goal
			const header = container.querySelector('.cursor-pointer');
			fireEvent.click(header!);

			expect(container.textContent).toContain('Test Coverage');
			expect(container.textContent).toContain('Bugs Fixed');
			expect(container.textContent).toContain('75 % / 100 %');
			expect(container.textContent).toContain('75%');
		});

		it('should show metric progress in header for measurable missions', () => {
			const goals = [
				createMockGoal('goal-1', {
					missionType: 'measurable',
					structuredMetrics: [{ name: 'Score', target: 100, current: 60 }],
				}),
			];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			// Header shows metric progress without expanding
			expect(container.textContent).toContain('Score');
		});
	});

	describe('Recurring Schedule Display', () => {
		it('should show schedule info in header for recurring missions', () => {
			const goals = [
				createMockGoal('goal-1', {
					missionType: 'recurring',
					schedule: { expression: '@daily', timezone: 'UTC' },
				}),
			];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			expect(container.textContent).toContain('@daily');
		});

		it('should show "Paused" label when schedule is paused', () => {
			const goals = [
				createMockGoal('goal-1', {
					missionType: 'recurring',
					schedule: { expression: '@daily', timezone: 'UTC' },
					schedulePaused: true,
				}),
			];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			expect(container.textContent).toContain('Paused');
		});

		it('should show schedule details when recurring mission is expanded', () => {
			const goals = [
				createMockGoal('goal-1', {
					missionType: 'recurring',
					schedule: { expression: '0 9 * * 1', timezone: 'America/New_York' },
				}),
			];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);

			// Expand
			const header = container.querySelector('.cursor-pointer');
			fireEvent.click(header!);

			expect(container.textContent).toContain('0 9 * * 1');
			expect(container.textContent).toContain('America/New_York');
		});
	});

	describe('Mission Creation Form', () => {
		it('should show mission type selector buttons in the create form', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);

			// Open the create modal
			const createButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent === 'Create Mission'
			);
			fireEvent.click(createButton!);

			// The modal body should have rendered — look for testid buttons
			expect(document.body.querySelector('[data-testid="mission-type-one_shot"]')).toBeTruthy();
			expect(document.body.querySelector('[data-testid="mission-type-measurable"]')).toBeTruthy();
			expect(document.body.querySelector('[data-testid="mission-type-recurring"]')).toBeTruthy();
		});

		it('should show metrics section when measurable type is selected', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);

			const createButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent === 'Create Mission'
			);
			fireEvent.click(createButton!);

			// Click measurable type
			const measurableBtn = document.body.querySelector('[data-testid="mission-type-measurable"]');
			fireEvent.click(measurableBtn!);

			expect(document.body.querySelector('[data-testid="metrics-section"]')).toBeTruthy();
		});

		it('should show schedule section when recurring type is selected', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);

			const createButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent === 'Create Mission'
			);
			fireEvent.click(createButton!);

			// Click recurring type
			const recurringBtn = document.body.querySelector('[data-testid="mission-type-recurring"]');
			fireEvent.click(recurringBtn!);

			expect(document.body.querySelector('[data-testid="schedule-section"]')).toBeTruthy();
			expect(document.body.querySelector('[data-testid="schedule-preset"]')).toBeTruthy();
			expect(document.body.querySelector('[data-testid="timezone-select"]')).toBeTruthy();
		});

		it('should show autonomy level selector buttons', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);

			const createButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent === 'Create Mission'
			);
			fireEvent.click(createButton!);

			expect(document.body.querySelector('[data-testid="autonomy-supervised"]')).toBeTruthy();
			expect(document.body.querySelector('[data-testid="autonomy-semi_autonomous"]')).toBeTruthy();
		});

		it('should add a metric row when "Add Metric" is clicked', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);

			const createButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent === 'Create Mission'
			);
			fireEvent.click(createButton!);

			// Select measurable type
			const measurableBtn = document.body.querySelector('[data-testid="mission-type-measurable"]');
			fireEvent.click(measurableBtn!);

			// Click add metric button
			const addMetricBtn = document.body.querySelector('[data-testid="add-metric-btn"]');
			fireEvent.click(addMetricBtn!);

			// Should now have a metric name input
			const nameInput = document.body.querySelector('[aria-label="Metric 1 name"]');
			expect(nameInput).toBeTruthy();
		});

		it('should show custom cron field when "Custom" preset is selected', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);

			const createButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent === 'Create Mission'
			);
			fireEvent.click(createButton!);

			// Select recurring type
			const recurringBtn = document.body.querySelector('[data-testid="mission-type-recurring"]');
			fireEvent.click(recurringBtn!);

			// Select custom preset
			const presetSelect = document.body.querySelector('[data-testid="schedule-preset"]');
			fireEvent.change(presetSelect!, { target: { value: 'custom' } });

			expect(document.body.querySelector('[data-testid="custom-cron"]')).toBeTruthy();
		});

		it('should disable submit when recurring + custom preset + empty cron expression', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);

			const createButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent === 'Create Mission'
			);
			fireEvent.click(createButton!);

			// Fill in title
			const titleInput = document.body.querySelector('#goal-title') as HTMLInputElement;
			fireEvent.input(titleInput, { target: { value: 'My recurring mission' } });

			// Select recurring type
			const recurringBtn = document.body.querySelector('[data-testid="mission-type-recurring"]');
			fireEvent.click(recurringBtn!);

			// Select custom preset (cron field empty)
			const presetSelect = document.body.querySelector('[data-testid="schedule-preset"]');
			fireEvent.change(presetSelect!, { target: { value: 'custom' } });

			// Submit button should be disabled
			const submitBtn = Array.from(document.body.querySelectorAll('button[type="submit"]')).at(
				-1
			) as HTMLButtonElement;
			expect(submitBtn.disabled).toBe(true);
		});

		it('should keep modal open when submission fails', async () => {
			const failingCreate = vi.fn().mockRejectedValue(new Error('Network error'));
			const { container } = render(
				<GoalsEditor goals={[]} {...defaultHandlers} onCreateGoal={failingCreate} />
			);

			const createButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent === 'Create Mission'
			);
			fireEvent.click(createButton!);

			// Fill in title and submit
			const titleInput = document.body.querySelector('#goal-title') as HTMLInputElement;
			fireEvent.input(titleInput, { target: { value: 'Test Mission' } });

			const submitBtn = Array.from(document.body.querySelectorAll('button[type="submit"]')).at(-1)!;
			fireEvent.click(submitBtn);

			// Wait for async rejection to settle
			await new Promise((resolve) => setTimeout(resolve, 20));

			// Modal should still be open (title input still present)
			expect(document.body.querySelector('#goal-title')).toBeTruthy();
		});
	});

	describe('Auto-Completed Notifications', () => {
		it('should show auto-completed feed when notifications are provided', () => {
			const notifications = [
				{
					taskId: 'task-1',
					taskTitle: 'Fix login bug',
					goalId: 'goal-1',
					prUrl: 'https://github.com/org/repo/pull/42',
					timestamp: Date.now(),
				},
			];
			const { container } = render(
				<GoalsEditor goals={[]} {...defaultHandlers} autoCompletedNotifications={notifications} />
			);
			expect(container.textContent).toContain('Fix login bug');
			expect(container.textContent).toContain('Auto-Completed');
		});

		it('should not show auto-completed feed when no notifications', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);
			const feed = container.querySelector('[data-testid="auto-completed-feed"]');
			expect(feed).toBeNull();
		});

		it('should call onDismissNotification when dismiss button clicked', () => {
			const onDismiss = vi.fn();
			const notifications = [
				{
					taskId: 'task-abc',
					taskTitle: 'Completed task',
					goalId: 'goal-1',
					prUrl: '',
					timestamp: Date.now(),
				},
			];
			const { container } = render(
				<GoalsEditor
					goals={[]}
					{...defaultHandlers}
					autoCompletedNotifications={notifications}
					onDismissNotification={onDismiss}
				/>
			);
			const dismissButton = container.querySelector('[aria-label="Dismiss notification"]');
			fireEvent.click(dismissButton!);
			expect(onDismiss).toHaveBeenCalledWith('task-abc');
		});
	});

	describe('Mission Type Filter', () => {
		it('should show filter buttons when missions exist', () => {
			const goals = [createMockGoal('goal-1', { missionType: 'recurring' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			expect(container.querySelector('[data-testid="filter-all"]')).toBeTruthy();
			expect(container.querySelector('[data-testid="filter-measurable"]')).toBeTruthy();
			expect(container.querySelector('[data-testid="filter-recurring"]')).toBeTruthy();
		});

		it('should filter missions by recurring type', () => {
			const goals = [
				createMockGoal('goal-1', { title: 'One-Shot Goal', missionType: 'one_shot' }),
				createMockGoal('goal-2', { title: 'Recurring Goal', missionType: 'recurring' }),
			];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);

			// Click recurring filter
			const recurringFilter = container.querySelector('[data-testid="filter-recurring"]');
			fireEvent.click(recurringFilter!);

			expect(container.textContent).toContain('Recurring Goal');
			expect(container.textContent).not.toContain('One-Shot Goal');
		});

		it('should show all missions when "All" filter is selected', () => {
			const goals = [
				createMockGoal('goal-1', { title: 'One-Shot Goal', missionType: 'one_shot' }),
				createMockGoal('goal-2', { title: 'Recurring Goal', missionType: 'recurring' }),
			];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);

			// Click recurring filter first
			const recurringFilter = container.querySelector('[data-testid="filter-recurring"]');
			fireEvent.click(recurringFilter!);

			// Then click all
			const allFilter = container.querySelector('[data-testid="filter-all"]');
			fireEvent.click(allFilter!);

			expect(container.textContent).toContain('One-Shot Goal');
			expect(container.textContent).toContain('Recurring Goal');
		});

		it('should not show filter when no missions', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);
			expect(container.querySelector('[data-testid="filter-all"]')).toBeNull();
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
				dependsOn: [],
				updatedAt: 1000000,
			},
			{
				id: 'task-2',
				title: 'Write unit tests',
				status: 'in_progress',
				priority: 'normal',
				progress: 50,
				dependsOn: [],
				updatedAt: 1000000,
			},
			{
				id: 'task-3',
				title: 'Deploy to staging',
				status: 'pending',
				priority: 'low',
				progress: 0,
				dependsOn: [],
				updatedAt: 1000000,
			},
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
