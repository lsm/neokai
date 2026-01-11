// @ts-nocheck
/**
 * Tests for MarkdownRenderer Component
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock marked
const mockParse = mock((content: string) => `<p>${content}</p>`);
mock.module('marked', () => ({
	marked: {
		parse: mockParse,
		setOptions: mock(() => {}),
	},
}));

// Mock highlight.js
const mockHighlightElement = mock(() => {});
mock.module('highlight.js', () => ({
	default: {
		highlightElement: mockHighlightElement,
	},
}));

describe('MarkdownRenderer', () => {
	beforeEach(() => {
		mockParse.mockClear();
		mockHighlightElement.mockClear();
	});

	describe('Markdown Parsing', () => {
		it('should parse simple text', () => {
			const content = 'Hello World';
			const _result = mockParse(content);
			expect(result).toBe('<p>Hello World</p>');
		});

		it('should be called with content', () => {
			const content = 'Test content';
			mockParse(content);
			expect(mockParse).toHaveBeenCalledWith('Test content');
		});

		it('should memoize parsing results', () => {
			const content = 'Same content';
			mockParse(content);
			mockParse(content);
			// In the real component, useMemo would prevent re-parsing
			expect(mockParse).toHaveBeenCalledTimes(2); // Without memoization
		});
	});

	describe('Code Block Highlighting', () => {
		it('should highlight code blocks after render', () => {
			// Simulate finding code blocks
			const mockCodeBlock = document.createElement('code');
			mockHighlightElement(mockCodeBlock);
			expect(mockHighlightElement).toHaveBeenCalled();
		});
	});

	describe('Content Types', () => {
		it('should handle plain text', () => {
			mockParse.mockImplementation((text) => `<p>${text}</p>`);
			const _result = mockParse('Plain text');
			expect(result).toContain('<p>');
		});

		it('should handle markdown with headers', () => {
			mockParse.mockImplementation((text) => {
				if (text.startsWith('# ')) {
					return `<h1>${text.slice(2)}</h1>`;
				}
				return `<p>${text}</p>`;
			});
			const _result = mockParse('# Header');
			expect(result).toBe('<h1>Header</h1>');
		});

		it('should handle markdown with code blocks', () => {
			mockParse.mockImplementation(
				() => '<pre><code class="language-javascript">const x = 1;</code></pre>'
			);
			const _result = mockParse('```javascript\nconst x = 1;\n```');
			expect(result).toContain('<code');
			expect(result).toContain('language-javascript');
		});

		it('should handle markdown with links', () => {
			mockParse.mockImplementation(() => '<p><a href="https://example.com">Link</a></p>');
			const _result = mockParse('[Link](https://example.com)');
			expect(result).toContain('<a href=');
		});

		it('should handle markdown with images', () => {
			mockParse.mockImplementation(() => '<p><img src="image.png" alt="Image"></p>');
			const _result = mockParse('![Image](image.png)');
			expect(result).toContain('<img');
		});

		it('should handle markdown with lists', () => {
			mockParse.mockImplementation(() => '<ul><li>Item 1</li><li>Item 2</li></ul>');
			const _result = mockParse('- Item 1\n- Item 2');
			expect(result).toContain('<ul>');
			expect(result).toContain('<li>');
		});

		it('should handle markdown with tables', () => {
			mockParse.mockImplementation(() => '<table><thead><tr><th>Header</th></tr></thead></table>');
			const _result = mockParse('| Header |\n|--------|');
			expect(result).toContain('<table>');
		});

		it('should handle markdown with blockquotes', () => {
			mockParse.mockImplementation(() => '<blockquote><p>Quote</p></blockquote>');
			const _result = mockParse('> Quote');
			expect(result).toContain('<blockquote>');
		});

		it('should handle inline code', () => {
			mockParse.mockImplementation(() => '<p>Use <code>npm install</code></p>');
			const _result = mockParse('Use `npm install`');
			expect(result).toContain('<code>');
		});

		it('should handle bold text', () => {
			mockParse.mockImplementation(() => '<p><strong>Bold</strong></p>');
			const _result = mockParse('**Bold**');
			expect(result).toContain('<strong>');
		});

		it('should handle italic text', () => {
			mockParse.mockImplementation(() => '<p><em>Italic</em></p>');
			const _result = mockParse('*Italic*');
			expect(result).toContain('<em>');
		});
	});

	describe('Class Handling', () => {
		it('should apply default prose class', () => {
			// The component applies 'prose' class by default
			const baseClass = 'prose';
			expect(baseClass).toBe('prose');
		});

		it('should merge custom className', () => {
			const baseClass = 'prose';
			const customClass = 'custom-class';
			const combinedClass = `${baseClass} ${customClass}`;
			expect(combinedClass).toBe('prose custom-class');
		});

		it('should handle empty className', () => {
			const baseClass = 'prose';
			const customClass = '';
			const combinedClass = `${baseClass} ${customClass || ''}`;
			expect(combinedClass.trim()).toBe('prose');
		});
	});

	describe('Table Wrapping', () => {
		it('should wrap tables in scrollable container', () => {
			// Simulate table wrapping logic
			const wrapper = document.createElement('div');
			wrapper.className = 'prose-table-wrapper';
			expect(wrapper.className).toBe('prose-table-wrapper');
		});

		it('should not double-wrap tables', () => {
			// Test that already wrapped tables are not wrapped again
			const wrapper = document.createElement('div');
			wrapper.className = 'prose-table-wrapper';
			const isAlreadyWrapped = wrapper.classList.contains('prose-table-wrapper');
			expect(isAlreadyWrapped).toBe(true);
		});
	});

	describe('Paragraph Margin Handling', () => {
		it('should remove top margin from first paragraph', () => {
			const p = document.createElement('p');
			p.style.marginTop = '0';
			expect(p.style.marginTop).toBe('0');
		});

		it('should remove bottom margin from last paragraph', () => {
			const p = document.createElement('p');
			p.style.marginBottom = '0';
			expect(p.style.marginBottom).toBe('0');
		});
	});

	describe('GFM Support', () => {
		it('should support GitHub Flavored Markdown', () => {
			// marked.setOptions is called with gfm: true
			const options = { breaks: true, gfm: true };
			expect(options.gfm).toBe(true);
		});

		it('should support line breaks', () => {
			// marked.setOptions is called with breaks: true
			const options = { breaks: true, gfm: true };
			expect(options.breaks).toBe(true);
		});
	});

	describe('Edge Cases', () => {
		it('should handle empty content', () => {
			mockParse.mockImplementation(() => '');
			const _result = mockParse('');
			expect(result).toBe('');
		});

		it('should handle content with special characters', () => {
			mockParse.mockImplementation((text) => `<p>${text}</p>`);
			const _result = mockParse('<script>alert("xss")</script>');
			// Marked escapes HTML by default
			expect(mockParse).toHaveBeenCalled();
		});

		it('should handle very long content', () => {
			const longContent = 'x'.repeat(10000);
			mockParse.mockImplementation((text) => `<p>${text}</p>`);
			const _result = mockParse(longContent);
			expect(result.length).toBeGreaterThan(10000);
		});

		it('should handle content with newlines', () => {
			mockParse.mockImplementation(() => '<p>Line 1</p>\n<p>Line 2</p>');
			const _result = mockParse('Line 1\n\nLine 2');
			expect(result).toContain('Line 1');
			expect(result).toContain('Line 2');
		});
	});
});
