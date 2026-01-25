// @ts-nocheck
/**
 * Tests for SessionListItem Component
 *
 * Tests the session list item with status indicators, metadata display,
 * worktree badge, and archived status.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { signal, computed } from '@preact/signals';
import type { Session, AgentProcessingState } from '@liuboer/shared';

// Define signals after imports - use getters in vi.mock to defer evaluation
let mockStatuses: ReturnType<
	typeof signal<Map<string, { processingState: AgentProcessingState; hasUnread: boolean }>>
>;
let mockCurrentSessionId: ReturnType<typeof signal<string | null>>;

vi.mock('../../lib/session-status.ts', () => ({
	get allSessionStatuses() {
		return computed(() => mockStatuses.value);
	},
	getProcessingPhaseColor: (state: AgentProcessingState) => {
		if (state.status === 'idle' || state.status === 'interrupted') return null;
		if (state.status === 'queued') return { dot: 'bg-yellow-500', text: 'text-yellow-400' };
		if (state.status === 'processing') {
			switch (state.phase) {
				case 'thinking':
					return { dot: 'bg-blue-500', text: 'text-blue-400' };
				case 'streaming':
					return { dot: 'bg-green-500', text: 'text-green-400' };
				default:
					return { dot: 'bg-purple-500', text: 'text-purple-400' };
			}
		}
		return null;
	},
}));

vi.mock('../../lib/signals.ts', () => ({
	get currentSessionIdSignal() {
		return mockCurrentSessionId;
	},
}));

// Initialize signals after mocks are set up
mockStatuses = signal<Map<string, { processingState: AgentProcessingState; hasUnread: boolean }>>(
	new Map()
);
mockCurrentSessionId = signal<string | null>(null);

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

	const mockOnSessionClick = vi.fn(() => {});

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

	describe('Status Indicator', () => {
		beforeEach(() => {
			mockStatuses.value = new Map();
		});

		it('should not show indicator when no status exists', () => {
			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			// No status indicator should be present
			const indicator = container.querySelector('.animate-pulse');
			expect(indicator).toBeNull();
		});

		it('should not show indicator when status is idle', () => {
			mockStatuses.value = new Map([
				['session-1', { processingState: { status: 'idle' }, hasUnread: false }],
			]);

			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			const indicator = container.querySelector('.animate-pulse');
			expect(indicator).toBeNull();
		});

		it('should show pulsing indicator when processing', () => {
			mockStatuses.value = new Map([
				[
					'session-1',
					{ processingState: { status: 'processing', phase: 'thinking' }, hasUnread: false },
				],
			]);

			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			const pulsingIndicator = container.querySelector('.animate-pulse');
			expect(pulsingIndicator).toBeTruthy();
		});

		it('should show blue dot when thinking', () => {
			mockStatuses.value = new Map([
				[
					'session-1',
					{ processingState: { status: 'processing', phase: 'thinking' }, hasUnread: false },
				],
			]);

			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			const blueDot = container.querySelector('.bg-blue-500');
			expect(blueDot).toBeTruthy();
		});

		it('should show green dot when streaming', () => {
			mockStatuses.value = new Map([
				[
					'session-1',
					{ processingState: { status: 'processing', phase: 'streaming' }, hasUnread: false },
				],
			]);

			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			const greenDot = container.querySelector('.bg-green-500');
			expect(greenDot).toBeTruthy();
		});

		it('should show yellow dot when queued', () => {
			mockStatuses.value = new Map([
				['session-1', { processingState: { status: 'queued' }, hasUnread: false }],
			]);

			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			const yellowDot = container.querySelector('.bg-yellow-500');
			expect(yellowDot).toBeTruthy();
		});

		it('should show static blue dot when has unread messages', () => {
			mockStatuses.value = new Map([
				['session-1', { processingState: { status: 'idle' }, hasUnread: true }],
			]);

			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			// Should show blue unread dot
			const unreadDot = container.querySelector('.bg-blue-500');
			expect(unreadDot).toBeTruthy();

			// Should NOT be pulsing (static dot)
			const pulsingDot = container.querySelector('.animate-pulse');
			expect(pulsingDot).toBeNull();
		});

		it('should prioritize processing state over unread', () => {
			mockStatuses.value = new Map([
				[
					'session-1',
					{ processingState: { status: 'processing', phase: 'streaming' }, hasUnread: true },
				],
			]);

			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			// Should show green streaming dot (processing takes priority)
			const streamingDot = container.querySelector('.bg-green-500');
			expect(streamingDot).toBeTruthy();

			// Should be pulsing
			const pulsingDot = container.querySelector('.animate-pulse');
			expect(pulsingDot).toBeTruthy();
		});

		it('should show ping animation when processing', () => {
			mockStatuses.value = new Map([
				[
					'session-1',
					{ processingState: { status: 'processing', phase: 'thinking' }, hasUnread: false },
				],
			]);

			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			const pingAnimation = container.querySelector('.animate-ping');
			expect(pingAnimation).toBeTruthy();
		});

		it('should not show indicator for interrupted status', () => {
			mockStatuses.value = new Map([
				['session-1', { processingState: { status: 'interrupted' }, hasUnread: false }],
			]);

			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			const indicator = container.querySelector('.animate-pulse');
			expect(indicator).toBeNull();
		});
	});

	describe('Active Session Styling', () => {
		beforeEach(() => {
			mockCurrentSessionId.value = null;
		});

		it('should have active styling when current session', () => {
			mockCurrentSessionId.value = 'session-1';

			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			const button = container.querySelector('button');
			expect(button?.className).toContain('bg-dark-850');
			expect(button?.className).toContain('border-l-blue-500');
		});

		it('should have inactive styling when not current session', () => {
			mockCurrentSessionId.value = 'other-session';

			const { container } = render(
				<SessionListItem session={mockSession} onSessionClick={mockOnSessionClick} />
			);

			const button = container.querySelector('button');
			expect(button?.className).toContain('hover:bg-dark-900');
			expect(button?.className).not.toContain('bg-dark-850');
		});
	});
});
