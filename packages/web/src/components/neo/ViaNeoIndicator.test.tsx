/**
 * Tests for ViaNeoIndicator component
 *
 * Verifies:
 * - Default render: shows sparkle icon and "via Neo" text
 * - Correct data-testid attribute for targeting in larger component tests
 * - Size variants: 'sm' (default) and 'xs'
 * - Custom className is applied
 * - Title/tooltip text is present for accessibility
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/preact';
import { ViaNeoIndicator } from './ViaNeoIndicator.tsx';

describe('ViaNeoIndicator', () => {
	afterEach(() => {
		cleanup();
	});

	it('renders the "via Neo" text', () => {
		const { getByTestId } = render(<ViaNeoIndicator />);
		const el = getByTestId('via-neo-indicator');
		expect(el.textContent).toContain('via Neo');
	});

	it('renders with data-testid="via-neo-indicator"', () => {
		const { getByTestId } = render(<ViaNeoIndicator />);
		expect(getByTestId('via-neo-indicator')).toBeTruthy();
	});

	it('has an accessible title attribute', () => {
		const { getByTestId } = render(<ViaNeoIndicator />);
		const el = getByTestId('via-neo-indicator');
		expect(el.getAttribute('title')).toBeTruthy();
	});

	it('renders an SVG sparkle icon inside', () => {
		const { getByTestId } = render(<ViaNeoIndicator />);
		const el = getByTestId('via-neo-indicator');
		expect(el.querySelector('svg')).toBeTruthy();
	});

	it('applies violet color class by default', () => {
		const { getByTestId } = render(<ViaNeoIndicator />);
		const el = getByTestId('via-neo-indicator');
		expect(el.className).toContain('text-violet-400');
	});

	it('accepts and applies a custom class', () => {
		const { getByTestId } = render(<ViaNeoIndicator class="my-custom-class" />);
		const el = getByTestId('via-neo-indicator');
		expect(el.className).toContain('my-custom-class');
	});

	it('sm size (default) uses text-xs', () => {
		const { getByTestId } = render(<ViaNeoIndicator size="sm" />);
		const el = getByTestId('via-neo-indicator');
		expect(el.className).toContain('text-xs');
	});

	it('xs size uses text-[10px]', () => {
		const { getByTestId } = render(<ViaNeoIndicator size="xs" />);
		const el = getByTestId('via-neo-indicator');
		expect(el.className).toContain('text-[10px]');
	});

	it('defaults to sm size when size prop is omitted', () => {
		const { getByTestId } = render(<ViaNeoIndicator />);
		const el = getByTestId('via-neo-indicator');
		expect(el.className).toContain('text-xs');
		expect(el.className).not.toContain('text-[10px]');
	});
});
