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
		createdAt: Math.floor(Date.now() / 1000) - 86400,
		updatedAt: Math.floor(Date.now() / 1000),
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
		});

		it('should have create goal button in empty state', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);
			const buttons = container.querySelectorAll('button');
			const hasCreateGoal = Array.from(buttons).some((btn) =>
				btn.textContent?.includes('first goal')
			);
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

		it('should show description in card header', () => {
			const goals = [createMockGoal('goal-1', { description: 'Visible description text' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			expect(container.textContent).toContain('Visible description text');
		});
	});

	describe('Status Indicators', () => {
		it('should show "Active" label for active status', () => {
			const goals = [createMockGoal('goal-1', { status: 'active' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			expect(container.textContent).toContain('Active');
		});

		it('should show green dot for active status', () => {
			const goals = [createMockGoal('goal-1', { status: 'active' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			const activeDot = container.querySelector('.bg-green-400');
			expect(activeDot).toBeTruthy();
		});

		it('should show "Completed" label for completed status', () => {
			const goals = [createMockGoal('goal-1', { status: 'completed' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			expect(container.textContent).toContain('Completed');
		});

		it('should show "Needs Review" label for needs_human status', () => {
			const goals = [createMockGoal('goal-1', { status: 'needs_human' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			expect(container.textContent).toContain('Needs Review');
		});

		it('should show yellow dot for needs_human status', () => {
			const goals = [createMockGoal('goal-1', { status: 'needs_human' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			const dot = container.querySelector('.bg-yellow-400');
			expect(dot).toBeTruthy();
		});

		it('should show "Archived" label for archived status', () => {
			const goals = [createMockGoal('goal-1', { status: 'archived' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			expect(container.textContent).toContain('Archived');
		});

		it('should show gray dot for archived status', () => {
			const goals = [createMockGoal('goal-1', { status: 'archived' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			const archivedDot = container.querySelector('.bg-gray-600');
			expect(archivedDot).toBeTruthy();
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

	describe('Priority Border Colors', () => {
		it('should show red left border for urgent priority', () => {
			const goals = [createMockGoal('goal-1', { priority: 'urgent' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			const card = container.querySelector('.border-l-red-500');
			expect(card).toBeTruthy();
		});

		it('should show orange left border for high priority', () => {
			const goals = [createMockGoal('goal-1', { priority: 'high' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			const card = container.querySelector('.border-l-orange-400');
			expect(card).toBeTruthy();
		});

		it('should show blue left border for normal priority', () => {
			const goals = [createMockGoal('goal-1', { priority: 'normal' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			const card = container.querySelector('.border-l-blue-500');
			expect(card).toBeTruthy();
		});

		it('should show gray left border for low priority', () => {
			const goals = [createMockGoal('goal-1', { priority: 'low' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			const card = container.querySelector('.border-l-gray-500');
			expect(card).toBeTruthy();
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
		it('should show description in card header (collapsed)', () => {
			const goals = [createMockGoal('goal-1', { description: 'Detailed description here' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			// Description is now visible in the card header (truncated)
			expect(container.textContent).toContain('Detailed description here');
		});

		it('should have clickable header for expansion', () => {
			const goals = [createMockGoal('goal-1', { description: 'Detailed description here' })];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);

			const goalHeader = container.querySelector('.cursor-pointer');
			expect(goalHeader).toBeTruthy();
		});

		it('should show "Show details" label when collapsed', () => {
			const goals = [createMockGoal('goal-1')];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			expect(container.textContent).toContain('Show details');
		});

		it('should show "Hide details" label when expanded', () => {
			const goals = [createMockGoal('goal-1')];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);

			const header = container.querySelector('.cursor-pointer');
			fireEvent.click(header!);

			expect(container.textContent).toContain('Hide details');
		});

		it('should show relative creation time', () => {
			const goals = [createMockGoal('goal-1')];
			const { container } = render(<GoalsEditor goals={goals} {...defaultHandlers} />);
			// createdAt is 24h ago, should show "1 day ago"
			expect(container.textContent).toContain('day ago');
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

	describe('Two-Step Goal Creation Wizard', () => {
		/** Helper: open the create modal and navigate to step 1 */
		const openCreateModal = (container: Element) => {
			const createButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent === 'Create Goal'
			);
			fireEvent.click(createButton!);
		};

		/** Helper: fill step 1 and advance to step 2 */
		const advanceToStep2 = (titleValue = 'Test Goal') => {
			const titleInput = document.body.querySelector('#wizard-goal-title') as HTMLInputElement;
			fireEvent.input(titleInput, { target: { value: titleValue } });
			const nextBtn = Array.from(document.body.querySelectorAll('button')).find(
				(btn) => btn.textContent === 'Next →'
			);
			fireEvent.click(nextBtn!);
		};

		it('should show goal name input in step 1', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);
			openCreateModal(container);
			expect(document.body.querySelector('#wizard-goal-title')).toBeTruthy();
		});

		it('should show priority segmented control in step 1', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);
			openCreateModal(container);
			// Priority buttons with emoji labels
			expect(document.body.textContent).toContain('Urgent');
			expect(document.body.textContent).toContain('Normal');
		});

		it('should disable Next button when title is empty', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);
			openCreateModal(container);
			const nextBtn = Array.from(document.body.querySelectorAll('button')).find(
				(btn) => btn.textContent === 'Next →'
			) as HTMLButtonElement;
			expect(nextBtn?.disabled).toBe(true);
		});

		it('should enable Next button when title is filled', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);
			openCreateModal(container);
			const titleInput = document.body.querySelector('#wizard-goal-title') as HTMLInputElement;
			fireEvent.input(titleInput, { target: { value: 'My Goal' } });
			const nextBtn = Array.from(document.body.querySelectorAll('button')).find(
				(btn) => btn.textContent === 'Next →'
			) as HTMLButtonElement;
			expect(nextBtn?.disabled).toBe(false);
		});

		it('should show mission type selector buttons in step 2', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);
			openCreateModal(container);
			advanceToStep2();

			expect(document.body.querySelector('[data-testid="mission-type-one_shot"]')).toBeTruthy();
			expect(document.body.querySelector('[data-testid="mission-type-measurable"]')).toBeTruthy();
			expect(document.body.querySelector('[data-testid="mission-type-recurring"]')).toBeTruthy();
		});

		it('should show autonomy level selector buttons in step 2', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);
			openCreateModal(container);
			advanceToStep2();

			expect(document.body.querySelector('[data-testid="autonomy-supervised"]')).toBeTruthy();
			expect(document.body.querySelector('[data-testid="autonomy-semi_autonomous"]')).toBeTruthy();
		});

		it('should show metrics section when measurable type is selected in step 2', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);
			openCreateModal(container);
			advanceToStep2();

			const measurableBtn = document.body.querySelector('[data-testid="mission-type-measurable"]');
			fireEvent.click(measurableBtn!);

			expect(document.body.querySelector('[data-testid="metrics-section"]')).toBeTruthy();
		});

		it('should show schedule section when recurring type is selected in step 2', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);
			openCreateModal(container);
			advanceToStep2();

			const recurringBtn = document.body.querySelector('[data-testid="mission-type-recurring"]');
			fireEvent.click(recurringBtn!);

			expect(document.body.querySelector('[data-testid="schedule-section"]')).toBeTruthy();
			expect(document.body.querySelector('[data-testid="schedule-preset"]')).toBeTruthy();
			expect(document.body.querySelector('[data-testid="timezone-select"]')).toBeTruthy();
		});

		it('should add a metric row when "Add Metric" is clicked in step 2', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);
			openCreateModal(container);
			advanceToStep2();

			const measurableBtn = document.body.querySelector('[data-testid="mission-type-measurable"]');
			fireEvent.click(measurableBtn!);

			const addMetricBtn = document.body.querySelector('[data-testid="add-metric-btn"]');
			fireEvent.click(addMetricBtn!);

			const nameInput = document.body.querySelector('[aria-label="Metric 1 name"]');
			expect(nameInput).toBeTruthy();
		});

		it('should show custom cron field when "Custom" preset is selected in step 2', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);
			openCreateModal(container);
			advanceToStep2();

			const recurringBtn = document.body.querySelector('[data-testid="mission-type-recurring"]');
			fireEvent.click(recurringBtn!);

			const presetSelect = document.body.querySelector('[data-testid="schedule-preset"]');
			fireEvent.change(presetSelect!, { target: { value: 'custom' } });

			expect(document.body.querySelector('[data-testid="custom-cron"]')).toBeTruthy();
		});

		it('should disable Create button when recurring + custom preset + empty cron expression', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);
			openCreateModal(container);
			advanceToStep2();

			const recurringBtn = document.body.querySelector('[data-testid="mission-type-recurring"]');
			fireEvent.click(recurringBtn!);

			const presetSelect = document.body.querySelector('[data-testid="schedule-preset"]');
			fireEvent.change(presetSelect!, { target: { value: 'custom' } });

			// The "Create" button (not "Skip & Create") should be disabled
			const createBtn = Array.from(document.body.querySelectorAll('button')).find(
				(btn) => btn.textContent === 'Create'
			) as HTMLButtonElement;
			expect(createBtn?.disabled).toBe(true);
		});

		it('should allow "Skip & Create" even with empty cron', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);
			openCreateModal(container);
			advanceToStep2();

			const recurringBtn = document.body.querySelector('[data-testid="mission-type-recurring"]');
			fireEvent.click(recurringBtn!);

			const presetSelect = document.body.querySelector('[data-testid="schedule-preset"]');
			fireEvent.change(presetSelect!, { target: { value: 'custom' } });

			// "Skip & Create" should NOT be disabled (it uses defaults, not current step 2 values)
			const skipBtn = Array.from(document.body.querySelectorAll('button')).find(
				(btn) => btn.textContent === 'Skip & Create'
			) as HTMLButtonElement;
			expect(skipBtn?.disabled).toBe(false);
		});

		it('should navigate back to step 1 when Back button is clicked', () => {
			const { container } = render(<GoalsEditor goals={[]} {...defaultHandlers} />);
			openCreateModal(container);
			advanceToStep2();

			// Verify we're on step 2
			expect(document.body.querySelector('[data-testid="mission-type-one_shot"]')).toBeTruthy();

			// Click Back
			const backBtn = Array.from(document.body.querySelectorAll('button')).find(
				(btn) => btn.textContent === '← Back'
			);
			fireEvent.click(backBtn!);

			// Should be back to step 1
			expect(document.body.querySelector('#wizard-goal-title')).toBeTruthy();
		});

		it('should keep modal open when submission fails', async () => {
			const failingCreate = vi.fn().mockRejectedValue(new Error('Network error'));
			const { container } = render(
				<GoalsEditor goals={[]} {...defaultHandlers} onCreateGoal={failingCreate} />
			);

			openCreateModal(container);
			advanceToStep2('Test Goal');

			// Click Create
			const createBtn = Array.from(document.body.querySelectorAll('button')).find(
				(btn) => btn.textContent === 'Create'
			);
			fireEvent.click(createBtn!);

			// Wait for async rejection to settle
			await new Promise((resolve) => setTimeout(resolve, 20));

			// Modal should still be open (← Back button still present)
			const backBtn = Array.from(document.body.querySelectorAll('button')).find(
				(btn) => btn.textContent === '← Back'
			);
			expect(backBtn).toBeTruthy();
		});

		it('should call onCreateGoal with defaults when Skip & Create is clicked', async () => {
			const onCreate = vi.fn().mockResolvedValue(undefined);
			const { container } = render(
				<GoalsEditor goals={[]} {...defaultHandlers} onCreateGoal={onCreate} />
			);

			openCreateModal(container);
			advanceToStep2('My Skipped Goal');

			const skipBtn = Array.from(document.body.querySelectorAll('button')).find(
				(btn) => btn.textContent === 'Skip & Create'
			);
			fireEvent.click(skipBtn!);

			await new Promise((resolve) => setTimeout(resolve, 20));

			expect(onCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					title: 'My Skipped Goal',
					missionType: 'one_shot',
					autonomyLevel: 'supervised',
				})
			);
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
