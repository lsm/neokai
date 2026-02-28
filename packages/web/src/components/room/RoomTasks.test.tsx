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

	describe('Escalated Section', () => {
		it('should render escalated section with orange header', () => {
			const tasks = [createTask('t1', 'escalated')];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const header = container.querySelector('.text-orange-400');
			expect(header).toBeTruthy();
			expect(header?.textContent).toContain('Escalated');
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

			const header = container.querySelector('.text-red-400');
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
	});

	describe('Multiple Status Groups', () => {
		it('should render all status groups when tasks exist in each', () => {
			const tasks = [
				createTask('t1', 'in_progress'),
				createTask('t2', 'escalated'),
				createTask('t3', 'pending'),
				createTask('t4', 'draft'),
				createTask('t5', 'completed'),
				createTask('t6', 'failed'),
			];

			const { container } = render(<RoomTasks tasks={tasks} />);

			const headers = container.querySelectorAll('h3');
			const headerTexts = Array.from(headers).map((h) => h.textContent);

			expect(headerTexts).toContain('In Progress (1)');
			expect(headerTexts).toContain('Escalated (1)');
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
