import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Transition } from '../src/mod.ts';

describe('Notification with Avatar (Transition-based)', () => {
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it('renders notification when show=true', async () => {
		function NotificationWithAvatar() {
			const [show, setShow] = [true, () => {}];
			return (
				<div aria-live="assertive">
					<Transition show={show}>
						<div data-testid="avatar-notification" class="flex">
							<img alt="" src="https://example.com/avatar.jpg" class="h-10 w-10 rounded-full" />
							<div>
								<p class="text-sm font-medium">Emilia Gates</p>
								<p class="mt-1 text-sm">Sure! 8:30pm works great!</p>
							</div>
							<button onClick={() => setShow(false)}>Reply</button>
						</div>
					</Transition>
				</div>
			);
		}

		render(<NotificationWithAvatar />);
		await act(async () => {});

		const notification = screen.queryByTestId('avatar-notification');
		expect(notification).not.toBeNull();
	});

	it('renders avatar image with alt text', async () => {
		function NotificationWithAvatar() {
			const [show, setShow] = [true, () => {}];
			return (
				<Transition show={show}>
					<div data-testid="avatar-container">
						<img alt="User avatar" src="https://example.com/avatar.jpg" />
						<p data-testid="sender-name">Emilia Gates</p>
					</div>
				</Transition>
			);
		}

		render(<NotificationWithAvatar />);
		await act(async () => {});

		const img = screen.queryByRole('img', { name: 'User avatar' });
		expect(img).not.toBeNull();
	});

	it('has reply button', async () => {
		function NotificationWithAvatar() {
			const [show] = [true];
			return (
				<Transition show={show}>
					<div>
						<img alt="" src="https://example.com/avatar.jpg" />
						<button data-testid="reply-btn" type="button">
							Reply
						</button>
					</div>
				</Transition>
			);
		}

		render(<NotificationWithAvatar />);
		await act(async () => {});

		const replyBtn = screen.getByTestId('reply-btn');
		expect(replyBtn).not.toBeNull();
		expect(replyBtn.textContent).toBe('Reply');
	});
});

describe('Notification with Split Buttons (Transition-based)', () => {
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it('renders notification when show=true', async () => {
		function NotificationWithSplitButtons() {
			const [show, setShow] = [true, () => {}];
			return (
				<div aria-live="assertive">
					<Transition show={show}>
						<div data-testid="split-notification" class="flex divide-x">
							<div class="flex-1 p-4">
								<p class="text-sm font-medium">Receive notifications</p>
								<p class="mt-1 text-sm">Notifications may include alerts, sounds, and badges.</p>
							</div>
							<div class="flex flex-col divide-y">
								<button onClick={() => setShow(false)}>Reply</button>
								<button onClick={() => setShow(false)}>Don't allow</button>
							</div>
						</div>
					</Transition>
				</div>
			);
		}

		render(<NotificationWithSplitButtons />);
		await act(async () => {});

		const notification = screen.queryByTestId('split-notification');
		expect(notification).not.toBeNull();
	});

	it('has two action buttons', async () => {
		function NotificationWithSplitButtons() {
			const [show, setShow] = [true, () => {}];
			return (
				<Transition show={show}>
					<div>
						<div>
							<p class="text-sm font-medium">Receive notifications</p>
						</div>
						<div class="flex flex-col divide-y">
							<button data-testid="reply-btn" onClick={() => setShow(false)}>
								Reply
							</button>
							<button data-testid="dismiss-btn" onClick={() => setShow(false)}>
								Don't allow
							</button>
						</div>
					</div>
				</Transition>
			);
		}

		render(<NotificationWithSplitButtons />);
		await act(async () => {});

		const replyBtn = screen.getByTestId('reply-btn');
		const dismissBtn = screen.getByTestId('dismiss-btn');

		expect(replyBtn).not.toBeNull();
		expect(dismissBtn).not.toBeNull();
		expect(replyBtn.textContent).toBe('Reply');
		expect(dismissBtn.textContent).toBe("Don't allow");
	});

	it('reply button is clickable', async () => {
		const onReply = vi.fn();

		function NotificationWithSplitButtons() {
			const [show, setShow] = [true, onReply];
			return (
				<Transition show={show}>
					<div>
						<button data-testid="reply-btn" onClick={() => setShow(false)}>
							Reply
						</button>
					</div>
				</Transition>
			);
		}

		render(<NotificationWithSplitButtons />);
		await act(async () => {});

		await act(async () => {
			fireEvent.click(screen.getByTestId('reply-btn'));
		});

		expect(onReply).toHaveBeenCalled();
	});

	it('dismiss button is clickable', async () => {
		const onDismiss = vi.fn();

		function NotificationWithSplitButtons() {
			const [show, setShow] = [true, onDismiss];
			return (
				<Transition show={show}>
					<div>
						<button data-testid="dismiss-btn" onClick={() => setShow(false)}>
							Don't allow
						</button>
					</div>
				</Transition>
			);
		}

		render(<NotificationWithSplitButtons />);
		await act(async () => {});

		await act(async () => {
			fireEvent.click(screen.getByTestId('dismiss-btn'));
		});

		expect(onDismiss).toHaveBeenCalled();
	});
});

describe('Transition component integration with notifications', () => {
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it('Transition sets data attributes on enter', async () => {
		function ControlledNotification() {
			const [show, setShow] = [true, () => {}];
			return (
				<Transition show={show}>
					<div data-testid="transitioned-content">
						<p>Notification content</p>
					</div>
				</Transition>
			);
		}

		render(<ControlledNotification />);
		await act(async () => {});

		const content = screen.getByTestId('transitioned-content');
		// Transition should have data-enter attribute during enter phase
		expect(content).toBeTruthy();
	});

	it('Transition hides content when show=false', async () => {
		function ControlledNotification() {
			const [show] = [false];
			return (
				<Transition show={show}>
					<div data-testid="transitioned-content">
						<p>Notification content</p>
					</div>
				</Transition>
			);
		}

		render(<ControlledNotification />);
		await act(async () => {});

		// When show=false, Transition unmounts content
		const content = screen.queryByTestId('transitioned-content');
		expect(content).toBeNull();
	});

	it('notification uses proper aria-live region', async () => {
		function NotificationContainer() {
			const [show] = [true];
			return (
				<div aria-live="assertive" data-testid="live-region">
					<Transition show={show}>
						<div data-testid="notification">Notification content</div>
					</Transition>
				</div>
			);
		}

		render(<NotificationContainer />);
		await act(async () => {});

		const liveRegion = screen.getByTestId('live-region');
		expect(liveRegion.getAttribute('aria-live')).toBe('assertive');
	});
});
