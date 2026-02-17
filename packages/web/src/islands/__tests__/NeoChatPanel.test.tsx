// @ts-nocheck
/**
 * Tests for NeoChatPanel Component
 *
 * Tests the collapsible overlay panel for Neo chat.
 * Controlled by neoChatOpenSignal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';

// Define mock functions in vi.hoisted for proper hoisting
const { mockSendNeoMessage, mockToastError } = vi.hoisted(() => ({
	mockSendNeoMessage: vi.fn(),
	mockToastError: vi.fn(),
}));

// Mock the toast
vi.mock('../../lib/toast', () => ({
	toast: {
		error: mockToastError,
	},
}));

// Mock the signals module - factory must not reference external variables
vi.mock('../../lib/signals', () => {
	const { signal } = require('@preact/signals');
	const mockSignal = signal(true);
	return {
		neoChatOpenSignal: mockSignal,
	};
});

// Mock the room-store module - factory must not reference external variables
vi.mock('../../lib/room-store', () => {
	const { signal } = require('@preact/signals');
	return {
		roomStore: {
			neoMessages: signal([]),
			sendNeoMessage: mockSendNeoMessage,
		},
	};
});

// Mock the connection-manager (needed by room-store)
vi.mock('../../lib/connection-manager', () => ({
	connectionManager: {
		getHubIfConnected: vi.fn(() => ({
			request: vi.fn(),
		})),
		getHub: vi.fn(() =>
			Promise.resolve({
				request: vi.fn(),
				onEvent: vi.fn(() => vi.fn()),
				joinChannel: vi.fn(),
				leaveChannel: vi.fn(),
			})
		),
	},
}));

// Import AFTER mocking
import { NeoChatPanel } from '../NeoChatPanel';
import { neoChatOpenSignal } from '../../lib/signals';
import { roomStore } from '../../lib/room-store';

describe('NeoChatPanel', () => {
	beforeEach(() => {
		cleanup();
		neoChatOpenSignal.value = true;
		roomStore.neoMessages.value = [];
		mockSendNeoMessage.mockClear();
		mockToastError.mockClear();
	});

	afterEach(() => {
		cleanup();
		neoChatOpenSignal.value = false;
	});

	describe('Visibility', () => {
		it('should be visible when neoChatOpenSignal is true', () => {
			neoChatOpenSignal.value = true;
			const { container } = render(<NeoChatPanel />);

			// Panel should be visible (not hidden with translate-x-full)
			const panel = container.querySelector('.w-96');
			expect(panel).toBeTruthy();
			expect(panel?.className).toContain('translate-x-0');
			expect(panel?.className).not.toContain('translate-x-full');
		});

		it('should be hidden when neoChatOpenSignal is false', () => {
			neoChatOpenSignal.value = false;
			const { container } = render(<NeoChatPanel />);

			// Panel should have translate-x-full class (hidden)
			const panel = container.querySelector('.w-96');
			expect(panel).toBeTruthy();
			expect(panel?.className).toContain('translate-x-full');
		});
	});

	describe('Panel Structure', () => {
		it('should have correct width (w-96)', () => {
			const { container } = render(<NeoChatPanel />);

			const panel = container.querySelector('.w-96');
			expect(panel).toBeTruthy();
		});

		it('should slide from right (fixed right-0)', () => {
			const { container } = render(<NeoChatPanel />);

			const panel = container.querySelector('.w-96');
			expect(panel?.className).toContain('right-0');
		});

		it('should have transition classes for sliding animation', () => {
			const { container } = render(<NeoChatPanel />);

			const panel = container.querySelector('.w-96');
			expect(panel?.className).toContain('transition-transform');
			expect(panel?.className).toContain('duration-300');
			expect(panel?.className).toContain('ease-in-out');
		});

		it('should have correct z-index', () => {
			const { container } = render(<NeoChatPanel />);

			const panel = container.querySelector('.w-96');
			expect(panel?.className).toContain('z-50');
		});
	});

	describe('Header', () => {
		it('should show header with title "Neo"', () => {
			const { container } = render(<NeoChatPanel />);

			const title = container.querySelector('h3');
			expect(title?.textContent).toBe('Neo');
		});

		it('should show subtitle "AI Orchestrator"', () => {
			const { container } = render(<NeoChatPanel />);

			const subtitle = container.querySelector('.text-xs.text-gray-400');
			expect(subtitle?.textContent).toBe('AI Orchestrator');
		});
	});

	describe('Close Button', () => {
		it('should have a close button', () => {
			const { container } = render(<NeoChatPanel />);

			const closeButton = container.querySelector('button[title="Close panel"]');
			expect(closeButton).toBeTruthy();
		});

		it('should set neoChatOpenSignal to false when close button is clicked', () => {
			neoChatOpenSignal.value = true;
			const { container } = render(<NeoChatPanel />);

			const closeButton = container.querySelector('button[title="Close panel"]');
			fireEvent.click(closeButton);

			expect(neoChatOpenSignal.value).toBe(false);
		});

		it('should have X icon in close button', () => {
			const { container } = render(<NeoChatPanel />);

			const closeButton = container.querySelector('button[title="Close panel"]');
			const svg = closeButton?.querySelector('svg');
			expect(svg).toBeTruthy();
		});
	});

	describe('Backdrop', () => {
		it('should have backdrop on mobile when open', () => {
			neoChatOpenSignal.value = true;
			const { container } = render(<NeoChatPanel />);

			// Backdrop should be present when panel is open
			const backdrop = container.querySelector('.fixed.inset-0.bg-black\\/50');
			expect(backdrop).toBeTruthy();
		});

		it('should not have backdrop when panel is closed', () => {
			neoChatOpenSignal.value = false;
			const { container } = render(<NeoChatPanel />);

			// Backdrop should not be present when panel is closed
			const backdrop = container.querySelector('.fixed.inset-0.bg-black\\/50');
			expect(backdrop).toBeNull();
		});

		it('should close panel when backdrop is clicked', () => {
			neoChatOpenSignal.value = true;
			const { container } = render(<NeoChatPanel />);

			const backdrop = container.querySelector('.fixed.inset-0.bg-black\\/50');
			fireEvent.click(backdrop);

			expect(neoChatOpenSignal.value).toBe(false);
		});

		it('backdrop should have lg:hidden class (only visible on mobile)', () => {
			neoChatOpenSignal.value = true;
			const { container } = render(<NeoChatPanel />);

			const backdrop = container.querySelector('.fixed.inset-0.bg-black\\/50');
			expect(backdrop?.className).toContain('lg:hidden');
		});

		it('backdrop should have z-40', () => {
			neoChatOpenSignal.value = true;
			const { container } = render(<NeoChatPanel />);

			const backdrop = container.querySelector('.fixed.inset-0.bg-black\\/50');
			expect(backdrop?.className).toContain('z-40');
		});
	});

	describe('Content', () => {
		it('should show empty state when no messages', () => {
			roomStore.neoMessages.value = [];
			const { container } = render(<NeoChatPanel />);

			expect(container.textContent).toContain('Start a conversation with Neo');
		});

		it('should show messages when available', () => {
			roomStore.neoMessages.value = [
				{
					id: 'msg-1',
					contextId: 'ctx-1',
					role: 'user',
					content: 'Hello Neo',
					timestamp: Date.now(),
					tokenCount: 10,
				},
				{
					id: 'msg-2',
					contextId: 'ctx-1',
					role: 'assistant',
					content: 'Hello! How can I help?',
					timestamp: Date.now(),
					tokenCount: 20,
				},
			];

			const { container } = render(<NeoChatPanel />);

			expect(container.textContent).toContain('Hello Neo');
			expect(container.textContent).toContain('Hello! How can I help?');
		});

		it('should have textarea for input', () => {
			const { container } = render(<NeoChatPanel />);

			const textarea = container.querySelector('textarea');
			expect(textarea).toBeTruthy();
			expect(textarea?.placeholder).toBe('Ask Neo...');
		});

		it('should have send button', () => {
			const { container } = render(<NeoChatPanel />);

			// The Send button should be present
			expect(container.textContent).toContain('Send');
		});
	});

	describe('Signal Reactivity', () => {
		it('should read neoChatOpenSignal value correctly', () => {
			// Test that the signal value is read correctly
			neoChatOpenSignal.value = true;
			expect(neoChatOpenSignal.value).toBe(true);

			neoChatOpenSignal.value = false;
			expect(neoChatOpenSignal.value).toBe(false);
		});

		it('should use signal value in component rendering', () => {
			// When signal is true, panel should be visible
			neoChatOpenSignal.value = true;
			const { container: containerOpen } = render(<NeoChatPanel />);
			const panelOpen = containerOpen.querySelector('.w-96');
			expect(panelOpen?.className).toContain('translate-x-0');

			cleanup();

			// When signal is false, panel should be hidden
			neoChatOpenSignal.value = false;
			const { container: containerClosed } = render(<NeoChatPanel />);
			const panelClosed = containerClosed.querySelector('.w-96');
			expect(panelClosed?.className).toContain('translate-x-full');
		});
	});

	describe('Message Styling', () => {
		it('should style user messages differently from assistant messages', () => {
			roomStore.neoMessages.value = [
				{
					id: 'msg-1',
					contextId: 'ctx-1',
					role: 'user',
					content: 'User message',
					timestamp: Date.now(),
					tokenCount: 10,
				},
				{
					id: 'msg-2',
					contextId: 'ctx-1',
					role: 'assistant',
					content: 'Assistant message',
					timestamp: Date.now(),
					tokenCount: 20,
				},
			];

			const { container } = render(<NeoChatPanel />);

			// User message should have blue background
			const userMessage = container.querySelector('.bg-blue-600');
			expect(userMessage).toBeTruthy();
			expect(userMessage?.textContent).toContain('User message');

			// Assistant message should have dark background
			const assistantMessage = container.querySelector('.bg-dark-800');
			expect(assistantMessage).toBeTruthy();
			expect(assistantMessage?.textContent).toContain('Assistant message');
		});

		it('should show timestamp for messages', () => {
			const timestamp = Date.now();
			roomStore.neoMessages.value = [
				{
					id: 'msg-1',
					contextId: 'ctx-1',
					role: 'user',
					content: 'Test message',
					timestamp: timestamp,
					tokenCount: 10,
				},
			];

			const { container } = render(<NeoChatPanel />);

			// Should contain a formatted time (the exact format depends on locale)
			const timeElement = container.querySelector('.text-xs.opacity-50');
			expect(timeElement).toBeTruthy();
		});

		it('should style system messages with dark-700 background', () => {
			roomStore.neoMessages.value = [
				{
					id: 'msg-1',
					contextId: 'ctx-1',
					role: 'system',
					content: 'System notification',
					timestamp: Date.now(),
					tokenCount: 5,
				},
			];

			const { container } = render(<NeoChatPanel />);

			// System message should have bg-dark-700 and smaller text
			const systemMessage = container.querySelector('.bg-dark-700.text-gray-300.text-xs');
			expect(systemMessage).toBeTruthy();
			expect(systemMessage?.textContent).toContain('System notification');
		});
	});

	describe('Message Input', () => {
		it('should allow typing in the textarea', () => {
			const { container } = render(<NeoChatPanel />);

			const textarea = container.querySelector('textarea');
			fireEvent.input(textarea, { target: { value: 'Hello Neo!' } });

			expect(textarea?.value).toBe('Hello Neo!');
		});

		it('should send message when Send button is clicked', async () => {
			mockSendNeoMessage.mockResolvedValue(undefined);

			const { container } = render(<NeoChatPanel />);

			const textarea = container.querySelector('textarea');
			fireEvent.input(textarea, { target: { value: 'Hello Neo!' } });

			// Find the send button (it's a Button component with text "Send")
			const sendButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent?.trim() === 'Send'
			);

			fireEvent.click(sendButton);

			await waitFor(() => {
				expect(mockSendNeoMessage).toHaveBeenCalledWith('Hello Neo!');
			});
		});

		it('should clear textarea after sending message', async () => {
			mockSendNeoMessage.mockResolvedValue(undefined);

			const { container } = render(<NeoChatPanel />);

			const textarea = container.querySelector('textarea');
			fireEvent.input(textarea, { target: { value: 'Hello Neo!' } });

			const sendButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent?.trim() === 'Send'
			);

			fireEvent.click(sendButton);

			await waitFor(() => {
				expect(textarea?.value).toBe('');
			});
		});

		it('should send message on Enter key (without Shift)', async () => {
			mockSendNeoMessage.mockResolvedValue(undefined);

			const { container } = render(<NeoChatPanel />);

			const textarea = container.querySelector('textarea');
			fireEvent.input(textarea, { target: { value: 'Test message' } });

			// Simulate Enter key press
			fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

			await waitFor(() => {
				expect(mockSendNeoMessage).toHaveBeenCalledWith('Test message');
			});
		});

		it('should NOT send message on Shift+Enter', async () => {
			const { container } = render(<NeoChatPanel />);

			const textarea = container.querySelector('textarea');
			fireEvent.input(textarea, { target: { value: 'Test message' } });

			// Simulate Shift+Enter key press (should not send)
			fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

			// Wait a bit to ensure no send happens
			await new Promise((resolve) => setTimeout(resolve, 100));

			expect(mockSendNeoMessage).not.toHaveBeenCalled();
		});

		it('should not send empty message', async () => {
			const { container } = render(<NeoChatPanel />);

			const textarea = container.querySelector('textarea');
			fireEvent.input(textarea, { target: { value: '' } });

			const sendButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent?.trim() === 'Send'
			);

			// Button should be disabled when input is empty
			expect(sendButton?.hasAttribute('disabled')).toBe(true);
		});

		it('should not send whitespace-only message', async () => {
			const { container } = render(<NeoChatPanel />);

			const textarea = container.querySelector('textarea');
			fireEvent.input(textarea, { target: { value: '   ' } });

			const sendButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent?.trim() === 'Send'
			);

			// Button should be disabled when input is whitespace only
			expect(sendButton?.hasAttribute('disabled')).toBe(true);
		});

		it('should trim whitespace from message before sending', async () => {
			mockSendNeoMessage.mockResolvedValue(undefined);

			const { container } = render(<NeoChatPanel />);

			const textarea = container.querySelector('textarea');
			fireEvent.input(textarea, { target: { value: '  Hello Neo!  ' } });

			const sendButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent?.trim() === 'Send'
			);

			fireEvent.click(sendButton);

			await waitFor(() => {
				expect(mockSendNeoMessage).toHaveBeenCalledWith('Hello Neo!');
			});
		});
	});

	describe('Loading State', () => {
		it('should show loading spinner when sending message', async () => {
			// Create a promise that we can resolve manually
			let resolveSend;
			mockSendNeoMessage.mockImplementation(
				() => new Promise((resolve) => (resolveSend = resolve))
			);

			const { container } = render(<NeoChatPanel />);

			const textarea = container.querySelector('textarea');
			fireEvent.input(textarea, { target: { value: 'Hello Neo!' } });

			const sendButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent?.trim() === 'Send'
			);

			fireEvent.click(sendButton);

			// Should show spinner while sending
			await waitFor(() => {
				const spinner = container.querySelector('.animate-spin');
				expect(spinner).toBeTruthy();
			});

			// Resolve the send promise to clean up
			resolveSend();
		});

		it('should disable textarea while sending', async () => {
			let resolveSend;
			mockSendNeoMessage.mockImplementation(
				() => new Promise((resolve) => (resolveSend = resolve))
			);

			const { container } = render(<NeoChatPanel />);

			const textarea = container.querySelector('textarea');
			fireEvent.input(textarea, { target: { value: 'Hello Neo!' } });

			const sendButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent?.trim() === 'Send'
			);

			fireEvent.click(sendButton);

			// Textarea should be disabled while sending
			await waitFor(() => {
				expect(textarea?.hasAttribute('disabled')).toBe(true);
			});

			resolveSend();
		});

		it('should disable send button while sending', async () => {
			let resolveSend;
			mockSendNeoMessage.mockImplementation(
				() => new Promise((resolve) => (resolveSend = resolve))
			);

			const { container } = render(<NeoChatPanel />);

			const textarea = container.querySelector('textarea');
			fireEvent.input(textarea, { target: { value: 'Hello Neo!' } });

			const sendButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent?.trim() === 'Send'
			);

			fireEvent.click(sendButton);

			// Button should be disabled while sending
			await waitFor(() => {
				expect(sendButton?.hasAttribute('disabled')).toBe(true);
			});

			resolveSend();
		});

		it('should re-enable textarea after sending completes', async () => {
			mockSendNeoMessage.mockResolvedValue(undefined);

			const { container } = render(<NeoChatPanel />);

			const textarea = container.querySelector('textarea');
			fireEvent.input(textarea, { target: { value: 'Hello Neo!' } });

			const sendButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent?.trim() === 'Send'
			);

			fireEvent.click(sendButton);

			// After sending completes, textarea should be re-enabled
			await waitFor(() => {
				expect(textarea?.hasAttribute('disabled')).toBe(false);
			});
		});
	});

	describe('Error Handling', () => {
		it('should show error toast when send fails', async () => {
			mockSendNeoMessage.mockRejectedValue(new Error('Network error'));

			const { container } = render(<NeoChatPanel />);

			const textarea = container.querySelector('textarea');
			fireEvent.input(textarea, { target: { value: 'Hello Neo!' } });

			const sendButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent?.trim() === 'Send'
			);

			fireEvent.click(sendButton);

			await waitFor(() => {
				expect(mockToastError).toHaveBeenCalledWith('Network error');
			});
		});

		it('should show generic error message when error is not an Error instance', async () => {
			mockSendNeoMessage.mockRejectedValue('Unknown failure');

			const { container } = render(<NeoChatPanel />);

			const textarea = container.querySelector('textarea');
			fireEvent.input(textarea, { target: { value: 'Hello Neo!' } });

			const sendButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent?.trim() === 'Send'
			);

			fireEvent.click(sendButton);

			await waitFor(() => {
				expect(mockToastError).toHaveBeenCalledWith('Failed to send');
			});
		});

		it('should re-enable textarea after send error', async () => {
			mockSendNeoMessage.mockRejectedValue(new Error('Network error'));

			const { container } = render(<NeoChatPanel />);

			const textarea = container.querySelector('textarea');
			fireEvent.input(textarea, { target: { value: 'Hello Neo!' } });

			const sendButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.textContent?.trim() === 'Send'
			);

			fireEvent.click(sendButton);

			// After error, textarea should be re-enabled
			await waitFor(() => {
				expect(textarea?.hasAttribute('disabled')).toBe(false);
			});
		});
	});
});
