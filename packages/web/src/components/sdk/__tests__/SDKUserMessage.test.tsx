// @ts-nocheck
/**
 * SDKUserMessage Component Tests
 *
 * Tests user message rendering including text, images, and special cases
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { render, fireEvent } from '@testing-library/preact';
import { SDKUserMessage } from '../SDKUserMessage';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import type { UUID } from 'crypto';

// Mock the utils module for copyToClipboard
vi.mock('../../../lib/utils.ts', async (importOriginal) => {
	const original = await importOriginal<typeof import('../../../lib/utils.ts')>();
	return {
		...original,
		copyToClipboard: vi.fn(),
	};
});

// Mock the toast module
vi.mock('../../../lib/toast.ts', () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
	},
}));

import { copyToClipboard } from '../../../lib/utils.ts';
import { toast } from '../../../lib/toast.ts';

beforeEach(() => {
	vi.clearAllMocks();
});

// Helper to create a valid UUID
const createUUID = (): UUID => crypto.randomUUID() as UUID;

// Factory functions for test messages
function createTextMessage(text: string): Extract<SDKMessage, { type: 'user' }> {
	return {
		type: 'user',
		message: {
			role: 'user',
			content: text,
		},
		parent_tool_use_id: null,
		uuid: createUUID(),
		session_id: 'test-session',
	};
}

function createArrayContentMessage(
	blocks: Array<Record<string, unknown>>
): Extract<SDKMessage, { type: 'user' }> {
	return {
		type: 'user',
		message: {
			role: 'user',
			content: blocks,
		},
		parent_tool_use_id: null,
		uuid: createUUID(),
		session_id: 'test-session',
	} as unknown as Extract<SDKMessage, { type: 'user' }>;
}

function createImageMessage(): Extract<SDKMessage, { type: 'user' }> {
	return {
		type: 'user',
		message: {
			role: 'user',
			content: [
				{ type: 'text', text: 'Here is an image:' },
				{
					type: 'image',
					source: {
						type: 'base64',
						media_type: 'image/png',
						data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
					},
				},
			],
		},
		parent_tool_use_id: null,
		uuid: createUUID(),
		session_id: 'test-session',
	} as unknown as Extract<SDKMessage, { type: 'user' }>;
}

function createToolResultMessage(): Extract<SDKMessage, { type: 'user' }> {
	return {
		type: 'user',
		message: {
			role: 'user',
			content: [
				{
					type: 'tool_result',
					tool_use_id: 'toolu_test123',
					content: 'Tool execution result',
				},
			],
		},
		parent_tool_use_id: null,
		uuid: createUUID(),
		session_id: 'test-session',
	} as unknown as Extract<SDKMessage, { type: 'user' }>;
}

function createSyntheticMessage(): Extract<SDKMessage, { type: 'user' }> {
	return {
		type: 'user',
		message: {
			role: 'user',
			content: 'Interrupt: User cancelled operation',
		},
		parent_tool_use_id: null,
		isSynthetic: true,
		uuid: createUUID(),
		session_id: 'test-session',
	};
}

function createReplayMessage(content: string): Extract<SDKMessage, { type: 'user' }> {
	return {
		type: 'user',
		message: {
			role: 'user',
			content: content,
		},
		parent_tool_use_id: null,
		uuid: createUUID(),
		session_id: 'test-session',
		isReplay: true,
	} as unknown as Extract<SDKMessage, { type: 'user' }>;
}

function createSessionInfo(): Extract<SDKMessage, { type: 'system'; subtype: 'init' }> {
	return {
		type: 'system',
		subtype: 'init',
		agents: [],
		apiKeySource: 'user',
		betas: [],
		claude_code_version: '1.0.0',
		cwd: '/test/path',
		tools: ['Read', 'Write', 'Bash'],
		mcp_servers: [{ name: 'test-server', status: 'connected' }],
		model: 'claude-3-5-sonnet-20241022',
		permissionMode: 'default',
		slash_commands: ['help', 'clear'],
		output_style: 'default',
		skills: [],
		plugins: [],
		uuid: createUUID(),
		session_id: 'test-session',
	};
}

describe('SDKUserMessage', () => {
	describe('Basic Rendering', () => {
		it('should render with data-testid attribute', () => {
			const message = createTextMessage('Hello world');
			const { container } = render(<SDKUserMessage message={message} />);

			expect(container.querySelector('[data-testid="user-message"]')).toBeTruthy();
		});

		it('should include message UUID in data attribute', () => {
			const message = createTextMessage('Hello world');
			const { container } = render(<SDKUserMessage message={message} />);

			const element = container.querySelector('[data-message-uuid]');
			expect(element?.getAttribute('data-message-uuid')).toBe(message.uuid);
		});

		it('should include message role in data attribute', () => {
			const message = createTextMessage('Hello world');
			const { container } = render(<SDKUserMessage message={message} />);

			const element = container.querySelector('[data-message-role]');
			expect(element?.getAttribute('data-message-role')).toBe('user');
		});
	});

	describe('Text Content', () => {
		it('should render string content', () => {
			const message = createTextMessage('Hello world');
			const { container } = render(<SDKUserMessage message={message} />);

			expect(container.textContent).toContain('Hello world');
		});

		it('should render array content with text blocks', () => {
			const message = createArrayContentMessage([
				{ type: 'text', text: 'First block' },
				{ type: 'text', text: 'Second block' },
			]);
			const { container } = render(<SDKUserMessage message={message} />);

			expect(container.textContent).toContain('First block');
		});

		it('should preserve whitespace', () => {
			const message = createTextMessage('Line 1\nLine 2\nLine 3');
			const { container } = render(<SDKUserMessage message={message} />);

			const textDiv = container.querySelector('.whitespace-pre-wrap');
			expect(textDiv).toBeTruthy();
		});
	});

	describe('Image Content', () => {
		it('should render attached images', () => {
			const message = createImageMessage();
			const { container } = render(<SDKUserMessage message={message} />);

			const img = container.querySelector('img');
			expect(img).toBeTruthy();
			expect(img?.getAttribute('src')).toContain('data:image/png;base64');
		});

		it('should render text alongside images', () => {
			const message = createImageMessage();
			const { container } = render(<SDKUserMessage message={message} />);

			expect(container.textContent).toContain('Here is an image');
			expect(container.querySelector('img')).toBeTruthy();
		});
	});

	describe('Tool Result Messages', () => {
		it('should not render tool result messages', () => {
			const message = createToolResultMessage();
			const { container } = render(<SDKUserMessage message={message} />);

			// Tool result messages should return null
			expect(container.innerHTML).toBe('');
		});
	});

	describe('Synthetic Messages', () => {
		it('should render synthetic messages with special styling', () => {
			const message = createSyntheticMessage();
			const { container } = render(<SDKUserMessage message={message} />);

			// Should use SyntheticMessageBlock component
			expect(container.querySelector('[data-testid="synthetic-message"]')).toBeTruthy();
		});

		it('should show synthetic badge', () => {
			const message = createSyntheticMessage();
			const { container } = render(<SDKUserMessage message={message} />);

			expect(container.textContent).toContain('synthetic');
		});

		it('should handle synthetic message with non-object content blocks', () => {
			// Create synthetic message with array content containing non-object elements
			// Note: Avoid null since isToolResultMessage() tries to access .type on all elements
			const message = {
				type: 'user',
				message: {
					role: 'user',
					content: [
						{ type: 'text', text: 'Valid text block' },
						'plain string element', // Non-object element to test line 108
						123, // Non-object element (number)
						true, // Boolean element
					],
				},
				parent_tool_use_id: null,
				isSynthetic: true,
				uuid: createUUID(),
				session_id: 'test-session',
			} as unknown as Extract<SDKMessage, { type: 'user' }>;

			const { container } = render(<SDKUserMessage message={message} />);

			// Should render without error
			expect(container.querySelector('[data-testid="synthetic-message"]')).toBeTruthy();
		});

		it('should return null for synthetic message with invalid content type', () => {
			// Create synthetic message with content that is neither array nor string
			const message = {
				type: 'user',
				message: {
					role: 'user',
					content: 12345, // Neither array nor string - should return null from getSyntheticContentBlocks
				},
				parent_tool_use_id: null,
				isSynthetic: true,
				uuid: createUUID(),
				session_id: 'test-session',
			} as unknown as Extract<SDKMessage, { type: 'user' }>;

			const { container } = render(<SDKUserMessage message={message} />);

			// When getSyntheticContentBlocks returns null, the message should render as a normal user message
			// (syntheticContentBlocks will be null, so it won't use SyntheticMessageBlock)
			expect(container.querySelector('[data-testid="user-message"]')).toBeTruthy();
		});
	});

	describe('Replay Messages (Slash Commands)', () => {
		it('should render command output with SlashCommandOutput', () => {
			const message = createReplayMessage(
				'<local-command-stdout>Command executed successfully</local-command-stdout>'
			);
			const { container } = render(<SDKUserMessage message={message} isReplay={true} />);

			expect(container.textContent).toContain('Command executed successfully');
		});

		it('should hide "Compacted" output (shown in CompactBoundaryMessage)', () => {
			const message = createReplayMessage('<local-command-stdout>Compacted</local-command-stdout>');
			const { container } = render(<SDKUserMessage message={message} isReplay={true} />);

			// Should be hidden
			expect(container.innerHTML).toBe('');
		});
	});

	describe('Error Output', () => {
		it('should render error output with ErrorOutput component', () => {
			const message = createTextMessage(
				'<local-command-stderr>Error: Something went wrong</local-command-stderr>'
			);
			const { container } = render(<SDKUserMessage message={message} />);

			// Should show error styling
			expect(container.textContent).toContain('Error');
		});
	});

	describe('Session Info', () => {
		it('should show session info icon when sessionInfo is provided', () => {
			const message = createTextMessage('Hello');
			const sessionInfo = createSessionInfo();

			const { container } = render(<SDKUserMessage message={message} sessionInfo={sessionInfo} />);

			// Session info button should be present
			const infoButton = container.querySelector('button[title="Session info"]');
			expect(infoButton).toBeTruthy();
		});

		it('should not show session info icon when sessionInfo is not provided', () => {
			const message = createTextMessage('Hello');
			const { container } = render(<SDKUserMessage message={message} />);

			const infoButton = container.querySelector('button[title="Session info"]');
			expect(infoButton).toBeFalsy();
		});
	});

	describe('Parent Tool Use (Sub-agent)', () => {
		it('should show parent tool use indicator for sub-agent messages', () => {
			const message = {
				...createTextMessage('Sub-agent user message'),
				parent_tool_use_id: 'toolu_parent123',
			};

			const { container } = render(<SDKUserMessage message={message} />);

			expect(container.textContent).toContain('Sub-agent message');
			expect(container.textContent).toContain('toolu_pa');
		});
	});

	describe('Timestamp', () => {
		it('should show timestamp when available', () => {
			const message = {
				...createTextMessage('Hello'),
				timestamp: Date.now(),
			};

			const { container } = render(<SDKUserMessage message={message} />);

			// Should show time (format like "10:30")
			const timeRegex = /\d{1,2}:\d{2}/;
			expect(container.textContent).toMatch(timeRegex);
		});
	});

	describe('Copy Functionality', () => {
		it('should have copy button', () => {
			const message = createTextMessage('Hello world');
			const { container } = render(<SDKUserMessage message={message} />);

			const copyButton = container.querySelector('button[title="Copy message"]');
			expect(copyButton).toBeTruthy();
		});

		it('should show success toast when copy succeeds', async () => {
			vi.mocked(copyToClipboard).mockResolvedValue(true);

			const message = createTextMessage('Hello world');
			const { container } = render(<SDKUserMessage message={message} />);

			const copyButton = container.querySelector('button[title="Copy message"]');
			fireEvent.click(copyButton!);

			// Wait for the async handler to complete
			await vi.waitFor(() => {
				expect(copyToClipboard).toHaveBeenCalledWith('Hello world');
				expect(toast.success).toHaveBeenCalledWith('Message copied to clipboard');
			});
		});

		it('should show error toast when copy fails', async () => {
			vi.mocked(copyToClipboard).mockResolvedValue(false);

			const message = createTextMessage('Hello world');
			const { container } = render(<SDKUserMessage message={message} />);

			const copyButton = container.querySelector('button[title="Copy message"]');
			fireEvent.click(copyButton!);

			// Wait for the async handler to complete
			await vi.waitFor(() => {
				expect(copyToClipboard).toHaveBeenCalledWith('Hello world');
				expect(toast.error).toHaveBeenCalledWith('Failed to copy message');
			});
		});
	});

	describe('Styling', () => {
		it('should be right-aligned (user messages)', () => {
			const message = createTextMessage('Hello');
			const { container } = render(<SDKUserMessage message={message} />);

			expect(container.querySelector('.justify-end')).toBeTruthy();
		});

		it('should have max-width constraint', () => {
			const message = createTextMessage('Hello');
			const { container } = render(<SDKUserMessage message={message} />);

			// Check for max-width classes
			const wrapper = container.querySelector('.max-w-\\[85\\%\\]');
			expect(wrapper).toBeTruthy();
		});
	});

	describe('Rewind Mode', () => {
		const onMessageCheckboxChange = vi.fn();

		beforeEach(() => {
			onMessageCheckboxChange.mockClear();
		});

		it('should show checkbox when in rewind mode', () => {
			const message = createTextMessage('Hello');
			const selectedMessages = new Set<string>();
			const allMessages = [{ uuid: message.uuid }];

			const { container } = render(
				<SDKUserMessage
					message={message}
					rewindMode={true}
					selectedMessages={selectedMessages}
					onMessageCheckboxChange={onMessageCheckboxChange}
					allMessages={allMessages}
				/>
			);

			const checkbox = container.querySelector('input[type="checkbox"]');
			expect(checkbox).toBeTruthy();
		});

		it('should not show checkbox when not in rewind mode', () => {
			const message = createTextMessage('Hello');
			const { container } = render(<SDKUserMessage message={message} rewindMode={false} />);

			const checkbox = container.querySelector('input[type="checkbox"]');
			expect(checkbox).toBeNull();
		});

		it('should check checkbox when message is selected', () => {
			const message = createTextMessage('Hello');
			const selectedMessages = new Set<string>([message.uuid]);
			const allMessages = [{ uuid: message.uuid }];

			const { container } = render(
				<SDKUserMessage
					message={message}
					rewindMode={true}
					selectedMessages={selectedMessages}
					onMessageCheckboxChange={onMessageCheckboxChange}
					allMessages={allMessages}
				/>
			);

			const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
			expect(checkbox.checked).toBe(true);
		});

		it('should not check checkbox when message is not selected', () => {
			const message = createTextMessage('Hello');
			const selectedMessages = new Set<string>();
			const allMessages = [{ uuid: message.uuid }];

			const { container } = render(
				<SDKUserMessage
					message={message}
					rewindMode={true}
					selectedMessages={selectedMessages}
					onMessageCheckboxChange={onMessageCheckboxChange}
					allMessages={allMessages}
				/>
			);

			const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
			expect(checkbox.checked).toBe(false);
		});

		it('should call onMessageCheckboxChange when checkbox is clicked', () => {
			const message = createTextMessage('Hello');
			const selectedMessages = new Set<string>();
			const allMessages = [{ uuid: message.uuid }];

			const { container } = render(
				<SDKUserMessage
					message={message}
					rewindMode={true}
					selectedMessages={selectedMessages}
					onMessageCheckboxChange={onMessageCheckboxChange}
					allMessages={allMessages}
				/>
			);

			const checkbox = container.querySelector('input[type="checkbox"]');
			fireEvent.click(checkbox!);

			expect(onMessageCheckboxChange).toHaveBeenCalledWith(message.uuid, true);
		});

		it('should be left-aligned in rewind mode', () => {
			const message = createTextMessage('Hello');
			const selectedMessages = new Set<string>();
			const allMessages = [{ uuid: message.uuid }];

			const { container } = render(
				<SDKUserMessage
					message={message}
					rewindMode={true}
					selectedMessages={selectedMessages}
					onMessageCheckboxChange={onMessageCheckboxChange}
					allMessages={allMessages}
				/>
			);

			expect(container.querySelector('.justify-start')).toBeTruthy();
		});

		it('should not show checkbox when message has no uuid', () => {
			const message = createTextMessage('Hello');
			// @ts-expect-error - Testing undefined uuid
			message.uuid = undefined;
			const selectedMessages = new Set<string>();
			const allMessages = [{}];

			const { container } = render(
				<SDKUserMessage
					message={message}
					rewindMode={true}
					selectedMessages={selectedMessages}
					onMessageCheckboxChange={onMessageCheckboxChange}
					allMessages={allMessages}
				/>
			);

			const checkbox = container.querySelector('input[type="checkbox"]');
			expect(checkbox).toBeNull();
		});
	});

	describe('Rewind Button and Spinner', () => {
		const onRewind = vi.fn();

		beforeEach(() => {
			onRewind.mockClear();
		});

		it('should show rewind button when message has uuid and onRewind callback', () => {
			const message = createTextMessage('Hello');
			const { container } = render(
				<SDKUserMessage
					message={message}
					sessionId="test-session"
					onRewind={onRewind}
					rewindingMessageUuid={null}
				/>
			);

			const rewindButton = container.querySelector('button[title="Rewind to here"]');
			expect(rewindButton).toBeTruthy();
		});

		it('should show spinner when rewindingMessageUuid matches message uuid', () => {
			const message = createTextMessage('Hello');
			const { container } = render(
				<SDKUserMessage
					message={message}
					sessionId="test-session"
					onRewind={onRewind}
					rewindingMessageUuid={message.uuid}
				/>
			);

			// Should show spinner instead of rewind button
			const spinner = container.querySelector('[role="status"]');
			expect(spinner).toBeTruthy();
			expect(spinner?.getAttribute('aria-label')).toBe('Loading');

			// Rewind button should not be present
			const rewindButton = container.querySelector('button[title="Rewind to here"]');
			expect(rewindButton).toBeFalsy();
		});

		it('should show rewind button when rewindingMessageUuid does not match', () => {
			const message = createTextMessage('Hello');
			const { container } = render(
				<SDKUserMessage
					message={message}
					sessionId="test-session"
					onRewind={onRewind}
					rewindingMessageUuid="different-uuid"
				/>
			);

			// Should show rewind button, not spinner
			const rewindButton = container.querySelector('button[title="Rewind to here"]');
			expect(rewindButton).toBeTruthy();

			const spinner = container.querySelector('[role="status"]');
			expect(spinner).toBeFalsy();
		});

		it('should call onRewind with message uuid when rewind button is clicked', () => {
			const message = createTextMessage('Hello');
			const { container } = render(
				<SDKUserMessage
					message={message}
					sessionId="test-session"
					onRewind={onRewind}
					rewindingMessageUuid={null}
				/>
			);

			const rewindButton = container.querySelector('button[title="Rewind to here"]');
			fireEvent.click(rewindButton!);

			expect(onRewind).toHaveBeenCalledWith(message.uuid);
		});

		it('should not show rewind button for synthetic messages', () => {
			const message = createSyntheticMessage();
			const { container } = render(
				<SDKUserMessage
					message={message}
					sessionId="test-session"
					onRewind={onRewind}
					rewindingMessageUuid={null}
				/>
			);

			const rewindButton = container.querySelector('button[title="Rewind to here"]');
			expect(rewindButton).toBeFalsy();
		});

		it('should not show rewind button when sessionId is missing', () => {
			const message = createTextMessage('Hello');
			const { container } = render(
				<SDKUserMessage message={message} onRewind={onRewind} rewindingMessageUuid={null} />
			);

			const rewindButton = container.querySelector('button[title="Rewind to here"]');
			expect(rewindButton).toBeFalsy();
		});

		it('should not show rewind button when onRewind is missing', () => {
			const message = createTextMessage('Hello');
			const { container } = render(
				<SDKUserMessage message={message} sessionId="test-session" rewindingMessageUuid={null} />
			);

			const rewindButton = container.querySelector('button[title="Rewind to here"]');
			expect(rewindButton).toBeFalsy();
		});

		it('should not show rewind button when message has no uuid', () => {
			const message = createTextMessage('Hello');
			// @ts-expect-error - Testing undefined uuid
			message.uuid = undefined;

			const { container } = render(
				<SDKUserMessage
					message={message}
					sessionId="test-session"
					onRewind={onRewind}
					rewindingMessageUuid={null}
				/>
			);

			const rewindButton = container.querySelector('button[title="Rewind to here"]');
			expect(rewindButton).toBeFalsy();
		});
	});
});
