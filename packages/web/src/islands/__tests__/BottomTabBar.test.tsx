/**
 * Tests for BottomTabBar Component
 *
 * Tests mobile-only bottom navigation: rendering, active state highlighting,
 * tab click navigation, and inbox badge display.
 */

import { render, screen, fireEvent } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal, computed } from '@preact/signals';

// Mock router functions
vi.mock('../../lib/router.ts', () => ({
	navigateToSessions: vi.fn(),
	navigateToSettings: vi.fn(),
	navigateToHome: vi.fn(),
	navigateToRooms: vi.fn(),
	navigateToInbox: vi.fn(),
	navigateToSpaces: vi.fn(),
}));

// Mock inboxStore
const mockItemsSignal = signal<unknown[]>([]);
const mockReviewCount = computed(() => mockItemsSignal.value.length);

vi.mock('../../lib/inbox-store.ts', () => ({
	inboxStore: {
		get items() {
			return mockItemsSignal;
		},
		get isLoading() {
			return signal(false);
		},
		get reviewCount() {
			return mockReviewCount;
		},
		refresh: vi.fn().mockResolvedValue(undefined),
	},
}));

import { BottomTabBar } from '../BottomTabBar.tsx';
import { navSectionSignal } from '../../lib/signals.ts';
import {
	navigateToInbox,
	navigateToRooms,
	navigateToSessions,
	navigateToSettings,
} from '../../lib/router.ts';

describe('BottomTabBar', () => {
	beforeEach(() => {
		navSectionSignal.value = 'chats';
		mockItemsSignal.value = [];
		vi.clearAllMocks();
	});

	describe('Rendering', () => {
		it('should render all four tabs', () => {
			render(<BottomTabBar />);

			expect(screen.getByRole('tab', { name: 'Inbox' })).toBeTruthy();
			expect(screen.getByRole('tab', { name: 'Rooms' })).toBeTruthy();
			expect(screen.getByRole('tab', { name: 'Chats' })).toBeTruthy();
			expect(screen.getByRole('tab', { name: 'Settings' })).toBeTruthy();
		});

		it('should render tab labels as visible text', () => {
			const { container } = render(<BottomTabBar />);

			const labels = container.querySelectorAll('span.text-\\[10px\\]');
			const texts = Array.from(labels).map((el) => el.textContent);
			expect(texts).toContain('Inbox');
			expect(texts).toContain('Rooms');
			expect(texts).toContain('Chats');
			expect(texts).toContain('Settings');
		});

		it('should have role="tablist" on the container', () => {
			const { container } = render(<BottomTabBar />);

			const tablist = container.querySelector('[role="tablist"]');
			expect(tablist).toBeTruthy();
		});
	});

	describe('Mobile-only visibility', () => {
		it('should have md:hidden class on the container', () => {
			const { container } = render(<BottomTabBar />);

			const bar = container.querySelector('[role="tablist"]');
			expect(bar?.className).toContain('md:hidden');
		});

		it('should have flex class for mobile display', () => {
			const { container } = render(<BottomTabBar />);

			const bar = container.querySelector('[role="tablist"]');
			expect(bar?.className).toContain('flex');
		});

		it('should be fixed positioned at the bottom', () => {
			const { container } = render(<BottomTabBar />);

			const bar = container.querySelector('[role="tablist"]');
			expect(bar?.className).toContain('fixed');
			expect(bar?.className).toContain('bottom-0');
		});
	});

	describe('Active State', () => {
		it('should mark Chats tab as selected when navSection is chats', () => {
			navSectionSignal.value = 'chats';
			render(<BottomTabBar />);

			const chatsTab = screen.getByRole('tab', { name: 'Chats' });
			expect(chatsTab.getAttribute('aria-selected')).toBe('true');
		});

		it('should mark Inbox tab as selected when navSection is inbox', () => {
			navSectionSignal.value = 'inbox';
			render(<BottomTabBar />);

			const inboxTab = screen.getByRole('tab', { name: 'Inbox' });
			expect(inboxTab.getAttribute('aria-selected')).toBe('true');
		});

		it('should mark Rooms tab as selected when navSection is rooms', () => {
			navSectionSignal.value = 'rooms';
			render(<BottomTabBar />);

			const roomsTab = screen.getByRole('tab', { name: 'Rooms' });
			expect(roomsTab.getAttribute('aria-selected')).toBe('true');
		});

		it('should mark Settings tab as selected when navSection is settings', () => {
			navSectionSignal.value = 'settings';
			render(<BottomTabBar />);

			const settingsTab = screen.getByRole('tab', { name: 'Settings' });
			expect(settingsTab.getAttribute('aria-selected')).toBe('true');
		});

		it('should apply active color class to active tab', () => {
			navSectionSignal.value = 'chats';
			render(<BottomTabBar />);

			const chatsTab = screen.getByRole('tab', { name: 'Chats' });
			expect(chatsTab.className).toContain('text-indigo-400');
		});

		it('should apply inactive color class to non-active tabs', () => {
			navSectionSignal.value = 'chats';
			render(<BottomTabBar />);

			const inboxTab = screen.getByRole('tab', { name: 'Inbox' });
			expect(inboxTab.className).toContain('text-gray-500');
		});

		it('should only have one tab selected at a time', () => {
			navSectionSignal.value = 'rooms';
			render(<BottomTabBar />);

			const tabs = screen.getAllByRole('tab');
			const selectedTabs = tabs.filter((t) => t.getAttribute('aria-selected') === 'true');
			expect(selectedTabs).toHaveLength(1);
		});
	});

	describe('Navigation', () => {
		it('should call navigateToInbox when Inbox tab is clicked', () => {
			render(<BottomTabBar />);

			const inboxTab = screen.getByRole('tab', { name: 'Inbox' });
			fireEvent.click(inboxTab);

			expect(navigateToInbox).toHaveBeenCalledTimes(1);
		});

		it('should call navigateToRooms when Rooms tab is clicked', () => {
			render(<BottomTabBar />);

			const roomsTab = screen.getByRole('tab', { name: 'Rooms' });
			fireEvent.click(roomsTab);

			expect(navigateToRooms).toHaveBeenCalledTimes(1);
		});

		it('should call navigateToSessions when Chats tab is clicked', () => {
			render(<BottomTabBar />);

			const chatsTab = screen.getByRole('tab', { name: 'Chats' });
			fireEvent.click(chatsTab);

			expect(navigateToSessions).toHaveBeenCalledTimes(1);
		});

		it('should call navigateToSettings when Settings tab is clicked', () => {
			render(<BottomTabBar />);

			const settingsTab = screen.getByRole('tab', { name: 'Settings' });
			fireEvent.click(settingsTab);

			expect(navigateToSettings).toHaveBeenCalledTimes(1);
		});
	});

	describe('Inbox Badge', () => {
		it('should not show badge when review count is zero', () => {
			mockItemsSignal.value = [];
			const { container } = render(<BottomTabBar />);

			const badge = container.querySelector('.bg-red-500');
			expect(badge).toBeNull();
		});

		it('should show badge when review count is greater than zero', () => {
			mockItemsSignal.value = [{}];
			const { container } = render(<BottomTabBar />);

			const badge = container.querySelector('.bg-red-500');
			expect(badge).toBeTruthy();
		});

		it('should display numeric count when badge count is 1-9', () => {
			mockItemsSignal.value = Array.from({ length: 3 }, () => ({}));
			const { container } = render(<BottomTabBar />);

			const badgeSpan = container.querySelector('.bg-red-500 span');
			expect(badgeSpan?.textContent).toBe('3');
		});

		it('should display "9+" when badge count exceeds 9', () => {
			mockItemsSignal.value = Array.from({ length: 12 }, () => ({}));
			const { container } = render(<BottomTabBar />);

			const badgeSpan = container.querySelector('.bg-red-500 span');
			expect(badgeSpan?.textContent).toBe('9+');
		});

		it('should only show badge on Inbox tab, not other tabs', () => {
			mockItemsSignal.value = [{}];
			render(<BottomTabBar />);

			// Only the Inbox button wrapper should have a badge
			const inboxTab = screen.getByRole('tab', { name: 'Inbox' });
			const chatsTab = screen.getByRole('tab', { name: 'Chats' });

			expect(inboxTab.querySelector('.bg-red-500')).toBeTruthy();
			expect(chatsTab.querySelector('.bg-red-500')).toBeNull();
		});
	});

	describe('Accessibility', () => {
		it('should have aria-selected on all tabs', () => {
			render(<BottomTabBar />);

			const tabs = screen.getAllByRole('tab');
			for (const tab of tabs) {
				expect(tab.hasAttribute('aria-selected')).toBe(true);
			}
		});

		it('should have aria-label on all tabs', () => {
			render(<BottomTabBar />);

			const tabs = screen.getAllByRole('tab');
			for (const tab of tabs) {
				expect(tab.hasAttribute('aria-label')).toBe(true);
			}
		});

		it('should have type="button" on all tab buttons', () => {
			render(<BottomTabBar />);

			const tabs = screen.getAllByRole('tab');
			for (const tab of tabs) {
				expect(tab.getAttribute('type')).toBe('button');
			}
		});

		it('should have aria-label on the tablist', () => {
			const { container } = render(<BottomTabBar />);

			const tablist = container.querySelector('[role="tablist"]');
			expect(tablist?.getAttribute('aria-label')).toBe('Main navigation');
		});
	});

	describe('Signal Reactivity', () => {
		it('should update active tab when navSectionSignal changes', () => {
			navSectionSignal.value = 'chats';
			const { rerender } = render(<BottomTabBar />);

			let chatsTab = screen.getByRole('tab', { name: 'Chats' });
			expect(chatsTab.getAttribute('aria-selected')).toBe('true');

			navSectionSignal.value = 'rooms';
			rerender(<BottomTabBar />);

			chatsTab = screen.getByRole('tab', { name: 'Chats' });
			const roomsTab = screen.getByRole('tab', { name: 'Rooms' });
			expect(chatsTab.getAttribute('aria-selected')).toBe('false');
			expect(roomsTab.getAttribute('aria-selected')).toBe('true');
		});
	});
});
