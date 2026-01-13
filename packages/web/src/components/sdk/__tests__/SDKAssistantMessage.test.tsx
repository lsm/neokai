// @ts-nocheck
/**
 * SDKAssistantMessage Component Tests
 *
 * Tests assistant message rendering with text, tools, and thinking blocks
 */
import { describe, it, expect } from 'vitest';

import { render } from '@testing-library/preact';
import { SDKAssistantMessage } from '../SDKAssistantMessage';
import type { SDKMessage } from '@liuboer/shared/sdk/sdk.d.ts';
import type { UUID } from 'crypto';

// Helper to create a valid UUID
const createUUID = (): UUID => crypto.randomUUID() as UUID;

// Factory functions for test messages
function createTextOnlyMessage(text: string): Extract<SDKMessage, { type: 'assistant' }> {
	return {
		type: 'assistant',
		message: {
			id: 'msg_test',
			type: 'message',
			role: 'assistant',
			content: [{ type: 'text', text }],
			model: 'claude-3-5-sonnet-20241022',
			stop_reason: 'end_turn',
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 20 },
		},
		parent_tool_use_id: null,
		uuid: createUUID(),
		session_id: 'test-session',
	} as unknown as Extract<SDKMessage, { type: 'assistant' }>;
}

function createToolUseMessage(): Extract<SDKMessage, { type: 'assistant' }> {
	return {
		type: 'assistant',
		message: {
			id: 'msg_test',
			type: 'message',
			role: 'assistant',
			content: [
				{
					type: 'tool_use',
					id: 'toolu_test123',
					name: 'Read',
					input: { file_path: '/test/file.txt' },
				},
			],
			model: 'claude-3-5-sonnet-20241022',
			stop_reason: 'tool_use',
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 20 },
		},
		parent_tool_use_id: null,
		uuid: createUUID(),
		session_id: 'test-session',
	} as unknown as Extract<SDKMessage, { type: 'assistant' }>;
}

function createThinkingMessage(): Extract<SDKMessage, { type: 'assistant' }> {
	return {
		type: 'assistant',
		message: {
			id: 'msg_test',
			type: 'message',
			role: 'assistant',
			content: [
				{ type: 'thinking', thinking: 'Let me think about this carefully...' },
				{ type: 'text', text: 'Here is my response.' },
			],
			model: 'claude-3-5-sonnet-20241022',
			stop_reason: 'end_turn',
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 20 },
		},
		parent_tool_use_id: null,
		uuid: createUUID(),
		session_id: 'test-session',
	} as unknown as Extract<SDKMessage, { type: 'assistant' }>;
}

function createMixedContentMessage(): Extract<SDKMessage, { type: 'assistant' }> {
	return {
		type: 'assistant',
		message: {
			id: 'msg_test',
			type: 'message',
			role: 'assistant',
			content: [
				{ type: 'text', text: 'I will read the file.' },
				{
					type: 'tool_use',
					id: 'toolu_read123',
					name: 'Read',
					input: { file_path: '/test/file.txt' },
				},
				{ type: 'text', text: 'The file has been read.' },
			],
			model: 'claude-3-5-sonnet-20241022',
			stop_reason: 'end_turn',
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 20 },
		},
		parent_tool_use_id: null,
		uuid: createUUID(),
		session_id: 'test-session',
	} as unknown as Extract<SDKMessage, { type: 'assistant' }>;
}

function createTaskToolMessage(): Extract<SDKMessage, { type: 'assistant' }> {
	return {
		type: 'assistant',
		message: {
			id: 'msg_test',
			type: 'message',
			role: 'assistant',
			content: [
				{
					type: 'tool_use',
					id: 'toolu_task123',
					name: 'Task',
					input: {
						subagent_type: 'Explore',
						description: 'Find all test files',
						prompt: 'Search for test files',
					},
				},
			],
			model: 'claude-3-5-sonnet-20241022',
			stop_reason: 'tool_use',
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 20 },
		},
		parent_tool_use_id: null,
		uuid: createUUID(),
		session_id: 'test-session',
	} as unknown as Extract<SDKMessage, { type: 'assistant' }>;
}

function createErrorMessage(): Extract<SDKMessage, { type: 'assistant' }> {
	return {
		type: 'assistant',
		message: {
			id: 'msg_test',
			type: 'message',
			role: 'assistant',
			content: [{ type: 'text', text: 'An error occurred' }],
			model: 'claude-3-5-sonnet-20241022',
			stop_reason: 'end_turn',
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 20 },
		},
		parent_tool_use_id: null,
		error: 'invalid_request',
		uuid: createUUID(),
		session_id: 'test-session',
	} as unknown as Extract<SDKMessage, { type: 'assistant' }>;
}

describe('SDKAssistantMessage', () => {
	describe('Basic Rendering', () => {
		it('should render with data-testid attribute', () => {
			const message = createTextOnlyMessage('Hello world');
			const { container } = render(<SDKAssistantMessage message={message} />);

			expect(container.querySelector('[data-testid="assistant-message"]')).toBeTruthy();
		});

		it('should include message UUID in data attribute', () => {
			const message = createTextOnlyMessage('Hello world');
			const { container } = render(<SDKAssistantMessage message={message} />);

			const element = container.querySelector('[data-message-uuid]');
			expect(element?.getAttribute('data-message-uuid')).toBe(message.uuid);
		});

		it('should include message role in data attribute', () => {
			const message = createTextOnlyMessage('Hello world');
			const { container } = render(<SDKAssistantMessage message={message} />);

			const element = container.querySelector('[data-message-role]');
			expect(element?.getAttribute('data-message-role')).toBe('assistant');
		});
	});

	describe('Text Content', () => {
		it('should render text content', () => {
			const message = createTextOnlyMessage('Hello world');
			const { container } = render(<SDKAssistantMessage message={message} />);

			expect(container.textContent).toContain('Hello world');
		});

		it('should render multiple text blocks', () => {
			const message = createMixedContentMessage();
			const { container } = render(<SDKAssistantMessage message={message} />);

			expect(container.textContent).toContain('I will read the file');
			expect(container.textContent).toContain('The file has been read');
		});

		it('should show timestamp', () => {
			const message = createTextOnlyMessage('Hello');
			const messageWithTimestamp = { ...message, timestamp: Date.now() };
			const { container } = render(
				<SDKAssistantMessage message={messageWithTimestamp as typeof message} />
			);

			// Timestamp should be visible (format like "10:30")
			const timeRegex = /\d{1,2}:\d{2}/;
			expect(container.textContent).toMatch(timeRegex);
		});
	});

	describe('Tool Use Blocks', () => {
		it('should render tool use blocks', () => {
			const message = createToolUseMessage();
			const { container } = render(<SDKAssistantMessage message={message} />);

			// Tool card should be rendered
			expect(container.textContent).toContain('Read');
		});

		it('should display tool result when available', () => {
			const message = createToolUseMessage();
			const toolResultsMap = new Map([['toolu_test123', { content: 'File content here' }]]);

			const { container } = render(
				<SDKAssistantMessage message={message} toolResultsMap={toolResultsMap} />
			);

			expect(container.textContent).toContain('Read');
		});

		it('should render Task tool as SubagentBlock', () => {
			const message = createTaskToolMessage();
			const { container } = render(<SDKAssistantMessage message={message} />);

			// SubagentBlock should show the subagent type
			expect(container.textContent).toContain('Explore');
		});
	});

	describe('Thinking Blocks', () => {
		it('should render thinking blocks', () => {
			const message = createThinkingMessage();
			const { container } = render(<SDKAssistantMessage message={message} />);

			// ThinkingBlock should be rendered
			expect(container.querySelector('[data-testid="thinking-block"]')).toBeTruthy();
			expect(container.textContent).toContain('Thinking');
		});

		it('should render thinking content', () => {
			const message = createThinkingMessage();
			const { container } = render(<SDKAssistantMessage message={message} />);

			expect(container.textContent).toContain('Let me think about this carefully');
		});
	});

	describe('Error State', () => {
		it('should apply error styling when message has error', () => {
			const message = createErrorMessage();
			const { container } = render(<SDKAssistantMessage message={message} />);

			// Should have error styling (red background)
			expect(container.querySelector('.bg-red-50, .dark\\:bg-red-900\\/20')).toBeTruthy();
		});

		it('should show API Error label', () => {
			const message = createErrorMessage();
			const { container } = render(<SDKAssistantMessage message={message} />);

			expect(container.textContent).toContain('API Error');
		});
	});

	describe('Parent Tool Use (Sub-agent)', () => {
		it('should show parent tool use indicator for sub-agent messages', () => {
			const message = createTextOnlyMessage('Sub-agent response');
			const subAgentMessage = {
				...message,
				parent_tool_use_id: 'toolu_parent123',
			} as typeof message;

			const { container } = render(<SDKAssistantMessage message={subAgentMessage} />);

			expect(container.textContent).toContain('Sub-agent response');
		});
	});

	describe('Copy Functionality', () => {
		it('should have copy button', () => {
			const message = createTextOnlyMessage('Hello world');
			const { container } = render(<SDKAssistantMessage message={message} />);

			const copyButton = container.querySelector('button[title="Copy message"]');
			expect(copyButton).toBeTruthy();
		});
	});

	describe('Question Handling (AskUserQuestion)', () => {
		it('should render AskUserQuestion tool with QuestionPrompt', () => {
			const message = {
				type: 'assistant',
				message: {
					id: 'msg_test',
					type: 'message',
					role: 'assistant',
					content: [
						{
							type: 'tool_use',
							id: 'toolu_question123',
							name: 'AskUserQuestion',
							input: {
								questions: [
									{
										question: 'Which option?',
										header: 'Select one',
										options: [
											{ label: 'A', description: 'Option A' },
											{ label: 'B', description: 'Option B' },
										],
										multiSelect: false,
									},
								],
							},
						},
					],
					model: 'claude-3-5-sonnet-20241022',
					stop_reason: 'tool_use',
					stop_sequence: null,
					usage: { input_tokens: 10, output_tokens: 20 },
				},
				parent_tool_use_id: null,
				uuid: createUUID(),
				session_id: 'test-session',
			} as unknown as Extract<SDKMessage, { type: 'assistant' }>;

			const { container } = render(
				<SDKAssistantMessage message={message} sessionId="test-session" />
			);

			// AskUserQuestion tool should be rendered
			expect(container.textContent).toContain('AskUserQuestion');
		});
	});
});
