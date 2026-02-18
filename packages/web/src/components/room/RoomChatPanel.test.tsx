// @ts-nocheck
/**
 * Tests for RoomChatPanel Component
 *
 * Tests the chat interface for communicating with the room agent.
 * Covers message rendering, input handling, send functionality,
 * auto-scroll behavior, attachments, and empty state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor, screen } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { RoomChatPanel, type RoomChatMessage } from './RoomChatPanel';
import type { MessageImage } from '@neokai/shared';

// Mock the useChatBase hook
vi.mock('../../hooks/useChatBase', () => ({
	useChatBase: vi.fn(() => ({
		input: '',
		setInput: vi.fn(),
		sending: false,
		sendMessage: vi.fn(),
		handleKeyDown: vi.fn(),
		attachments: [],
		fileInputRef: { current: null },
		handleFileSelect: vi.fn(),
		handleRemoveAttachment: vi.fn(),
		openFilePicker: vi.fn(),
		messagesContainerRef: { current: null },
		messagesEndRef: { current: null },
		showScrollButton: false,
		scrollToBottom: vi.fn(),
		error: null,
		clearError: vi.fn(),
	})),
}));

// Import after mocking
import { useChatBase } from '../../hooks/useChatBase';

/**
 * Helper to create mock messages signal
 */
function createMockMessagesSignal(messages: RoomChatMessage[] = []) {
	return signal(messages);
}

/**
 * Helper to create a mock message
 */
function createMockMessage(overrides: Partial<RoomChatMessage> = {}): RoomChatMessage {
	return {
		id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		role: 'user',
		content: 'Test message',
		timestamp: Date.now(),
		...overrides,
	};
}

describe('RoomChatPanel', () => {
	const mockOnSendMessage = vi.fn();
	const mockOnClose = vi.fn();
	let mockUseChatBaseReturn: ReturnType<typeof useChatBase>;

	beforeEach(() => {
		cleanup();
		mockOnSendMessage.mockClear();
		mockOnClose.mockClear();
		vi.clearAllMocks();

		// Setup default mock return
		mockUseChatBaseReturn = {
			input: '',
			setInput: vi.fn(),
			sending: false,
			sendMessage: vi.fn(),
			handleKeyDown: vi.fn(),
			attachments: [],
			fileInputRef: { current: null },
			handleFileSelect: vi.fn(),
			handleRemoveAttachment: vi.fn(),
			openFilePicker: vi.fn(),
			messagesContainerRef: { current: null },
			messagesEndRef: { current: null },
			showScrollButton: false,
			scrollToBottom: vi.fn(),
			error: null,
			clearError: vi.fn(),
		};
		vi.mocked(useChatBase).mockReturnValue(mockUseChatBaseReturn);
	});

	afterEach(() => {
		cleanup();
	});

	describe('Basic Rendering', () => {
		it('should render with required props', () => {
			const messages = createMockMessagesSignal();
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			expect(container).toBeTruthy();
		});

		it('should render default title "Room Agent" when no title provided', () => {
			const messages = createMockMessagesSignal();
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			expect(container.textContent).toContain('Room Agent');
		});

		it('should render custom title when provided', () => {
			const messages = createMockMessagesSignal();
			const { container } = render(
				<RoomChatPanel
					roomId="room-123"
					messages={messages}
					onSendMessage={mockOnSendMessage}
					title="Project Alpha"
				/>
			);

			expect(container.textContent).toContain('Project Alpha');
		});

		it('should apply custom className', () => {
			const messages = createMockMessagesSignal();
			const { container } = render(
				<RoomChatPanel
					roomId="room-123"
					messages={messages}
					onSendMessage={mockOnSendMessage}
					className="custom-class"
				/>
			);

			const panel = container.querySelector('.custom-class');
			expect(panel).toBeTruthy();
		});

		it('should call useChatBase with correct options', () => {
			const messages = createMockMessagesSignal();
			render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			expect(useChatBase).toHaveBeenCalledWith(
				expect.objectContaining({
					chatId: 'room-123',
					sendMessage: mockOnSendMessage,
					messages: messages,
				})
			);
		});
	});

	describe('Header', () => {
		it('should display message count in header', () => {
			const messages = createMockMessagesSignal([
				createMockMessage({ id: '1', content: 'First' }),
				createMockMessage({ id: '2', content: 'Second' }),
				createMockMessage({ id: '3', content: 'Third' }),
			]);
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			expect(container.textContent).toContain('3 messages');
		});

		it('should display singular "message" for single message', () => {
			const messages = createMockMessagesSignal([
				createMockMessage({ id: '1', content: 'Only one' }),
			]);
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			expect(container.textContent).toContain('1 message');
		});

		it('should show sending indicator when sending', () => {
			const messages = createMockMessagesSignal();
			mockUseChatBaseReturn.sending = true;
			vi.mocked(useChatBase).mockReturnValue(mockUseChatBaseReturn);

			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			expect(container.textContent).toContain('Sending...');
		});

		it('should not show sending indicator when not sending', () => {
			const messages = createMockMessagesSignal();
			mockUseChatBaseReturn.sending = false;
			vi.mocked(useChatBase).mockReturnValue(mockUseChatBaseReturn);

			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			expect(container.textContent).not.toContain('Sending...');
		});

		it('should render close button when onClose provided', () => {
			const messages = createMockMessagesSignal();
			const { container } = render(
				<RoomChatPanel
					roomId="room-123"
					messages={messages}
					onSendMessage={mockOnSendMessage}
					onClose={mockOnClose}
				/>
			);

			const closeButton = container.querySelector('button[title="Close chat"]');
			expect(closeButton).toBeTruthy();
		});

		it('should not render close button when onClose not provided', () => {
			const messages = createMockMessagesSignal();
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			const closeButton = container.querySelector('button[title="Close chat"]');
			expect(closeButton).toBeNull();
		});

		it('should call onClose when close button clicked', () => {
			const messages = createMockMessagesSignal();
			const { container } = render(
				<RoomChatPanel
					roomId="room-123"
					messages={messages}
					onSendMessage={mockOnSendMessage}
					onClose={mockOnClose}
				/>
			);

			const closeButton = container.querySelector('button[title="Close chat"]')!;
			fireEvent.click(closeButton);

			expect(mockOnClose).toHaveBeenCalledTimes(1);
		});
	});

	describe('Message Rendering', () => {
		it('should render user messages with blue background', () => {
			const messages = createMockMessagesSignal([
				createMockMessage({ role: 'user', content: 'Hello' }),
			]);
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			const messageBubble = container.querySelector('.bg-blue-600');
			expect(messageBubble).toBeTruthy();
			expect(messageBubble?.textContent).toContain('Hello');
		});

		it('should render assistant messages with dark background', () => {
			const messages = createMockMessagesSignal([
				createMockMessage({ role: 'assistant', content: 'Hi there!' }),
			]);
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			const messageBubble = container.querySelector('.bg-dark-800');
			expect(messageBubble).toBeTruthy();
			expect(messageBubble?.textContent).toContain('Hi there!');
		});

		it('should render system messages with smaller text', () => {
			const messages = createMockMessagesSignal([
				createMockMessage({ role: 'system', content: 'System notice' }),
			]);
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			// System messages have the text-gray-400 class and text-xs
			const messageBubble = container.querySelector('.bg-dark-700.text-gray-400');
			expect(messageBubble).toBeTruthy();
			expect(messageBubble?.textContent).toContain('System notice');
		});

		it('should render external messages with purple styling', () => {
			const messages = createMockMessagesSignal([
				createMockMessage({
					role: 'external_message',
					content: 'External event',
					senderName: 'GitHub',
				}),
			]);
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			const messageBubble = container.querySelector('.bg-purple-900\\/50');
			expect(messageBubble).toBeTruthy();
			expect(messageBubble?.textContent).toContain('External event');
		});

		it('should display sender name for assistant messages', () => {
			const messages = createMockMessagesSignal([
				createMockMessage({
					role: 'assistant',
					content: 'Response',
					senderName: 'Agent Smith',
				}),
			]);
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			expect(container.textContent).toContain('Agent Smith');
		});

		it('should display "External" label for external messages without sender name', () => {
			const messages = createMockMessagesSignal([
				createMockMessage({
					role: 'external_message',
					content: 'External event',
				}),
			]);
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			expect(container.textContent).toContain('External');
		});

		it('should display timestamp on all messages', () => {
			const fixedTime = 1708300800000; // Fixed timestamp for consistent testing
			const messages = createMockMessagesSignal([
				createMockMessage({
					role: 'user',
					content: 'Test',
					timestamp: fixedTime,
				}),
			]);
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			// The timestamp should be rendered
			const timeElement = container.querySelector('.text-xs.mt-1');
			expect(timeElement).toBeTruthy();
		});

		it('should render multiple messages', () => {
			const messages = createMockMessagesSignal([
				createMockMessage({ id: '1', role: 'user', content: 'First' }),
				createMockMessage({ id: '2', role: 'assistant', content: 'Second' }),
				createMockMessage({ id: '3', role: 'user', content: 'Third' }),
			]);
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			expect(container.textContent).toContain('First');
			expect(container.textContent).toContain('Second');
			expect(container.textContent).toContain('Third');
		});

		it('should preserve whitespace in message content', () => {
			const messages = createMockMessagesSignal([
				createMockMessage({
					role: 'assistant',
					content: 'Line 1\nLine 2\nLine 3',
				}),
			]);
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			const messageContent = container.querySelector('.whitespace-pre-wrap');
			expect(messageContent).toBeTruthy();
			expect(messageContent?.textContent).toContain('Line 1');
		});
	});

	describe('Empty State', () => {
		it('should show empty state when no messages', () => {
			const messages = createMockMessagesSignal([]);
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			expect(container.textContent).toContain('No messages yet');
			expect(container.textContent).toContain('Start a conversation with the room agent.');
		});

		it('should not show empty state when there are messages', () => {
			const messages = createMockMessagesSignal([createMockMessage({ content: 'Hello' })]);
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			expect(container.textContent).not.toContain('No messages yet');
		});
	});

	describe('Input Area', () => {
		it('should render input textarea', () => {
			const messages = createMockMessagesSignal();
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			const textarea = container.querySelector('textarea');
			expect(textarea).toBeTruthy();
		});

		it('should render attach file button', () => {
			const messages = createMockMessagesSignal();
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			const attachButton = container.querySelector('button[title="Attach image"]');
			expect(attachButton).toBeTruthy();
		});

		it('should call openFilePicker when attach button clicked', () => {
			const messages = createMockMessagesSignal();
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			const attachButton = container.querySelector('button[title="Attach image"]')!;
			fireEvent.click(attachButton);

			expect(mockUseChatBaseReturn.openFilePicker).toHaveBeenCalledTimes(1);
		});

		it('should disable attach button when sending', () => {
			const messages = createMockMessagesSignal();
			mockUseChatBaseReturn.sending = true;
			vi.mocked(useChatBase).mockReturnValue(mockUseChatBaseReturn);

			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			const attachButton = container.querySelector(
				'button[title="Attach image"]'
			) as HTMLButtonElement;
			expect(attachButton?.disabled).toBe(true);
		});

		it('should render hidden file input', () => {
			const messages = createMockMessagesSignal();
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			const fileInput = container.querySelector('input[type="file"]');
			expect(fileInput).toBeTruthy();
			expect(fileInput?.getAttribute('accept')).toBe('image/png,image/jpeg,image/gif,image/webp');
			expect(fileInput?.hasAttribute('multiple')).toBe(true);
		});

		it('should show keyboard shortcut hint', () => {
			const messages = createMockMessagesSignal();
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			expect(container.textContent).toContain('Enter to send, Shift+Enter for newline');
		});
	});

	describe('Attachments', () => {
		it('should show attachment count when attachments exist', () => {
			const messages = createMockMessagesSignal();
			mockUseChatBaseReturn.attachments = [
				{
					name: 'image1.png',
					size: 1000,
					type: 'image',
					source: { type: 'base64', media_type: 'image/png', data: '' },
					media_type: 'image/png',
					data: '',
				},
				{
					name: 'image2.png',
					size: 2000,
					type: 'image',
					source: { type: 'base64', media_type: 'image/png', data: '' },
					media_type: 'image/png',
					data: '',
				},
			] as any;
			vi.mocked(useChatBase).mockReturnValue(mockUseChatBaseReturn);

			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			expect(container.textContent).toContain('2 attachment(s)');
		});

		it('should not show attachment count when no attachments', () => {
			const messages = createMockMessagesSignal();
			mockUseChatBaseReturn.attachments = [];
			vi.mocked(useChatBase).mockReturnValue(mockUseChatBaseReturn);

			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			expect(container.textContent).not.toContain('attachment(s)');
		});

		it('should render AttachmentPreview when attachments exist', () => {
			const messages = createMockMessagesSignal();
			mockUseChatBaseReturn.attachments = [
				{
					name: 'image.png',
					size: 1000,
					type: 'image',
					source: { type: 'base64', media_type: 'image/png', data: '' },
					media_type: 'image/png',
					data: '',
				},
			] as any;
			vi.mocked(useChatBase).mockReturnValue(mockUseChatBaseReturn);

			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			// AttachmentPreview renders images
			const images = container.querySelectorAll('img');
			expect(images.length).toBeGreaterThan(0);
		});
	});

	describe('Scroll to Bottom Button', () => {
		it('should show scroll button when showScrollButton is true', () => {
			const messages = createMockMessagesSignal();
			mockUseChatBaseReturn.showScrollButton = true;
			vi.mocked(useChatBase).mockReturnValue(mockUseChatBaseReturn);

			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			const scrollButton = container.querySelector('button[title="Scroll to bottom"]');
			expect(scrollButton).toBeTruthy();
		});

		it('should not show scroll button when showScrollButton is false', () => {
			const messages = createMockMessagesSignal();
			mockUseChatBaseReturn.showScrollButton = false;
			vi.mocked(useChatBase).mockReturnValue(mockUseChatBaseReturn);

			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			const scrollButton = container.querySelector('button[title="Scroll to bottom"]');
			expect(scrollButton).toBeNull();
		});

		it('should call scrollToBottom when scroll button clicked', () => {
			const messages = createMockMessagesSignal();
			mockUseChatBaseReturn.showScrollButton = true;
			vi.mocked(useChatBase).mockReturnValue(mockUseChatBaseReturn);

			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			const scrollButton = container.querySelector('button[title="Scroll to bottom"]')!;
			fireEvent.click(scrollButton);

			expect(mockUseChatBaseReturn.scrollToBottom).toHaveBeenCalledWith(true);
		});
	});

	describe('Error Handling', () => {
		it('should show error when error is set', () => {
			const messages = createMockMessagesSignal();
			mockUseChatBaseReturn.error = 'Something went wrong';
			vi.mocked(useChatBase).mockReturnValue(mockUseChatBaseReturn);

			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			expect(container.textContent).toContain('Something went wrong');
		});

		it('should not show error when error is null', () => {
			const messages = createMockMessagesSignal();
			mockUseChatBaseReturn.error = null;
			vi.mocked(useChatBase).mockReturnValue(mockUseChatBaseReturn);

			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			// Error container should not exist
			const errorContainer = container.querySelector('.bg-red-900\\/30');
			expect(errorContainer).toBeNull();
		});

		it('should call clearError when error dismiss button clicked', () => {
			const messages = createMockMessagesSignal();
			mockUseChatBaseReturn.error = 'Test error';
			vi.mocked(useChatBase).mockReturnValue(mockUseChatBaseReturn);

			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			// Find the dismiss button inside error container
			const errorContainer = container.querySelector('.bg-red-900\\/30');
			const dismissButton = errorContainer?.querySelector('button');
			expect(dismissButton).toBeTruthy();

			fireEvent.click(dismissButton!);
			expect(mockUseChatBaseReturn.clearError).toHaveBeenCalledTimes(1);
		});
	});

	describe('Layout Structure', () => {
		it('should have proper vertical layout', () => {
			const messages = createMockMessagesSignal();
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			const mainPanel = container.firstElementChild;
			expect(mainPanel?.className).toContain('flex');
			expect(mainPanel?.className).toContain('flex-col');
			expect(mainPanel?.className).toContain('h-full');
		});

		it('should have scrollable messages container', () => {
			const messages = createMockMessagesSignal();
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			const messagesContainer = container.querySelector('.overflow-y-auto');
			expect(messagesContainer).toBeTruthy();
			expect(messagesContainer?.className).toContain('flex-1');
		});

		it('should have fixed header', () => {
			const messages = createMockMessagesSignal();
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			const header = container.querySelector('.border-b');
			expect(header?.className).toContain('shrink-0');
		});

		it('should have fixed input area', () => {
			const messages = createMockMessagesSignal();
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			const inputArea = container.querySelector('.border-t');
			expect(inputArea?.className).toContain('shrink-0');
		});
	});

	describe('Message Positioning', () => {
		it('should align user messages to the right', () => {
			const messages = createMockMessagesSignal([
				createMockMessage({ role: 'user', content: 'User message' }),
			]);
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			const messageWrapper = container.querySelector('.justify-end');
			expect(messageWrapper).toBeTruthy();
		});

		it('should align non-user messages to the left', () => {
			const messages = createMockMessagesSignal([
				createMockMessage({ role: 'assistant', content: 'Assistant message' }),
			]);
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			const messageWrapper = container.querySelector('.justify-start');
			expect(messageWrapper).toBeTruthy();
		});

		it('should limit message width to 85%', () => {
			const messages = createMockMessagesSignal([
				createMockMessage({ role: 'assistant', content: 'Long message' }),
			]);
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			const messageBubble = container.querySelector('.max-w-\\[85\\%\\]');
			expect(messageBubble).toBeTruthy();
		});
	});

	describe('Signal Reactivity', () => {
		it('should update when messages signal changes', async () => {
			const messages = createMockMessagesSignal([
				createMockMessage({ id: '1', content: 'First message' }),
			]);

			const { container, rerender } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			expect(container.textContent).toContain('First message');
			expect(container.textContent).toContain('1 message');

			// Update the signal
			messages.value = [
				createMockMessage({ id: '1', content: 'First message' }),
				createMockMessage({ id: '2', content: 'Second message' }),
			];

			// Re-render to pick up signal change
			rerender(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			expect(container.textContent).toContain('Second message');
			expect(container.textContent).toContain('2 messages');
		});
	});

	describe('External Message Icon', () => {
		it('should show arrow icon for external messages', () => {
			const messages = createMockMessagesSignal([
				createMockMessage({
					role: 'external_message',
					content: 'External notification',
				}),
			]);
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			// External messages have an SVG icon in the sender name area
			const senderArea = container.querySelector('.flex.items-center.gap-1');
			expect(senderArea?.querySelector('svg')).toBeTruthy();
		});

		it('should not show arrow icon for non-external messages', () => {
			const messages = createMockMessagesSignal([
				createMockMessage({
					role: 'assistant',
					content: 'Assistant response',
					senderName: 'Agent',
				}),
			]);
			const { container } = render(
				<RoomChatPanel roomId="room-123" messages={messages} onSendMessage={mockOnSendMessage} />
			);

			// The sender name area should exist but without the external icon
			const senderArea = container.querySelector('.flex.items-center.gap-1');
			// For assistant messages with senderName, there should be no SVG (the external icon)
			expect(senderArea?.querySelector('svg')).toBeNull();
		});
	});
});
