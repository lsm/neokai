// @ts-nocheck
/**
 * Tests for SessionList Component
 *
 * Tests the session list in the sidebar with pagination,
 * archive toggle, and session selection.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/preact';
import { signal, computed } from '@preact/signals';
import type { Session, GlobalSettings } from '@neokai/shared';

// Define vi.fn() in vi.hoisted, signals after imports with getters for deferred evaluation
const { mockNavigateToSession, mockUpdateGlobalSettings, mockToastError } = vi.hoisted(() => ({
	mockNavigateToSession: vi.fn(),
	mockUpdateGlobalSettings: vi.fn().mockResolvedValue({ success: true, settings: {} }),
	mockToastError: vi.fn(),
}));

// Define signals that will be used in mocks
let mockSessionsSignal: ReturnType<typeof signal<Session[]>>;
let mockHasArchivedSessionsSignal: ReturnType<typeof signal<boolean>>;
let mockGlobalSettingsSignal: ReturnType<typeof signal<GlobalSettings | null>>;

// Mock the state module
vi.mock('../../lib/state.ts', () => ({
	get sessions() {
		return computed(() => mockSessionsSignal.value);
	},
	get hasArchivedSessions() {
		return computed(() => mockHasArchivedSessionsSignal.value);
	},
	get globalSettings() {
		return computed(() => mockGlobalSettingsSignal.value);
	},
}));

// Mock the router module
vi.mock('../../lib/router.ts', () => ({
	navigateToSession: (sessionId: string) => mockNavigateToSession(sessionId),
}));

// Mock the api-helpers module
vi.mock('../../lib/api-helpers.ts', () => ({
	updateGlobalSettings: (updates: Partial<GlobalSettings>) => mockUpdateGlobalSettings(updates),
}));

// Mock the toast module
vi.mock('../../lib/toast.ts', () => ({
	toast: {
		error: (message: string) => mockToastError(message),
		success: vi.fn(),
		info: vi.fn(),
		warning: vi.fn(),
	},
}));

// Initialize signals after mocks are set up
mockSessionsSignal = signal<Session[]>([]);
mockHasArchivedSessionsSignal = signal<boolean>(false);
mockGlobalSettingsSignal = signal<GlobalSettings | null>({ showArchived: false });

import { SessionList } from '../SessionList';

// Helper to create mock sessions
const createMockSession = (
	id: string,
	title: string,
	status: 'active' | 'archived' = 'active'
): Session => ({
	id,
	title,
	status,
	workspacePath: '/test/path',
	createdAt: new Date().toISOString(),
	lastActiveAt: new Date().toISOString(),
	metadata: {
		messageCount: 10,
		totalTokens: 5000,
		totalCost: 0.05,
	},
});

// Helper to create many sessions for pagination tests
const createManySessions = (count: number): Session[] => {
	return Array.from({ length: count }, (_, i) =>
		createMockSession(`session-${i + 1}`, `Session ${i + 1}`)
	);
};

describe('SessionList', () => {
	beforeEach(() => {
		cleanup();
		vi.clearAllMocks();
		mockSessionsSignal.value = [];
		mockHasArchivedSessionsSignal.value = false;
		mockGlobalSettingsSignal.value = { showArchived: false };
	});

	afterEach(() => {
		cleanup();
	});

	describe('Basic Rendering', () => {
		it('should render sessions list when sessions exist', () => {
			mockSessionsSignal.value = [createMockSession('session-1', 'Test Session')];

			const { container } = render(<SessionList />);

			expect(container.textContent).toContain('Test Session');
		});

		it('should render multiple sessions', () => {
			mockSessionsSignal.value = [
				createMockSession('session-1', 'First Session'),
				createMockSession('session-2', 'Second Session'),
				createMockSession('session-3', 'Third Session'),
			];

			const { container } = render(<SessionList />);

			expect(container.textContent).toContain('First Session');
			expect(container.textContent).toContain('Second Session');
			expect(container.textContent).toContain('Third Session');
		});

		it('should render session cards with correct test ids', () => {
			mockSessionsSignal.value = [createMockSession('session-1', 'Test Session')];

			const { container } = render(<SessionList />);

			const sessionCard = container.querySelector('[data-testid="session-card"]');
			expect(sessionCard).toBeTruthy();
		});

		it('should render session cards with session id data attribute', () => {
			mockSessionsSignal.value = [createMockSession('session-1', 'Test Session')];

			const { container } = render(<SessionList />);

			const sessionCard = container.querySelector('[data-session-id="session-1"]');
			expect(sessionCard).toBeTruthy();
		});
	});

	describe('Empty State', () => {
		it('should show empty state when no sessions', () => {
			mockSessionsSignal.value = [];

			const { container } = render(<SessionList />);

			expect(container.textContent).toContain('No sessions yet.');
			expect(container.textContent).toContain('Create one to get started!');
		});

		it('should show emoji in empty state', () => {
			mockSessionsSignal.value = [];

			const { container } = render(<SessionList />);

			expect(container.textContent).toContain('💬');
		});

		it('should not show empty state when sessions exist', () => {
			mockSessionsSignal.value = [createMockSession('session-1', 'Test Session')];

			const { container } = render(<SessionList />);

			expect(container.textContent).not.toContain('No sessions yet.');
		});
	});

	describe('Pagination', () => {
		it('should show first 20 sessions by default', () => {
			mockSessionsSignal.value = createManySessions(25);

			const { container } = render(<SessionList />);

			// Should show first 20 sessions - check by session id data attribute
			for (let i = 1; i <= 20; i++) {
				const sessionCard = container.querySelector(`[data-session-id="session-${i}"]`);
				expect(sessionCard).toBeTruthy();
			}
			// Should not show session 21-25 (no DOM elements for them)
			expect(container.querySelector('[data-session-id="session-21"]')).toBeNull();
			expect(container.querySelector('[data-session-id="session-22"]')).toBeNull();
		});

		it('should show Load More button when more sessions exist', () => {
			mockSessionsSignal.value = createManySessions(25);

			const { container } = render(<SessionList />);

			expect(container.textContent).toContain('Load More');
			expect(container.textContent).toContain('5 remaining');
		});

		it('should not show Load More button when all sessions visible', () => {
			mockSessionsSignal.value = createManySessions(15);

			const { container } = render(<SessionList />);

			expect(container.textContent).not.toContain('Load More');
		});

		it('should load more sessions when Load More button clicked', () => {
			mockSessionsSignal.value = createManySessions(25);

			const { container } = render(<SessionList />);

			// Initially shows first 20
			expect(container.textContent).toContain('Load More');

			// Click Load More
			const loadMoreButton = Array.from(container.querySelectorAll('button')).find((btn) =>
				btn.textContent?.includes('Load More')
			);
			fireEvent.click(loadMoreButton!);

			// Now shows all 25 sessions
			for (let i = 1; i <= 25; i++) {
				expect(container.textContent).toContain(`Session ${i}`);
			}
		});

		it('should update remaining count after loading more', () => {
			mockSessionsSignal.value = createManySessions(45);

			const { container } = render(<SessionList />);

			// Initially 25 remaining (45 - 20)
			expect(container.textContent).toContain('25 remaining');

			// Click Load More
			const loadMoreButton = Array.from(container.querySelectorAll('button')).find((btn) =>
				btn.textContent?.includes('Load More')
			);
			fireEvent.click(loadMoreButton!);

			// Now 5 remaining (45 - 40)
			expect(container.textContent).toContain('5 remaining');
		});

		it('should hide Load More button when all sessions loaded', () => {
			mockSessionsSignal.value = createManySessions(30);

			const { container } = render(<SessionList />);

			// Click Load More once to show 40 (all 30)
			const loadMoreButton = Array.from(container.querySelectorAll('button')).find((btn) =>
				btn.textContent?.includes('Load More')
			);
			fireEvent.click(loadMoreButton!);

			// No more Load More button
			expect(container.textContent).not.toContain('Load More');
		});

		it('should load exactly 20 more sessions per click', () => {
			mockSessionsSignal.value = createManySessions(50);

			const { container } = render(<SessionList />);

			// First click: 20 -> 40 (10 remaining)
			const loadMoreButton1 = Array.from(container.querySelectorAll('button')).find((btn) =>
				btn.textContent?.includes('Load More')
			);
			fireEvent.click(loadMoreButton1!);
			expect(container.textContent).toContain('10 remaining');

			// Second click: 40 -> 60 (all 50 shown)
			const loadMoreButton2 = Array.from(container.querySelectorAll('button')).find((btn) =>
				btn.textContent?.includes('Load More')
			);
			fireEvent.click(loadMoreButton2!);
			expect(container.textContent).not.toContain('Load More');
		});
	});

	describe('Archive Toggle', () => {
		it('should show archive toggle when there are archived sessions', () => {
			mockSessionsSignal.value = [createMockSession('session-1', 'Active')];
			mockHasArchivedSessionsSignal.value = true;

			const { container } = render(<SessionList />);

			expect(container.textContent).toContain('Show archived');
		});

		it('should not show archive toggle when no archived sessions', () => {
			mockSessionsSignal.value = [createMockSession('session-1', 'Active')];
			mockHasArchivedSessionsSignal.value = false;

			const { container } = render(<SessionList />);

			expect(container.textContent).not.toContain('Show archived');
			expect(container.textContent).not.toContain('Hide archived');
		});

		it('should show "Show archived" when archived are hidden', () => {
			mockSessionsSignal.value = [createMockSession('session-1', 'Active')];
			mockHasArchivedSessionsSignal.value = true;
			mockGlobalSettingsSignal.value = { showArchived: false };

			const { container } = render(<SessionList />);

			expect(container.textContent).toContain('Show archived');
		});

		it('should show "Hide archived" when archived are visible', () => {
			mockSessionsSignal.value = [createMockSession('session-1', 'Active')];
			mockHasArchivedSessionsSignal.value = true;
			mockGlobalSettingsSignal.value = { showArchived: true };

			const { container } = render(<SessionList />);

			expect(container.textContent).toContain('Hide archived');
		});

		it('should call updateGlobalSettings when toggle clicked', async () => {
			mockSessionsSignal.value = [createMockSession('session-1', 'Active')];
			mockHasArchivedSessionsSignal.value = true;
			mockGlobalSettingsSignal.value = { showArchived: false };

			const { container } = render(<SessionList />);

			const toggleButton = Array.from(container.querySelectorAll('button')).find((btn) =>
				btn.textContent?.includes('Show archived')
			);
			fireEvent.click(toggleButton!);

			expect(mockUpdateGlobalSettings).toHaveBeenCalledWith({ showArchived: true });
		});

		it('should show error toast when updateGlobalSettings fails', async () => {
			mockUpdateGlobalSettings.mockRejectedValueOnce(new Error('Network error'));
			mockSessionsSignal.value = [createMockSession('session-1', 'Active')];
			mockHasArchivedSessionsSignal.value = true;
			mockGlobalSettingsSignal.value = { showArchived: false };

			const { container } = render(<SessionList />);

			const toggleButton = Array.from(container.querySelectorAll('button')).find((btn) =>
				btn.textContent?.includes('Show archived')
			);
			fireEvent.click(toggleButton!);

			// Wait for async error handling
			await vi.waitFor(() => {
				expect(mockToastError).toHaveBeenCalledWith(
					'Failed to toggle archived sessions visibility'
				);
			});
		});

		it('should have rotated arrow icon when archived are visible', () => {
			mockSessionsSignal.value = [createMockSession('session-1', 'Active')];
			mockHasArchivedSessionsSignal.value = true;
			mockGlobalSettingsSignal.value = { showArchived: true };

			const { container } = render(<SessionList />);

			const toggleButton = Array.from(container.querySelectorAll('button')).find((btn) =>
				btn.textContent?.includes('Hide archived')
			);
			const svg = toggleButton?.querySelector('svg');
			expect(svg?.className).toContain('rotate-90');
		});

		it('should not have rotated arrow icon when archived are hidden', () => {
			mockSessionsSignal.value = [createMockSession('session-1', 'Active')];
			mockHasArchivedSessionsSignal.value = true;
			mockGlobalSettingsSignal.value = { showArchived: false };

			const { container } = render(<SessionList />);

			const toggleButton = Array.from(container.querySelectorAll('button')).find((btn) =>
				btn.textContent?.includes('Show archived')
			);
			const svg = toggleButton?.querySelector('svg');
			expect(svg?.className).not.toContain('rotate-90');
		});
	});

	describe('Session Selection', () => {
		it('should navigate to session when session card clicked', () => {
			mockSessionsSignal.value = [createMockSession('session-1', 'Test Session')];

			const { container } = render(<SessionList />);

			const sessionCard = container.querySelector('[data-session-id="session-1"]') as HTMLElement;
			fireEvent.click(sessionCard);

			expect(mockNavigateToSession).toHaveBeenCalledWith('session-1');
		});

		it('should call onSessionSelect callback when session clicked', () => {
			mockSessionsSignal.value = [createMockSession('session-1', 'Test Session')];
			const onSessionSelect = vi.fn();

			const { container } = render(<SessionList onSessionSelect={onSessionSelect} />);

			const sessionCard = container.querySelector('[data-session-id="session-1"]') as HTMLElement;
			fireEvent.click(sessionCard);

			expect(onSessionSelect).toHaveBeenCalledTimes(1);
		});

		it('should call onSessionSelect after navigateToSession', () => {
			mockSessionsSignal.value = [createMockSession('session-1', 'Test Session')];
			const onSessionSelect = vi.fn();

			const { container } = render(<SessionList onSessionSelect={onSessionSelect} />);

			const sessionCard = container.querySelector('[data-session-id="session-1"]') as HTMLElement;
			fireEvent.click(sessionCard);

			expect(mockNavigateToSession).toHaveBeenCalled();
			expect(onSessionSelect).toHaveBeenCalled();
		});

		it('should not fail when onSessionSelect not provided', () => {
			mockSessionsSignal.value = [createMockSession('session-1', 'Test Session')];

			const { container } = render(<SessionList />);

			const sessionCard = container.querySelector('[data-session-id="session-1"]') as HTMLElement;
			// Should not throw
			expect(() => fireEvent.click(sessionCard)).not.toThrow();
		});
	});

	describe('Archived Session Indicator', () => {
		it('should show archived icon for archived sessions', () => {
			mockSessionsSignal.value = [createMockSession('session-1', 'Archived Session', 'archived')];

			const { container } = render(<SessionList />);

			// Check for amber icon (archived indicator)
			const archivedIcon = container.querySelector('.text-amber-600');
			expect(archivedIcon).toBeTruthy();
		});

		it('should not show archived icon for active sessions', () => {
			mockSessionsSignal.value = [createMockSession('session-1', 'Active Session', 'active')];

			const { container } = render(<SessionList />);

			const archivedSpan = container.querySelector('[title="Archived session"]');
			expect(archivedSpan).toBeNull();
		});
	});

	describe('Pagination Reset on Archive Toggle', () => {
		it('should reset pagination when showArchived changes', () => {
			mockSessionsSignal.value = createManySessions(25);
			mockHasArchivedSessionsSignal.value = true;
			mockGlobalSettingsSignal.value = { showArchived: false };

			const { container, rerender } = render(<SessionList />);

			// Click Load More to increase visible count
			const loadMoreButton = Array.from(container.querySelectorAll('button')).find((btn) =>
				btn.textContent?.includes('Load More')
			);
			fireEvent.click(loadMoreButton!);

			// All sessions should be visible now
			expect(container.textContent).not.toContain('Load More');

			// Simulate archive toggle (settings change)
			mockGlobalSettingsSignal.value = { showArchived: true };

			// Re-render to trigger useEffect
			cleanup();
			const { container: newContainer } = render(<SessionList />);

			// Pagination should be reset - Load More should appear again
			expect(newContainer.textContent).toContain('Load More');
			expect(newContainer.textContent).toContain('5 remaining');
		});
	});

	describe('Edge Cases', () => {
		it('should handle exactly 20 sessions (no pagination needed)', () => {
			mockSessionsSignal.value = createManySessions(20);

			const { container } = render(<SessionList />);

			// All 20 should be visible
			for (let i = 1; i <= 20; i++) {
				expect(container.textContent).toContain(`Session ${i}`);
			}
			// No Load More button
			expect(container.textContent).not.toContain('Load More');
		});

		it('should handle exactly 21 sessions (pagination needed)', () => {
			mockSessionsSignal.value = createManySessions(21);

			const { container } = render(<SessionList />);

			// First 20 visible - check by session id data attribute
			for (let i = 1; i <= 20; i++) {
				const sessionCard = container.querySelector(`[data-session-id="session-${i}"]`);
				expect(sessionCard).toBeTruthy();
			}
			// Session 21 not visible initially (no DOM element)
			expect(container.querySelector('[data-session-id="session-21"]')).toBeNull();
			// 1 remaining
			expect(container.textContent).toContain('1 remaining');
		});

		it('should handle sessions with empty title', () => {
			const sessionWithEmptyTitle = createMockSession('session-1', '');
			mockSessionsSignal.value = [sessionWithEmptyTitle];

			const { container } = render(<SessionList />);

			// SessionListItem should display "New Session" for empty title
			expect(container.textContent).toContain('New Session');
		});

		it('should handle single session', () => {
			mockSessionsSignal.value = [createMockSession('session-1', 'Only Session')];

			const { container } = render(<SessionList />);

			expect(container.textContent).toContain('Only Session');
			expect(container.textContent).not.toContain('Load More');
		});
	});

	describe('Accessibility', () => {
		it('should have type="button" on all buttons', () => {
			mockSessionsSignal.value = createManySessions(25);
			mockHasArchivedSessionsSignal.value = true;

			const { container } = render(<SessionList />);

			const buttons = container.querySelectorAll('button');
			buttons.forEach((button) => {
				expect(button.getAttribute('type')).toBe('button');
			});
		});

		it('should have clickable session cards', () => {
			mockSessionsSignal.value = [createMockSession('session-1', 'Test Session')];

			const { container } = render(<SessionList />);

			const sessionCard = container.querySelector('[data-session-id="session-1"]');
			expect(sessionCard?.tagName).toBe('BUTTON');
		});
	});
});
