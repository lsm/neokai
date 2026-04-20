/**
 * Tests for RoomTasks Component
 *
 * Tests task filter tabs, tab switching, task grouping by status,
 * empty states, click handling, and section rendering for all tabs:
 * Active (draft + pending + in_progress),
 * Review (needs_attention → rate_limited/usage_limited → review),
 * Done (completed + cancelled).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import type { TaskSummary, RoomGoal } from '@neokai/shared';
import { RoomTasks, selectedTabSignal, getInitialTab } from './RoomTasks';

describe('RoomTasks', () => {
	afterEach(() => {
		cleanup();
	});

	const createTask = (
		id: string,
		status: TaskSummary['status'],
		overrides?: Partial<TaskSummary>
	): TaskSummary => ({
		id,
		title: `Task ${id}`,
		status,
		priority: 'normal',
		progress: 0,
		dependsOn: [],
		updatedAt: Date.now(),
		...overrides,
	});

	/** Helper to click a tab by label */
	function clickTab(container: Element, label: string) {
		const tabs = container.querySelectorAll('button');
		for (const tab of Array.from(tabs)) {
			if (tab.textContent?.includes(label)) {
				fireEvent.click(tab);
				return true;
			}
		}
		return false;
	}

	describe('Empty State', () => {
		it('should show empty state when no tasks', () => {
			const { container } = render(<RoomTasks tasks={[]} />);

			expect(container.textContent).toContain('No tasks yet');
			expect(container.textContent).toContain('Create a mission to get started');
		});

		it('should not show any status sections when no tasks', () => {
			const { container } = render(<RoomTasks tasks={[]} />);

			expect(container.querySelector('h3')).toBeFalsy();
		});
	});

	describe('Tab Bar', () => {
		beforeEach(() => {
			selectedTabSignal.value = 'active';
		});

		it('should show Active, Review, Done tabs (no Archived tab)', () => {
			const tasks = [
				createTask('t1', 'in_progress'),
				createTask('t2', 'review'),
				createTask('t3', 'completed'),
				createTask('t4', 'needs_attention'),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('Active');
			expect(container.textContent).toContain('Review');
			expect(container.textContent).toContain('Done');
			// Archived tab removed — archived tasks are excluded server-side
			expect(container.textContent).not.toContain('Archived');
		});

		it('should show correct counts on tabs', () => {
			const tasks = [
				createTask('t1', 'in_progress'),
				createTask('t2', 'pending'),
				createTask('t3', 'draft'),
				createTask('t4', 'review'),
				createTask('t5', 'needs_attention'),
				createTask('t6', 'completed'),
				createTask('t7', 'cancelled'),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			// Active: 3 (in_progress + pending + draft)
			expect(container.textContent).toContain('Active');
			expect(container.textContent).toContain('3');
		});

		it('should include rate_limited and usage_limited in review tab count', () => {
			const tasks = [
				createTask('t1', 'review'),
				createTask('t2', 'needs_attention'),
				createTask('t3', 'rate_limited'),
				createTask('t4', 'usage_limited'),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			// Review tab count: 4 (review + needs_attention + rate_limited + usage_limited)
			const tabBar = container.querySelector('.border-b.border-dark-700');
			const reviewTabBtn = Array.from(tabBar?.querySelectorAll('button') ?? []).find((b) =>
				b.textContent?.includes('Review')
			);
			expect(reviewTabBtn?.textContent).toContain('4');
		});
	});

	describe('Active Tab', () => {
		beforeEach(() => {
			selectedTabSignal.value = 'active';
		});

		it('should render in progress section with yellow header', () => {
			const tasks = [createTask('t1', 'in_progress')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const header = container.querySelector('.bg-yellow-900\\/20 h3');
			expect(header?.textContent).toContain('In Progress');
			expect(header?.textContent).toContain('1');
		});

		it('should show task title in the section', () => {
			const tasks = [createTask('t1', 'in_progress', { title: 'Build feature' })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('Build feature');
		});

		it('should render pending section', () => {
			const tasks = [createTask('t1', 'pending'), createTask('t2', 'pending')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('Pending (2)');
		});

		it('should show empty state for active tab when no active tasks', () => {
			const tasks = [createTask('t1', 'completed')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('No active tasks');
			expect(container.textContent).toContain('Active tasks will appear here');
		});
	});

	describe('Review Tab', () => {
		beforeEach(() => {
			selectedTabSignal.value = 'review';
		});

		it('should render review section with purple header', () => {
			const tasks = [createTask('t1', 'review')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const header = container.querySelector('.text-purple-400');
			expect(header).toBeTruthy();
			expect(header?.textContent).toContain('Review');
		});

		it('should show needs_attention tasks under Review tab', () => {
			const tasks = [
				createTask('t1', 'review', { title: 'Review task' }),
				createTask('t2', 'needs_attention', { title: 'Attention task', error: 'Something broke' }),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('Awaiting Review');
			expect(container.textContent).toContain('Needs Attention');
			expect(container.textContent).toContain('Review task');
			expect(container.textContent).toContain('Attention task');
		});

		it('should show rate_limited tasks under Review tab with orange styling', () => {
			const tasks = [createTask('t1', 'rate_limited', { title: 'Rate limited task' })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('Rate / Usage Limited');
			expect(container.textContent).toContain('Rate limited task');
			const header = container.querySelector('.text-orange-400');
			expect(header).toBeTruthy();
		});

		it('should show usage_limited tasks under Review tab with orange styling', () => {
			const tasks = [createTask('t1', 'usage_limited', { title: 'Usage limited task' })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('Rate / Usage Limited');
			expect(container.textContent).toContain('Usage limited task');
		});

		it('should show rate_limited and usage_limited tasks together in the same group', () => {
			const tasks = [
				createTask('t1', 'rate_limited', { title: 'Rate task' }),
				createTask('t2', 'usage_limited', { title: 'Usage task' }),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('Rate / Usage Limited (2)');
		});

		it('should display rate_limited error message in orange', () => {
			const tasks = [
				createTask('t1', 'rate_limited', { title: 'Rate task', error: 'API rate limit hit' }),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const errorEl = container.querySelector('p.text-orange-400');
			expect(errorEl).toBeTruthy();
			expect(errorEl?.textContent).toContain('API rate limit hit');
		});

		it('should display visual order: needs_attention above rate/usage limited above review', () => {
			const tasks = [
				createTask('t1', 'review', { title: 'Normal review' }),
				createTask('t2', 'rate_limited', { title: 'Rate limited' }),
				createTask('t3', 'needs_attention', { title: 'Needs attention' }),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const headers = Array.from(container.querySelectorAll('h3')).map((h) => h.textContent ?? '');
			const needsIdx = headers.findIndex((t) => t.includes('Needs Attention'));
			const rateIdx = headers.findIndex((t) => t.includes('Rate / Usage Limited'));
			const reviewIdx = headers.findIndex((t) => t.includes('Awaiting Review'));

			expect(needsIdx).toBeLessThan(rateIdx);
			expect(rateIdx).toBeLessThan(reviewIdx);
		});

		it('should show empty state when no review tasks', () => {
			const tasks = [createTask('t1', 'pending')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('No tasks to review');
		});
	});

	describe('Done Tab', () => {
		beforeEach(() => {
			selectedTabSignal.value = 'done';
		});

		it('should render completed section with green header', () => {
			const tasks = [
				createTask('t1', 'completed', { title: 'Finished task' }),
				createTask('t2', 'completed', { title: 'Another done' }),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			// Query for h3 specifically to avoid matching the tab button
			const header = container.querySelector('h3.text-green-400');
			expect(header).toBeTruthy();
			expect(header?.textContent).toContain('Completed (2)');
		});

		it('should show completed task titles', () => {
			const tasks = [createTask('t1', 'completed', { title: 'Finished task' })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('Finished task');
		});

		it('should have green background header for completed section', () => {
			const tasks = [createTask('t1', 'completed')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const greenHeader = container.querySelector('.bg-green-900\\/20');
			expect(greenHeader).toBeTruthy();
		});

		it('should show cancelled tasks under Done tab', () => {
			const tasks = [
				createTask('t1', 'completed', { title: 'Finished task' }),
				createTask('t2', 'cancelled', { title: 'Stopped task' }),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const headers = container.querySelectorAll('h3');
			const headerTexts = Array.from(headers).map((h) => h.textContent);

			expect(headerTexts).toContain('Completed (1)');
			expect(headerTexts).toContain('Cancelled (1)');
		});

		it('should show empty state when no completed or cancelled tasks', () => {
			const tasks = [createTask('t1', 'pending')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('No completed tasks');
		});
	});

	describe('Tab Switching', () => {
		it('should switch to review tab when clicked', () => {
			const tasks = [
				createTask('t1', 'in_progress'),
				createTask('t2', 'review', { title: 'Review task' }),
			];

			// Set to active BEFORE render so initial state is correct
			selectedTabSignal.value = 'active';
			const { container } = render(<RoomTasks tasks={tasks} />);

			// Initially on active tab, should see in_progress task
			expect(container.textContent).toContain('In Progress');

			// Click review tab
			clickTab(container, 'Review');

			// Now should see review task
			expect(container.textContent).toContain('Awaiting Review');
		});

		it('should switch to done tab when clicked', () => {
			const tasks = [
				createTask('t1', 'in_progress'),
				createTask('t2', 'completed', { title: 'Done task' }),
			];

			// Set to active BEFORE render
			selectedTabSignal.value = 'active';
			const { container } = render(<RoomTasks tasks={tasks} />);

			// Click done tab
			clickTab(container, 'Done');

			// Should see completed section
			expect(container.textContent).toContain('Completed (1)');
		});
	});

	describe('Click Handling', () => {
		beforeEach(() => {
			selectedTabSignal.value = 'active';
		});

		it('should call onTaskClick with task id when task is clicked', () => {
			const onTaskClick = vi.fn();
			const tasks = [createTask('task-123', 'pending', { title: 'Click me' })];

			const { container } = render(<RoomTasks tasks={tasks} onTaskClick={onTaskClick} />);

			const taskItem = container.querySelector('.cursor-pointer');
			fireEvent.click(taskItem!);

			expect(onTaskClick).toHaveBeenCalledWith('task-123');
		});

		it('should show arrow indicator when onTaskClick is provided', () => {
			const onTaskClick = vi.fn();
			const tasks = [createTask('t1', 'pending')];

			const { container } = render(<RoomTasks tasks={tasks} onTaskClick={onTaskClick} />);

			expect(container.textContent).toContain('→');
		});

		it('should not show arrow indicator when onTaskClick is not provided', () => {
			const tasks = [createTask('t1', 'pending')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).not.toContain('→');
		});

		it('should not have cursor-pointer when onTaskClick is not provided', () => {
			const tasks = [createTask('t1', 'pending')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const clickableItem = container.querySelector('.cursor-pointer');
			expect(clickableItem).toBeFalsy();
		});
	});

	describe('Task Progress', () => {
		beforeEach(() => {
			selectedTabSignal.value = 'active';
		});

		it('should show circular progress indicator when progress is defined', () => {
			const tasks = [createTask('t1', 'in_progress', { progress: 75 })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			// Circular indicator renders an SVG, not a percentage text
			const svg = container.querySelector('svg[width="24"]');
			expect(svg).toBeTruthy();
		});

		it('should show circular progress indicator instead of flat bar when progress is defined', () => {
			const tasks = [createTask('t1', 'in_progress', { progress: 50 })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			// No flat blue progress bar
			const flatBar = container.querySelector('.bg-blue-500');
			expect(flatBar).toBeFalsy();

			// Circular indicator renders an SVG
			const svg = container.querySelector('svg[width="24"]');
			expect(svg).toBeTruthy();
		});
	});

	describe('Working Indicator (activeSession)', () => {
		beforeEach(() => {
			selectedTabSignal.value = 'review';
		});

		it('should show worker working indicator when activeSession is worker on a review task', () => {
			const tasks = [createTask('t1', 'review', { activeSession: 'worker' })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('Worker working');
		});

		it('should show leader working indicator when activeSession is leader on a review task', () => {
			const tasks = [createTask('t1', 'review', { activeSession: 'leader' })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('Leader working');
		});

		it('should not show working indicator when activeSession is null on a review task', () => {
			const tasks = [createTask('t1', 'review', { activeSession: null })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).not.toContain('working');
		});

		it('should not show working indicator when activeSession is set but task is not in review status', () => {
			selectedTabSignal.value = 'active';
			const tasks = [createTask('t1', 'in_progress', { activeSession: 'worker' })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).not.toContain('Worker working');
		});
	});

	describe('Semantic Status Border', () => {
		it('should apply blue left border to in_progress tasks', () => {
			selectedTabSignal.value = 'active';
			const tasks = [createTask('t1', 'in_progress')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const item = container.querySelector('.border-l-blue-500');
			expect(item).toBeTruthy();
		});

		it('should apply gray left border to pending tasks', () => {
			selectedTabSignal.value = 'active';
			const tasks = [createTask('t1', 'pending')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const item = container.querySelector('.border-l-gray-500');
			expect(item).toBeTruthy();
		});

		it('should apply amber left border to review tasks', () => {
			selectedTabSignal.value = 'review';
			const tasks = [createTask('t1', 'review')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const item = container.querySelector('.border-l-amber-500');
			expect(item).toBeTruthy();
		});

		it('should apply green left border to completed tasks', () => {
			selectedTabSignal.value = 'done';
			const tasks = [createTask('t1', 'completed')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const item = container.querySelector('.border-l-green-500');
			expect(item).toBeTruthy();
		});

		it('should apply red left border to needs_attention tasks', () => {
			selectedTabSignal.value = 'review';
			const tasks = [createTask('t1', 'needs_attention')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const item = container.querySelector('.border-l-red-500');
			expect(item).toBeTruthy();
		});

		it('should apply dark gray left border to cancelled tasks', () => {
			selectedTabSignal.value = 'done';
			const tasks = [createTask('t1', 'cancelled')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const item = container.querySelector('.border-l-gray-700');
			expect(item).toBeTruthy();
		});
	});

	describe('Worker Summary (currentStep)', () => {
		beforeEach(() => {
			selectedTabSignal.value = 'review';
		});

		it('should show currentStep as worker summary for review tasks', () => {
			const tasks = [
				createTask('t1', 'review', { currentStep: 'Implementing authentication module' }),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('Implementing authentication module');
		});

		it('should NOT show worker summary when currentStep is not set', () => {
			const tasks = [createTask('t1', 'review')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			// No italic summary element
			const summaryEl = container.querySelector('p.italic');
			expect(summaryEl).toBeFalsy();
		});

		it('should NOT show worker summary for non-review tasks with currentStep', () => {
			selectedTabSignal.value = 'active';
			const tasks = [createTask('t1', 'in_progress', { currentStep: 'Should not appear' })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			// The review expanded section is not rendered for non-review tasks
			const summaryEl = container.querySelector('p.italic');
			expect(summaryEl).toBeFalsy();
		});
	});

	describe('localStorage Migration (getInitialTab)', () => {
		function mockStoredTab(value: string | null) {
			vi.mocked(localStorage.getItem).mockImplementation((key) => {
				if (key === 'neokai:room:taskFilterTab') return value;
				return null;
			});
		}

		it('should migrate "needs_attention" to "review"', () => {
			mockStoredTab('needs_attention');
			expect(getInitialTab()).toBe('review');
		});

		it('should migrate "failed" to "review"', () => {
			mockStoredTab('failed');
			expect(getInitialTab()).toBe('review');
		});

		it('should migrate "archived" to "active"', () => {
			mockStoredTab('archived');
			expect(getInitialTab()).toBe('active');
		});

		it('should preserve valid tab values', () => {
			mockStoredTab('active');
			expect(getInitialTab()).toBe('active');

			mockStoredTab('review');
			expect(getInitialTab()).toBe('review');

			mockStoredTab('done');
			expect(getInitialTab()).toBe('done');
		});

		it('should default to "active" for unknown values', () => {
			mockStoredTab('garbage');
			expect(getInitialTab()).toBe('active');
		});

		it('should default to "active" when no value stored', () => {
			mockStoredTab(null);
			expect(getInitialTab()).toBe('active');
		});
	});

	describe('Tab Grouping Consistency', () => {
		it('needs_attention tasks appear under review tab, not a separate tab', () => {
			selectedTabSignal.value = 'review';
			const tasks = [createTask('t1', 'needs_attention', { title: 'Migrated task' })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('Needs Attention (1)');
			expect(container.textContent).toContain('Migrated task');
		});

		it('cancelled tasks appear under done tab', () => {
			selectedTabSignal.value = 'done';
			const tasks = [createTask('t1', 'cancelled', { title: 'Cancelled task' })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('Cancelled (1)');
			expect(container.textContent).toContain('Cancelled task');
		});

		it('draft tasks appear under active tab', () => {
			selectedTabSignal.value = 'active';
			const tasks = [createTask('t1', 'draft', { title: 'Draft task' })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('Draft (1)');
			expect(container.textContent).toContain('Draft task');
		});

		it('rate_limited tasks appear under review tab, not active tab', () => {
			selectedTabSignal.value = 'active';
			const tasks = [createTask('t1', 'rate_limited', { title: 'Rate limited task' })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			// Active tab should show empty state since rate_limited is not active
			expect(container.textContent).toContain('No active tasks');
			expect(container.textContent).not.toContain('Rate limited task');
		});

		it('usage_limited tasks appear under review tab, not active tab', () => {
			selectedTabSignal.value = 'active';
			const tasks = [createTask('t1', 'usage_limited', { title: 'Usage limited task' })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('No active tasks');
			expect(container.textContent).not.toContain('Usage limited task');
		});

		it('there is no needs_attention tab button in the tab bar', () => {
			const tasks = [
				createTask('t1', 'needs_attention'),
				createTask('t2', 'in_progress'),
				createTask('t3', 'review'),
			];

			selectedTabSignal.value = 'active';
			const { container } = render(<RoomTasks tasks={tasks} />);

			const tabBar = container.querySelector('.border-b.border-dark-700');
			const tabButtons = tabBar?.querySelectorAll('button') ?? [];
			const tabButtonLabels = Array.from(tabButtons).map((t) =>
				t.textContent?.replace(/\d/g, '').trim()
			);
			expect(tabButtonLabels).not.toContain('Needs Attention');
		});
	});

	describe('Reactivate Button in Done Tab', () => {
		beforeEach(() => {
			selectedTabSignal.value = 'done';
		});

		it('should show Reactivate button for completed task when onReactivate is provided', () => {
			const onReactivate = vi.fn();
			const tasks = [createTask('t1', 'completed')];

			const { container } = render(<RoomTasks tasks={tasks} onReactivate={onReactivate} />);

			const reactivateBtn = container.querySelector('[data-testid="task-reactivate-t1"]');
			expect(reactivateBtn).toBeTruthy();
		});

		it('should show Reactivate button for cancelled task when onReactivate is provided', () => {
			const onReactivate = vi.fn();
			const tasks = [createTask('t1', 'cancelled')];

			const { container } = render(<RoomTasks tasks={tasks} onReactivate={onReactivate} />);

			const reactivateBtn = container.querySelector('[data-testid="task-reactivate-t1"]');
			expect(reactivateBtn).toBeTruthy();
		});

		it('should NOT show Reactivate button when onReactivate is not provided', () => {
			const tasks = [createTask('t1', 'completed')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const reactivateBtn = container.querySelector('[data-testid="task-reactivate-t1"]');
			expect(reactivateBtn).toBeFalsy();
		});

		it('should call onReactivate with correct task id when clicked', () => {
			const onReactivate = vi.fn();
			const tasks = [createTask('task-42', 'completed', { title: 'Done task' })];

			const { container } = render(<RoomTasks tasks={tasks} onReactivate={onReactivate} />);

			const reactivateBtn = container.querySelector(
				'[data-testid="task-reactivate-task-42"]'
			) as HTMLButtonElement;
			expect(reactivateBtn).toBeTruthy();
			fireEvent.click(reactivateBtn);

			expect(onReactivate).toHaveBeenCalledWith('task-42');
		});

		it('should NOT call onTaskClick when Reactivate is clicked (stopPropagation)', () => {
			const onReactivate = vi.fn();
			const onTaskClick = vi.fn();
			const tasks = [createTask('task-42', 'completed', { title: 'Done task' })];

			const { container } = render(
				<RoomTasks tasks={tasks} onReactivate={onReactivate} onTaskClick={onTaskClick} />
			);

			const reactivateBtn = container.querySelector(
				'[data-testid="task-reactivate-task-42"]'
			) as HTMLButtonElement;
			fireEvent.click(reactivateBtn);

			expect(onReactivate).toHaveBeenCalledWith('task-42');
			expect(onTaskClick).not.toHaveBeenCalled();
		});
	});

	describe('Goal Badge', () => {
		beforeEach(() => {
			selectedTabSignal.value = 'active';
		});

		const createGoal = (id: string, title: string, linkedTaskIds: string[]): RoomGoal => ({
			id,
			roomId: 'room-1',
			title,
			description: '',
			status: 'active',
			priority: 'normal',
			progress: 0,
			linkedTaskIds,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});

		it('should show goal badge on task linked to a goal', () => {
			const task = createTask('task-1', 'in_progress');
			const goal = createGoal('goal-1', 'My Mission', ['task-1']);

			const { container } = render(
				<RoomTasks tasks={[task]} goalByTaskId={new Map([['task-1', goal]])} />
			);

			const badge = container.querySelector('[data-testid="task-goal-badge-task-1"]');
			expect(badge).toBeTruthy();
			expect(badge?.textContent).toContain('My Mission');
		});

		it('should NOT show goal badge on task not linked to any goal', () => {
			const task = createTask('task-2', 'in_progress');
			const goal = createGoal('goal-1', 'My Mission', ['task-1']); // links to task-1 only

			const { container } = render(
				<RoomTasks tasks={[task]} goalByTaskId={new Map([['task-1', goal]])} />
			);

			const badge = container.querySelector('[data-testid="task-goal-badge-task-2"]');
			expect(badge).toBeNull();
		});

		it('should NOT show goal badge when goalByTaskId prop is not provided', () => {
			const task = createTask('task-1', 'in_progress');

			const { container } = render(<RoomTasks tasks={[task]} />);

			const badge = container.querySelector('[data-testid="task-goal-badge-task-1"]');
			expect(badge).toBeNull();
		});

		it('should call onGoalClick when badge is clicked', () => {
			const task = createTask('task-1', 'in_progress');
			const goal = createGoal('goal-1', 'My Mission', ['task-1']);
			const onGoalClick = vi.fn();

			const { container } = render(
				<RoomTasks
					tasks={[task]}
					goalByTaskId={new Map([['task-1', goal]])}
					onGoalClick={onGoalClick}
				/>
			);

			const badge = container.querySelector(
				'[data-testid="task-goal-badge-task-1"]'
			) as HTMLButtonElement;
			fireEvent.click(badge);

			expect(onGoalClick).toHaveBeenCalledWith('goal-1');
		});

		it('should NOT call onTaskClick when goal badge is clicked (stopPropagation)', () => {
			const task = createTask('task-1', 'in_progress');
			const goal = createGoal('goal-1', 'My Mission', ['task-1']);
			const onGoalClick = vi.fn();
			const onTaskClick = vi.fn();

			const { container } = render(
				<RoomTasks
					tasks={[task]}
					goalByTaskId={new Map([['task-1', goal]])}
					onGoalClick={onGoalClick}
					onTaskClick={onTaskClick}
				/>
			);

			const badge = container.querySelector(
				'[data-testid="task-goal-badge-task-1"]'
			) as HTMLButtonElement;
			fireEvent.click(badge);

			expect(onGoalClick).toHaveBeenCalledWith('goal-1');
			expect(onTaskClick).not.toHaveBeenCalled();
		});

		it('should show goal badge on tasks in review tab', () => {
			selectedTabSignal.value = 'review';
			const task = createTask('task-r', 'review');
			const goal = createGoal('goal-1', 'Review Mission', ['task-r']);

			const { container } = render(
				<RoomTasks tasks={[task]} goalByTaskId={new Map([['task-r', goal]])} />
			);

			const badge = container.querySelector('[data-testid="task-goal-badge-task-r"]');
			expect(badge).toBeTruthy();
			expect(badge?.textContent).toContain('Review Mission');
		});

		it('should show goal badge on tasks in done tab', () => {
			selectedTabSignal.value = 'done';
			const task = createTask('task-d', 'completed');
			const goal = createGoal('goal-1', 'Done Mission', ['task-d']);

			const { container } = render(
				<RoomTasks tasks={[task]} goalByTaskId={new Map([['task-d', goal]])} />
			);

			const badge = container.querySelector('[data-testid="task-goal-badge-task-d"]');
			expect(badge).toBeTruthy();
		});

		it('should show correct goal title as tooltip on badge', () => {
			const task = createTask('task-1', 'in_progress');
			const goal = createGoal('goal-1', 'Specific Goal Name', ['task-1']);

			const { container } = render(
				<RoomTasks tasks={[task]} goalByTaskId={new Map([['task-1', goal]])} />
			);

			const badge = container.querySelector('[data-testid="task-goal-badge-task-1"]');
			expect(badge?.getAttribute('title')).toBe('Mission: Specific Goal Name');
		});

		it('should render goal badge on a separate line below the title row', () => {
			const task = createTask('task-1', 'in_progress');
			const goal = createGoal('goal-1', 'My Mission', ['task-1']);

			const { container } = render(
				<RoomTasks tasks={[task]} goalByTaskId={new Map([['task-1', goal]])} />
			);

			const badge = container.querySelector('[data-testid="task-goal-badge-task-1"]');
			const titleEl = container.querySelector('h4');
			// The badge must NOT be inside the same element as the title (it is on its own line)
			expect(titleEl?.parentElement?.contains(badge)).toBe(false);
			// The badge must share a common ancestor with the title (both inside the task card)
			expect(titleEl?.closest('[class*="flex-1"]')?.contains(badge)).toBe(true);
		});

		it('should use target icon (concentric circles) not lightning bolt on goal badge', () => {
			const task = createTask('task-1', 'in_progress');
			const goal = createGoal('goal-1', 'My Mission', ['task-1']);

			const { container } = render(
				<RoomTasks tasks={[task]} goalByTaskId={new Map([['task-1', goal]])} />
			);

			const badge = container.querySelector('[data-testid="task-goal-badge-task-1"]');
			// Target icon uses SVG circle elements (concentric circles)
			const circles = badge?.querySelectorAll('circle');
			expect(circles?.length).toBeGreaterThanOrEqual(2);
			// Lightning bolt used a path element, not circles
			const lightningPath = badge?.querySelector('path[d*="M13 10V3L4 14h7v7l9-11h-7z"]');
			expect(lightningPath).toBeNull();
		});
	});

	describe('PR Badge', () => {
		beforeEach(() => {
			selectedTabSignal.value = 'active';
		});

		it('should show purple PR badge when task has prUrl and prNumber', () => {
			const tasks = [
				createTask('t1', 'in_progress', {
					prUrl: 'https://github.com/org/repo/pull/42',
					prNumber: 42,
				}),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const prLink = container.querySelector('a[href="https://github.com/org/repo/pull/42"]');
			expect(prLink).toBeTruthy();
			expect(prLink?.textContent).toContain('PR #42');
			expect(prLink?.getAttribute('target')).toBe('_blank');
		});

		it('should show PR badge with "?" when prNumber is not set', () => {
			const tasks = [
				createTask('t1', 'in_progress', { prUrl: 'https://github.com/org/repo/pull/99' }),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const prLink = container.querySelector('a[href="https://github.com/org/repo/pull/99"]');
			expect(prLink).toBeTruthy();
			expect(prLink?.textContent).toContain('PR #?');
		});

		it('should NOT show PR badge when task has no prUrl', () => {
			const tasks = [createTask('t1', 'in_progress')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const prLinks = container.querySelectorAll('a[href*="github.com"]');
			expect(prLinks).toHaveLength(0);
		});

		it('should NOT propagate click on PR badge to task item', () => {
			const onTaskClick = vi.fn();
			const tasks = [
				createTask('t1', 'in_progress', {
					prUrl: 'https://github.com/org/repo/pull/5',
					prNumber: 5,
				}),
			];

			const { container } = render(<RoomTasks tasks={tasks} onTaskClick={onTaskClick} />);

			const prLink = container.querySelector(
				'a[href="https://github.com/org/repo/pull/5"]'
			) as HTMLAnchorElement;
			fireEvent.click(prLink);

			expect(onTaskClick).not.toHaveBeenCalled();
		});

		it('should not render prUrl as plain text', () => {
			const prUrl = 'https://github.com/org/repo/pull/42';
			const tasks = [createTask('t1', 'in_progress', { prUrl, prNumber: 42 })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			// The URL itself should not appear as visible text
			expect(container.textContent).not.toContain(prUrl);
		});
	});

	describe('Short ID Badge', () => {
		beforeEach(() => {
			selectedTabSignal.value = 'active';
		});

		it('should show short ID badge when task has shortId', () => {
			const tasks = [createTask('uuid-123', 'pending', { shortId: 't-42' })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const badge = container.querySelector('[data-testid="short-id-badge-t-42"]');
			expect(badge).toBeTruthy();
			expect(badge?.textContent).toContain('#t-42');
		});

		it('should NOT show short ID badge when task has no shortId', () => {
			const tasks = [createTask('uuid-123', 'pending')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			// No badge elements with the short-id-badge prefix
			const badges = container.querySelectorAll('[data-testid^="short-id-badge-"]');
			expect(badges).toHaveLength(0);
		});

		it('should have tooltip "Click to copy short ID" on the badge', () => {
			const tasks = [createTask('uuid-123', 'pending', { shortId: 't-7' })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const badge = container.querySelector('[data-testid="short-id-badge-t-7"]');
			expect(badge?.getAttribute('title')).toBe('Click to copy short ID');
		});

		it('should NOT call onTaskClick when short ID badge is clicked (stopPropagation)', () => {
			const onTaskClick = vi.fn();
			// Mock clipboard since jsdom doesn't implement it
			Object.defineProperty(navigator, 'clipboard', {
				value: { writeText: vi.fn().mockResolvedValue(undefined) },
				configurable: true,
			});
			const tasks = [createTask('uuid-123', 'pending', { shortId: 't-5', title: 'My task' })];

			const { container } = render(<RoomTasks tasks={tasks} onTaskClick={onTaskClick} />);

			const badge = container.querySelector(
				'[data-testid="short-id-badge-t-5"]'
			) as HTMLButtonElement;
			fireEvent.click(badge);

			expect(onTaskClick).not.toHaveBeenCalled();
		});

		it('should use shortId when calling onTaskClick (prefers short ID for navigation)', () => {
			const onTaskClick = vi.fn();
			const tasks = [createTask('uuid-123', 'pending', { shortId: 't-42', title: 'My task' })];

			const { container } = render(<RoomTasks tasks={tasks} onTaskClick={onTaskClick} />);

			const taskItem = container.querySelector('.cursor-pointer');
			fireEvent.click(taskItem!);

			expect(onTaskClick).toHaveBeenCalledWith('t-42');
		});

		it('should fall back to UUID when calling onTaskClick if no shortId', () => {
			const onTaskClick = vi.fn();
			const tasks = [createTask('uuid-123', 'pending', { title: 'My task' })];

			const { container } = render(<RoomTasks tasks={tasks} onTaskClick={onTaskClick} />);

			const taskItem = container.querySelector('.cursor-pointer');
			fireEvent.click(taskItem!);

			expect(onTaskClick).toHaveBeenCalledWith('uuid-123');
		});
	});
});
