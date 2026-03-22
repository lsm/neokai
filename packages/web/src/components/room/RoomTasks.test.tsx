/**
 * Tests for RoomTasks Component
 *
 * Tests task filter tabs, tab switching, task grouping by status,
 * empty states, click handling, and section rendering for all tabs:
 * Active (draft + pending + in_progress), Review (review + needs_attention),
 * Done (completed + cancelled), Archived (archived, hidden by default).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/preact';
import type { TaskSummary, RoomGoal } from '@neokai/shared';
import { RoomTasks, selectedTabSignal, getInitialTab } from './RoomTasks';

// Mock toast to prevent side effects from toast.rejected() calls
vi.mock('../../lib/toast.ts', () => ({
	toast: {
		rejected: vi.fn(),
		approved: vi.fn(),
		error: vi.fn(),
		success: vi.fn(),
		info: vi.fn(),
	},
}));

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
			expect(container.textContent).toContain('Create a task to get started');
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

		it('should show Active, Review, Done tabs (Archived hidden when count is 0)', () => {
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
			// Archived tab hidden when no archived tasks
			expect(container.textContent).not.toContain('Archived');
		});

		it('should show Archived tab when there are archived tasks', () => {
			const tasks = [createTask('t1', 'in_progress'), createTask('t2', 'archived')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('Archived');
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

		it('should show View details link for review tasks when onView is provided', () => {
			const onView = vi.fn();
			const tasks = [createTask('t1', 'review', { title: 'Review me' })];

			const { container } = render(<RoomTasks tasks={tasks} onView={onView} />);

			const viewBtn = Array.from(container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('View details')
			);
			expect(viewBtn).toBeTruthy();
		});

		it('should NOT show View details link when onView is not provided', () => {
			const tasks = [createTask('t1', 'review')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const viewBtn = Array.from(container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('View details')
			);
			expect(viewBtn).toBeFalsy();
		});

		it('should call onView with task id when View details link is clicked', () => {
			const onView = vi.fn();
			const tasks = [createTask('task-42', 'review', { title: 'Review me' })];

			const { container } = render(<RoomTasks tasks={tasks} onView={onView} />);

			const viewBtn = Array.from(container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('View details')
			) as HTMLButtonElement;
			fireEvent.click(viewBtn);

			expect(onView).toHaveBeenCalledWith('task-42');
		});

		it('should NOT show View details link for non-review tasks', () => {
			const onView = vi.fn();
			const tasks = [createTask('t1', 'in_progress')];

			const { container } = render(<RoomTasks tasks={tasks} onView={onView} />);

			const viewBtn = Array.from(container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('View details')
			);
			expect(viewBtn).toBeFalsy();
		});

		it('should NOT call onTaskClick when View details link is clicked (stopPropagation)', () => {
			const onView = vi.fn();
			const onTaskClick = vi.fn();
			const tasks = [createTask('task-42', 'review', { title: 'Review me' })];

			const { container } = render(
				<RoomTasks tasks={tasks} onView={onView} onTaskClick={onTaskClick} />
			);

			const viewBtn = Array.from(container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('View details')
			) as HTMLButtonElement;
			fireEvent.click(viewBtn);

			expect(onView).toHaveBeenCalledWith('task-42');
			expect(onTaskClick).not.toHaveBeenCalled();
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

	describe('Archived Tab', () => {
		beforeEach(() => {
			selectedTabSignal.value = 'archived';
		});

		it('should render archived section with muted header', () => {
			const tasks = [createTask('t1', 'archived', { title: 'Old task' })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const header = container.querySelector('h3.text-gray-500');
			expect(header).toBeTruthy();
			expect(header?.textContent).toContain('Archived (1)');
		});

		it('should show archived task titles', () => {
			const tasks = [createTask('t1', 'archived', { title: 'Old task' })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('Old task');
		});

		it('should auto-reset to active tab when no archived tasks exist', () => {
			const tasks = [createTask('t1', 'pending')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			// Auto-reset kicks in, shows active tab content instead of archived empty state
			expect(container.textContent).toContain('Pending (1)');
			expect(selectedTabSignal.value).toBe('active');
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

		it('should switch to archived tab when clicked', () => {
			const tasks = [
				createTask('t1', 'in_progress'),
				createTask('t2', 'archived', { title: 'Archived task' }),
			];

			// Set to active BEFORE render
			selectedTabSignal.value = 'active';
			const { container } = render(<RoomTasks tasks={tasks} />);

			// Click archived tab
			clickTab(container, 'Archived');

			// Should see archived section
			expect(container.textContent).toContain('Archived (1)');
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

		it('should show progress percentage when defined', () => {
			const tasks = [createTask('t1', 'in_progress', { progress: 75 })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('75%');
		});

		it('should show progress bar when progress is defined', () => {
			const tasks = [createTask('t1', 'in_progress', { progress: 50 })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const progressBar = container.querySelector('.bg-blue-500');
			expect(progressBar).toBeTruthy();
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

	describe('PR Button', () => {
		beforeEach(() => {
			selectedTabSignal.value = 'review';
		});

		it('should render PR button when prUrl is set', () => {
			const tasks = [
				createTask('t1', 'review', {
					prUrl: 'https://github.com/org/repo/pull/42',
					prNumber: 42,
				}),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const prLink = container.querySelector('a[href="https://github.com/org/repo/pull/42"]');
			expect(prLink).toBeTruthy();
			expect(container.textContent).toContain('PR #42');
		});

		it('should not render PR button when prUrl is not set', () => {
			const tasks = [createTask('t1', 'review')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const prLinks = container.querySelectorAll('a[href*="/pull/"]');
			expect(prLinks).toHaveLength(0);
		});

		it('should open PR link in new tab', () => {
			const tasks = [
				createTask('t1', 'review', {
					prUrl: 'https://github.com/org/repo/pull/7',
					prNumber: 7,
				}),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const prLink = container.querySelector('a[href*="/pull/"]') as HTMLAnchorElement;
			expect(prLink?.target).toBe('_blank');
			expect(prLink?.rel).toContain('noopener');
		});

		it('should show PR number in button text', () => {
			const tasks = [
				createTask('t1', 'review', {
					prUrl: 'https://github.com/org/repo/pull/99',
					prNumber: 99,
				}),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('PR #99');
		});

		it('should render PR button for in_progress task with prUrl', () => {
			selectedTabSignal.value = 'active';
			const tasks = [
				createTask('t1', 'in_progress', {
					prUrl: 'https://github.com/org/repo/pull/10',
					prNumber: 10,
				}),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const prLink = container.querySelector('a[href="https://github.com/org/repo/pull/10"]');
			expect(prLink).toBeTruthy();
			expect(container.textContent).toContain('PR #10');
		});

		it('should render PR button for completed task with prUrl', () => {
			selectedTabSignal.value = 'done';
			const tasks = [
				createTask('t1', 'completed', {
					prUrl: 'https://github.com/org/repo/pull/20',
					prNumber: 20,
				}),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const prLink = container.querySelector('a[href="https://github.com/org/repo/pull/20"]');
			expect(prLink).toBeTruthy();
			expect(container.textContent).toContain('PR #20');
		});

		it('should render PR button for needs_attention task with prUrl', () => {
			selectedTabSignal.value = 'review';
			const tasks = [
				createTask('t1', 'needs_attention', {
					prUrl: 'https://github.com/org/repo/pull/30',
					prNumber: 30,
				}),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const prLink = container.querySelector('a[href="https://github.com/org/repo/pull/30"]');
			expect(prLink).toBeTruthy();
			expect(container.textContent).toContain('PR #30');
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

		it('should apply muted border to archived tasks', () => {
			selectedTabSignal.value = 'archived';
			const tasks = [createTask('t1', 'archived')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const item = container.querySelector('.border-l-gray-800');
			expect(item).toBeTruthy();
		});
	});

	describe('Inline Reject Form', () => {
		beforeEach(() => {
			selectedTabSignal.value = 'review';
		});

		it('should show Reject button for review tasks when onReject is provided', () => {
			const onReject = vi.fn();
			const tasks = [createTask('t1', 'review')];

			const { container } = render(<RoomTasks tasks={tasks} onReject={onReject} />);

			const rejectBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent?.trim() === 'Reject'
			);
			expect(rejectBtn).toBeTruthy();
		});

		it('should NOT show Reject button when onReject is not provided', () => {
			const tasks = [createTask('t1', 'review')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const rejectBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent?.trim() === 'Reject'
			);
			expect(rejectBtn).toBeFalsy();
		});

		it('should NOT show Reject button for non-review tasks', () => {
			selectedTabSignal.value = 'active';
			const onReject = vi.fn();
			const tasks = [createTask('t1', 'in_progress')];

			const { container } = render(<RoomTasks tasks={tasks} onReject={onReject} />);

			const rejectBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent?.trim() === 'Reject'
			);
			expect(rejectBtn).toBeFalsy();
		});

		it('should expand inline form when Reject button is clicked', () => {
			const onReject = vi.fn();
			const tasks = [createTask('t1', 'review')];

			const { container } = render(<RoomTasks tasks={tasks} onReject={onReject} />);

			const rejectBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent?.trim() === 'Reject'
			) as HTMLButtonElement;
			fireEvent.click(rejectBtn);

			// Form wrapper should be expanded (max-h-48 replaces max-h-0)
			const formWrapper = container.querySelector('.overflow-hidden.transition-all');
			expect(formWrapper?.classList.contains('max-h-48')).toBe(true);
			expect(container.textContent).toContain('Confirm Reject');
			expect(container.textContent).toContain('Cancel');
		});

		it('should hide inline form when Cancel is clicked', () => {
			const onReject = vi.fn();
			const tasks = [createTask('t1', 'review')];

			const { container } = render(<RoomTasks tasks={tasks} onReject={onReject} />);

			// Open form
			const rejectBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent?.trim() === 'Reject'
			) as HTMLButtonElement;
			fireEvent.click(rejectBtn);
			const formWrapper = container.querySelector('.overflow-hidden.transition-all');
			expect(formWrapper?.classList.contains('max-h-48')).toBe(true);

			// Cancel — form should collapse (max-h-0)
			const cancelBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent?.trim() === 'Cancel'
			) as HTMLButtonElement;
			fireEvent.click(cancelBtn);

			expect(formWrapper?.classList.contains('max-h-0')).toBe(true);
		});

		it('Confirm Reject button should be disabled when feedback is empty', () => {
			const onReject = vi.fn();
			const tasks = [createTask('t1', 'review')];

			const { container } = render(<RoomTasks tasks={tasks} onReject={onReject} />);

			const rejectBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent?.trim() === 'Reject'
			) as HTMLButtonElement;
			fireEvent.click(rejectBtn);

			const confirmBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent?.trim() === 'Confirm Reject'
			) as HTMLButtonElement;
			expect(confirmBtn.disabled).toBe(true);
		});

		it('should call onReject with taskId and feedback when Confirm Reject is clicked', () => {
			const onReject = vi.fn();
			const tasks = [createTask('task-99', 'review')];

			const { container } = render(<RoomTasks tasks={tasks} onReject={onReject} />);

			// Open form
			const rejectBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent?.trim() === 'Reject'
			) as HTMLButtonElement;
			fireEvent.click(rejectBtn);

			// Type feedback
			const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
			fireEvent.input(textarea, { target: { value: 'Needs more work' } });

			// Confirm
			const confirmBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent?.trim() === 'Confirm Reject'
			) as HTMLButtonElement;
			fireEvent.click(confirmBtn);

			expect(onReject).toHaveBeenCalledWith('task-99', 'Needs more work');
		});

		it('should collapse form after Confirm Reject is clicked', () => {
			const onReject = vi.fn();
			const tasks = [createTask('t1', 'review')];

			const { container } = render(<RoomTasks tasks={tasks} onReject={onReject} />);

			// Open form
			const rejectBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent?.trim() === 'Reject'
			) as HTMLButtonElement;
			fireEvent.click(rejectBtn);

			// Type feedback and confirm
			const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
			fireEvent.input(textarea, { target: { value: 'Feedback here' } });
			const confirmBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent?.trim() === 'Confirm Reject'
			) as HTMLButtonElement;
			fireEvent.click(confirmBtn);

			// Form should be collapsed (max-h-0)
			const formWrapper = container.querySelector('.overflow-hidden.transition-all');
			expect(formWrapper?.classList.contains('max-h-0')).toBe(true);
		});

		it('should NOT call onTaskClick when Reject button is clicked', () => {
			const onReject = vi.fn();
			const onTaskClick = vi.fn();
			const tasks = [createTask('task-42', 'review')];

			const { container } = render(
				<RoomTasks tasks={tasks} onReject={onReject} onTaskClick={onTaskClick} />
			);

			const rejectBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent?.trim() === 'Reject'
			) as HTMLButtonElement;
			fireEvent.click(rejectBtn);

			expect(onTaskClick).not.toHaveBeenCalled();
		});
	});
	describe('Approve Button', () => {
		beforeEach(() => {
			selectedTabSignal.value = 'review';
		});

		it('should show Approve button for review tasks when onApprove is provided', () => {
			const onApprove = vi.fn();
			const tasks = [createTask('t1', 'review')];

			const { container } = render(<RoomTasks tasks={tasks} onApprove={onApprove} />);

			const approveBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent?.trim() === 'Approve'
			);
			expect(approveBtn).toBeTruthy();
		});

		it('should NOT show Approve button when onApprove is not provided', () => {
			const tasks = [createTask('t1', 'review')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const approveBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent?.trim() === 'Approve'
			);
			expect(approveBtn).toBeFalsy();
		});

		it('should call onApprove with task id when Approve button is clicked', () => {
			const onApprove = vi.fn();
			const tasks = [createTask('task-77', 'review')];

			const { container } = render(<RoomTasks tasks={tasks} onApprove={onApprove} />);

			const approveBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent?.trim() === 'Approve'
			) as HTMLButtonElement;
			fireEvent.click(approveBtn);

			expect(onApprove).toHaveBeenCalledWith('task-77');
		});

		it('should NOT show Approve button for non-review tasks', () => {
			selectedTabSignal.value = 'active';
			const onApprove = vi.fn();
			const tasks = [createTask('t1', 'in_progress')];

			const { container } = render(<RoomTasks tasks={tasks} onApprove={onApprove} />);

			const approveBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent?.trim() === 'Approve'
			);
			expect(approveBtn).toBeFalsy();
		});

		it('should NOT call onTaskClick when Approve button is clicked (stopPropagation)', () => {
			const onApprove = vi.fn();
			const onTaskClick = vi.fn();
			const tasks = [createTask('task-55', 'review')];

			const { container } = render(
				<RoomTasks tasks={tasks} onApprove={onApprove} onTaskClick={onTaskClick} />
			);

			const approveBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent?.trim() === 'Approve'
			) as HTMLButtonElement;
			fireEvent.click(approveBtn);

			expect(onApprove).toHaveBeenCalledWith('task-55');
			expect(onTaskClick).not.toHaveBeenCalled();
		});

		it('should show "✓ Approved" on button and disable it immediately after click', () => {
			const onApprove = vi.fn();
			const tasks = [createTask('task-99', 'review')];

			const { container } = render(<RoomTasks tasks={tasks} onApprove={onApprove} />);

			const approveBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent?.trim() === 'Approve'
			) as HTMLButtonElement;
			fireEvent.click(approveBtn);

			expect(approveBtn.textContent?.trim()).toContain('Approved');
			expect(approveBtn.disabled).toBe(true);
		});

		it('should add opacity-40 to card after Approve is clicked', () => {
			const onApprove = vi.fn();
			const tasks = [createTask('task-98', 'review')];

			const { container } = render(<RoomTasks tasks={tasks} onApprove={onApprove} />);

			const approveBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent?.trim() === 'Approve'
			) as HTMLButtonElement;
			fireEvent.click(approveBtn);

			const fadedCard = container.querySelector('.opacity-40');
			expect(fadedCard).toBeTruthy();
		});

		it('should add border-l-green-500 to card after Approve is clicked', () => {
			const onApprove = vi.fn();
			const tasks = [createTask('task-97', 'review')];

			const { container } = render(<RoomTasks tasks={tasks} onApprove={onApprove} />);

			const approveBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent?.trim() === 'Approve'
			) as HTMLButtonElement;
			fireEvent.click(approveBtn);

			const greenCard = container.querySelector('.border-l-green-500');
			expect(greenCard).toBeTruthy();
		});

		it('should revert Approve button text to "Approve" after 300ms', async () => {
			vi.useFakeTimers();
			const onApprove = vi.fn();
			const tasks = [createTask('task-96', 'review')];

			const { container } = render(<RoomTasks tasks={tasks} onApprove={onApprove} />);

			const approveBtn = Array.from(container.querySelectorAll('button')).find(
				(b) => b.textContent?.trim() === 'Approve'
			) as HTMLButtonElement;
			fireEvent.click(approveBtn);

			expect(approveBtn.textContent?.trim()).toContain('Approved');

			await act(async () => {
				vi.advanceTimersByTime(310);
			});
			expect(approveBtn.textContent?.trim()).toBe('Approve');
			expect(approveBtn.disabled).toBe(false);

			vi.useRealTimers();
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

		it('should preserve valid tab values', () => {
			mockStoredTab('active');
			expect(getInitialTab()).toBe('active');

			mockStoredTab('review');
			expect(getInitialTab()).toBe('review');

			mockStoredTab('done');
			expect(getInitialTab()).toBe('done');

			mockStoredTab('archived');
			expect(getInitialTab()).toBe('archived');
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

	describe('Archived Tab Auto-Reset', () => {
		it('should auto-reset to active when archived tab selected but no archived tasks', () => {
			selectedTabSignal.value = 'archived';
			const tasks = [createTask('t1', 'in_progress')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			// Should show active tab content, not archived empty state
			expect(container.textContent).toContain('In Progress');
			expect(container.textContent).not.toContain('No archived tasks');
			// Signal should be reset
			expect(selectedTabSignal.value).toBe('active');
		});

		it('should stay on archived tab when archived tasks exist', () => {
			selectedTabSignal.value = 'archived';
			const tasks = [createTask('t1', 'archived', { title: 'Old task' })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('Archived (1)');
			expect(selectedTabSignal.value).toBe('archived');
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

			expect(onGoalClick).toHaveBeenCalled();
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

			expect(onGoalClick).toHaveBeenCalled();
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
	});
});
