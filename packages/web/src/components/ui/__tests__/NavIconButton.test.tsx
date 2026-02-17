// @ts-nocheck
/**
 * Tests for NavIconButton Component
 */

import { render } from '@testing-library/preact';
import { describe, it, expect, vi } from 'vitest';
import { NavIconButton } from '../NavIconButton';

describe('NavIconButton', () => {
	describe('Rendering', () => {
		it('should render icon children', () => {
			const { container } = render(
				<NavIconButton label="Test button">
					<span class="test-icon">Icon</span>
				</NavIconButton>
			);
			const icon = container.querySelector('.test-icon');
			expect(icon?.textContent).toBe('Icon');
		});

		it('should render with custom className', () => {
			const { container } = render(
				<NavIconButton label="Test" class="custom-class">
					<span>Icon</span>
				</NavIconButton>
			);
			const button = container.querySelector('button');
			expect(button?.className).toContain('custom-class');
		});

		it('should have button type by default', () => {
			const { container } = render(
				<NavIconButton label="Test">
					<span>Icon</span>
				</NavIconButton>
			);
			const button = container.querySelector('button');
			expect(button?.type).toBe('button');
		});
	});

	describe('Active State', () => {
		it('should have aria-pressed="false" when not active', () => {
			const { container } = render(
				<NavIconButton label="Test" active={false}>
					<span>Icon</span>
				</NavIconButton>
			);
			const button = container.querySelector('button');
			expect(button?.getAttribute('aria-pressed')).toBe('false');
		});

		it('should have aria-pressed="true" when active', () => {
			const { container } = render(
				<NavIconButton label="Test" active={true}>
					<span>Icon</span>
				</NavIconButton>
			);
			const button = container.querySelector('button');
			expect(button?.getAttribute('aria-pressed')).toBe('true');
		});

		it('should have aria-pressed="false" by default (active not specified)', () => {
			const { container } = render(
				<NavIconButton label="Test">
					<span>Icon</span>
				</NavIconButton>
			);
			const button = container.querySelector('button');
			expect(button?.getAttribute('aria-pressed')).toBe('false');
		});

		it('should apply active CSS classes when active', () => {
			const { container } = render(
				<NavIconButton label="Test" active={true}>
					<span>Icon</span>
				</NavIconButton>
			);
			const button = container.querySelector('button');
			expect(button?.className).toContain('bg-dark-800');
			expect(button?.className).toContain('text-gray-100');
		});

		it('should apply inactive CSS classes when not active', () => {
			const { container } = render(
				<NavIconButton label="Test" active={false}>
					<span>Icon</span>
				</NavIconButton>
			);
			const button = container.querySelector('button');
			expect(button?.className).toContain('text-gray-400');
			expect(button?.className).toContain('hover:text-gray-200');
			expect(button?.className).toContain('hover:bg-dark-850');
		});

		it('should apply inactive CSS classes by default', () => {
			const { container } = render(
				<NavIconButton label="Test">
					<span>Icon</span>
				</NavIconButton>
			);
			const button = container.querySelector('button');
			expect(button?.className).toContain('text-gray-400');
		});
	});

	describe('Tooltip and Label', () => {
		it('should display tooltip title from label prop', () => {
			const { container } = render(
				<NavIconButton label="Settings">
					<span>Icon</span>
				</NavIconButton>
			);
			const button = container.querySelector('button');
			expect(button?.title).toBe('Settings');
		});

		it('should have aria-label matching label prop', () => {
			const { container } = render(
				<NavIconButton label="Settings">
					<span>Icon</span>
				</NavIconButton>
			);
			const button = container.querySelector('button');
			expect(button?.getAttribute('aria-label')).toBe('Settings');
		});
	});

	describe('Disabled State', () => {
		it('should not be disabled by default', () => {
			const { container } = render(
				<NavIconButton label="Test">
					<span>Icon</span>
				</NavIconButton>
			);
			const button = container.querySelector('button');
			expect(button?.disabled).toBe(false);
		});

		it('should be disabled when disabled prop is true', () => {
			const { container } = render(
				<NavIconButton label="Test" disabled={true}>
					<span>Icon</span>
				</NavIconButton>
			);
			const button = container.querySelector('button');
			expect(button?.disabled).toBe(true);
		});

		it('should have disabled opacity style', () => {
			const { container } = render(
				<NavIconButton label="Test" disabled={true}>
					<span>Icon</span>
				</NavIconButton>
			);
			const button = container.querySelector('button');
			expect(button?.className).toContain('disabled:opacity-40');
			expect(button?.className).toContain('disabled:cursor-not-allowed');
		});
	});

	describe('Interactions', () => {
		it('should call onClick when clicked', () => {
			const onClick = vi.fn();
			const { container } = render(
				<NavIconButton label="Test" onClick={onClick}>
					<span>Icon</span>
				</NavIconButton>
			);
			const button = container.querySelector('button');

			button?.click();

			expect(onClick).toHaveBeenCalledTimes(1);
		});

		it('should not call onClick when disabled', () => {
			const onClick = vi.fn();
			const { container } = render(
				<NavIconButton label="Test" onClick={onClick} disabled={true}>
					<span>Icon</span>
				</NavIconButton>
			);
			const button = container.querySelector('button');

			button?.click();

			expect(onClick).not.toHaveBeenCalled();
		});

		it('should call onClick when active button is clicked', () => {
			const onClick = vi.fn();
			const { container } = render(
				<NavIconButton label="Test" onClick={onClick} active={true}>
					<span>Icon</span>
				</NavIconButton>
			);
			const button = container.querySelector('button');

			button?.click();

			expect(onClick).toHaveBeenCalledTimes(1);
		});
	});

	describe('Accessibility', () => {
		it('should have focus-visible styles', () => {
			const { container } = render(
				<NavIconButton label="Test">
					<span>Icon</span>
				</NavIconButton>
			);
			const button = container.querySelector('button');
			expect(button?.className).toContain('focus-visible:outline-none');
			expect(button?.className).toContain('focus-visible:ring-2');
			expect(button?.className).toContain('focus-visible:ring-blue-500');
		});

		it('should have fixed dimensions for consistent layout', () => {
			const { container } = render(
				<NavIconButton label="Test">
					<span>Icon</span>
				</NavIconButton>
			);
			const button = container.querySelector('button');
			expect(button?.className).toContain('w-12');
			expect(button?.className).toContain('h-12');
		});

		it('should have rounded corners', () => {
			const { container } = render(
				<NavIconButton label="Test">
					<span>Icon</span>
				</NavIconButton>
			);
			const button = container.querySelector('button');
			expect(button?.className).toContain('rounded-xl');
		});

		it('should have flexbox centering for icon', () => {
			const { container } = render(
				<NavIconButton label="Test">
					<span>Icon</span>
				</NavIconButton>
			);
			const button = container.querySelector('button');
			expect(button?.className).toContain('flex');
			expect(button?.className).toContain('items-center');
			expect(button?.className).toContain('justify-center');
		});

		it('should have transition styles', () => {
			const { container } = render(
				<NavIconButton label="Test">
					<span>Icon</span>
				</NavIconButton>
			);
			const button = container.querySelector('button');
			expect(button?.className).toContain('transition-all');
			expect(button?.className).toContain('duration-150');
		});
	});
});
