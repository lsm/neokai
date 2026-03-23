/**
 * Tests for CollapsibleSection Component
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/preact';
import { CollapsibleSection } from './CollapsibleSection';

describe('CollapsibleSection', () => {
	afterEach(() => cleanup());

	it('renders title and children when expanded by default', () => {
		const { getByText } = render(
			<CollapsibleSection title="Goals">
				<div>Goal content</div>
			</CollapsibleSection>
		);

		expect(getByText('Goals')).toBeTruthy();
		expect(getByText('Goal content')).toBeTruthy();
		expect(getByText('▼')).toBeTruthy();
	});

	it('hides children when defaultExpanded is false', () => {
		const { getByText, queryByText } = render(
			<CollapsibleSection title="Sessions" defaultExpanded={false}>
				<div>Session content</div>
			</CollapsibleSection>
		);

		expect(getByText('Sessions')).toBeTruthy();
		expect(queryByText('Session content')).toBeNull();
		expect(getByText('▶')).toBeTruthy();
	});

	it('toggles children visibility on header click', () => {
		const { getByText, queryByText, getByRole } = render(
			<CollapsibleSection title="Tasks">
				<div>Task content</div>
			</CollapsibleSection>
		);

		expect(getByText('Task content')).toBeTruthy();

		// Collapse
		fireEvent.click(getByRole('button'));
		expect(queryByText('Task content')).toBeNull();
		expect(getByText('▶')).toBeTruthy();

		// Expand again
		fireEvent.click(getByRole('button'));
		expect(getByText('Task content')).toBeTruthy();
		expect(getByText('▼')).toBeTruthy();
	});

	it('sets aria-expanded attribute correctly', () => {
		const { getByRole } = render(
			<CollapsibleSection title="Goals">
				<div>Content</div>
			</CollapsibleSection>
		);

		const button = getByRole('button');
		expect(button.getAttribute('aria-expanded')).toBe('true');
		expect(button.getAttribute('aria-label')).toBe('Goals section');

		fireEvent.click(button);
		expect(button.getAttribute('aria-expanded')).toBe('false');
	});

	it('renders count badge when count is provided', () => {
		const { getByText } = render(
			<CollapsibleSection title="Goals" count={5}>
				<div>Content</div>
			</CollapsibleSection>
		);

		expect(getByText('(5)')).toBeTruthy();
	});

	it('renders count badge with zero', () => {
		const { getByText } = render(
			<CollapsibleSection title="Goals" count={0}>
				<div>Content</div>
			</CollapsibleSection>
		);

		expect(getByText('(0)')).toBeTruthy();
	});

	it('does not render count badge when count is undefined', () => {
		const { queryByText } = render(
			<CollapsibleSection title="Goals">
				<div>Content</div>
			</CollapsibleSection>
		);

		expect(queryByText('(', { exact: false })).toBeNull();
	});

	it('renders headerRight slot', () => {
		const { getByText } = render(
			<CollapsibleSection title="Sessions" headerRight={<span>+</span>}>
				<div>Content</div>
			</CollapsibleSection>
		);

		expect(getByText('+')).toBeTruthy();
	});

	it('headerRight click does not toggle section', () => {
		const { getByText, queryByText } = render(
			<CollapsibleSection title="Sessions" headerRight={<button type="button">+</button>}>
				<div>Content</div>
			</CollapsibleSection>
		);

		// Click the + button in headerRight (separate from toggle button)
		fireEvent.click(getByText('+'));

		// Section should still be expanded (not toggled)
		expect(queryByText('Content')).toBeTruthy();
	});
});
