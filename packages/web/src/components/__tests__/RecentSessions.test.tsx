// @ts-nocheck
/**
 * Tests for RecentSessions Component
 *
 * Tests the recent sessions welcome page with session cards,
 * mobile menu, and empty state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { Session } from '@neokai/shared';

// Define vi.fn() in vi.hoisted, signals after imports with getters for deferred evaluation
const { mockNavigateToSession } = vi.hoisted(() => ({
	mockNavigateToSession: vi.fn(),
}));
let mockContextPanelOpenSignal: ReturnType<typeof signal<boolean>>;

vi.mock('../../lib/router.ts', () => ({
	navigateToSession: (sessionId: string) => mockNavigateToSession(sessionId),
}));

vi.mock('../../lib/signals.ts', () => ({
	get contextPanelOpenSignal() {
		return mockContextPanelOpenSignal;
	},
}));

// Initialize signal after mocks are set up
mockContextPanelOpenSignal = signal(false);

import RecentSessions from '../RecentSessions';

// Mock window.innerWidth for mobile detection
Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true, configurable: true });

describe('RecentSessions', () => {
	const createMockSession = (id: string, title: string, lastActiveAt: Date): Session => ({
		id,
		title,
		status: 'active',
		workspacePath: '/test/path',
		createdAt: new Date().toISOString(),
		lastActiveAt: lastActiveAt.toISOString(),
		metadata: {
			messageCount: 10,
			totalTokens: 5000,
			totalCost: 0.05,
		},
	});

	const mockSessions: Session[] = [
		createMockSession('session-1', 'First Session', new Date('2024-01-15')),
		createMockSession('session-2', 'Second Session', new Date('2024-01-14')),
		createMockSession('session-3', 'Third Session', new Date('2024-01-13')),
		createMockSession('session-4', 'Fourth Session', new Date('2024-01-12')),
		createMockSession('session-5', 'Fifth Session', new Date('2024-01-11')),
		createMockSession('session-6', 'Sixth Session', new Date('2024-01-10')),
		createMockSession('session-7', 'Seventh Session', new Date('2024-01-09')),
	];

	beforeEach(() => {
		cleanup();
		vi.resetAllMocks();
		mockContextPanelOpenSignal.value = false;
		Object.defineProperty(window, 'innerWidth', {
			value: 1024,
			writable: true,
			configurable: true,
		});
	});

	afterEach(() => {
		cleanup();
		vi.resetAllMocks();
	});

	describe('Basic Rendering', () => {
		it('should render welcome header', () => {
			const { container } = render(<RecentSessions sessions={mockSessions} />);

			expect(container.textContent).toContain('Welcome to NeoKai');
		});

		it('should render feature highlights', () => {
			const { container } = render(<RecentSessions sessions={mockSessions} />);

			expect(container.textContent).toContain('Real-time streaming');
			expect(container.textContent).toContain('Tool visualization');
			expect(container.textContent).toContain('Workspace management');
			expect(container.textContent).toContain('Multi-session support');
		});

		it('should render recent sessions section when sessions exist', () => {
			const { container } = render(<RecentSessions sessions={mockSessions} />);

			expect(container.textContent).toContain('Recent Sessions');
		});
	});

	describe('Session Display', () => {
		it('should display only 5 most recent sessions', () => {
			const { container } = render(<RecentSessions sessions={mockSessions} />);

			// Should show first 5 sessions
			expect(container.textContent).toContain('First Session');
			expect(container.textContent).toContain('Second Session');
			expect(container.textContent).toContain('Third Session');
			expect(container.textContent).toContain('Fourth Session');
			expect(container.textContent).toContain('Fifth Session');

			// Should not show 6th and 7th
			expect(container.textContent).not.toContain('Sixth Session');
			expect(container.textContent).not.toContain('Seventh Session');
		});

		it('should sort sessions by lastActiveAt descending', () => {
			const unsortedSessions = [
				createMockSession('oldest', 'Oldest', new Date('2024-01-01')),
				createMockSession('newest', 'Newest', new Date('2024-01-15')),
				createMockSession('middle', 'Middle', new Date('2024-01-08')),
			];

			const { container } = render(<RecentSessions sessions={unsortedSessions} />);

			// Find session cards (buttons with group class in the grid)
			const sessionCards = Array.from(container.querySelectorAll('button')).filter((btn) =>
				btn.className.includes('group')
			);
			// First session card should contain "Newest"
			expect(sessionCards[0]?.textContent).toContain('Newest');
		});

		it('should show "Showing X of Y sessions" when more than 5 sessions', () => {
			const { container } = render(<RecentSessions sessions={mockSessions} />);

			expect(container.textContent).toContain('Showing 5 of 7 sessions');
			expect(container.textContent).toContain('View all sessions in the sidebar');
		});

		it('should not show "Showing X of Y" when 5 or fewer sessions', () => {
			const fewSessions = mockSessions.slice(0, 3);
			const { container } = render(<RecentSessions sessions={fewSessions} />);

			expect(container.textContent).not.toContain('Showing');
		});
	});

	describe('Session Card Content', () => {
		it('should display session title', () => {
			const sessions = [mockSessions[0]];
			const { container } = render(<RecentSessions sessions={sessions} />);

			expect(container.textContent).toContain('First Session');
		});

		it('should display "New Session" for sessions without title', () => {
			const sessionWithoutTitle = { ...mockSessions[0], title: '' };
			const { container } = render(<RecentSessions sessions={[sessionWithoutTitle]} />);

			expect(container.textContent).toContain('New Session');
		});

		it('should display message count', () => {
			const sessions = [mockSessions[0]];
			const { container } = render(<RecentSessions sessions={sessions} />);

			expect(container.textContent).toContain('10');
		});

		it('should display token count', () => {
			const sessions = [mockSessions[0]];
			const { container } = render(<RecentSessions sessions={sessions} />);

			expect(container.textContent).toContain('5.0k');
		});

		it('should display cost', () => {
			const sessions = [mockSessions[0]];
			const { container } = render(<RecentSessions sessions={sessions} />);

			expect(container.textContent).toContain('$0.0500');
		});

		it('should display worktree icon when session has worktree', () => {
			const sessionWithWorktree = {
				...mockSessions[0],
				worktree: { path: '/worktree/path', branch: 'session/test' },
			};
			const { container } = render(<RecentSessions sessions={[sessionWithWorktree]} />);

			const worktreeIcon = container.querySelector('.text-purple-400');
			expect(worktreeIcon).toBeTruthy();
		});

		it('should display archived icon when session is archived', () => {
			const archivedSession = {
				...mockSessions[0],
				status: 'archived' as const,
			};
			const { container } = render(<RecentSessions sessions={[archivedSession]} />);

			const archivedIcon = container.querySelector('.text-amber-600');
			expect(archivedIcon).toBeTruthy();
		});
	});

	describe('Session Click Handling', () => {
		it('should have clickable session cards', () => {
			const { container } = render(<RecentSessions sessions={mockSessions} />);

			const sessionCards = Array.from(container.querySelectorAll('button')).filter((btn) =>
				btn.className.includes('group')
			);
			expect(sessionCards.length).toBeGreaterThan(0);
		});

		it('should have cursor pointer on session cards', () => {
			const { container } = render(<RecentSessions sessions={mockSessions} />);

			const sessionCards = Array.from(container.querySelectorAll('button')).filter((btn) =>
				btn.className.includes('group')
			);
			expect(sessionCards[0].className).toContain('cursor-pointer');
		});

		it('should navigate to session when clicked', () => {
			const { container } = render(<RecentSessions sessions={mockSessions} />);

			const sessionCards = Array.from(container.querySelectorAll('button')).filter((btn) =>
				btn.className.includes('group')
			);

			fireEvent.click(sessionCards[0]);

			// Should call navigateToSession with the first session's ID
			expect(mockNavigateToSession).toHaveBeenCalledWith('session-1');
		});

		it('should close sidebar on mobile when session is clicked', () => {
			// Set mobile width
			Object.defineProperty(window, 'innerWidth', {
				value: 500,
				writable: true,
				configurable: true,
			});
			mockContextPanelOpenSignal.value = true;

			const { container } = render(<RecentSessions sessions={mockSessions} />);

			const sessionCards = Array.from(container.querySelectorAll('button')).filter((btn) =>
				btn.className.includes('group')
			);

			fireEvent.click(sessionCards[0]);

			expect(mockNavigateToSession).toHaveBeenCalledWith('session-1');
			expect(mockContextPanelOpenSignal.value).toBe(false);
		});

		it('should not close sidebar on desktop when session is clicked', () => {
			// Set desktop width
			Object.defineProperty(window, 'innerWidth', {
				value: 1024,
				writable: true,
				configurable: true,
			});
			mockContextPanelOpenSignal.value = true;

			const { container } = render(<RecentSessions sessions={mockSessions} />);

			const sessionCards = Array.from(container.querySelectorAll('button')).filter((btn) =>
				btn.className.includes('group')
			);

			fireEvent.click(sessionCards[0]);

			expect(mockNavigateToSession).toHaveBeenCalledWith('session-1');
			// Sidebar should remain open on desktop
			expect(mockContextPanelOpenSignal.value).toBe(true);
		});
	});

	describe('Mobile Menu', () => {
		it('should render hamburger menu button', () => {
			const { container } = render(<RecentSessions sessions={mockSessions} />);

			const menuButton = container.querySelector('button[title="Open menu"]');
			expect(menuButton).toBeTruthy();
		});

		it('should have svg icon in menu button', () => {
			const { container } = render(<RecentSessions sessions={mockSessions} />);

			const menuButton = container.querySelector('button[title="Open menu"]')!;
			const svg = menuButton.querySelector('svg');
			expect(svg).toBeTruthy();
		});

		it('should open sidebar when menu button is clicked', () => {
			mockContextPanelOpenSignal.value = false;

			const { container } = render(<RecentSessions sessions={mockSessions} />);

			const menuButton = container.querySelector('button[title="Open menu"]');
			fireEvent.click(menuButton!);

			expect(mockContextPanelOpenSignal.value).toBe(true);
		});
	});

	describe('Empty State', () => {
		it('should show empty state message when no sessions', () => {
			const { container } = render(<RecentSessions sessions={[]} />);

			expect(container.textContent).toContain(
				'No sessions yet. Create a new session from the sidebar to start chatting.'
			);
		});

		it('should not show Recent Sessions section when no sessions', () => {
			const { container } = render(<RecentSessions sessions={[]} />);

			expect(container.textContent).not.toContain('Recent Sessions');
		});

		it('should show different subtitle when no sessions', () => {
			const { container } = render(<RecentSessions sessions={[]} />);

			expect(container.textContent).toContain('Create a new session to get started');
		});

		it('should show continue subtitle when sessions exist', () => {
			const { container } = render(<RecentSessions sessions={mockSessions} />);

			expect(container.textContent).toContain(
				'Continue where you left off or create a new session'
			);
		});
	});

	describe('Card Hover Effects', () => {
		it('should have hover styles on session cards', () => {
			const { container } = render(<RecentSessions sessions={mockSessions} />);

			const sessionCards = Array.from(container.querySelectorAll('button')).filter((btn) =>
				btn.className.includes('group')
			);
			expect(sessionCards[0].className).toContain('hover:bg-dark-800');
		});

		it('should have arrow indicator that shows on hover', () => {
			const { container } = render(<RecentSessions sessions={mockSessions} />);

			// Arrow indicator should exist but be hidden by default
			const arrow = container.querySelector('.group-hover\\:opacity-100');
			expect(arrow).toBeTruthy();
		});
	});
});
