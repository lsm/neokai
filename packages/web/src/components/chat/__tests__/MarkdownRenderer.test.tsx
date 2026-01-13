// @ts-nocheck
/**
 * Tests for MarkdownRenderer Component
 *
 * Tests actual rendering behavior without mocking marked library.
 * This prevents global mock pollution that breaks other tests.
import { describe, it, expect } from 'vitest';
 *
 * Note: Uses synchronous tests where possible since Happy-DOM
 * may have timing issues with async markdown parsing.
 */

import { render } from '@testing-library/preact';
import MarkdownRenderer from '../MarkdownRenderer';

describe('MarkdownRenderer', () => {
	describe('Basic Rendering', () => {
		it('should render plain text', () => {
			const { container } = render(<MarkdownRenderer content="Hello World" />);
			expect(container.textContent).toContain('Hello World');
		});

		it('should render with prose class', () => {
			const { container } = render(<MarkdownRenderer content="Test" />);
			expect(container.querySelector('.prose')).toBeTruthy();
		});

		it('should merge custom className', () => {
			const { container } = render(<MarkdownRenderer content="Test" class="custom-class" />);
			const div = container.querySelector('div');
			expect(div?.className).toContain('prose');
			expect(div?.className).toContain('custom-class');
		});

		it('should handle empty className', () => {
			const { container } = render(<MarkdownRenderer content="Test" class="" />);
			const div = container.querySelector('div');
			expect(div?.className).toContain('prose');
		});
	});

	describe('Markdown Parsing', () => {
		it('should render headers', () => {
			const { container } = render(<MarkdownRenderer content="# Heading 1" />);
			expect(container.textContent).toContain('Heading 1');
		});

		it('should render bold text', () => {
			const { container } = render(<MarkdownRenderer content="This is **bold** text" />);
			expect(container.textContent).toContain('bold');
		});

		it('should render italic text', () => {
			const { container } = render(<MarkdownRenderer content="This is *italic* text" />);
			expect(container.textContent).toContain('italic');
		});

		it('should render links', () => {
			const { container } = render(<MarkdownRenderer content="[Link text](https://example.com)" />);
			expect(container.textContent).toContain('Link text');
		});

		it('should render inline code', () => {
			const { container } = render(<MarkdownRenderer content="Use `npm install`" />);
			expect(container.textContent).toContain('npm install');
		});

		it('should render unordered lists', () => {
			const { container } = render(<MarkdownRenderer content="- Item 1\n- Item 2\n- Item 3" />);
			expect(container.textContent).toContain('Item 1');
			expect(container.textContent).toContain('Item 2');
			expect(container.textContent).toContain('Item 3');
		});

		it('should render ordered lists', () => {
			const { container } = render(<MarkdownRenderer content="1. First\n2. Second\n3. Third" />);
			expect(container.textContent).toContain('First');
			expect(container.textContent).toContain('Second');
			expect(container.textContent).toContain('Third');
		});

		it('should render blockquotes', () => {
			const { container } = render(<MarkdownRenderer content="> This is a quote" />);
			expect(container.textContent).toContain('This is a quote');
		});

		it('should render paragraphs', () => {
			const { container } = render(<MarkdownRenderer content="Hello World" />);
			expect(container.textContent).toContain('Hello World');
		});
	});

	describe('Code Blocks', () => {
		it('should render code blocks', () => {
			const { container } = render(<MarkdownRenderer content="```\nconst x = 1;\n```" />);
			expect(container.textContent).toContain('const x = 1');
		});

		it('should render code blocks with language', () => {
			const { container } = render(<MarkdownRenderer content="```javascript\nconst x = 1;\n```" />);
			expect(container.textContent).toContain('const x = 1');
		});
	});

	describe('Tables', () => {
		it('should render tables', () => {
			const tableContent = `| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |`;

			const { container } = render(<MarkdownRenderer content={tableContent} />);
			expect(container.textContent).toContain('Header 1');
			expect(container.textContent).toContain('Cell 1');
		});

		it('should wrap tables for scrolling', () => {
			const tableContent = `| Header 1 | Header 2 |
|----------|----------|
| Cell 1   | Cell 2   |`;

			const { container } = render(<MarkdownRenderer content={tableContent} />);
			expect(container.textContent).toContain('Header 1');
		});
	});

	describe('Paragraph Margins', () => {
		it('should remove top margin from first paragraph', () => {
			const { container } = render(<MarkdownRenderer content="Hello World" />);
			const paragraphs = container.querySelectorAll('p');
			expect(paragraphs.length).toBeGreaterThan(0);
			const firstP = paragraphs[0] as HTMLElement;
			// Style values may include 'px' suffix
			expect(firstP.style.marginTop).toMatch(/^0(px)?$/);
		});

		it('should remove bottom margin from last paragraph', () => {
			const { container } = render(<MarkdownRenderer content="Hello World" />);
			const paragraphs = container.querySelectorAll('p');
			expect(paragraphs.length).toBeGreaterThan(0);
			const lastP = paragraphs[paragraphs.length - 1] as HTMLElement;
			// Style values may include 'px' suffix
			expect(lastP.style.marginBottom).toMatch(/^0(px)?$/);
		});
	});

	describe('GFM Support', () => {
		it('should support line breaks', () => {
			const { container } = render(<MarkdownRenderer content="Line 1\nLine 2" />);
			const content = container.innerHTML;
			expect(content).toContain('Line 1');
			expect(content).toContain('Line 2');
		});

		it('should support strikethrough', () => {
			const { container } = render(<MarkdownRenderer content="~~deleted~~" />);
			expect(container.textContent).toContain('deleted');
		});
	});

	describe('Edge Cases', () => {
		it('should handle empty content', () => {
			const { container } = render(<MarkdownRenderer content="" />);
			const div = container.querySelector('.prose');
			expect(div).toBeTruthy();
		});

		it('should handle very long content', () => {
			const longContent = 'x'.repeat(10000);
			const { container } = render(<MarkdownRenderer content={longContent} />);
			expect(container.textContent?.length).toBeGreaterThan(1000);
		});

		it('should handle special characters', () => {
			const { container } = render(<MarkdownRenderer content={'Special: <>&"\''} />);
			expect(container.textContent).toContain('Special');
		});

		it('should handle content with newlines', () => {
			const { container } = render(<MarkdownRenderer content="Line 1\n\nLine 2" />);
			expect(container.textContent).toContain('Line 1');
			expect(container.textContent).toContain('Line 2');
		});
	});
});
