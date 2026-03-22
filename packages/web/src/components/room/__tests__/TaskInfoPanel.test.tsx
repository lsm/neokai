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

		it('should show worker session info when provided', () => {
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

			expect(container.textContent).toContain('Worker:');
			expect(container.textContent).toContain('worker-s'); // first 8 chars + '...'
		});

		it('should show leader session info when provided', () => {
			const leaderSession = {
				id: 'leader-session-id-5678',
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
