// @ts-nocheck
/**
 * SyntheticMessageBlock Component Tests
 *
 * Tests synthetic (system-generated) user message rendering
 */
import { describe, it, expect, mock, spyOn, vi } from 'vitest';

import { render } from '@testing-library/preact';
import { SyntheticMessageBlock } from '../SyntheticMessageBlock';

describe('SyntheticMessageBlock', () => {
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
	});
});
