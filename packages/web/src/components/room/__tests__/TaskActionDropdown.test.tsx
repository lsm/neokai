/**
 * Tests for TaskActionDropdown Component
 *
 * Tests the action dropdown that combines task info and actions.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { TaskActionDropdown } from '../TaskActionDropdown';

describe('TaskActionDropdown', () => {
	beforeEach(() => {
		cleanup();
	});

	afterEach(() => {
		cleanup();
	});

	describe('Rendering', () => {
		it('should render trigger button', () => {
			const { container } = render(<TaskActionDropdown actions={{}} visibleActions={{}} />);

			const trigger = container.querySelector('[data-testid="task-action-dropdown-trigger"]');
			expect(trigger).toBeTruthy();
		});

		it('should not show dropdown when not clicked', () => {
			const { container } = render(<TaskActionDropdown actions={{}} visibleActions={{}} />);

			// Dropdown should not be visible initially
			expect(container.textContent).not.toContain('Info');
			expect(container.textContent).not.toContain('Actions');
		});
	});

	describe('Dropdown Toggle', () => {
		it('should open dropdown when trigger is clicked', () => {
			const { container } = render(
				<TaskActionDropdown worktreePath="/test/path" actions={{}} visibleActions={{}} />
			);

			const trigger = container.querySelector('[data-testid="task-action-dropdown-trigger"]');
			fireEvent.click(trigger!);

			// Dropdown should now be visible with info section (but no Actions header since no actions)
			expect(container.textContent).toContain('Info');
		});

		it('should close dropdown when trigger is clicked again', () => {
			const { container } = render(<TaskActionDropdown actions={{}} visibleActions={{}} />);

			const trigger = container.querySelector('[data-testid="task-action-dropdown-trigger"]');
			fireEvent.click(trigger!);
			fireEvent.click(trigger!);

			// Dropdown should be closed
			expect(container.textContent).not.toContain('Info');
		});

		it('should close dropdown on Escape key', () => {
			const { container } = render(<TaskActionDropdown actions={{}} visibleActions={{}} />);

			const trigger = container.querySelector('[data-testid="task-action-dropdown-trigger"]');
			fireEvent.click(trigger!);

			fireEvent.keyDown(document, { key: 'Escape' });

			expect(container.textContent).not.toContain('Info');
		});
	});

	describe('Info Section', () => {
		it('should show worktree path when provided', () => {
			const { container } = render(
				<TaskActionDropdown
					worktreePath="/Users/test/project/packages/web"
					actions={{}}
					visibleActions={{}}
				/>
			);

			const trigger = container.querySelector('[data-testid="task-action-dropdown-trigger"]');
			fireEvent.click(trigger!);

			// Should show truncated path
			expect(container.textContent).toContain('packages/web');
		});

		it('should show full path on hover title', () => {
			const { container } = render(
				<TaskActionDropdown
					worktreePath="/Users/test/project/packages/web"
					actions={{}}
					visibleActions={{}}
				/>
			);

			const trigger = container.querySelector('[data-testid="task-action-dropdown-trigger"]');
			fireEvent.click(trigger!);

			// The truncated path element should have a title with full path
			const pathElement = container.querySelector('[title="/Users/test/project/packages/web"]');
			expect(pathElement).toBeTruthy();
		});
	});

	describe('Actions Section', () => {
		it('should show Complete action when visible', () => {
			const onComplete = vi.fn();
			const { container } = render(
				<TaskActionDropdown actions={{ onComplete }} visibleActions={{ complete: true }} />
			);

			const trigger = container.querySelector('[data-testid="task-action-dropdown-trigger"]');
			fireEvent.click(trigger!);

			expect(container.textContent).toContain('Complete');
		});

		it('should show Archive action when visible', () => {
			const onArchive = vi.fn();
			const { container } = render(
				<TaskActionDropdown actions={{ onArchive }} visibleActions={{ archive: true }} />
			);

			const trigger = container.querySelector('[data-testid="task-action-dropdown-trigger"]');
			fireEvent.click(trigger!);

			expect(container.textContent).toContain('Archive');
		});

		it('should NOT show action when not visible', () => {
			const onComplete = vi.fn();
			const { container } = render(
				<TaskActionDropdown actions={{ onComplete }} visibleActions={{ complete: false }} />
			);

			const trigger = container.querySelector('[data-testid="task-action-dropdown-trigger"]');
			fireEvent.click(trigger!);

			expect(container.textContent).not.toContain('Complete');
		});

		it('should call onComplete when Complete action is clicked', () => {
			const onComplete = vi.fn();
			const { container } = render(
				<TaskActionDropdown actions={{ onComplete }} visibleActions={{ complete: true }} />
			);

			const trigger = container.querySelector('[data-testid="task-action-dropdown-trigger"]');
			fireEvent.click(trigger!);

			const completeBtn = container.querySelector('[data-testid="task-action-complete"]');
			fireEvent.click(completeBtn!);

			expect(onComplete).toHaveBeenCalled();
		});

		it('should call onArchive when Archive action is clicked', () => {
			const onArchive = vi.fn();
			const { container } = render(
				<TaskActionDropdown actions={{ onArchive }} visibleActions={{ archive: true }} />
			);

			const trigger = container.querySelector('[data-testid="task-action-dropdown-trigger"]');
			fireEvent.click(trigger!);

			const archiveBtn = container.querySelector('[data-testid="task-action-archive"]');
			fireEvent.click(archiveBtn!);

			expect(onArchive).toHaveBeenCalled();
		});

		it('should close dropdown after action is clicked', () => {
			const onComplete = vi.fn();
			const { container } = render(
				<TaskActionDropdown actions={{ onComplete }} visibleActions={{ complete: true }} />
			);

			const trigger = container.querySelector('[data-testid="task-action-dropdown-trigger"]');
			fireEvent.click(trigger!);

			const completeBtn = container.querySelector('[data-testid="task-action-complete"]');
			fireEvent.click(completeBtn!);

			// Dropdown should be closed
			expect(container.textContent).not.toContain('Info');
		});
	});

	describe('Disabled Actions', () => {
		it('should disable Complete action when disabled is true', () => {
			const onComplete = vi.fn();
			const { container } = render(
				<TaskActionDropdown
					actions={{ onComplete }}
					visibleActions={{ complete: true }}
					disabledActions={{ complete: true }}
				/>
			);

			const trigger = container.querySelector('[data-testid="task-action-dropdown-trigger"]');
			fireEvent.click(trigger!);

			const completeBtn = container.querySelector(
				'[data-testid="task-action-complete"]'
			) as HTMLButtonElement;
			expect(completeBtn?.disabled).toBe(true);
		});

		it('should NOT call onComplete when disabled action is clicked', () => {
			const onComplete = vi.fn();
			const { container } = render(
				<TaskActionDropdown
					actions={{ onComplete }}
					visibleActions={{ complete: true }}
					disabledActions={{ complete: true }}
				/>
			);

			const trigger = container.querySelector('[data-testid="task-action-dropdown-trigger"]');
			fireEvent.click(trigger!);

			const completeBtn = container.querySelector('[data-testid="task-action-complete"]');
			fireEvent.click(completeBtn!);

			expect(onComplete).not.toHaveBeenCalled();
		});
	});

	describe('Empty State', () => {
		it('should show "No actions available" when no info and no actions', () => {
			const { container } = render(<TaskActionDropdown actions={{}} visibleActions={{}} />);

			const trigger = container.querySelector('[data-testid="task-action-dropdown-trigger"]');
			fireEvent.click(trigger!);

			expect(container.textContent).toContain('No actions available');
		});
	});

	describe('Visual Feedback', () => {
		it('should show danger styling for Archive action', () => {
			const onArchive = vi.fn();
			const { container } = render(
				<TaskActionDropdown actions={{ onArchive }} visibleActions={{ archive: true }} />
			);

			const trigger = container.querySelector('[data-testid="task-action-dropdown-trigger"]');
			fireEvent.click(trigger!);

			// Archive should have danger styling
			const archiveBtn = container.querySelector('[data-testid="task-action-archive"]');
			expect(archiveBtn?.getAttribute('class')).toContain('text-red-400');
		});
	});
});
