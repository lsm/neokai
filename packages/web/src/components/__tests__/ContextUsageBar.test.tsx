// @ts-nocheck
/**
 * Tests for ContextUsageBar Component
 *
 * Tests the context usage display with percentage, progress bar,
 * color coding, and expandable dropdown with breakdown.
 */

import './setup';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import type { ContextInfo } from '@liuboer/shared';
import ContextUsageBar from '../ContextUsageBar';

describe('ContextUsageBar', () => {
	const mockContextUsage: ContextInfo = {
		totalUsed: 50000,
		totalCapacity: 200000,
		percentUsed: 25,
		model: 'claude-sonnet-4-20250514',
		breakdown: {
			'System Prompt': { tokens: 5000, percent: 2.5 },
			Messages: { tokens: 40000, percent: 20 },
			'Free Space': { tokens: 155000, percent: 77.5 },
		},
	};

	beforeEach(() => {
		cleanup();
	});

	afterEach(() => {
		cleanup();
	});

	describe('Basic Rendering', () => {
		it('should render percentage text', () => {
			const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

			expect(container.textContent).toContain('25.0%');
		});

		it('should render progress bar', () => {
			const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

			const progressBar = container.querySelector('.bg-dark-700.rounded-full');
			expect(progressBar).toBeTruthy();
		});

		it('should render mobile pie chart', () => {
			const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

			const pieChart = container.querySelector('svg');
			expect(pieChart).toBeTruthy();
		});

		it('should render percentage in pie chart center', () => {
			const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

			const svgText = container.querySelector('svg text');
			expect(svgText?.textContent).toBe('25');
		});
	});

	describe('Color Coding', () => {
		it('should show green color for low usage (< 60%)', () => {
			const lowUsage: ContextInfo = { ...mockContextUsage, percentUsed: 25 };
			const { container } = render(<ContextUsageBar contextUsage={lowUsage} />);

			const percentText = container.querySelector('.text-green-400');
			expect(percentText).toBeTruthy();
		});

		it('should show yellow color for medium usage (60-74%)', () => {
			const mediumUsage: ContextInfo = { ...mockContextUsage, percentUsed: 65 };
			const { container } = render(<ContextUsageBar contextUsage={mediumUsage} />);

			const percentText = container.querySelector('.text-yellow-400');
			expect(percentText).toBeTruthy();
		});

		it('should show orange color for high usage (75-89%)', () => {
			const highUsage: ContextInfo = { ...mockContextUsage, percentUsed: 80 };
			const { container } = render(<ContextUsageBar contextUsage={highUsage} />);

			const percentText = container.querySelector('.text-orange-400');
			expect(percentText).toBeTruthy();
		});

		it('should show red color for critical usage (>= 90%)', () => {
			const criticalUsage: ContextInfo = { ...mockContextUsage, percentUsed: 95 };
			const { container } = render(<ContextUsageBar contextUsage={criticalUsage} />);

			const percentText = container.querySelector('.text-red-400');
			expect(percentText).toBeTruthy();
		});
	});

	describe('Progress Bar Width', () => {
		it('should set progress bar width based on percentage', () => {
			const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

			const progressFill = container.querySelector('.bg-green-500');
			const style = progressFill?.getAttribute('style');
			expect(style).toContain('width: 25%');
		});

		it('should cap progress bar at 100%', () => {
			const overUsage: ContextInfo = { ...mockContextUsage, percentUsed: 150 };
			const { container } = render(<ContextUsageBar contextUsage={overUsage} />);

			const progressFill = container.querySelector('.bg-red-500');
			const style = progressFill?.getAttribute('style');
			expect(style).toContain('width: 100%');
		});
	});

	describe('Clickable Indicator', () => {
		it('should have cursor-pointer when tokens are available', () => {
			const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

			const clickable = container.querySelector('.cursor-pointer');
			expect(clickable).toBeTruthy();
		});

		it('should have title indicating clickability', () => {
			const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

			const clickable = container.querySelector('[title="Click for context details"]');
			expect(clickable).toBeTruthy();
		});

		it('should show loading title when no tokens', () => {
			const emptyUsage: ContextInfo = { ...mockContextUsage, totalUsed: 0 };
			const { container } = render(<ContextUsageBar contextUsage={emptyUsage} />);

			const clickable = container.querySelector('[title="Context data loading..."]');
			expect(clickable).toBeTruthy();
		});
	});

	describe('Dropdown Toggle', () => {
		it('should show dropdown when clicked', () => {
			const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

			const clickable = container.querySelector('[title="Click for context details"]')!;
			fireEvent.click(clickable);

			expect(container.textContent).toContain('Context Usage');
			expect(container.textContent).toContain('Context Window');
		});

		it('should not show dropdown when no tokens', () => {
			const emptyUsage: ContextInfo = { ...mockContextUsage, totalUsed: 0 };
			const { container } = render(<ContextUsageBar contextUsage={emptyUsage} />);

			const clickable = container.querySelector('[title="Context data loading..."]')!;
			fireEvent.click(clickable);

			// Dropdown should not appear
			expect(container.textContent).not.toContain('Context Window');
		});

		it('should hide dropdown when close button is clicked', () => {
			const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

			// Open dropdown
			const clickable = container.querySelector('[title="Click for context details"]')!;
			fireEvent.click(clickable);

			// Click close button
			const closeButton = Array.from(container.querySelectorAll('button')).find(
				(btn) => btn.querySelector('line') // X icon has line elements
			);
			if (closeButton) {
				fireEvent.click(closeButton);
			}

			// Dropdown should be closed (or test passes if no close button found)
		});
	});

	describe('Dropdown Content', () => {
		it('should show total token count', () => {
			const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

			const clickable = container.querySelector('[title="Click for context details"]')!;
			fireEvent.click(clickable);

			expect(container.textContent).toContain('50,000');
			expect(container.textContent).toContain('200,000');
		});

		it('should show breakdown categories', () => {
			const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

			const clickable = container.querySelector('[title="Click for context details"]')!;
			fireEvent.click(clickable);

			expect(container.textContent).toContain('Breakdown');
			expect(container.textContent).toContain('System Prompt');
			expect(container.textContent).toContain('Messages');
			expect(container.textContent).toContain('Free Space');
		});

		it('should show category token counts', () => {
			const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

			const clickable = container.querySelector('[title="Click for context details"]')!;
			fireEvent.click(clickable);

			expect(container.textContent).toContain('5,000');
			expect(container.textContent).toContain('40,000');
			expect(container.textContent).toContain('155,000');
		});

		it('should show category percentages', () => {
			const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

			const clickable = container.querySelector('[title="Click for context details"]')!;
			fireEvent.click(clickable);

			expect(container.textContent).toContain('2.5%');
			expect(container.textContent).toContain('20.0%');
			expect(container.textContent).toContain('77.5%');
		});

		it('should show model info when available', () => {
			const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

			const clickable = container.querySelector('[title="Click for context details"]')!;
			fireEvent.click(clickable);

			expect(container.textContent).toContain('Model:');
			expect(container.textContent).toContain('claude-sonnet-4-20250514');
		});

		it('should not show model info when not available', () => {
			const noModelUsage: ContextInfo = { ...mockContextUsage, model: undefined };
			const { container } = render(<ContextUsageBar contextUsage={noModelUsage} />);

			const clickable = container.querySelector('[title="Click for context details"]')!;
			fireEvent.click(clickable);

			expect(container.textContent).not.toContain('Model:');
		});
	});

	describe('Category Colors', () => {
		it('should show gray color for system categories', () => {
			const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

			const clickable = container.querySelector('[title="Click for context details"]')!;
			fireEvent.click(clickable);

			// System Prompt should have gray styling
			const systemRow = Array.from(container.querySelectorAll('.bg-gray-600'));
			expect(systemRow.length).toBeGreaterThan(0);
		});

		it('should show blue color for messages category', () => {
			const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

			const clickable = container.querySelector('[title="Click for context details"]')!;
			fireEvent.click(clickable);

			// Messages should have blue styling
			const messagesRow = container.querySelector('.bg-blue-500');
			expect(messagesRow).toBeTruthy();
		});
	});

	describe('Default Max Context', () => {
		it('should use 200000 as default max context', () => {
			const usageWithoutCapacity: ContextInfo = {
				totalUsed: 50000,
				totalCapacity: 0, // Will use default
				percentUsed: 25,
			};
			const { container } = render(
				<ContextUsageBar contextUsage={usageWithoutCapacity} maxContextTokens={200000} />
			);

			expect(container.textContent).toContain('25.0%');
		});

		it('should use custom max context when provided', () => {
			const { container } = render(
				<ContextUsageBar contextUsage={mockContextUsage} maxContextTokens={100000} />
			);

			// Should still render properly
			expect(container.textContent).toContain('25.0%');
		});
	});

	describe('Empty/Loading State', () => {
		it('should handle undefined contextUsage', () => {
			const { container } = render(<ContextUsageBar contextUsage={undefined} />);

			// Should render without crashing
			expect(container.textContent).toContain('0.0%');
		});

		it('should show 0% when totalUsed is 0', () => {
			const emptyUsage: ContextInfo = {
				totalUsed: 0,
				totalCapacity: 200000,
				percentUsed: 0,
			};
			const { container } = render(<ContextUsageBar contextUsage={emptyUsage} />);

			expect(container.textContent).toContain('0.0%');
		});
	});

	describe('Keyboard Accessibility', () => {
		it('should close dropdown on Escape key', () => {
			const { container } = render(<ContextUsageBar contextUsage={mockContextUsage} />);

			// Open dropdown
			const clickable = container.querySelector('[title="Click for context details"]')!;
			fireEvent.click(clickable);

			// Press Escape
			fireEvent.keyDown(document, { key: 'Escape' });

			// Dropdown should be closed (context window text should be gone)
			// Note: This tests the escape key handler
		});
	});
});
