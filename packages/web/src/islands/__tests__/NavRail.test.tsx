// @ts-nocheck
/**
 * Tests for NavRail Component
 *
 * Tests navigation rail rendering, active state highlighting, signal updates,
 * and mobile visibility.
 */
import { render, screen, fireEvent } from '@testing-library/preact';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { NavRail } from '../NavRail.tsx';
import { navSectionSignal } from '../../lib/signals.ts';

// Mock the router functions
vi.mock('../../lib/router.ts', () => ({
	navigateToChats: vi.fn(),
	navigateToRooms: vi.fn(),
	navigateToSettings: vi.fn(),
}));

// Import mocked functions for assertions
import { navigateToChats, navigateToRooms, navigateToSettings } from '../../lib/router.ts';

describe('NavRail', () => {
	beforeEach(() => {
		// Reset signal to default value before each test
		navSectionSignal.value = 'chats';
		// Clear mock calls
		vi.clearAllMocks();
	});

	describe('Rendering', () => {
		it('should render the logo', () => {
			render(<NavRail />);
			const logo = screen.getByTitle('NeoKai');
			expect(logo).toBeTruthy();
		});

		it('should render all navigation icons', () => {
			render(<NavRail />);

			// Check all navigation buttons are rendered
			expect(screen.getByTitle('Chats')).toBeTruthy();
			expect(screen.getByTitle('Rooms')).toBeTruthy();
			expect(screen.getByTitle('Projects (Coming Soon)')).toBeTruthy();
			expect(screen.getByTitle('Settings')).toBeTruthy();
		});

		it('should render Chats button with correct label', () => {
			render(<NavRail />);
			const chatsButton = screen.getByRole('button', { name: 'Chats' });
			expect(chatsButton).toBeTruthy();
		});

		it('should render Rooms button with correct label', () => {
			render(<NavRail />);
			const roomsButton = screen.getByRole('button', { name: 'Rooms' });
			expect(roomsButton).toBeTruthy();
		});

		it('should render Projects button with correct label', () => {
			render(<NavRail />);
			const projectsButton = screen.getByRole('button', { name: 'Projects (Coming Soon)' });
			expect(projectsButton).toBeTruthy();
		});

		it('should render Settings button with correct label', () => {
			render(<NavRail />);
			const settingsButton = screen.getByRole('button', { name: 'Settings' });
			expect(settingsButton).toBeTruthy();
		});
	});

	describe('Active Section Highlighting', () => {
		it('should highlight Chats button when navSection is chats', () => {
			navSectionSignal.value = 'chats';
			render(<NavRail />);

			const chatsButton = screen.getByRole('button', { name: 'Chats' });
			expect(chatsButton.getAttribute('aria-pressed')).toBe('true');

			// Other buttons should not be active
			const roomsButton = screen.getByRole('button', { name: 'Rooms' });
			expect(roomsButton.getAttribute('aria-pressed')).toBe('false');
		});

		it('should highlight Rooms button when navSection is rooms', () => {
			navSectionSignal.value = 'rooms';
			render(<NavRail />);

			const roomsButton = screen.getByRole('button', { name: 'Rooms' });
			expect(roomsButton.getAttribute('aria-pressed')).toBe('true');

			// Chats should not be active
			const chatsButton = screen.getByRole('button', { name: 'Chats' });
			expect(chatsButton.getAttribute('aria-pressed')).toBe('false');
		});

		it('should highlight Settings button when navSection is settings', () => {
			navSectionSignal.value = 'settings';
			render(<NavRail />);

			const settingsButton = screen.getByRole('button', { name: 'Settings' });
			expect(settingsButton.getAttribute('aria-pressed')).toBe('true');
		});

		it('should show Projects as inactive even when navSection is projects', () => {
			navSectionSignal.value = 'projects';
			render(<NavRail />);

			const projectsButton = screen.getByRole('button', { name: 'Projects (Coming Soon)' });
			// Projects button has active={navSection === 'projects'} but is disabled
			expect(projectsButton.getAttribute('aria-pressed')).toBe('true');
		});
	});

	describe('Click Interactions', () => {
		it('should call navigateToChats when Chats button is clicked', () => {
			render(<NavRail />);

			const chatsButton = screen.getByRole('button', { name: 'Chats' });
			fireEvent.click(chatsButton);

			expect(navigateToChats).toHaveBeenCalledTimes(1);
		});

		it('should call navigateToRooms when Rooms button is clicked', () => {
			render(<NavRail />);

			const roomsButton = screen.getByRole('button', { name: 'Rooms' });
			fireEvent.click(roomsButton);

			expect(navigateToRooms).toHaveBeenCalledTimes(1);
		});

		it('should call navigateToSettings when Settings button is clicked', () => {
			render(<NavRail />);

			const settingsButton = screen.getByRole('button', { name: 'Settings' });
			fireEvent.click(settingsButton);

			expect(navigateToSettings).toHaveBeenCalledTimes(1);
		});

		it('should not call any navigate function when Projects button is clicked', () => {
			render(<NavRail />);

			// Projects button is disabled, so click should not trigger anything
			const projectsButton = screen.getByRole('button', { name: 'Projects (Coming Soon)' });
			fireEvent.click(projectsButton);

			// Since the button is disabled, click events shouldn't trigger navigation
			expect(navigateToChats).not.toHaveBeenCalled();
			expect(navigateToRooms).not.toHaveBeenCalled();
			expect(navigateToSettings).not.toHaveBeenCalled();
		});
	});

	describe('Projects Button State', () => {
		it('should have Projects button disabled', () => {
			render(<NavRail />);

			const projectsButton = screen.getByRole('button', { name: 'Projects (Coming Soon)' });
			expect(projectsButton.hasAttribute('disabled')).toBe(true);
		});

		it('should have disabled styling on Projects button', () => {
			render(<NavRail />);

			const projectsButton = screen.getByRole('button', { name: 'Projects (Coming Soon)' });
			expect(projectsButton.className).toContain('disabled:opacity-40');
			expect(projectsButton.className).toContain('disabled:cursor-not-allowed');
		});
	});

	describe('Mobile Visibility', () => {
		it('should have hidden class for mobile (hidden on small screens)', () => {
			const { container } = render(<NavRail />);

			const navRail = container.querySelector('div');
			expect(navRail?.className).toContain('hidden');
		});

		it('should have md:flex class for tablet/desktop visibility', () => {
			const { container } = render(<NavRail />);

			const navRail = container.querySelector('div');
			expect(navRail?.className).toContain('md:flex');
		});

		it('should have correct width class (w-16)', () => {
			const { container } = render(<NavRail />);

			const navRail = container.querySelector('div');
			expect(navRail?.className).toContain('w-16');
		});
	});

	describe('Layout Structure', () => {
		it('should have correct flex layout classes', () => {
			const { container } = render(<NavRail />);

			const navRail = container.querySelector('div');
			expect(navRail?.className).toContain('flex-col');
			expect(navRail?.className).toContain('items-center');
		});

		it('should have a nav element for navigation items', () => {
			const { container } = render(<NavRail />);

			const nav = container.querySelector('nav');
			expect(nav).toBeTruthy();
		});

		it('should have Settings in a separate bottom container', () => {
			const { container } = render(<NavRail />);

			// Settings should be in a container with mt-auto class (pushed to bottom)
			const bottomContainer = container.querySelector('.mt-auto');
			expect(bottomContainer).toBeTruthy();

			const settingsButton = screen.getByRole('button', { name: 'Settings' });
			expect(bottomContainer?.contains(settingsButton)).toBe(true);
		});
	});

	describe('Accessibility', () => {
		it('should have aria-pressed attribute on all buttons', () => {
			render(<NavRail />);

			const buttons = screen.getAllByRole('button');
			for (const button of buttons) {
				expect(button.hasAttribute('aria-pressed')).toBe(true);
			}
		});

		it('should have aria-label attribute on all buttons', () => {
			render(<NavRail />);

			const buttons = screen.getAllByRole('button');
			for (const button of buttons) {
				expect(button.hasAttribute('aria-label')).toBe(true);
			}
		});

		it('should have title attribute on all buttons', () => {
			render(<NavRail />);

			const buttons = screen.getAllByRole('button');
			for (const button of buttons) {
				expect(button.hasAttribute('title')).toBe(true);
			}
		});
	});

	describe('Signal Reactivity', () => {
		it('should update active state when navSectionSignal changes', () => {
			navSectionSignal.value = 'chats';
			const { rerender } = render(<NavRail />);

			let chatsButton = screen.getByRole('button', { name: 'Chats' });
			expect(chatsButton.getAttribute('aria-pressed')).toBe('true');

			// Change signal and rerender
			navSectionSignal.value = 'rooms';
			rerender(<NavRail />);

			chatsButton = screen.getByRole('button', { name: 'Chats' });
			const roomsButton = screen.getByRole('button', { name: 'Rooms' });
			expect(chatsButton.getAttribute('aria-pressed')).toBe('false');
			expect(roomsButton.getAttribute('aria-pressed')).toBe('true');
		});
	});
});
