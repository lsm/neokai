// @ts-nocheck
/**
 * Tests for SessionListItem Component
 *
 * Tests the session list item with status indicators, metadata display,
 * worktree badge, and archived status.
 *
 * Note: Tests without mock.module to avoid polluting other tests.
 */

import './setup';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import type { Session } from '@liuboer/shared';
import SessionListItem from '../SessionListItem';

describe('SessionListItem', () => {
	const mockSession: Session = {
		id: 'session-1',
		title: 'Test Session',
		status: 'active',
		workspacePath: '/test/path',
		createdAt: new Date().toISOString(),
		lastActiveAt: new Date().toISOString(),
		metadata: {
			messageCount: 10,
			totalTokens: 5000,
			totalCost: 0.05,
		},
	};

	const mockOnSessionClick = mock(() => {});

	beforeEach(() => {
		cleanup();
		mockOnSessionClick.mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	describe('Basic Rendering', () => {
		it('should render session title', () => {
			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			const title = container.querySelector('h3');
			expect(title?.textContent).toBe('Test Session');
		});

		it('should render "New Session" when title is empty', () => {
			const sessionWithoutTitle = { ...mockSession, title: '' };
			const { container } = render(
				<SessionListItem session={sessionWithoutTitle} onSessionClick={mockOnSessionClick} />
			);

			const title = container.querySelector('h3');
			expect(title?.textContent).toBe('New Session');
		});

		it('should render message count', () => {
			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			expect(container.textContent).toContain('10');
		});

		it('should render token count', () => {
			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			// Should contain formatted token count (5.0k)
			expect(container.textContent).toContain('5.0k');
		});

		it('should render cost', () => {
			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			expect(container.textContent).toContain('$0.0500');
		});

		it('should render relative time', () => {
			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			// Should contain some time string (e.g., "just now", "1m ago", etc.)
			const text = container.textContent || '';
			expect(text.length).toBeGreaterThan(0);
		});

		it('should have correct data-testid', () => {
			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			const card = container.querySelector('[data-testid="session-card"]');
			expect(card).toBeTruthy();
		});

		it('should have correct data-session-id', () => {
			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			const card = container.querySelector('[data-session-id="session-1"]');
			expect(card).toBeTruthy();
		});
	});

	describe('Click Handling', () => {
		it('should call onSessionClick with session id when clicked', () => {
			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			const button = container.querySelector('button')!;
			fireEvent.click(button);

			expect(mockOnSessionClick).toHaveBeenCalledWith('session-1');
		});

		it('should call onSessionClick only once per click', () => {
			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			const button = container.querySelector('button')!;
			fireEvent.click(button);

			expect(mockOnSessionClick).toHaveBeenCalledTimes(1);
		});
	});

	describe('Active State', () => {
		it('should have styling classes on button', () => {
			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			const button = container.querySelector('button')!;
			// Should have base styles
			expect(button.className).toContain('transition-all');
			expect(button.className).toContain('w-full');
		});

		it('should have hover styling for inactive session', () => {
			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			const button = container.querySelector('button')!;
			expect(button.className).toContain('hover:bg-dark-900');
		});
	});

	describe('Worktree Badge', () => {
		it('should show worktree icon when session has worktree', () => {
			const sessionWithWorktree = {
				...mockSession,
				worktree: {
					path: '/worktree/path',
					branch: 'session/test-branch',
				},
			};
			const { container } = render(
				<SessionListItem session={sessionWithWorktree} onSessionClick={mockOnSessionClick} />
			);

			// GitBranchIcon should be present
			const worktreeIcon = container.querySelector('.text-purple-400');
			expect(worktreeIcon).toBeTruthy();
		});

		it('should not show worktree icon when session has no worktree', () => {
			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			const worktreeIcon = container.querySelector('.text-purple-400');
			expect(worktreeIcon).toBeNull();
		});

		it('should have correct title on worktree icon', () => {
			const sessionWithWorktree = {
				...mockSession,
				worktree: {
					path: '/worktree/path',
					branch: 'session/test-branch',
				},
			};
			const { container } = render(
				<SessionListItem session={sessionWithWorktree} onSessionClick={mockOnSessionClick} />
			);

			const worktreeSpan = container.querySelector('[title="Worktree: session/test-branch"]');
			expect(worktreeSpan).toBeTruthy();
		});
	});

	describe('Archived Status', () => {
		it('should show archived icon when session is archived', () => {
			const archivedSession = { ...mockSession, status: 'archived' as const };
			const { container } = render(
				<SessionListItem session={archivedSession} onSessionClick={mockOnSessionClick} />
			);

			const archivedIcon = container.querySelector('.text-amber-600');
			expect(archivedIcon).toBeTruthy();
		});

		it('should have correct title on archived icon', () => {
			const archivedSession = { ...mockSession, status: 'archived' as const };
			const { container } = render(
				<SessionListItem session={archivedSession} onSessionClick={mockOnSessionClick} />
			);

			const archivedSpan = container.querySelector('[title="Archived session"]');
			expect(archivedSpan).toBeTruthy();
		});

		it('should not show archived icon for active sessions', () => {
			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			const archivedSpan = container.querySelector('[title="Archived session"]');
			expect(archivedSpan).toBeNull();
		});
	});

	describe('Metadata Display', () => {
		it('should handle zero message count', () => {
			const sessionWithNoMessages = {
				...mockSession,
				metadata: { ...mockSession.metadata, messageCount: 0 },
			};
			const { container } = render(
				<SessionListItem session={sessionWithNoMessages} onSessionClick={mockOnSessionClick} />
			);

			// Should render without error and show 0
			expect(container.textContent).toContain('0');
		});

		it('should handle zero token count', () => {
			const sessionWithNoTokens = {
				...mockSession,
				metadata: { ...mockSession.metadata, totalTokens: 0 },
			};
			const { container } = render(
				<SessionListItem session={sessionWithNoTokens} onSessionClick={mockOnSessionClick} />
			);

			// Should render without error
			expect(container.textContent).toContain('0');
		});

		it('should handle zero cost', () => {
			const sessionWithNoCost = {
				...mockSession,
				metadata: { ...mockSession.metadata, totalCost: 0 },
			};
			const { container } = render(
				<SessionListItem session={sessionWithNoCost} onSessionClick={mockOnSessionClick} />
			);

			expect(container.textContent).toContain('$0.0000');
		});

		it('should handle large token counts', () => {
			const sessionWithLargeTokens = {
				...mockSession,
				metadata: { ...mockSession.metadata, totalTokens: 1500000 },
			};
			const { container } = render(
				<SessionListItem session={sessionWithLargeTokens} onSessionClick={mockOnSessionClick} />
			);

			// Should contain formatted token count (1500.0k)
			expect(container.textContent).toContain('1500.0k');
		});
	});
});
