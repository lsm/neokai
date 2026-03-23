/**
 * Tests for RuntimeMessageRenderer Component
 *
 * Covers all four runtime message types:
 * - status: centered divider with text
 * - rate_limited: amber notification card with role, text, resetsAt
 * - model_fallback: amber notification card with role, fromModel, toModel
 * - leader_summary: purple context card with summary text
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/preact';
import { RuntimeMessageRenderer } from '../RuntimeMessageRenderer';
import type { RuntimeMessage } from '../../../hooks/useTurnBlocks';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';

// Mock MarkdownRenderer to avoid complex markdown dependencies in unit tests
vi.mock('../../chat/MarkdownRenderer', () => ({
	default: ({ content, class: cls }: { content: string; class?: string }) => (
		<div data-testid="markdown-renderer" class={cls}>
			{content}
		</div>
	),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRuntimeMessage(msgFields: Record<string, unknown>): RuntimeMessage {
	return {
		type: 'runtime',
		message: msgFields as SDKMessage,
		index: 0,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RuntimeMessageRenderer', () => {
	afterEach(() => {
		cleanup();
	});

	describe('data-testid', () => {
		it('renders data-testid="runtime-message" for status type', () => {
			const { container } = render(
				<RuntimeMessageRenderer message={makeRuntimeMessage({ type: 'status', text: 'hello' })} />
			);
			expect(container.querySelector('[data-testid="runtime-message"]')).toBeTruthy();
		});

		it('renders data-testid="runtime-message" for rate_limited type', () => {
			const { container } = render(
				<RuntimeMessageRenderer
					message={makeRuntimeMessage({ type: 'rate_limited', text: 'Slow down' })}
				/>
			);
			expect(container.querySelector('[data-testid="runtime-message"]')).toBeTruthy();
		});

		it('renders data-testid="runtime-message" for model_fallback type', () => {
			const { container } = render(
				<RuntimeMessageRenderer
					message={makeRuntimeMessage({
						type: 'model_fallback',
						fromModel: 'claude-3',
						toModel: 'claude-2',
					})}
				/>
			);
			expect(container.querySelector('[data-testid="runtime-message"]')).toBeTruthy();
		});

		it('renders data-testid="runtime-message" for leader_summary type', () => {
			const { container } = render(
				<RuntimeMessageRenderer
					message={makeRuntimeMessage({ type: 'leader_summary', text: 'Summary text' })}
				/>
			);
			expect(container.querySelector('[data-testid="runtime-message"]')).toBeTruthy();
		});
	});

	describe('status message', () => {
		it('renders status text inside a divider layout', () => {
			const { getByText } = render(
				<RuntimeMessageRenderer
					message={makeRuntimeMessage({ type: 'status', text: 'Task started' })}
				/>
			);
			expect(getByText('Task started')).toBeTruthy();
		});

		it('falls back to "Status update" when text is missing', () => {
			const { getByText } = render(
				<RuntimeMessageRenderer message={makeRuntimeMessage({ type: 'status' })} />
			);
			expect(getByText('Status update')).toBeTruthy();
		});

		it('applies correct text class for status text', () => {
			const { container } = render(
				<RuntimeMessageRenderer
					message={makeRuntimeMessage({ type: 'status', text: 'Step done' })}
				/>
			);
			const span = container.querySelector('span.text-xs.text-gray-500');
			expect(span).toBeTruthy();
			expect(span?.textContent).toBe('Step done');
		});

		it('renders two horizontal line dividers', () => {
			const { container } = render(
				<RuntimeMessageRenderer message={makeRuntimeMessage({ type: 'status', text: 'Step' })} />
			);
			const lines = container.querySelectorAll('.h-px.bg-dark-700');
			expect(lines).toHaveLength(2);
		});
	});

	describe('rate_limited message', () => {
		it('renders rate limit text', () => {
			const { getByText } = render(
				<RuntimeMessageRenderer
					message={makeRuntimeMessage({ type: 'rate_limited', text: 'Too many requests' })}
				/>
			);
			expect(getByText('Too many requests')).toBeTruthy();
		});

		it('falls back to "Rate limit reached" when text is missing', () => {
			const { getByText } = render(
				<RuntimeMessageRenderer message={makeRuntimeMessage({ type: 'rate_limited' })} />
			);
			expect(getByText('Rate limit reached')).toBeTruthy();
		});

		it('displays "Leader rate limited" for leader sessionRole', () => {
			const { getByText } = render(
				<RuntimeMessageRenderer
					message={makeRuntimeMessage({
						type: 'rate_limited',
						sessionRole: 'leader',
						text: 'slow',
					})}
				/>
			);
			expect(getByText('Leader rate limited')).toBeTruthy();
		});

		it('displays "Worker rate limited" for worker sessionRole', () => {
			const { getByText } = render(
				<RuntimeMessageRenderer
					message={makeRuntimeMessage({
						type: 'rate_limited',
						sessionRole: 'worker',
						text: 'slow',
					})}
				/>
			);
			expect(getByText('Worker rate limited')).toBeTruthy();
		});

		it('displays "Agent rate limited" for unknown sessionRole', () => {
			const { getByText } = render(
				<RuntimeMessageRenderer
					message={makeRuntimeMessage({ type: 'rate_limited', text: 'slow' })}
				/>
			);
			expect(getByText('Agent rate limited')).toBeTruthy();
		});

		it('renders text as-is without appending a duplicate reset time', () => {
			// The daemon already embeds the time in text (e.g. "Pausing until 12:30:00 PM.")
			// Appending a "Resets at" suffix from the resetsAt field would double-display the time.
			const now = new Date('2025-01-01T12:30:00').getTime();
			const { container } = render(
				<RuntimeMessageRenderer
					message={makeRuntimeMessage({
						type: 'rate_limited',
						text: 'Rate limit detected. Pausing until 12:30:00 PM.',
						resetsAt: now,
					})}
				/>
			);
			const p = container.querySelector('p.text-xs');
			expect(p?.textContent).toBe('Rate limit detected. Pausing until 12:30:00 PM.');
			expect(p?.textContent).not.toContain('Resets at');
		});

		it('applies amber border and background styling', () => {
			const { container } = render(
				<RuntimeMessageRenderer message={makeRuntimeMessage({ type: 'rate_limited', text: 'x' })} />
			);
			const card = container.querySelector('[data-testid="runtime-message"]');
			expect(card?.className).toContain('border-amber-700/50');
			expect(card?.className).toContain('bg-amber-950/20');
		});
	});

	describe('model_fallback message', () => {
		it('renders fromModel and toModel', () => {
			const { container } = render(
				<RuntimeMessageRenderer
					message={makeRuntimeMessage({
						type: 'model_fallback',
						fromModel: 'claude-3-opus',
						toModel: 'claude-3-sonnet',
					})}
				/>
			);
			const p = container.querySelector('p.text-xs');
			expect(p?.textContent).toContain('claude-3-opus');
			expect(p?.textContent).toContain('claude-3-sonnet');
		});

		it('falls back to "Previous model" and "New model" when fields are missing', () => {
			const { container } = render(
				<RuntimeMessageRenderer message={makeRuntimeMessage({ type: 'model_fallback' })} />
			);
			const p = container.querySelector('p.text-xs');
			expect(p?.textContent).toContain('Previous model');
			expect(p?.textContent).toContain('New model');
		});

		it('displays "Leader model switched" for leader sessionRole', () => {
			const { getByText } = render(
				<RuntimeMessageRenderer
					message={makeRuntimeMessage({
						type: 'model_fallback',
						sessionRole: 'leader',
						fromModel: 'a',
						toModel: 'b',
					})}
				/>
			);
			expect(getByText('Leader model switched')).toBeTruthy();
		});

		it('displays "Worker model switched" for worker sessionRole', () => {
			const { getByText } = render(
				<RuntimeMessageRenderer
					message={makeRuntimeMessage({
						type: 'model_fallback',
						sessionRole: 'worker',
						fromModel: 'a',
						toModel: 'b',
					})}
				/>
			);
			expect(getByText('Worker model switched')).toBeTruthy();
		});

		it('displays "Agent model switched" for unknown sessionRole', () => {
			const { getByText } = render(
				<RuntimeMessageRenderer
					message={makeRuntimeMessage({ type: 'model_fallback', fromModel: 'a', toModel: 'b' })}
				/>
			);
			expect(getByText('Agent model switched')).toBeTruthy();
		});

		it('applies amber border and background styling', () => {
			const { container } = render(
				<RuntimeMessageRenderer message={makeRuntimeMessage({ type: 'model_fallback' })} />
			);
			const card = container.querySelector('[data-testid="runtime-message"]');
			expect(card?.className).toContain('border-amber-700/50');
			expect(card?.className).toContain('bg-amber-950/20');
		});
	});

	describe('leader_summary message', () => {
		it('renders summary text via MarkdownRenderer', () => {
			const { getByTestId } = render(
				<RuntimeMessageRenderer
					message={makeRuntimeMessage({ type: 'leader_summary', text: 'The plan is complete.' })}
				/>
			);
			const md = getByTestId('markdown-renderer');
			expect(md.textContent).toBe('The plan is complete.');
		});

		it('strips "[Turn Summary] " prefix from text', () => {
			const { getByTestId } = render(
				<RuntimeMessageRenderer
					message={makeRuntimeMessage({
						type: 'leader_summary',
						text: '[Turn Summary] Finished milestone 1.',
					})}
				/>
			);
			const md = getByTestId('markdown-renderer');
			expect(md.textContent).toBe('Finished milestone 1.');
		});

		it('does not strip other prefixes', () => {
			const { getByTestId } = render(
				<RuntimeMessageRenderer
					message={makeRuntimeMessage({ type: 'leader_summary', text: 'Some other text.' })}
				/>
			);
			const md = getByTestId('markdown-renderer');
			expect(md.textContent).toBe('Some other text.');
		});

		it('shows "Turn Summary" heading', () => {
			const { getByText } = render(
				<RuntimeMessageRenderer
					message={makeRuntimeMessage({ type: 'leader_summary', text: 'Done.' })}
				/>
			);
			expect(getByText('Turn Summary')).toBeTruthy();
		});

		it('applies purple border and background styling', () => {
			const { container } = render(
				<RuntimeMessageRenderer
					message={makeRuntimeMessage({ type: 'leader_summary', text: 'Done.' })}
				/>
			);
			const card = container.querySelector('[data-testid="runtime-message"]');
			expect(card?.className).toContain('border-purple-800/40');
			expect(card?.className).toContain('bg-purple-950/20');
		});

		it('passes "text-sm text-gray-300" class to MarkdownRenderer', () => {
			const { getByTestId } = render(
				<RuntimeMessageRenderer
					message={makeRuntimeMessage({ type: 'leader_summary', text: 'Done.' })}
				/>
			);
			const md = getByTestId('markdown-renderer');
			expect(md.className).toContain('text-sm');
			expect(md.className).toContain('text-gray-300');
		});

		it('renders without crash when text field is missing (empty string fallback)', () => {
			const { getByTestId, getByText } = render(
				<RuntimeMessageRenderer message={makeRuntimeMessage({ type: 'leader_summary' })} />
			);
			// Card and heading still render
			expect(getByTestId('runtime-message')).toBeTruthy();
			expect(getByText('Turn Summary')).toBeTruthy();
			// MarkdownRenderer receives an empty string
			const md = getByTestId('markdown-renderer');
			expect(md.textContent).toBe('');
		});
	});

	describe('unknown message type', () => {
		it('renders null for unknown type', () => {
			const { container } = render(
				<RuntimeMessageRenderer message={makeRuntimeMessage({ type: 'unknown_type', text: 'x' })} />
			);
			expect(container.querySelector('[data-testid="runtime-message"]')).toBeNull();
			expect(container.firstChild).toBeNull();
		});
	});
});
