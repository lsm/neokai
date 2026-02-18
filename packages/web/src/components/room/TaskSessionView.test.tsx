// @ts-nocheck
/**
 * Tests for TaskSessionView Component
 */

import { render, cleanup } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskSessionView } from './TaskSessionView';
import type { TaskSession, TaskExecutionMode } from '@neokai/shared';

describe('TaskSessionView', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
	});

	afterEach(() => {
		cleanup();
	});

	const createMockSession = (sessionId: string, overrides?: Partial<TaskSession>): TaskSession => ({
		sessionId,
		role: 'primary',
		status: 'pending',
		...overrides,
	});

	describe('Execution Mode Display', () => {
		const mockSessions: TaskSession[] = [createMockSession('session-1')];

		it('should display "Single Worker" for single mode', () => {
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={mockSessions} executionMode="single" />
			);
			expect(container.textContent).toContain('Single Worker');
			expect(container.textContent).toContain('One session handles the entire task');
		});

		it('should display "Parallel Workers" for parallel mode', () => {
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={mockSessions} executionMode="parallel" />
			);
			expect(container.textContent).toContain('Parallel Workers');
			expect(container.textContent).toContain('Multiple sessions work simultaneously');
		});

		it('should display "Serial Workers" for serial mode', () => {
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={mockSessions} executionMode="serial" />
			);
			expect(container.textContent).toContain('Serial Workers');
			expect(container.textContent).toContain('Sessions work one after another');
		});

		it('should display "Parallel + Review" for parallel_then_merge mode', () => {
			const { container } = render(
				<TaskSessionView
					taskId="task-1"
					sessions={mockSessions}
					executionMode="parallel_then_merge"
				/>
			);
			expect(container.textContent).toContain('Parallel + Review');
			expect(container.textContent).toContain('Parallel work followed by review');
		});
	});

	describe('Session Count', () => {
		it('should display singular "session" for one session', () => {
			const sessions = [createMockSession('session-1')];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="single" />
			);
			expect(container.textContent).toContain('1 session');
		});

		it('should display plural "sessions" for multiple sessions', () => {
			const sessions = [createMockSession('session-1'), createMockSession('session-2')];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="parallel" />
			);
			expect(container.textContent).toContain('2 sessions');
		});
	});

	describe('Empty State', () => {
		it('should display "No sessions assigned" when sessions array is empty', () => {
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={[]} executionMode="single" />
			);
			expect(container.textContent).toContain('No sessions assigned');
		});
	});

	describe('Session Card Rendering', () => {
		it('should render session ID (truncated)', () => {
			const sessions = [createMockSession('verylongsessionid12345')];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="single" />
			);
			// truncateSessionId takes first 8 and last 4 chars: "verylong...2345"
			expect(container.textContent).toContain('verylong...2345');
		});

		it('should render session ID without truncation for short IDs', () => {
			const sessions = [createMockSession('short')];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="single" />
			);
			expect(container.textContent).toContain('short');
		});
	});

	describe('Role Badge Styling', () => {
		it('should apply blue styling for primary role', () => {
			const sessions = [createMockSession('session-1', { role: 'primary' })];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="single" />
			);
			const badge = container.querySelector('.bg-blue-600');
			expect(badge).toBeTruthy();
			expect(badge?.textContent).toBe('primary');
		});

		it('should apply gray styling for secondary role', () => {
			const sessions = [createMockSession('session-1', { role: 'secondary' })];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="single" />
			);
			const badge = container.querySelector('.bg-gray-600');
			expect(badge).toBeTruthy();
			expect(badge?.textContent).toBe('secondary');
		});

		it('should apply purple styling for reviewer role', () => {
			const sessions = [createMockSession('session-1', { role: 'reviewer' })];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="single" />
			);
			const badge = container.querySelector('.bg-purple-600');
			expect(badge).toBeTruthy();
			expect(badge?.textContent).toBe('reviewer');
		});
	});

	describe('Status Indicators', () => {
		it('should show gray dot for pending status', () => {
			const sessions = [createMockSession('session-1', { status: 'pending' })];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="single" />
			);
			const pendingDot = container.querySelector('.bg-gray-500.rounded-full');
			expect(pendingDot).toBeTruthy();
		});

		it('should show animated pulse for active status', () => {
			const sessions = [createMockSession('session-1', { status: 'active' })];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="single" />
			);
			const pulseElement = container.querySelector('.animate-pulse');
			expect(pulseElement).toBeTruthy();
		});

		it('should show green checkmark for completed status', () => {
			const sessions = [createMockSession('session-1', { status: 'completed' })];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="single" />
			);
			const completedIcon = container.querySelector('.text-green-500');
			expect(completedIcon).toBeTruthy();
		});

		it('should show red X for failed status', () => {
			const sessions = [createMockSession('session-1', { status: 'failed' })];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="single" />
			);
			const failedIcon = container.querySelector('.text-red-500');
			expect(failedIcon).toBeTruthy();
		});
	});

	describe('Session Links', () => {
		it('should render link for active session', () => {
			const sessions = [createMockSession('session-1', { status: 'active' })];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="single" />
			);
			const link = container.querySelector('a[href="/sessions/session-1"]');
			expect(link).toBeTruthy();
		});

		it('should render link for completed session', () => {
			const sessions = [createMockSession('session-1', { status: 'completed' })];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="single" />
			);
			const link = container.querySelector('a[href="/sessions/session-1"]');
			expect(link).toBeTruthy();
		});

		it('should not render link for pending session', () => {
			const sessions = [createMockSession('session-1', { status: 'pending' })];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="single" />
			);
			const link = container.querySelector('a[href="/sessions/session-1"]');
			expect(link).toBeNull();
		});

		it('should not render link for failed session', () => {
			const sessions = [createMockSession('session-1', { status: 'failed' })];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="single" />
			);
			const link = container.querySelector('a[href="/sessions/session-1"]');
			expect(link).toBeNull();
		});
	});

	describe('Summary Stats', () => {
		it('should display active session count', () => {
			const sessions = [
				createMockSession('session-1', { status: 'active' }),
				createMockSession('session-2', { status: 'active' }),
				createMockSession('session-3', { status: 'pending' }),
			];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="parallel" />
			);
			expect(container.textContent).toContain('Active: 2');
		});

		it('should display completed session count', () => {
			const sessions = [
				createMockSession('session-1', { status: 'completed' }),
				createMockSession('session-2', { status: 'pending' }),
			];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="parallel" />
			);
			expect(container.textContent).toContain('Completed: 1');
		});

		it('should display failed session count', () => {
			const sessions = [
				createMockSession('session-1', { status: 'failed' }),
				createMockSession('session-2', { status: 'pending' }),
			];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="parallel" />
			);
			expect(container.textContent).toContain('Failed: 1');
		});

		it('should display "All sessions pending" when no activity', () => {
			const sessions = [
				createMockSession('session-1', { status: 'pending' }),
				createMockSession('session-2', { status: 'pending' }),
			];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="parallel" />
			);
			expect(container.textContent).toContain('All sessions pending');
		});
	});

	describe('Execution Mode Flow Visualization', () => {
		it('should show || connector for parallel mode with multiple sessions', () => {
			const sessions = [createMockSession('session-1'), createMockSession('session-2')];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="parallel" />
			);
			expect(container.textContent).toContain('||');
		});

		it('should show arrow connector for serial mode with multiple sessions', () => {
			const sessions = [createMockSession('session-1'), createMockSession('session-2')];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="serial" />
			);
			// Arrow is rendered via SVG
			expect(container.querySelector('svg')).toBeTruthy();
		});

		it('should separate workers and reviewers for parallel_then_merge mode', () => {
			const sessions = [
				createMockSession('session-1', { role: 'primary' }),
				createMockSession('session-2', { role: 'secondary' }),
				createMockSession('session-3', { role: 'reviewer' }),
			];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="parallel_then_merge" />
			);
			// Check that both workers and reviewers are rendered
			expect(container.textContent).toContain('primary');
			expect(container.textContent).toContain('secondary');
			expect(container.textContent).toContain('reviewer');
		});
	});

	describe('Data Attributes', () => {
		it('should have data-task-id attribute on container', () => {
			const sessions = [createMockSession('session-1')];
			const { container } = render(
				<TaskSessionView taskId="task-123" sessions={sessions} executionMode="single" />
			);
			const element = container.querySelector('[data-task-id="task-123"]');
			expect(element).toBeTruthy();
		});

		it('should have data-session-id attribute on session cards', () => {
			const sessions = [createMockSession('session-abc')];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="single" />
			);
			const element = container.querySelector('[data-session-id="session-abc"]');
			expect(element).toBeTruthy();
		});
	});

	describe('Styling', () => {
		it('should have rounded-lg container', () => {
			const sessions = [createMockSession('session-1')];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="single" />
			);
			const mainContainer = container.querySelector('.rounded-lg');
			expect(mainContainer).toBeTruthy();
		});

		it('should have execution mode badge in header', () => {
			const sessions = [createMockSession('session-1')];
			const { container } = render(
				<TaskSessionView taskId="task-1" sessions={sessions} executionMode="single" />
			);
			const modeBadge = container.querySelector('.bg-dark-700');
			expect(modeBadge).toBeTruthy();
			expect(modeBadge?.textContent).toBe('1');
		});
	});
});
