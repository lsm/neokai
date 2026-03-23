/**
 * Tests for TurnSummaryBlock component
 *
 * Covers:
 * - Basic rendering: agent name, role color class, stats badges, duration
 * - Active turn: pulsing animation class and data-testid="turn-block-active"
 * - Inactive turn: no animation / no active indicator
 * - Error turn: error styling and error message
 * - Selected state: highlighted border when isSelected=true
 * - Click handler: onClick called with turn data
 * - Last action badge: last action text displayed
 * - Stats display: correct counts
 * - Zero stats: badges with zero counts hidden
 * - data-testid attributes: all required attributes present
 * - Human turn: agentRole="human" → label "Human"
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/preact';
import { TurnSummaryBlock } from '../TurnSummaryBlock';
import type { TurnBlock } from '../../../hooks/useTurnBlocks';
import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';

// ---------------------------------------------------------------------------
// Mock SDKMessageRenderer to avoid full SDK rendering in unit tests
// ---------------------------------------------------------------------------

vi.mock('../../sdk/SDKMessageRenderer', () => ({
	SDKMessageRenderer: ({ message }: { message: SDKMessage }) => {
		const m = message as { type: string };
		return <span data-testid="mock-sdk-renderer">sdk:{m.type}</span>;
	},
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAssistantMsg(text = 'Hello'): SDKMessage {
	return {
		type: 'assistant',
		message: { role: 'assistant', content: [{ type: 'text', text }] },
	} as unknown as SDKMessage;
}

function makeTurn(overrides: Partial<TurnBlock> = {}): TurnBlock {
	return {
		id: 'turn-1',
		sessionId: 'session-1',
		agentRole: 'coder',
		agentLabel: 'Coder',
		startTime: 1_000_000,
		endTime: 1_150_000, // 2m 30s
		messageCount: 3,
		toolCallCount: 2,
		thinkingCount: 1,
		assistantCount: 1,
		lastAction: 'Bash',
		previewMessage: makeAssistantMsg(),
		isActive: false,
		isError: false,
		errorMessage: null,
		messages: [],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TurnSummaryBlock', () => {
	afterEach(() => {
		cleanup();
	});

	// ── Basic rendering ─────────────────────────────────────────────────────

	describe('basic rendering', () => {
		it('renders agent name', () => {
			const { container } = render(<TurnSummaryBlock turn={makeTurn()} onClick={vi.fn()} />);
			const nameEl = container.querySelector('[data-testid="turn-block-agent-name"]');
			expect(nameEl).toBeTruthy();
			expect(nameEl!.textContent).toBe('Coder');
		});

		it('applies labelColor class from ROLE_COLORS for coder', () => {
			const { container } = render(
				<TurnSummaryBlock turn={makeTurn({ agentRole: 'coder' })} onClick={vi.fn()} />
			);
			const nameEl = container.querySelector('[data-testid="turn-block-agent-name"]');
			expect(nameEl!.className).toContain('text-blue-400');
		});

		it('renders turn duration when endTime is set', () => {
			const turn = makeTurn({ startTime: 0, endTime: 150_000 }); // 2m 30s
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			// duration span is the last element in the title row
			expect(container.textContent).toContain('2m 30s');
		});

		it('renders "running..." when endTime is null', () => {
			const turn = makeTurn({ endTime: null });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			expect(container.textContent).toContain('running...');
		});

		it('renders last action badge', () => {
			const turn = makeTurn({ lastAction: 'Read' });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			expect(container.textContent).toContain('Read');
		});

		it('does not render last action badge when lastAction is null', () => {
			const turn = makeTurn({ lastAction: null });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			// No badge text from lastAction
			const titleRow = container.querySelector(
				'[data-testid="turn-block-agent-name"]'
			)?.parentElement;
			// Only agent name + duration span expected, no badge
			const spans = titleRow?.querySelectorAll('span') ?? [];
			// Agent name span + duration span = 2; no badge span
			expect(spans.length).toBe(2);
		});

		it('renders SDKMessageRenderer for preview', () => {
			const { container } = render(<TurnSummaryBlock turn={makeTurn()} onClick={vi.fn()} />);
			expect(container.querySelector('[data-testid="mock-sdk-renderer"]')).toBeTruthy();
		});

		it('renders "No messages" when previewMessage is null', () => {
			const turn = makeTurn({ previewMessage: null });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			const preview = container.querySelector('[data-testid="turn-block-preview"]');
			expect(preview!.textContent).toContain('No messages');
		});
	});

	// ── Stats badges ─────────────────────────────────────────────────────────

	describe('stats badges', () => {
		it('renders all three stat badges when counts are non-zero', () => {
			const turn = makeTurn({ toolCallCount: 3, thinkingCount: 2, assistantCount: 4 });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			const stats = container.querySelector('[data-testid="turn-block-stats"]');
			expect(stats!.textContent).toContain('3');
			expect(stats!.textContent).toContain('2');
			expect(stats!.textContent).toContain('4');
		});

		it('hides tool calls badge when count is 0', () => {
			const turn = makeTurn({ toolCallCount: 0, thinkingCount: 1, assistantCount: 1 });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			const stats = container.querySelector('[data-testid="turn-block-stats"]');
			// Only 2 pill badges (thinking + assistant)
			expect(stats!.querySelectorAll('span').length).toBe(2);
		});

		it('hides thinking badge when count is 0', () => {
			const turn = makeTurn({ toolCallCount: 1, thinkingCount: 0, assistantCount: 1 });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			const stats = container.querySelector('[data-testid="turn-block-stats"]');
			expect(stats!.querySelectorAll('span').length).toBe(2);
		});

		it('hides assistant badge when count is 0', () => {
			const turn = makeTurn({ toolCallCount: 1, thinkingCount: 1, assistantCount: 0 });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			const stats = container.querySelector('[data-testid="turn-block-stats"]');
			expect(stats!.querySelectorAll('span').length).toBe(2);
		});

		it('renders no stat badges when all counts are 0', () => {
			const turn = makeTurn({ toolCallCount: 0, thinkingCount: 0, assistantCount: 0 });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			const stats = container.querySelector('[data-testid="turn-block-stats"]');
			expect(stats!.querySelectorAll('span').length).toBe(0);
		});
	});

	// ── Active state ──────────────────────────────────────────────────────────

	describe('active turn', () => {
		it('renders data-testid="turn-block-active" indicator when isActive', () => {
			const turn = makeTurn({ isActive: true, endTime: null });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			expect(container.querySelector('[data-testid="turn-block-active"]')).toBeTruthy();
		});

		it('does NOT render active indicator when isActive is false', () => {
			const turn = makeTurn({ isActive: false });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			expect(container.querySelector('[data-testid="turn-block-active"]')).toBeNull();
		});

		it('applies animate-pulse class on root when isActive', () => {
			const turn = makeTurn({ isActive: true, endTime: null });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			const root = container.querySelector('[data-testid="turn-block"]');
			expect(root!.className).toContain('animate-pulse');
		});

		it('does NOT apply animate-pulse on root when inactive', () => {
			const turn = makeTurn({ isActive: false });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			const root = container.querySelector('[data-testid="turn-block"]');
			expect(root!.className).not.toContain('animate-pulse');
		});
	});

	// ── Selected state ────────────────────────────────────────────────────────

	describe('selected state', () => {
		it('applies ring-1 ring-blue-500 when isSelected=true', () => {
			const turn = makeTurn();
			const { container } = render(
				<TurnSummaryBlock turn={turn} onClick={vi.fn()} isSelected={true} />
			);
			const root = container.querySelector('[data-testid="turn-block"]');
			expect(root!.className).toContain('ring-1');
			expect(root!.className).toContain('ring-blue-500');
		});

		it('does NOT apply ring when isSelected=false', () => {
			const turn = makeTurn();
			const { container } = render(
				<TurnSummaryBlock turn={turn} onClick={vi.fn()} isSelected={false} />
			);
			const root = container.querySelector('[data-testid="turn-block"]');
			expect(root!.className).not.toContain('ring-blue-500');
		});

		it('does NOT apply ring when isSelected prop is omitted (default=false)', () => {
			const turn = makeTurn();
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			const root = container.querySelector('[data-testid="turn-block"]');
			expect(root!.className).not.toContain('ring-blue-500');
		});
	});

	// ── Error state ───────────────────────────────────────────────────────────

	describe('error turn', () => {
		it('renders error message when isError and errorMessage set', () => {
			const turn = makeTurn({ isError: true, errorMessage: 'Something went wrong' });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			expect(container.textContent).toContain('Something went wrong');
		});

		it('applies red border styling when isError', () => {
			const turn = makeTurn({ isError: true, errorMessage: 'Oops' });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			const root = container.querySelector('[data-testid="turn-block"]');
			expect(root!.className).toContain('border-red-800');
		});

		it('does not render error section when isError=false', () => {
			const turn = makeTurn({ isError: false, errorMessage: null });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			// No red text anywhere
			expect(container.querySelector('.text-red-400')).toBeNull();
		});

		it('applies red border but no error message div when isError=true and errorMessage=null', () => {
			// This edge case is reachable: useTurnBlocks can set isError=true with errorMessage=null
			// when error detection fires but no text is extractable.
			const turn = makeTurn({ isError: true, errorMessage: null });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			// Border-red-800 class still applied
			const root = container.querySelector('[data-testid="turn-block"]');
			expect(root!.className).toContain('border-red-800');
			// But no red message div rendered (guarded by turn.isError && turn.errorMessage)
			expect(container.querySelector('.text-red-400')).toBeNull();
		});
	});

	// ── Click handler ─────────────────────────────────────────────────────────

	describe('click handler', () => {
		it('calls onClick with the turn when clicked', () => {
			const onClickMock = vi.fn();
			const turn = makeTurn();
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={onClickMock} />);
			const root = container.querySelector('[data-testid="turn-block"]') as HTMLElement;
			fireEvent.click(root);
			expect(onClickMock).toHaveBeenCalledOnce();
			expect(onClickMock).toHaveBeenCalledWith(turn);
		});

		it('calls onClick with Enter key press', () => {
			const onClickMock = vi.fn();
			const turn = makeTurn();
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={onClickMock} />);
			const root = container.querySelector('[data-testid="turn-block"]') as HTMLElement;
			fireEvent.keyDown(root, { key: 'Enter' });
			expect(onClickMock).toHaveBeenCalledWith(turn);
		});

		it('calls onClick with Space key press', () => {
			const onClickMock = vi.fn();
			const turn = makeTurn();
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={onClickMock} />);
			const root = container.querySelector('[data-testid="turn-block"]') as HTMLElement;
			fireEvent.keyDown(root, { key: ' ' });
			expect(onClickMock).toHaveBeenCalledWith(turn);
		});
	});

	// ── data-testid attributes ────────────────────────────────────────────────

	describe('data-testid attributes', () => {
		it('has all required data-testid attributes', () => {
			const { container } = render(
				<TurnSummaryBlock turn={makeTurn({ isActive: true, endTime: null })} onClick={vi.fn()} />
			);
			expect(container.querySelector('[data-testid="turn-block"]')).toBeTruthy();
			expect(container.querySelector('[data-testid="turn-block-agent-name"]')).toBeTruthy();
			expect(container.querySelector('[data-testid="turn-block-stats"]')).toBeTruthy();
			expect(container.querySelector('[data-testid="turn-block-preview"]')).toBeTruthy();
			expect(container.querySelector('[data-testid="turn-block-active"]')).toBeTruthy();
		});
	});

	// ── Role colors ───────────────────────────────────────────────────────────

	describe('role colors', () => {
		const roles: Array<[string, string]> = [
			['planner', 'text-teal-400'],
			['coder', 'text-blue-400'],
			['general', 'text-slate-400'],
			['leader', 'text-purple-400'],
			['human', 'text-green-400'],
			['craft', 'text-blue-400'],
			['lead', 'text-purple-400'],
			['system', 'text-gray-500'],
		];

		it.each(roles)('applies correct label color for role=%s', (role, expectedClass) => {
			const turn = makeTurn({ agentRole: role });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			const nameEl = container.querySelector('[data-testid="turn-block-agent-name"]');
			expect(nameEl!.className).toContain(expectedClass);
		});

		it('renders agentLabel (not ROLE_COLORS label) for human turn', () => {
			// agentLabel is set to a custom string that differs from ROLE_COLORS['human'].label
			// to verify the component uses turn.agentLabel, not a re-derived ROLE_COLORS lookup
			const turn = makeTurn({ agentRole: 'human', agentLabel: 'Human (GPT-4)' });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			const nameEl = container.querySelector('[data-testid="turn-block-agent-name"]');
			// Must show the custom agentLabel, NOT the ROLE_COLORS-derived 'Human'
			expect(nameEl!.textContent).toBe('Human (GPT-4)');
		});

		it('falls back to agentRole text for unknown role', () => {
			const turn = makeTurn({ agentRole: 'custom-agent', agentLabel: 'custom-agent' });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			const nameEl = container.querySelector('[data-testid="turn-block-agent-name"]');
			expect(nameEl!.textContent).toBe('custom-agent');
		});

		it('falls back to agentRole when agentLabel is empty string (system role quirk)', () => {
			// ROLE_COLORS['system'].label is '' — useTurnBlocks propagates this as agentLabel.
			// The component uses `turn.agentLabel || turn.agentRole`, so the empty agentLabel
			// causes the agentRole string 'system' to be rendered instead.
			const turn = makeTurn({ agentRole: 'system', agentLabel: '' });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			const nameEl = container.querySelector('[data-testid="turn-block-agent-name"]');
			expect(nameEl!.textContent).toBe('system');
		});
	});

	// ── Duration formatting ────────────────────────────────────────────────────

	describe('duration formatting', () => {
		it('formats seconds only for durations under 1 minute', () => {
			const turn = makeTurn({ startTime: 0, endTime: 45_000 });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			expect(container.textContent).toContain('45s');
		});

		it('formats minutes only when seconds remainder is 0', () => {
			const turn = makeTurn({ startTime: 0, endTime: 180_000 });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			expect(container.textContent).toContain('3m');
		});

		it('formats minutes and seconds', () => {
			const turn = makeTurn({ startTime: 0, endTime: 125_000 });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			expect(container.textContent).toContain('2m 5s');
		});

		it('shows 0s for zero duration', () => {
			const turn = makeTurn({ startTime: 1_000_000, endTime: 1_000_000 });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			expect(container.textContent).toContain('0s');
		});
	});

	// ── Accessibility ─────────────────────────────────────────────────────────

	describe('accessibility', () => {
		it('has role="button" on the root element', () => {
			const { container } = render(<TurnSummaryBlock turn={makeTurn()} onClick={vi.fn()} />);
			const root = container.querySelector('[data-testid="turn-block"]');
			expect(root?.getAttribute('role')).toBe('button');
		});

		it('has tabIndex=0 for keyboard navigation', () => {
			const { container } = render(<TurnSummaryBlock turn={makeTurn()} onClick={vi.fn()} />);
			const root = container.querySelector('[data-testid="turn-block"]') as HTMLElement;
			expect(root?.tabIndex).toBe(0);
		});

		it('does NOT call onClick for non-Enter/Space key presses', () => {
			const onClickMock = vi.fn();
			const turn = makeTurn();
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={onClickMock} />);
			const root = container.querySelector('[data-testid="turn-block"]') as HTMLElement;
			fireEvent.keyDown(root, { key: 'Escape' });
			fireEvent.keyDown(root, { key: 'Tab' });
			fireEvent.keyDown(root, { key: 'ArrowDown' });
			expect(onClickMock).not.toHaveBeenCalled();
		});

		it('active indicator has aria-label="Active turn"', () => {
			const turn = makeTurn({ isActive: true, endTime: null });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			const indicator = container.querySelector('[data-testid="turn-block-active"]');
			expect(indicator?.getAttribute('aria-label')).toBe('Active turn');
		});
	});

	// ── Border class ──────────────────────────────────────────────────────────

	describe('border class', () => {
		it('applies role border class from ROLE_COLORS for coder', () => {
			const turn = makeTurn({ agentRole: 'coder' });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			const root = container.querySelector('[data-testid="turn-block"]');
			expect(root!.className).toContain('border-l-blue-500');
		});

		it('applies role border class for leader', () => {
			const turn = makeTurn({ agentRole: 'leader' });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			const root = container.querySelector('[data-testid="turn-block"]');
			expect(root!.className).toContain('border-l-purple-500');
		});

		it('falls back to gray border for unknown role', () => {
			const turn = makeTurn({ agentRole: 'unknown-role', agentLabel: 'Unknown' });
			const { container } = render(<TurnSummaryBlock turn={turn} onClick={vi.fn()} />);
			const root = container.querySelector('[data-testid="turn-block"]');
			expect(root!.className).toContain('border-l-gray-500');
		});
	});
});
