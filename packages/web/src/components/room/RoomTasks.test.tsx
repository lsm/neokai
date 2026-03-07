// @ts-nocheck
/**
 * Tests for RoomTasks Component
 *
 * Tests task grouping by status, empty state,
 * click handling, and section rendering for all statuses
 * including completed and failed.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import type { TaskSummary } from '@neokai/shared';
import { RoomTasks } from './RoomTasks';

describe('RoomTasks', () => {
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

	describe('In Progress Section', () => {
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
	});

	describe('Review Section', () => {
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
	});

	describe('Pending Section', () => {
		it('should render pending section', () => {
			const tasks = [createTask('t1', 'pending'), createTask('t2', 'pending')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			expect(container.textContent).toContain('Pending (2)');
		});
	});

	describe('Draft Section', () => {
		it('should render draft section with gray header', () => {
			const tasks = [createTask('t1', 'draft')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const header = container.querySelector('.text-gray-400');
			expect(header).toBeTruthy();
			expect(header?.textContent).toContain('Draft');
		});
	});

	describe('Completed Section', () => {
		it('should render completed section with green header', () => {
			const tasks = [
				createTask('t1', 'completed', { title: 'Finished task' }),
				createTask('t2', 'completed', { title: 'Another done' }),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const header = container.querySelector('.text-green-400');
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
	});

	describe('Failed Section', () => {
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

		it('should appear before in-progress tasks in the DOM', () => {
			const tasks = [createTask('t1', 'in_progress'), createTask('t2', 'failed')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const headers = container.querySelectorAll('h3');
			const headerTexts = Array.from(headers).map((h) => h.textContent ?? '');

			const failedIdx = headerTexts.findIndex((t) => t.includes('Failed'));
			const inProgressIdx = headerTexts.findIndex((t) => t.includes('In Progress'));

			expect(failedIdx).toBeGreaterThanOrEqual(0);
			expect(inProgressIdx).toBeGreaterThanOrEqual(0);
			expect(failedIdx).toBeLessThan(inProgressIdx);
		});
	});

	describe('Multiple Status Groups', () => {
		it('should render all status groups when tasks exist in each', () => {
			const tasks = [
				createTask('t1', 'in_progress'),
				createTask('t2', 'review'),
				createTask('t3', 'pending'),
				createTask('t4', 'draft'),
				createTask('t5', 'completed'),
				createTask('t6', 'failed'),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const headers = container.querySelectorAll('h3');
			const headerTexts = Array.from(headers).map((h) => h.textContent);

			expect(headerTexts).toContain('In Progress (1)');
			expect(headerTexts).toContain('Review (1)');
			expect(headerTexts).toContain('Pending (1)');
			expect(headerTexts).toContain('Draft (1)');
			expect(headerTexts).toContain('Completed (1)');
			expect(headerTexts).toContain('Failed (1)');
		});

		it('should only render sections for statuses that have tasks', () => {
			const tasks = [createTask('t1', 'pending'), createTask('t2', 'completed')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const headers = container.querySelectorAll('h3');
			expect(headers.length).toBe(2);
		});
	});

	describe('Click Handling', () => {
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
});
