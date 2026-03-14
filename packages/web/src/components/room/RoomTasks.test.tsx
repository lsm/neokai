/**
 * Tests for RoomTasks Component
 *
 * Tests task filter tabs, tab switching, task grouping by status,
 * empty states, click handling, and section rendering for all tabs.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import type { TaskSummary } from '@neokai/shared';
import { RoomTasks, selectedTabSignal } from './RoomTasks';

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

		it('should show all four tabs with counts', () => {
			const tasks = [
				createTask('t1', 'in_progress'),
				createTask('t2', 'review'),
				createTask('t3', 'completed'),
				createTask('t4', 'failed'),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('Active');
			expect(container.textContent).toContain('Review');
			expect(container.textContent).toContain('Done');
			expect(container.textContent).toContain('Failed');
		});

		it('should show correct counts on tabs', () => {
			const tasks = [
				createTask('t1', 'in_progress'),
				createTask('t2', 'pending'),
				createTask('t3', 'review'),
				createTask('t4', 'completed'),
				createTask('t5', 'failed'),
				createTask('t6', 'cancelled'),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			// Active: 2 (in_progress + pending)
			expect(container.textContent).toContain('Active');
			expect(container.textContent).toContain('2');
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

		it('should show Approve button for review tasks when onApprove is provided', () => {
			const onApprove = vi.fn();
			const tasks = [createTask('t1', 'review', { title: 'Review me' })];

			const { container } = render(<RoomTasks tasks={tasks} onApprove={onApprove} />);

			const approveBtn = Array.from(container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('Approve')
			);
			expect(approveBtn).toBeTruthy();
		});

		it('should show View button for review tasks when onView is provided', () => {
			const onView = vi.fn();
			const tasks = [createTask('t1', 'review', { title: 'Review me' })];

			const { container } = render(<RoomTasks tasks={tasks} onView={onView} />);

			const viewBtn = Array.from(container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('View')
			);
			expect(viewBtn).toBeTruthy();
		});

		it('should NOT show View button when onView is not provided', () => {
			const tasks = [createTask('t1', 'review')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const viewBtn = Array.from(container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('View')
			);
			expect(viewBtn).toBeFalsy();
		});

		it('should call onView with task id when View button is clicked', () => {
			const onView = vi.fn();
			const tasks = [createTask('task-42', 'review', { title: 'Review me' })];

			const { container } = render(<RoomTasks tasks={tasks} onView={onView} />);

			const viewBtn = Array.from(container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('View')
			) as HTMLButtonElement;
			fireEvent.click(viewBtn);

			expect(onView).toHaveBeenCalledWith('task-42');
		});

		it('should show both Approve and View buttons when both callbacks are provided', () => {
			const onApprove = vi.fn();
			const onView = vi.fn();
			const tasks = [createTask('t1', 'review', { title: 'Review me' })];

			const { container } = render(
				<RoomTasks tasks={tasks} onApprove={onApprove} onView={onView} />
			);

			const btns = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
			expect(btns.some((t) => t?.includes('Approve'))).toBe(true);
			expect(btns.some((t) => t?.includes('View'))).toBe(true);
		});

		it('should NOT show View button for non-review tasks', () => {
			const onView = vi.fn();
			const tasks = [createTask('t1', 'in_progress')];

			const { container } = render(<RoomTasks tasks={tasks} onView={onView} />);

			const viewBtn = Array.from(container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('View')
			);
			expect(viewBtn).toBeFalsy();
		});

		it('should NOT call onTaskClick when Approve button is clicked (stopPropagation)', () => {
			const onApprove = vi.fn();
			const onTaskClick = vi.fn();
			const tasks = [createTask('task-42', 'review', { title: 'Review me' })];

			const { container } = render(
				<RoomTasks tasks={tasks} onApprove={onApprove} onTaskClick={onTaskClick} />
			);

			const approveBtn = Array.from(container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('Approve')
			) as HTMLButtonElement;
			fireEvent.click(approveBtn);

			expect(onApprove).toHaveBeenCalledWith('task-42');
			expect(onTaskClick).not.toHaveBeenCalled();
		});

		it('should NOT call onTaskClick when View button is clicked (stopPropagation)', () => {
			const onView = vi.fn();
			const onTaskClick = vi.fn();
			const tasks = [createTask('task-42', 'review', { title: 'Review me' })];

			const { container } = render(
				<RoomTasks tasks={tasks} onView={onView} onTaskClick={onTaskClick} />
			);

			const viewBtn = Array.from(container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('View')
			) as HTMLButtonElement;
			fireEvent.click(viewBtn);

			expect(onView).toHaveBeenCalledWith('task-42');
			expect(onTaskClick).not.toHaveBeenCalled();
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

		it('should show empty state when no completed tasks', () => {
			const tasks = [createTask('t1', 'pending')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('No completed tasks');
		});
	});

	describe('Failed Tab', () => {
		beforeEach(() => {
			selectedTabSignal.value = 'failed';
		});

		it('should render failed section with red header', () => {
			const tasks = [createTask('t1', 'failed', { title: 'Broken task' })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const header = container.querySelector('h3.text-red-400');
			expect(header).toBeTruthy();
			expect(header?.textContent).toContain('Failed (1)');
		});

		it('should show failed task titles', () => {
			const tasks = [createTask('t1', 'failed', { title: 'Broken task' })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('Broken task');
		});

		it('should have red background header for failed section', () => {
			const tasks = [createTask('t1', 'failed')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const redHeader = container.querySelector('.bg-red-900\\/20');
			expect(redHeader).toBeTruthy();
		});

		it('should show error message for failed tasks with error', () => {
			const tasks = [
				createTask('t1', 'failed', { title: 'Broken task', error: 'Something went wrong' }),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('Something went wrong');
		});

		it('should not show error message for failed tasks without error', () => {
			const tasks = [createTask('t1', 'failed', { title: 'Broken task' })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			// No error paragraph should appear
			const errorEls = container.querySelectorAll('.text-red-400');
			// Only the header elements should have text-red-400, no error paragraph
			for (const el of Array.from(errorEls)) {
				expect(el.tagName.toLowerCase()).not.toBe('p');
			}
		});

		it('should render cancelled section with muted gray header', () => {
			const tasks = [createTask('t1', 'cancelled', { title: 'Stopped task' })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const header = container.querySelector('.text-gray-500');
			expect(header).toBeTruthy();
			expect(header?.textContent).toContain('Cancelled (1)');
		});

		it('should show cancelled task titles', () => {
			const tasks = [createTask('t1', 'cancelled', { title: 'Stopped task' })];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('Stopped task');
		});

		it('should not show Approve button for cancelled tasks', () => {
			const onApprove = vi.fn();
			const tasks = [createTask('t1', 'cancelled')];

			const { container } = render(<RoomTasks tasks={tasks} onApprove={onApprove} />);

			const approveBtn = Array.from(container.querySelectorAll('button')).find((b) =>
				b.textContent?.includes('Approve')
			);
			expect(approveBtn).toBeFalsy();
		});

		it('should render cancelled separately from failed', () => {
			const tasks = [
				createTask('t1', 'failed', { title: 'Error task' }),
				createTask('t2', 'cancelled', { title: 'Stopped task' }),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const headers = container.querySelectorAll('h3');
			const headerTexts = Array.from(headers).map((h) => h.textContent);

			expect(headerTexts).toContain('Failed (1)');
			expect(headerTexts).toContain('Cancelled (1)');
		});

		it('should show empty state when no failed or cancelled tasks', () => {
			const tasks = [createTask('t1', 'pending')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('No failed tasks');
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

		it('should switch to failed tab when clicked', () => {
			const tasks = [
				createTask('t1', 'in_progress'),
				createTask('t2', 'failed', { title: 'Failed task' }),
			];

			// Set to active BEFORE render
			selectedTabSignal.value = 'active';
			const { container } = render(<RoomTasks tasks={tasks} />);

			// Click failed tab
			clickTab(container, 'Failed');

			// Should see failed section
			expect(container.textContent).toContain('Failed (1)');
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
});
