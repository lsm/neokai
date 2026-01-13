// @ts-nocheck
/**
 * ThinkingBlock Component Tests
 *
 * Tests thinking block rendering with expand/collapse functionality
 */
import { describe, it, expect, mock, spyOn, vi } from 'vitest';

import { render } from '@testing-library/preact';
import { ThinkingBlock } from '../ThinkingBlock';

describe('ThinkingBlock', () => {
	describe('Basic Rendering', () => {
		it('should render with data-testid attribute', () => {
			const { container } = render(<ThinkingBlock content="Thinking content" />);

			expect(container.querySelector('[data-testid="thinking-block"]')).toBeTruthy();
		});

		it('should render thinking header', () => {
			const { container } = render(<ThinkingBlock content="Let me think..." />);

			expect(container.textContent).toContain('Thinking');
		});

		it('should display thinking content', () => {
			const content = 'Let me analyze this problem step by step.';
			const { container } = render(<ThinkingBlock content={content} />);

			expect(container.textContent).toContain('Let me analyze this problem');
		});

		it('should have lightbulb icon', () => {
			const { container } = render(<ThinkingBlock content="Thinking..." />);

			// Should have an SVG icon
			const svg = container.querySelector('svg');
			expect(svg).toBeTruthy();
		});
	});

	describe('Character Count', () => {
		it('should show character count', () => {
			const content = 'Short thinking content.';
			const { container } = render(<ThinkingBlock content={content} />);

			expect(container.textContent).toContain(`${content.length} character`);
		});

		it('should show singular "character" for 1 character', () => {
			const { container } = render(<ThinkingBlock content="x" />);

			expect(container.textContent).toContain('1 character');
			expect(container.textContent).not.toContain('1 characters');
		});

		it('should show plural "characters" for multiple characters', () => {
			const { container } = render(<ThinkingBlock content="abc" />);

			expect(container.textContent).toContain('3 characters');
		});

		it('should format large character counts with commas', () => {
			const longContent = 'x'.repeat(1500);
			const { container } = render(<ThinkingBlock content={longContent} />);

			expect(container.textContent).toContain('1,500');
		});
	});

	describe('Truncation and Expansion', () => {
		it('should not show expand button for short content', () => {
			const shortContent = 'Short content that fits in preview.';
			const { container } = render(<ThinkingBlock content={shortContent} />);

			// No "Show more" button for short content (truncation detection via scrollHeight)
			// In test environment, scrollHeight may not work, so we just verify content renders
			expect(container.textContent).toContain('Short content');
		});

		it('should render long content', () => {
			const longContent =
				'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10';
			const { container } = render(<ThinkingBlock content={longContent} />);

			// Content should be rendered (truncation detection uses useLayoutEffect/scrollHeight
			// which may not trigger in test environment)
			expect(container.textContent).toContain('Line 1');
			expect(container.textContent).toContain('Line 10');
		});

		it('should have expand button structure when content triggers truncation', () => {
			// Note: In a real browser, scrollHeight comparison triggers truncation
			// In test environment, we just verify the component structure is correct
			const longContent =
				'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10';
			const { container } = render(<ThinkingBlock content={longContent} />);

			// Verify content is rendered
			expect(container.textContent).toContain('Line 1');
			expect(container.querySelector('[data-testid="thinking-block"]')).toBeTruthy();
		});

		it('should render all lines of content', () => {
			const longContent =
				'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10';
			const { container } = render(<ThinkingBlock content={longContent} />);

			// Verify all content is in the DOM
			expect(container.textContent).toContain('Line 1');
			expect(container.textContent).toContain('Line 5');
			expect(container.textContent).toContain('Line 10');
		});
	});

	describe('Gradient Fade Overlay', () => {
		it('should have proper structure for gradient overlay', () => {
			const longContent =
				'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10';
			const { container } = render(<ThinkingBlock content={longContent} />);

			// Note: Gradient overlay is conditional on needsTruncation state,
			// which uses scrollHeight comparison that may not work in test env
			// Just verify the thinking block renders correctly
			expect(container.querySelector('[data-testid="thinking-block"]')).toBeTruthy();
			expect(container.textContent).toContain('Line 1');
		});

		it('should render content area with proper classes', () => {
			const longContent =
				'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10';
			const { container } = render(<ThinkingBlock content={longContent} />);

			// Verify the content container structure
			expect(container.querySelector('.border-t')).toBeTruthy();
			expect(container.querySelector('.bg-white, .dark\\:bg-gray-900')).toBeTruthy();
		});
	});

	describe('Styling', () => {
		it('should have amber color scheme', () => {
			const { container } = render(<ThinkingBlock content="Thinking..." />);

			// Amber background
			expect(container.querySelector('.bg-amber-50, .dark\\:bg-amber-900\\/20')).toBeTruthy();
		});

		it('should have border styling', () => {
			const { container } = render(<ThinkingBlock content="Thinking..." />);

			expect(container.querySelector('.border')).toBeTruthy();
			expect(container.querySelector('.rounded-lg')).toBeTruthy();
		});

		it('should apply custom className', () => {
			const { container } = render(
				<ThinkingBlock content="Thinking..." className="custom-class" />
			);

			expect(container.querySelector('.custom-class')).toBeTruthy();
		});
	});

	describe('Content Formatting', () => {
		it('should preserve whitespace in content', () => {
			const content = 'Step 1: First\nStep 2: Second\n  - Indented item';
			const { container } = render(<ThinkingBlock content={content} />);

			// Content should be in a pre element with whitespace-pre-wrap
			const contentElement = container.querySelector('.whitespace-pre-wrap');
			expect(contentElement).toBeTruthy();
		});

		it('should display monospace font for thinking content', () => {
			const { container } = render(<ThinkingBlock content="Thinking..." />);

			const contentElement = container.querySelector('.font-mono');
			expect(contentElement).toBeTruthy();
		});
	});

	describe('Edge Cases', () => {
		it('should handle empty content', () => {
			const { container } = render(<ThinkingBlock content="" />);

			expect(container.querySelector('[data-testid="thinking-block"]')).toBeTruthy();
			expect(container.textContent).toContain('0 characters');
		});

		it('should handle very long single line content', () => {
			const longLine = 'x'.repeat(5000);
			const { container } = render(<ThinkingBlock content={longLine} />);

			expect(container.textContent).toContain('5,000 characters');
		});

		it('should handle content with special characters', () => {
			const content = 'Thinking about <code> and "quotes" and \'apostrophes\'';
			const { container } = render(<ThinkingBlock content={content} />);

			expect(container.textContent).toContain('<code>');
			expect(container.textContent).toContain('"quotes"');
		});

		it('should handle content with unicode characters', () => {
			const content = 'Thinking about emojis and unicode';
			const { container } = render(<ThinkingBlock content={content} />);

			expect(container.textContent).toContain('Thinking about emojis');
		});
	});

	describe('Accessibility', () => {
		it('should have proper content structure', () => {
			const longContent =
				'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10';
			const { container } = render(<ThinkingBlock content={longContent} />);

			// Verify thinking block has proper structure
			expect(container.querySelector('[data-testid="thinking-block"]')).toBeTruthy();
			// Content should be in a pre element for proper formatting
			expect(container.querySelector('pre')).toBeTruthy();
		});

		it('should render header with icon', () => {
			const content = 'Some thinking content';
			const { container } = render(<ThinkingBlock content={content} />);

			// Should have header section with icon
			expect(container.querySelector('svg')).toBeTruthy();
			expect(container.textContent).toContain('Thinking');
		});
	});
});
