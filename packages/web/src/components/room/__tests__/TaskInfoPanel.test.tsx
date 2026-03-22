/**
 * Tests for TaskInfoPanel Component
 *
 * Tests the inline expandable info panel that replaces the old dropdown.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { TaskInfoPanel } from '../TaskInfoPanel';

// Mock TaskViewModelSelector to avoid connectionManager dependency in tests
vi.mock('../TaskViewModelSelector.tsx', () => ({
	TaskViewModelSelector: ({ currentModel }: { currentModel: string }) => (
		<span data-testid="model-selector-mock">{currentModel}</span>
	),
}));

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

	describe('Task ID and Group ID', () => {
		it('should show full task ID when provided', () => {
			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					taskId="task-abc123-def456-ghi789"
					actions={{}}
					visibleActions={{}}
				/>
			);

			expect(container.textContent).toContain('Task ID:');
			const el = container.querySelector('[data-testid="task-info-panel-task-id"]');
			expect(el?.textContent).toBe('task-abc123-def456-ghi789');
		});

		it('should show a copy button next to the task ID', () => {
			const { container } = render(
				<TaskInfoPanel isOpen={true} taskId="task-abc123" actions={{}} visibleActions={{}} />
			);

			// The task ID row should contain a button (the CopyButton) with a copy title
			const taskIdEl = container.querySelector('[data-testid="task-info-panel-task-id"]');
			expect(taskIdEl).toBeTruthy();
			// CopyButton renders a <button> with title="Copy" or "Copied!" in the same row
			const row = taskIdEl?.closest('.flex');
			const copyBtn = row?.querySelector('button[title]');
			expect(copyBtn).toBeTruthy();
		});

		it('should not show task ID row when not provided', () => {
			const { container } = render(
				<TaskInfoPanel isOpen={true} actions={{}} visibleActions={{}} />
			);

			expect(container.textContent).not.toContain('Task ID:');
		});

		it('should show full group ID when provided', () => {
			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					groupId="group-xyz789-abc123"
					actions={{}}
					visibleActions={{}}
				/>
			);

			expect(container.textContent).toContain('Group ID:');
			const el = container.querySelector('[data-testid="task-info-panel-group-id"]');
			expect(el?.textContent).toBe('group-xyz789-abc123');
		});

		it('should not show group ID row when not provided', () => {
			const { container } = render(
				<TaskInfoPanel isOpen={true} actions={{}} visibleActions={{}} />
			);

			expect(container.textContent).not.toContain('Group ID:');
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

		it('should show full worker session ID when provided', () => {
			const workerSession = {
				id: 'worker-session-id-1234-5678-abcd',
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
			// Should show the full session ID (not truncated)
			const el = container.querySelector('[data-testid="worker-session-id"]');
			expect(el?.textContent).toBe('worker-session-id-1234-5678-abcd');
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

		it('should show full leader session ID when provided', () => {
			const leaderSession = {
				id: 'leader-session-id-5678-efgh',
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
			// Should show the full session ID (not truncated)
			const el = container.querySelector('[data-testid="leader-session-id"]');
			expect(el?.textContent).toBe('leader-session-id-5678-efgh');
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

		it('should render model selector when session has model config', () => {
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

			expect(container.textContent).toContain('Model:');
			// Mock shows the model id
			expect(container.querySelector('[data-testid="model-selector-mock"]')).toBeTruthy();
		});

		it('should use leader session for model when no worker session', () => {
			const leaderSession = {
				id: 'leader-session-id-5678',
				status: 'active',
				config: { model: 'claude-opus-4-6' },
			} as never;

			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					leaderSession={leaderSession}
					actions={{}}
					visibleActions={{}}
				/>
			);

			expect(container.textContent).toContain('Model:');
			const modelEl = container.querySelector('[data-testid="model-selector-mock"]');
			expect(modelEl?.textContent).toBe('claude-opus-4-6');
		});

		it('should show empty state when no info and no actions', () => {
			const { container } = render(
				<TaskInfoPanel isOpen={true} actions={{}} visibleActions={{}} />
			);

			expect(container.textContent).toContain('No info or actions available');
		});
	});

	describe('Timestamp and metadata', () => {
		it('should show creation time when taskCreatedAt is provided', () => {
			// Use a fixed timestamp that will be formatted consistently
			const ts = new Date('2025-01-15T10:30:00').getTime();
			const { container } = render(
				<TaskInfoPanel isOpen={true} taskCreatedAt={ts} actions={{}} visibleActions={{}} />
			);

			expect(container.textContent).toContain('Created:');
			const el = container.querySelector('[data-testid="task-info-panel-created-at"]');
			expect(el).toBeTruthy();
			// Should have an ISO string as title
			expect(el?.getAttribute('title')).toContain('2025-01-15');
		});

		it('should not show Created row when taskCreatedAt is not provided', () => {
			const { container } = render(
				<TaskInfoPanel isOpen={true} actions={{}} visibleActions={{}} />
			);

			expect(container.textContent).not.toContain('Created:');
		});

		it('should show feedback iteration when > 0', () => {
			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					taskId="task-abc"
					feedbackIteration={3}
					actions={{}}
					visibleActions={{}}
				/>
			);

			expect(container.textContent).toContain('Iteration:');
			const el = container.querySelector('[data-testid="task-info-panel-iteration"]');
			expect(el?.textContent).toBe('3');
		});

		it('should not show iteration when feedbackIteration is 0', () => {
			const { container } = render(
				<TaskInfoPanel isOpen={true} feedbackIteration={0} actions={{}} visibleActions={{}} />
			);

			expect(container.textContent).not.toContain('Iteration:');
		});

		it('should not show iteration when feedbackIteration is undefined', () => {
			const { container } = render(
				<TaskInfoPanel isOpen={true} actions={{}} visibleActions={{}} />
			);

			expect(container.textContent).not.toContain('Iteration:');
		});

		it('should show PR link when prUrl and prNumber are provided', () => {
			const { container } = render(
				<TaskInfoPanel
					isOpen={true}
					prUrl="https://github.com/org/repo/pull/42"
					prNumber={42}
					actions={{}}
					visibleActions={{}}
				/>
			);

			expect(container.textContent).toContain('PR:');
			const link = container.querySelector(
				'[data-testid="task-info-panel-pr-link"]'
			) as HTMLAnchorElement;
			expect(link).toBeTruthy();
			expect(link?.textContent).toBe('#42');
			expect(link?.href).toContain('github.com/org/repo/pull/42');
		});

		it('should not show PR row when prUrl is not provided', () => {
			const { container } = render(
				<TaskInfoPanel isOpen={true} actions={{}} visibleActions={{}} />
			);

			expect(container.textContent).not.toContain('PR:');
		});

		it('should not show PR row when only prNumber is provided but no prUrl', () => {
			const { container } = render(
				<TaskInfoPanel isOpen={true} prNumber={42} actions={{}} visibleActions={{}} />
			);

			expect(container.textContent).not.toContain('PR:');
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
