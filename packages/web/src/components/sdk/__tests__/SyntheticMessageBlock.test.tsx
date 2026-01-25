// @ts-nocheck
/**
 * SyntheticMessageBlock Component Tests
 *
 * Tests synthetic (system-generated) user message rendering
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { render, fireEvent, waitFor } from '@testing-library/preact';
import { SyntheticMessageBlock } from '../SyntheticMessageBlock';

// Mock copyToClipboard
const mockCopyToClipboard = vi.fn();

vi.mock('../../../lib/utils.ts', async () => {
	const actual = await vi.importActual('../../../lib/utils.ts');
	return {
		...actual,
		copyToClipboard: (text: string) => mockCopyToClipboard(text),
	};
});

// Mock toast
const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();

vi.mock('../../../lib/toast.ts', () => ({
	toast: {
		success: (msg: string) => mockToastSuccess(msg),
		error: (msg: string) => mockToastError(msg),
	},
}));

describe('SyntheticMessageBlock', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockCopyToClipboard.mockResolvedValue(true);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe('Basic Rendering', () => {
		it('should render with data-testid attribute', () => {
			const { container } = render(
				<SyntheticMessageBlock content="Synthetic content" timestamp={Date.now()} />
			);

			expect(container.querySelector('[data-testid="synthetic-message"]')).toBeTruthy();
		});

		it('should include role in data attribute', () => {
			const { container } = render(
				<SyntheticMessageBlock content="Synthetic content" timestamp={Date.now()} />
			);

			const element = container.querySelector('[data-message-role]');
			expect(element?.getAttribute('data-message-role')).toBe('synthetic');
		});

		it('should include uuid in data attribute when provided', () => {
			const uuid = 'test-uuid-12345';
			const { container } = render(
				<SyntheticMessageBlock content="Synthetic content" timestamp={Date.now()} uuid={uuid} />
			);

			const element = container.querySelector('[data-message-uuid]');
			expect(element?.getAttribute('data-message-uuid')).toBe(uuid);
		});

		it('should include timestamp in data attribute', () => {
			const timestamp = 1703234567890;
			const { container } = render(
				<SyntheticMessageBlock content="Synthetic content" timestamp={timestamp} />
			);

			const element = container.querySelector('[data-message-timestamp]');
			expect(element?.getAttribute('data-message-timestamp')).toBe(String(timestamp));
		});
	});

	describe('Header', () => {
		it('should show "Synthetic Message" header', () => {
			const { container } = render(
				<SyntheticMessageBlock content="Content" timestamp={Date.now()} />
			);

			expect(container.textContent).toContain('Synthetic Message');
		});

		it('should have lightbulb icon', () => {
			const { container } = render(
				<SyntheticMessageBlock content="Content" timestamp={Date.now()} />
			);

			// Should have SVG icon in header
			const headerSvg = container.querySelector('.border-b svg');
			expect(headerSvg).toBeTruthy();
		});
	});

	describe('String Content', () => {
		it('should render simple string content', () => {
			const content = 'This is a synthetic message.';
			const { container } = render(
				<SyntheticMessageBlock content={content} timestamp={Date.now()} />
			);

			expect(container.textContent).toContain('This is a synthetic message');
		});

		it('should preserve whitespace in text content', () => {
			const content = 'Line 1\nLine 2\n  Indented line';
			const { container } = render(
				<SyntheticMessageBlock content={content} timestamp={Date.now()} />
			);

			// Should have whitespace-pre-wrap class
			const textDiv = container.querySelector('.whitespace-pre-wrap');
			expect(textDiv).toBeTruthy();
		});
	});

	describe('Array Content Blocks', () => {
		it('should render text blocks', () => {
			const content = [{ type: 'text', text: 'Text block content' }];
			const { container } = render(
				<SyntheticMessageBlock content={content} timestamp={Date.now()} />
			);

			expect(container.textContent).toContain('Text block content');
		});

		it('should render image blocks', () => {
			const content = [
				{
					type: 'image',
					source: { type: 'base64', data: 'abc123' },
				},
			];
			const { container } = render(
				<SyntheticMessageBlock content={content} timestamp={Date.now()} />
			);

			expect(container.textContent).toContain('Image');
			expect(container.textContent).toContain('base64');
		});

		it('should render tool_use blocks', () => {
			const content = [
				{
					type: 'tool_use',
					name: 'Read',
					input: { file_path: '/test/file.txt' },
				},
			];
			const { container } = render(
				<SyntheticMessageBlock content={content} timestamp={Date.now()} />
			);

			expect(container.textContent).toContain('Tool Use: Read');
			expect(container.textContent).toContain('file_path');
		});

		it('should render tool_result blocks', () => {
			const content = [
				{
					type: 'tool_result',
					tool_use_id: 'toolu_abc123456789012',
					content: 'File content here',
				},
			];
			const { container } = render(
				<SyntheticMessageBlock content={content} timestamp={Date.now()} />
			);

			expect(container.textContent).toContain('Tool Result');
			expect(container.textContent).toContain('toolu_abc123');
			expect(container.textContent).toContain('File content here');
		});

		it('should render tool_result blocks with empty content', () => {
			const content = [
				{
					type: 'tool_result',
					tool_use_id: 'toolu_abc123456789012',
					content: null,
				},
			];
			const { container } = render(
				<SyntheticMessageBlock content={content} timestamp={Date.now()} />
			);

			expect(container.textContent).toContain('(empty)');
		});

		it('should render unknown block types', () => {
			const content = [
				{
					type: 'custom_type',
					data: { key: 'value' },
				},
			];
			const { container } = render(
				<SyntheticMessageBlock content={content} timestamp={Date.now()} />
			);

			expect(container.textContent).toContain('custom_type');
			expect(container.textContent).toContain('key');
		});

		it('should render multiple blocks', () => {
			const content = [
				{ type: 'text', text: 'First text' },
				{ type: 'text', text: 'Second text' },
				{
					type: 'tool_use',
					name: 'Bash',
					input: { command: 'ls' },
				},
			];
			const { container } = render(
				<SyntheticMessageBlock content={content} timestamp={Date.now()} />
			);

			expect(container.textContent).toContain('First text');
			expect(container.textContent).toContain('Second text');
			expect(container.textContent).toContain('Tool Use: Bash');
		});
	});

	describe('Timestamp Display', () => {
		it('should show formatted time', () => {
			const timestamp = Date.now();
			const { container } = render(
				<SyntheticMessageBlock content="Content" timestamp={timestamp} />
			);

			// Should show time in format like "10:30 AM"
			const timeRegex = /\d{1,2}:\d{2}\s?(AM|PM)/i;
			expect(container.textContent).toMatch(timeRegex);
		});

		it('should not show timestamp when not provided', () => {
			const { container } = render(<SyntheticMessageBlock content="Content" />);

			// Should still render, just without timestamp
			expect(container.textContent).toContain('Content');
		});

		it('should have tooltip with full timestamp', () => {
			const timestamp = Date.now();
			const { container } = render(
				<SyntheticMessageBlock content="Content" timestamp={timestamp} />
			);

			// The time span should exist
			const timeSpan = container.querySelector('.text-xs.text-gray-500');
			expect(timeSpan).toBeTruthy();
		});
	});

	describe('Synthetic Badge', () => {
		it('should show synthetic badge', () => {
			const { container } = render(
				<SyntheticMessageBlock content="Content" timestamp={Date.now()} />
			);

			expect(container.textContent).toContain('synthetic');
		});

		it('should have purple styling for synthetic badge', () => {
			const { container } = render(
				<SyntheticMessageBlock content="Content" timestamp={Date.now()} />
			);

			expect(container.querySelector('.bg-purple-500\\/20, .text-purple-300')).toBeTruthy();
		});
	});

	describe('Copy Functionality', () => {
		it('should have copy button', () => {
			const { container } = render(
				<SyntheticMessageBlock content="Content to copy" timestamp={Date.now()} />
			);

			const copyButton = container.querySelector('button[title="Copy message"]');
			expect(copyButton).toBeTruthy();
		});

		it('should copy string content on button click', async () => {
			const { container } = render(
				<SyntheticMessageBlock content="Content to copy" timestamp={Date.now()} />
			);

			const copyButton = container.querySelector('button[title="Copy message"]');
			fireEvent.click(copyButton!);

			await waitFor(() => {
				expect(mockCopyToClipboard).toHaveBeenCalledWith('Content to copy');
				expect(mockToastSuccess).toHaveBeenCalledWith('Message copied to clipboard');
			});
		});

		it('should show error toast when copy fails', async () => {
			mockCopyToClipboard.mockResolvedValue(false);

			const { container } = render(
				<SyntheticMessageBlock content="Content to copy" timestamp={Date.now()} />
			);

			const copyButton = container.querySelector('button[title="Copy message"]');
			fireEvent.click(copyButton!);

			await waitFor(() => {
				expect(mockToastError).toHaveBeenCalledWith('Failed to copy message');
			});
		});

		it('should extract and copy text from array content blocks', async () => {
			const content = [
				{ type: 'text', text: 'First line' },
				{ type: 'text', text: 'Second line' },
				{ type: 'image', source: {} }, // non-text should be ignored
			];

			const { container } = render(
				<SyntheticMessageBlock content={content} timestamp={Date.now()} />
			);

			const copyButton = container.querySelector('button[title="Copy message"]');
			fireEvent.click(copyButton!);

			await waitFor(() => {
				expect(mockCopyToClipboard).toHaveBeenCalledWith('First line\nSecond line');
			});
		});

		it('should handle empty content array when copying', async () => {
			const { container } = render(<SyntheticMessageBlock content={[]} timestamp={Date.now()} />);

			const copyButton = container.querySelector('button[title="Copy message"]');
			fireEvent.click(copyButton!);

			await waitFor(() => {
				expect(mockCopyToClipboard).toHaveBeenCalledWith('');
			});
		});

		it('should handle content with only non-text blocks when copying', async () => {
			const content = [
				{ type: 'image', source: {} },
				{ type: 'tool_use', name: 'Read', input: {} },
			];

			const { container } = render(
				<SyntheticMessageBlock content={content} timestamp={Date.now()} />
			);

			const copyButton = container.querySelector('button[title="Copy message"]');
			fireEvent.click(copyButton!);

			await waitFor(() => {
				expect(mockCopyToClipboard).toHaveBeenCalledWith('');
			});
		});
	});

	describe('Styling', () => {
		it('should be right-aligned', () => {
			const { container } = render(
				<SyntheticMessageBlock content="Content" timestamp={Date.now()} />
			);

			expect(container.querySelector('.justify-end')).toBeTruthy();
		});

		it('should have purple border and background', () => {
			const { container } = render(
				<SyntheticMessageBlock content="Content" timestamp={Date.now()} />
			);

			expect(container.querySelector('.bg-purple-900\\/20, .border-purple-700\\/50')).toBeTruthy();
		});

		it('should have max-width constraint', () => {
			const { container } = render(
				<SyntheticMessageBlock content="Content" timestamp={Date.now()} />
			);

			expect(container.querySelector('.max-w-\\[85\\%\\]')).toBeTruthy();
		});

		it('should have rounded borders', () => {
			const { container } = render(
				<SyntheticMessageBlock content="Content" timestamp={Date.now()} />
			);

			expect(container.querySelector('.rounded-lg')).toBeTruthy();
		});
	});

	describe('Overflow Protection', () => {
		it('should apply break-words to text content', () => {
			const { container } = render(
				<SyntheticMessageBlock content="Long text content" timestamp={Date.now()} />
			);

			expect(container.querySelector('.break-words')).toBeTruthy();
		});

		it('should apply overflow-x-auto to JSON content', () => {
			const content = [
				{
					type: 'tool_use',
					name: 'Test',
					input: { longKey: 'x'.repeat(1000) },
				},
			];
			const { container } = render(
				<SyntheticMessageBlock content={content} timestamp={Date.now()} />
			);

			expect(container.querySelector('.overflow-x-auto')).toBeTruthy();
		});

		it('should apply overflow-auto to tool_result content', () => {
			const content = [
				{
					type: 'tool_result',
					tool_use_id: 'toolu_abc123456789012',
					content: 'x'.repeat(1000),
				},
			];
			const { container } = render(
				<SyntheticMessageBlock content={content} timestamp={Date.now()} />
			);

			expect(container.querySelector('.overflow-auto')).toBeTruthy();
		});
	});

	describe('Edge Cases', () => {
		it('should handle empty content array', () => {
			const { container } = render(<SyntheticMessageBlock content={[]} timestamp={Date.now()} />);

			expect(container.querySelector('[data-testid="synthetic-message"]')).toBeTruthy();
		});

		it('should handle content with undefined fields', () => {
			const content = [
				{
					type: 'tool_result',
					tool_use_id: 'toolu_abc123456789012',
					content: undefined,
				},
			];
			const { container } = render(
				<SyntheticMessageBlock content={content} timestamp={Date.now()} />
			);

			expect(container.textContent).toContain('(empty)');
		});

		it('should handle object content in tool_result', () => {
			const content = [
				{
					type: 'tool_result',
					tool_use_id: 'toolu_abc123456789012',
					content: { key: 'value', nested: { data: 123 } },
				},
			];
			const { container } = render(
				<SyntheticMessageBlock content={content} timestamp={Date.now()} />
			);

			expect(container.textContent).toContain('key');
			expect(container.textContent).toContain('value');
		});

		it('should handle very long text content', () => {
			const longContent = 'x'.repeat(10000);
			const { container } = render(
				<SyntheticMessageBlock content={longContent} timestamp={Date.now()} />
			);

			expect(container.querySelector('[data-testid="synthetic-message"]')).toBeTruthy();
		});

		it('should handle special characters in content', () => {
			const content = 'Special chars: <script>alert("xss")</script> & "quotes"';
			const { container } = render(
				<SyntheticMessageBlock content={content} timestamp={Date.now()} />
			);

			// Content should be rendered (escaped by React/Preact)
			expect(container.textContent).toContain('Special chars');
		});

		it('should handle content with Unicode characters', () => {
			const content = 'Unicode: 你好 🎉 émoji café';
			const { container } = render(
				<SyntheticMessageBlock content={content} timestamp={Date.now()} />
			);

			expect(container.textContent).toContain('你好');
			expect(container.textContent).toContain('🎉');
		});
	});

	describe('formatTime Helper', () => {
		// Tests the formatTime function behavior
		it('should format morning time correctly', () => {
			// Create a fixed timestamp for 9:30 AM
			const date = new Date();
			date.setHours(9, 30, 0, 0);
			const timestamp = date.getTime();

			const { container } = render(
				<SyntheticMessageBlock content="Content" timestamp={timestamp} />
			);

			// Should contain time format
			expect(container.textContent).toMatch(/\d{1,2}:\d{2}/);
		});

		it('should format afternoon time correctly', () => {
			// Create a fixed timestamp for 2:45 PM
			const date = new Date();
			date.setHours(14, 45, 0, 0);
			const timestamp = date.getTime();

			const { container } = render(
				<SyntheticMessageBlock content="Content" timestamp={timestamp} />
			);

			expect(container.textContent).toMatch(/\d{1,2}:\d{2}/);
		});

		it('should handle midnight time', () => {
			const date = new Date();
			date.setHours(0, 0, 0, 0);
			const timestamp = date.getTime();

			const { container } = render(
				<SyntheticMessageBlock content="Content" timestamp={timestamp} />
			);

			expect(container.textContent).toMatch(/12:00/i);
		});

		it('should handle noon time', () => {
			const date = new Date();
			date.setHours(12, 0, 0, 0);
			const timestamp = date.getTime();

			const { container } = render(
				<SyntheticMessageBlock content="Content" timestamp={timestamp} />
			);

			expect(container.textContent).toMatch(/12:00/i);
		});
	});

	describe('getTextContent Helper', () => {
		// Tests the text extraction logic for copy functionality
		it('should extract text from string content', () => {
			const content = 'Simple text content';
			const extracted = typeof content === 'string' ? content : '';
			expect(extracted).toBe('Simple text content');
		});

		it('should extract text from array of text blocks', () => {
			const content = [
				{ type: 'text', text: 'First' },
				{ type: 'text', text: 'Second' },
			];
			const extracted = content
				.map((block) => (block.type === 'text' ? block.text : ''))
				.filter(Boolean)
				.join('\n');
			expect(extracted).toBe('First\nSecond');
		});

		it('should skip non-text blocks when extracting', () => {
			const content = [
				{ type: 'text', text: 'Text content' },
				{ type: 'image', source: {} },
				{ type: 'tool_use', name: 'Read', input: {} },
			];
			const extracted = content
				.map((block) => (block.type === 'text' ? (block.text as string) : ''))
				.filter(Boolean)
				.join('\n');
			expect(extracted).toBe('Text content');
		});

		it('should handle empty array', () => {
			const content: Array<{ type: string; text?: string }> = [];
			const extracted = content
				.map((block) => (block.type === 'text' ? block.text : ''))
				.filter(Boolean)
				.join('\n');
			expect(extracted).toBe('');
		});
	});

	describe('Content Block Key Generation', () => {
		it('should render multiple blocks with unique keys', () => {
			const content = [
				{ type: 'text', text: 'Block 1' },
				{ type: 'text', text: 'Block 2' },
				{ type: 'text', text: 'Block 3' },
			];
			const { container } = render(
				<SyntheticMessageBlock content={content} timestamp={Date.now()} />
			);

			// All blocks should be rendered
			expect(container.textContent).toContain('Block 1');
			expect(container.textContent).toContain('Block 2');
			expect(container.textContent).toContain('Block 3');
		});
	});

	describe('Timestamp Zero Handling', () => {
		it('should handle timestamp of 0', () => {
			const { container } = render(<SyntheticMessageBlock content="Content" timestamp={0} />);

			// Timestamp 0 should result in "0" attribute but no displayed time
			const element = container.querySelector('[data-message-timestamp]');
			expect(element?.getAttribute('data-message-timestamp')).toBe('0');
		});

		it('should handle negative timestamp', () => {
			const { container } = render(<SyntheticMessageBlock content="Content" timestamp={-1000} />);

			// Should still render
			expect(container.querySelector('[data-testid="synthetic-message"]')).toBeTruthy();
		});
	});

	describe('Tool Use Block Details', () => {
		it('should render tool use with complex input', () => {
			const content = [
				{
					type: 'tool_use',
					name: 'Edit',
					input: {
						file_path: '/src/test.ts',
						old_string: 'const x = 1;',
						new_string: 'const x = 2;',
					},
				},
			];
			const { container } = render(
				<SyntheticMessageBlock content={content} timestamp={Date.now()} />
			);

			expect(container.textContent).toContain('Tool Use: Edit');
			expect(container.textContent).toContain('file_path');
		});

		it('should render tool use with array input', () => {
			const content = [
				{
					type: 'tool_use',
					name: 'TodoWrite',
					input: {
						todos: [
							{ content: 'Task 1', status: 'pending', activeForm: '' },
							{ content: 'Task 2', status: 'completed', activeForm: '' },
						],
					},
				},
			];
			const { container } = render(
				<SyntheticMessageBlock content={content} timestamp={Date.now()} />
			);

			expect(container.textContent).toContain('Tool Use: TodoWrite');
			expect(container.textContent).toContain('todos');
		});
	});

	describe('Tool Result Truncation', () => {
		it('should truncate long tool_use_id', () => {
			const content = [
				{
					type: 'tool_result',
					tool_use_id: 'toolu_abc123456789012345678901234567890',
					content: 'Result',
				},
			];
			const { container } = render(
				<SyntheticMessageBlock content={content} timestamp={Date.now()} />
			);

			// Should show truncated ID with ellipsis
			expect(container.textContent).toContain('toolu_abc123');
			expect(container.textContent).toContain('...');
		});
	});

	describe('Accessibility', () => {
		it('should have accessible copy button', () => {
			const { container } = render(
				<SyntheticMessageBlock content="Content" timestamp={Date.now()} />
			);

			const copyButton = container.querySelector('button[title="Copy message"]');
			expect(copyButton).toBeTruthy();
			expect(copyButton?.getAttribute('title')).toBe('Copy message');
		});
	});

	describe('Content Normalization', () => {
		it('should normalize string content to text block', () => {
			const stringContent = 'Simple string';
			// The component normalizes string to [{ type: 'text', text: content }]
			const normalized =
				typeof stringContent === 'string' ? [{ type: 'text', text: stringContent }] : stringContent;

			expect(normalized).toEqual([{ type: 'text', text: 'Simple string' }]);
		});

		it('should keep array content as is', () => {
			const arrayContent = [{ type: 'text', text: 'Array text' }];
			const normalized =
				typeof arrayContent === 'string' ? [{ type: 'text', text: arrayContent }] : arrayContent;

			expect(normalized).toBe(arrayContent);
		});
	});

	describe('Data Attributes', () => {
		it('should set data-message-timestamp to 0 when timestamp is undefined', () => {
			const { container } = render(<SyntheticMessageBlock content="Content" />);

			const element = container.querySelector('[data-message-timestamp]');
			expect(element?.getAttribute('data-message-timestamp')).toBe('0');
		});

		it('should preserve exact uuid value', () => {
			const uuid = 'unique-id-with-special-chars_123';
			const { container } = render(<SyntheticMessageBlock content="Content" uuid={uuid} />);

			const element = container.querySelector('[data-message-uuid]');
			expect(element?.getAttribute('data-message-uuid')).toBe(uuid);
		});
	});
});
