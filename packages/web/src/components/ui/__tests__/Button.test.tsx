/**
 * Tests for Button Component
 */

import './setup'; // Setup Happy-DOM
import { describe, it, expect } from 'bun:test';
import { render } from '@testing-library/preact';
import { Button } from '../Button';

describe('Button', () => {
	describe('Rendering', () => {
		it('should render children', () => {
			const { container } = render(<Button>Click Me</Button>);
			const button = container.querySelector('button');
			expect(button?.textContent).toBe('Click Me');
		});

		it('should render with custom className', () => {
			const { container } = render(<Button class="custom-class">Test</Button>);
			const button = container.querySelector('button');
			expect(button?.className).toContain('custom-class');
		});

		it('should render with icon', () => {
			const { container } = render(
				<Button icon={<span class="icon">Icon</span>}>With Icon</Button>
			);
			const icon = container.querySelector('.icon');
			expect(icon?.textContent).toBe('Icon');
		});
	});

	describe('Variants', () => {
		it('should render primary variant by default', () => {
			const { container } = render(<Button>Primary</Button>);
			const button = container.querySelector('button');
			expect(button?.className).toContain('bg-blue-600');
		});

		it('should render secondary variant', () => {
			const { container } = render(<Button variant="secondary">Secondary</Button>);
			const button = container.querySelector('button');
			expect(button?.className).toContain('bg-dark-800');
		});

		it('should render ghost variant', () => {
			const { container } = render(<Button variant="ghost">Ghost</Button>);
			const button = container.querySelector('button');
			expect(button?.className).toContain('hover:bg-dark-800');
		});

		it('should render danger variant', () => {
			const { container } = render(<Button variant="danger">Danger</Button>);
			const button = container.querySelector('button');
			expect(button?.className).toContain('bg-red-600');
		});
	});

	describe('Sizes', () => {
		it('should render medium size by default', () => {
			const { container } = render(<Button>Medium</Button>);
			const button = container.querySelector('button');
			expect(button?.className).toContain('px-4');
		});

		it('should render small size', () => {
			const { container } = render(<Button size="sm">Small</Button>);
			const button = container.querySelector('button');
			expect(button?.className).toContain('px-3');
		});

		it('should render large size', () => {
			const { container } = render(<Button size="lg">Large</Button>);
			const button = container.querySelector('button');
			expect(button?.className).toContain('px-6');
		});
	});

	describe('States', () => {
		it('should be disabled when disabled prop is true', () => {
			const { container } = render(<Button disabled>Disabled</Button>);
			const button = container.querySelector('button');
			expect(button?.disabled).toBe(true);
		});

		it('should show loading spinner when loading', () => {
			const { container } = render(<Button loading>Loading</Button>);
			const spinner = container.querySelector('.animate-spin');
			expect(spinner).toBeTruthy();
		});

		it('should be disabled when loading', () => {
			const { container } = render(<Button loading>Loading</Button>);
			const button = container.querySelector('button');
			expect(button?.disabled).toBe(true);
		});

		it('should hide icon when loading', () => {
			const { container } = render(
				<Button loading icon={<span class="icon">Icon</span>}>
					Loading
				</Button>
			);
			const icon = container.querySelector('.icon');
			expect(icon).toBeNull();
		});
	});

	describe('Layout', () => {
		it('should render full width when fullWidth is true', () => {
			const { container } = render(<Button fullWidth>Full Width</Button>);
			const button = container.querySelector('button');
			expect(button?.className).toContain('w-full');
		});

		it('should not render full width by default', () => {
			const { container } = render(<Button>Normal Width</Button>);
			const button = container.querySelector('button');
			expect(button?.className).not.toContain('w-full');
		});
	});

	describe('Interactions', () => {
		it('should call onClick when clicked', () => {
			const onClick = mock(() => {});
			const { container } = render(<Button onClick={onClick}>Clickable</Button>);
			const button = container.querySelector('button');

			button?.click();

			expect(onClick).toHaveBeenCalledTimes(1);
		});

		it('should not call onClick when disabled', () => {
			const onClick = mock(() => {});
			const { container } = render(
				<Button onClick={onClick} disabled>
					Disabled
				</Button>
			);
			const button = container.querySelector('button');

			button?.click();

			// Disabled buttons don't fire click events
			expect(onClick).not.toHaveBeenCalled();
		});

		it('should not call onClick when loading', () => {
			const onClick = mock(() => {});
			const { container } = render(
				<Button onClick={onClick} loading>
					Loading
				</Button>
			);
			const button = container.querySelector('button');

			button?.click();

			expect(onClick).not.toHaveBeenCalled();
		});
	});

	describe('Button Types', () => {
		it('should default to button type', () => {
			const { container } = render(<Button>Button</Button>);
			const button = container.querySelector('button');
			expect(button?.type).toBe('button');
		});

		it('should render submit type', () => {
			const { container } = render(<Button type="submit">Submit</Button>);
			const button = container.querySelector('button');
			expect(button?.type).toBe('submit');
		});

		it('should render reset type', () => {
			const { container } = render(<Button type="reset">Reset</Button>);
			const button = container.querySelector('button');
			expect(button?.type).toBe('reset');
		});
	});

	describe('Additional Props', () => {
		it('should pass through additional HTML attributes', () => {
			const { container } = render(
				<Button data-testid="test-button" aria-label="Test Button">
					Test
				</Button>
			);
			const button = container.querySelector('button');
			expect(button?.getAttribute('data-testid')).toBe('test-button');
			expect(button?.getAttribute('aria-label')).toBe('Test Button');
		});
	});

	describe('Accessibility', () => {
		it('should have focus-visible styles', () => {
			const { container } = render(<Button>Accessible</Button>);
			const button = container.querySelector('button');
			expect(button?.className).toContain('focus-visible:outline-none');
			expect(button?.className).toContain('focus-visible:ring-2');
		});

		it('should have disabled cursor when disabled', () => {
			const { container } = render(<Button disabled>Disabled</Button>);
			const button = container.querySelector('button');
			expect(button?.className).toContain('disabled:cursor-not-allowed');
		});
	});
});
