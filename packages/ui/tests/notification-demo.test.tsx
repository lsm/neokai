import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	NotificationWithAvatar,
	NotificationWithSplitButtons,
} from '../demo/sections/NotificationDemo.tsx';

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe('NotificationWithAvatar', () => {
	it('renders the notification content when component mounts', async () => {
		render(<NotificationWithAvatar />);
		await act(async () => {});

		// Check that sender name is visible
		expect(screen.getByText('Emilia Gates')).toBeTruthy();

		// Check that message is visible
		expect(screen.getByText('Sure! 8:30pm works great!')).toBeTruthy();
	});

	it('renders avatar image from correct URL', async () => {
		render(<NotificationWithAvatar />);
		await act(async () => {});

		const img = screen.getByRole('img');
		expect(img).toBeTruthy();
		expect(img.getAttribute('src')).toContain('images.unsplash.com');
	});

	it('has a Reply button', async () => {
		render(<NotificationWithAvatar />);
		await act(async () => {});

		const replyBtn = screen.getByRole('button', { name: 'Reply' });
		expect(replyBtn).toBeTruthy();
	});

	it('hides notification when Reply button is clicked', async () => {
		render(<NotificationWithAvatar />);
		await act(async () => {});

		// Verify notification is visible initially
		expect(screen.getByText('Emilia Gates')).toBeTruthy();

		// Click Reply button
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
		});

		// Notification should be hidden after clicking Reply
		expect(screen.queryByText('Emilia Gates')).toBeNull();
	});

	it('has aria-live="assertive" on overlay container', async () => {
		render(<NotificationWithAvatar />);
		await act(async () => {});

		const liveRegion = document.querySelector('[aria-live="assertive"]');
		expect(liveRegion).toBeTruthy();
	});
});

describe('NotificationWithSplitButtons', () => {
	it('renders the notification content when component mounts', async () => {
		render(<NotificationWithSplitButtons />);
		await act(async () => {});

		// Check that title is visible
		expect(screen.getByText('Receive notifications')).toBeTruthy();

		// Check that description is visible
		expect(screen.getByText('Notifications may include alerts, sounds, and badges.')).toBeTruthy();
	});

	it('has a Reply button', async () => {
		render(<NotificationWithSplitButtons />);
		await act(async () => {});

		const replyBtn = screen.getByRole('button', { name: 'Reply' });
		expect(replyBtn).toBeTruthy();
	});

	it('has a "Don\'t allow" button', async () => {
		render(<NotificationWithSplitButtons />);
		await act(async () => {});

		const dismissBtn = screen.getByRole('button', { name: "Don't allow" });
		expect(dismissBtn).toBeTruthy();
	});

	it('hides notification when Reply button is clicked', async () => {
		render(<NotificationWithSplitButtons />);
		await act(async () => {});

		// Verify notification is visible initially
		expect(screen.getByText('Receive notifications')).toBeTruthy();

		// Click Reply button
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
		});

		// Notification should be hidden after clicking Reply
		expect(screen.queryByText('Receive notifications')).toBeNull();
	});

	it('hides notification when "Don\'t allow" button is clicked', async () => {
		render(<NotificationWithSplitButtons />);
		await act(async () => {});

		// Verify notification is visible initially
		expect(screen.getByText('Receive notifications')).toBeTruthy();

		// Click "Don't allow" button
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: "Don't allow" }));
		});

		// Notification should be hidden after clicking "Don't allow"
		expect(screen.queryByText('Receive notifications')).toBeNull();
	});

	it('has aria-live="assertive" on overlay container', async () => {
		render(<NotificationWithSplitButtons />);
		await act(async () => {});

		const liveRegion = document.querySelector('[aria-live="assertive"]');
		expect(liveRegion).toBeTruthy();
	});
});

describe('Notification dismiss behavior', () => {
	it('can re-show avatar notification after dismissing', async () => {
		render(<NotificationWithSplitButtons />);
		await act(async () => {});

		// Initially visible
		expect(screen.getByText('Receive notifications')).toBeTruthy();

		// Dismiss
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
		});

		// Hidden
		expect(screen.queryByText('Receive notifications')).toBeNull();

		// Click "Show split-button notification" to re-show
		await act(async () => {
			fireEvent.click(screen.getByRole('button', { name: 'Show split-button notification' }));
		});

		// Should be visible again
		expect(screen.getByText('Receive notifications')).toBeTruthy();
	});
});
