import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { MinimalStyleExploration } from './MinimalStyleExploration';

describe('MinimalStyleExploration', () => {
	afterEach(() => cleanup());

	it('renders the exploration page header', () => {
		const { container } = render(<MinimalStyleExploration />);
		expect(container.textContent).toContain('Minimal thread mode');
		expect(container.textContent).toContain('style explorations');
	});

	it('renders all 6 style sections', () => {
		const { container } = render(<MinimalStyleExploration />);
		// Each section has a numbered heading.
		expect(container.textContent).toContain('1. Slack-style');
		expect(container.textContent).toContain('2. Compact row');
		expect(container.textContent).toContain('3. Card per turn');
		expect(container.textContent).toContain('4. Timeline / dot');
		expect(container.textContent).toContain('5. Bubble / chat');
		expect(container.textContent).toContain('6. Terminal / log');
	});

	it('renders mock turns: two completed (CODER, REVIEWER) and one active CODER', () => {
		const { container } = render(<MinimalStyleExploration />);
		const text = container.textContent ?? '';
		// Both agent labels appear in every style — at least 6 occurrences each.
		const coderCount = (text.match(/CODER/g) ?? []).length;
		const reviewerCount = (text.match(/REVIEWER/g) ?? []).length;
		expect(coderCount).toBeGreaterThanOrEqual(12); // 2 turns × 6 styles
		expect(reviewerCount).toBeGreaterThanOrEqual(6); // 1 turn × 6 styles
	});

	it('shows the completed-turn final message in every style', () => {
		const { container } = render(<MinimalStyleExploration />);
		const text = container.textContent ?? '';
		// Completed CODER message shows in every style (6× — one Compact-row variant
		// truncates with ellipsis but the prefix is still present).
		const coderMessage = 'PR #1631 is clean and mergeable';
		const occurrences = text.split(coderMessage).length - 1;
		expect(occurrences).toBeGreaterThanOrEqual(6);
	});

	it('shows the live tool-call roster for the active turn', () => {
		const { container } = render(<MinimalStyleExploration />);
		const text = container.textContent ?? '';
		// Each of the 4 roster entries should appear in multiple styles.
		expect(text).toContain('bun run typecheck');
		expect(text).toContain('provisionExistingSpaces');
		expect(text).toContain('git status');
		// "Live" indicator (uppercased via CSS, but DOM text is "Live") must appear
		// for the active turn in every style.
		const liveCount = (text.match(/Live/g) ?? []).length;
		expect(liveCount).toBeGreaterThanOrEqual(6);
	});

	it('shows compact stats line components', () => {
		const { container } = render(<MinimalStyleExploration />);
		const text = container.textContent ?? '';
		expect(text).toContain('47'); // tool calls for CODER
		expect(text).toContain('128k'); // tokens for CODER (formatted)
		expect(text).toContain('$4.20');
		expect(text).toContain('$0.09');
	});
});
