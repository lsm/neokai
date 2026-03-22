/**
 * Tests for TaskInfoPanel Component
 *
 * Tests the inline expandable info panel that replaces the old dropdown.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { TaskInfoPanel } from '../TaskInfoPanel';

describe('TaskInfoPanel', () => {
	afterEach(() => {
		cleanup();
	});

	describe('Visibility', () => {
		it('should not render anything when isOpen is false', () => {
			const { container } = render(
				<TaskInfoPanel isOpen={false} actions={{}} visibleActions={{}} />
			);

			expect(container.querySelector('[data-testid="task-info-panel"]')).toBeNull();
		});

		it('should render panel when isOpen is true', () => {
			const { container } = render(
				<TaskInfoPanel isOpen={true} actions={{}} visibleActions={{}} />
			);

			expect(container.querySelector('[data-testid="task-info-panel"]')).toBeTruthy();
		});
	});

	describe('Info Section', () => {
		it('should show worktree path when provided', () => {
			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					worktreePath="/Users/test/project/packages/web"
					actions={{}}
					visibleActions={{}}
				/>
			);

			expect(container.textContent).toContain('Path:');
			// Should show truncated path (last 2 segments)
			expect(container.textContent).toContain('packages/web');
		});

		it('should show full path as title attribute on hover', () => {
			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					worktreePath="/Users/test/project/packages/web"
					actions={{}}
					visibleActions={{}}
				/>
			);

			const pathElement = container.querySelector('[title="/Users/test/project/packages/web"]');
			expect(pathElement).toBeTruthy();
		});

		it('should show git branch from worktree metadata', () => {
			const workerSession = {
				id: 'worker-session-id-1234',
				status: 'active',
				config: { model: 'claude-sonnet-4-6' },
				worktree: {
					isWorktree: true,
					branch: 'feature/my-branch',
					worktreePath: '/tmp/wt',
					mainRepoPath: '/tmp',
				},
			} as never;

			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					workerSession={workerSession}
					actions={{}}
					visibleActions={{}}
				/>
			);

			expect(container.textContent).toContain('Branch:');
			expect(container.textContent).toContain('feature/my-branch');
		});

		it('should show git branch from session gitBranch when no worktree', () => {
			const workerSession = {
				id: 'worker-session-id-1234',
				status: 'active',
				config: { model: 'claude-sonnet-4-6' },
				gitBranch: 'main',
			} as never;

			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					workerSession={workerSession}
					actions={{}}
					visibleActions={{}}
				/>
			);

			expect(container.textContent).toContain('Branch:');
			expect(container.textContent).toContain('main');
		});

		it('should not show branch row when no branch info available', () => {
			const workerSession = {
				id: 'worker-session-id-1234',
				status: 'active',
				config: { model: 'claude-sonnet-4-6' },
			} as never;

			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					workerSession={workerSession}
					actions={{}}
					visibleActions={{}}
				/>
			);

			expect(container.textContent).not.toContain('Branch:');
		});

		it('should show worker session info when provided', () => {
			const workerSession = {
				id: 'worker-session-id-1234',
				status: 'active',
				config: { model: 'claude-sonnet-4-6' },
			} as never;

			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					workerSession={workerSession}
					actions={{}}
					visibleActions={{}}
				/>
			);

			expect(container.textContent).toContain('Worker:');
			expect(container.textContent).toContain('worker-s'); // first 8 chars + '...'
		});

		it('should show worker session status', () => {
			const workerSession = {
				id: 'worker-session-id-1234',
				status: 'active',
				config: { model: 'claude-sonnet-4-6' },
			} as never;

			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					workerSession={workerSession}
					actions={{}}
					visibleActions={{}}
				/>
			);

			const statusEl = container.querySelector('[data-testid="worker-session-status"]');
			expect(statusEl).toBeTruthy();
			expect(statusEl?.textContent).toBe('active');
		});

		it('should show leader session info when provided', () => {
			const leaderSession = {
				id: 'leader-session-id-5678',
				status: 'active',
				config: { model: 'claude-sonnet-4-6' },
			} as never;

			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					leaderSession={leaderSession}
					actions={{}}
					visibleActions={{}}
				/>
			);

			expect(container.textContent).toContain('Leader:');
			expect(container.textContent).toContain('leader-s'); // first 8 chars + '...'
		});

		it('should show leader session status', () => {
			const leaderSession = {
				id: 'leader-session-id-5678',
				status: 'ended',
				config: { model: 'claude-sonnet-4-6' },
			} as never;

			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					leaderSession={leaderSession}
					actions={{}}
					visibleActions={{}}
				/>
			);

			const statusEl = container.querySelector('[data-testid="leader-session-status"]');
			expect(statusEl).toBeTruthy();
			expect(statusEl?.textContent).toBe('ended');
		});

		it('should apply green color for active worker session status', () => {
			const workerSession = {
				id: 'worker-session-id-1234',
				status: 'active',
				config: { model: 'claude-sonnet-4-6' },
			} as never;

			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					workerSession={workerSession}
					actions={{}}
					visibleActions={{}}
				/>
			);

			const statusEl = container.querySelector('[data-testid="worker-session-status"]');
			expect(statusEl?.className).toContain('text-green-400');
		});

		it('should apply amber color for paused worker session status', () => {
			const workerSession = {
				id: 'worker-session-id-1234',
				status: 'paused',
				config: { model: 'claude-sonnet-4-6' },
			} as never;

			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					workerSession={workerSession}
					actions={{}}
					visibleActions={{}}
				/>
			);

			const statusEl = container.querySelector('[data-testid="worker-session-status"]');
			expect(statusEl?.className).toContain('text-amber-400');
		});

		it('should apply amber color for pending_worktree_choice worker session status', () => {
			const workerSession = {
				id: 'worker-session-id-1234',
				status: 'pending_worktree_choice',
				config: { model: 'claude-sonnet-4-6' },
			} as never;

			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					workerSession={workerSession}
					actions={{}}
					visibleActions={{}}
				/>
			);

			const statusEl = container.querySelector('[data-testid="worker-session-status"]');
			expect(statusEl?.className).toContain('text-amber-400');
		});

		it('should apply gray color for ended leader session status', () => {
			const leaderSession = {
				id: 'leader-session-id-5678',
				status: 'ended',
				config: { model: 'claude-sonnet-4-6' },
			} as never;

			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					leaderSession={leaderSession}
					actions={{}}
					visibleActions={{}}
				/>
			);

			const statusEl = container.querySelector('[data-testid="leader-session-status"]');
			expect(statusEl?.className).toContain('text-gray-500');
		});

		it('should apply gray color for archived leader session status', () => {
			const leaderSession = {
				id: 'leader-session-id-5678',
				status: 'archived',
				config: { model: 'claude-sonnet-4-6' },
			} as never;

			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					leaderSession={leaderSession}
					actions={{}}
					visibleActions={{}}
				/>
			);

			const statusEl = container.querySelector('[data-testid="leader-session-status"]');
			expect(statusEl?.className).toContain('text-gray-500');
		});

		it('should show branch from leader session when worker has no branch info', () => {
			const leaderSession = {
				id: 'leader-session-id-5678',
				status: 'active',
				config: { model: 'claude-sonnet-4-6' },
				gitBranch: 'task/leader-branch',
			} as never;

			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					leaderSession={leaderSession}
					actions={{}}
					visibleActions={{}}
				/>
			);

			expect(container.textContent).toContain('Branch:');
			expect(container.textContent).toContain('task/leader-branch');
		});

		it('should prefer worker branch over leader branch when both are present', () => {
			const workerSession = {
				id: 'worker-session-id-1234',
				status: 'active',
				config: { model: 'claude-sonnet-4-6' },
				gitBranch: 'task/worker-branch',
			} as never;
			const leaderSession = {
				id: 'leader-session-id-5678',
				status: 'active',
				config: { model: 'claude-sonnet-4-6' },
				gitBranch: 'task/leader-branch',
			} as never;

			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					workerSession={workerSession}
					leaderSession={leaderSession}
					actions={{}}
					visibleActions={{}}
				/>
			);

			expect(container.textContent).toContain('task/worker-branch');
			expect(container.textContent).not.toContain('task/leader-branch');
		});

		it('should show model when session has model config', () => {
			const workerSession = {
				id: 'worker-session-id-1234',
				config: { model: 'claude-sonnet-4-6' },
			} as never;

			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					workerSession={workerSession}
					actions={{}}
					visibleActions={{}}
				/>
			);

			expect(container.textContent).toContain('Model:');
		});

		it('should show empty state when no info and no actions', () => {
			const { container } = render(
				<TaskInfoPanel isOpen={true} actions={{}} visibleActions={{}} />
			);

			expect(container.textContent).toContain('No info or actions available');
		});
	});

	describe('Actions Section', () => {
		it('should show Complete action when visible', () => {
			const onComplete = vi.fn();
			const { container } = render(
				<TaskInfoPanel isOpen={true} actions={{ onComplete }} visibleActions={{ complete: true }} />
			);

			expect(container.querySelector('[data-testid="task-info-panel-complete"]')).toBeTruthy();
			expect(container.textContent).toContain('Complete');
		});

		it('should show Cancel action when visible', () => {
			const onCancel = vi.fn();
			const { container } = render(
				<TaskInfoPanel isOpen={true} actions={{ onCancel }} visibleActions={{ cancel: true }} />
			);

			expect(container.querySelector('[data-testid="task-info-panel-cancel"]')).toBeTruthy();
			expect(container.textContent).toContain('Cancel');
		});

		it('should show Archive action when visible', () => {
			const onArchive = vi.fn();
			const { container } = render(
				<TaskInfoPanel isOpen={true} actions={{ onArchive }} visibleActions={{ archive: true }} />
			);

			expect(container.querySelector('[data-testid="task-info-panel-archive"]')).toBeTruthy();
			expect(container.textContent).toContain('Archive');
		});

		it('should NOT show Complete action when not visible', () => {
			const onComplete = vi.fn();
			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					actions={{ onComplete }}
					visibleActions={{ complete: false }}
				/>
			);

			expect(container.querySelector('[data-testid="task-info-panel-complete"]')).toBeNull();
		});

		it('should NOT show Cancel action when not visible', () => {
			const onCancel = vi.fn();
			const { container } = render(
				<TaskInfoPanel isOpen={true} actions={{ onCancel }} visibleActions={{ cancel: false }} />
			);

			expect(container.querySelector('[data-testid="task-info-panel-cancel"]')).toBeNull();
		});

		it('should call onComplete when Complete button is clicked', () => {
			const onComplete = vi.fn();
			const { container } = render(
				<TaskInfoPanel isOpen={true} actions={{ onComplete }} visibleActions={{ complete: true }} />
			);

			const btn = container.querySelector('[data-testid="task-info-panel-complete"]');
			fireEvent.click(btn!);
			expect(onComplete).toHaveBeenCalledOnce();
		});

		it('should call onCancel when Cancel button is clicked', () => {
			const onCancel = vi.fn();
			const { container } = render(
				<TaskInfoPanel isOpen={true} actions={{ onCancel }} visibleActions={{ cancel: true }} />
			);

			const btn = container.querySelector('[data-testid="task-info-panel-cancel"]');
			fireEvent.click(btn!);
			expect(onCancel).toHaveBeenCalledOnce();
		});

		it('should call onArchive when Archive button is clicked', () => {
			const onArchive = vi.fn();
			const { container } = render(
				<TaskInfoPanel isOpen={true} actions={{ onArchive }} visibleActions={{ archive: true }} />
			);

			const btn = container.querySelector('[data-testid="task-info-panel-archive"]');
			fireEvent.click(btn!);
			expect(onArchive).toHaveBeenCalledOnce();
		});
	});

	describe('Disabled Actions', () => {
		it('should disable Complete button when disabledActions.complete is true', () => {
			const onComplete = vi.fn();
			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					actions={{ onComplete }}
					visibleActions={{ complete: true }}
					disabledActions={{ complete: true }}
				/>
			);

			const btn = container.querySelector(
				'[data-testid="task-info-panel-complete"]'
			) as HTMLButtonElement;
			expect(btn?.disabled).toBe(true);
		});

		it('should disable Cancel button when disabledActions.cancel is true', () => {
			const onCancel = vi.fn();
			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					actions={{ onCancel }}
					visibleActions={{ cancel: true }}
					disabledActions={{ cancel: true }}
				/>
			);

			const btn = container.querySelector(
				'[data-testid="task-info-panel-cancel"]'
			) as HTMLButtonElement;
			expect(btn?.disabled).toBe(true);
		});
	});

	describe('Path truncation', () => {
		it('should truncate long paths to last 2 segments', () => {
			const { container } = render(
				<TaskInfoPanel isOpen={true} worktreePath="/a/b/c/d/e/f" actions={{}} visibleActions={{}} />
			);

			expect(container.textContent).toContain('.../e/f');
			expect(container.textContent).not.toContain('/a/b/c');
		});

		it('should show short paths unchanged', () => {
			const { container } = render(
				<TaskInfoPanel isOpen={true} worktreePath="short/path" actions={{}} visibleActions={{}} />
			);

			expect(container.textContent).toContain('short/path');
		});
	});
});
