// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { SpaceTaskCardFeed } from './SpaceTaskCardFeed';
import type { SpaceTaskThreadEvent } from '../space-task-thread-events';

// Stub SDKMessageRenderer so we can render text/user events without pulling in
// the full SDK message tree — we just want to verify the card wrapper.
vi.mock('../../../sdk/SDKMessageRenderer', () => ({
	SDKMessageRenderer: ({ message }: { message: any }) => {
		const content = message?.message?.content;
		if (typeof content === 'string') {
			return <div data-testid="sdk-message-renderer">{content}</div>;
		}
		if (Array.isArray(content)) {
			const text = content
				.filter((b: any) => b?.type === 'text' && typeof b?.text === 'string')
				.map((b: any) => b.text)
				.join(' ')
				.trim();
			return <div data-testid="sdk-message-renderer">{text || message?.type || ''}</div>;
		}
		return <div data-testid="sdk-message-renderer">{message?.type || ''}</div>;
	},
}));

const fakeMaps = {
	toolResultsMap: new Map(),
	toolInputsMap: new Map(),
	subagentMessagesMap: new Map(),
	sessionInfoMap: new Map(),
} as const;

function makeEvent(
	id: string,
	label: string,
	kind: SpaceTaskThreadEvent['kind'] = 'text',
	extra: Partial<SpaceTaskThreadEvent> = {}
): SpaceTaskThreadEvent {
	return {
		id,
		label,
		taskId: 'task-1',
		taskTitle: 'Task One',
		sessionId: null,
		createdAt: Date.now(),
		kind,
		title: kind === 'tool' ? `${label}: ${kind}` : kind,
		summary: `${label} ${kind} summary`,
		...extra,
	};
}

function makeTextEvent(id: string, label: string, text: string): SpaceTaskThreadEvent {
	return makeEvent(id, label, 'text', {
		message: {
			type: 'assistant',
			uuid: id,
			message: { content: [{ type: 'text', text }] },
		} as any,
	});
}

function makeResultEvent(
	id: string,
	label: string,
	subtype: 'success' | 'error' = 'success'
): SpaceTaskThreadEvent {
	return makeEvent(id, label, 'result', {
		resultSubtype: subtype,
		isError: subtype !== 'success',
	});
}

describe('SpaceTaskCardFeed', () => {
	beforeEach(() => {
		cleanup();
	});

	afterEach(() => {
		cleanup();
	});

	// ── Card shape ────────────────────────────────────────────────────────────

	it('renders each logical block as a bordered rounded card', () => {
		// 2 distinct agents → 2 non-running blocks (last block gets running wrapper).
		// Give the feed 3 blocks so the last is running and the earlier two are cards.
		const events = [
			makeTextEvent('e1', 'Task Agent', 'block one'),
			makeTextEvent('e2', 'Coder Agent', 'block two'),
			makeTextEvent('e3', 'Reviewer Agent', 'block three'),
		];
		const { container } = render(
			<SpaceTaskCardFeed events={events} taskId="task-1" maps={fakeMaps as any} />
		);

		// The first two blocks are non-running, non-terminal → rendered as
		// bordered card containers with `data-testid="compact-card"`.
		const cards = container.querySelectorAll('[data-testid="compact-card"]');
		expect(cards.length).toBe(2);

		// Each card has the standard bordered rounded overflow-hidden shape,
		// matching ToolResultCard / SubagentBlock visual language.
		cards.forEach((card) => {
			const className = card.getAttribute('class') ?? '';
			expect(className).toContain('border');
			expect(className).toContain('rounded-lg');
			expect(className).toContain('overflow-hidden');
		});
	});

	it('renders the last non-terminal block with the running-block wrapper', () => {
		const events = [
			makeTextEvent('e1', 'Task Agent', 'prior'),
			makeTextEvent('e2', 'Coder Agent', 'final — running'),
		];
		render(<SpaceTaskCardFeed events={events} taskId="task-1" maps={fakeMaps as any} />);

		expect(screen.getByTestId('compact-running-block')).toBeTruthy();
	});

	it('does not render the running-block wrapper when the last block is terminal', () => {
		const events = [
			makeTextEvent('e1', 'Task Agent', 'prior'),
			makeResultEvent('e2', 'Task Agent', 'success'),
		];
		render(<SpaceTaskCardFeed events={events} taskId="task-1" maps={fakeMaps as any} />);

		expect(screen.queryByTestId('compact-running-block')).toBeNull();
	});

	// ── Header & chevron ──────────────────────────────────────────────────────

	it('renders the agent label in the card header using shortAgentLabel casing', () => {
		const events = [
			makeTextEvent('e1', 'Task Agent', 'a'),
			makeTextEvent('e2', 'Coder Agent', 'b'),
			makeTextEvent('e3', 'Reviewer Agent', 'c'),
		];
		const { container } = render(
			<SpaceTaskCardFeed events={events} taskId="task-1" maps={fakeMaps as any} />
		);

		const labels = Array.from(container.querySelectorAll('span[style*="color"]')).map(
			(el) => el.textContent
		);
		// All three agent labels appear somewhere as colored header spans.
		expect(labels).toContain('TASK');
		expect(labels).toContain('CODER');
		expect(labels).toContain('REVIEWER');
	});

	it('renders the event count in the header', () => {
		const events = [
			// 2 Coder Agent events → single block with "2 events" label
			makeTextEvent('e1', 'Task Agent', 'a'),
			makeTextEvent('e2', 'Coder Agent', 'b1'),
			makeEvent('e3', 'Coder Agent', 'tool', { iconToolName: 'Bash', summary: 'ls' }),
		];
		render(<SpaceTaskCardFeed events={events} taskId="task-1" maps={fakeMaps as any} />);

		// One block has 2 events → "2 events". Another has 1 event → "1 event".
		expect(screen.getByText('2 events')).toBeTruthy();
		expect(screen.getByText('1 event')).toBeTruthy();
	});

	it('renders a terminal badge (DONE) for success terminal blocks', () => {
		const events = [
			makeTextEvent('e1', 'Task Agent', 'prior'),
			makeResultEvent('e2', 'Task Agent', 'success'),
		];
		render(<SpaceTaskCardFeed events={events} taskId="task-1" maps={fakeMaps as any} />);

		// Same-agent consecutive events merge into one block → one DONE badge.
		const badges = screen.getAllByTestId('compact-card-badge');
		expect(badges.length).toBe(1);
		expect(badges[0].textContent).toBe('DONE');
	});

	it('renders a terminal badge (ERROR) for error terminal blocks', () => {
		const events = [
			makeTextEvent('e1', 'Task Agent', 'prior'),
			makeResultEvent('e2', 'Task Agent', 'error'),
		];
		render(<SpaceTaskCardFeed events={events} taskId="task-1" maps={fakeMaps as any} />);

		const badges = screen.getAllByTestId('compact-card-badge');
		expect(badges.length).toBe(1);
		expect(badges[0].textContent).toBe('ERROR');
	});

	// ── Expand / collapse behaviour ───────────────────────────────────────────

	it('collapses non-running non-terminal blocks by default (body hidden)', () => {
		// 3 blocks: T, C, R — last (R) is running, first two (T, C) are collapsed.
		const events = [
			makeTextEvent('e1', 'Task Agent', 'hidden task body'),
			makeTextEvent('e2', 'Coder Agent', 'hidden coder body'),
			makeTextEvent('e3', 'Reviewer Agent', 'visible running body'),
		];
		const { container } = render(
			<SpaceTaskCardFeed events={events} taskId="task-1" maps={fakeMaps as any} />
		);

		const bodies = container.querySelectorAll('[data-testid="compact-card-body"]');
		expect(bodies.length).toBe(3);

		// First two bodies (non-running, non-terminal) should have `hidden` class.
		expect(bodies[0].getAttribute('class') ?? '').toContain('hidden');
		expect(bodies[1].getAttribute('class') ?? '').toContain('hidden');
		// Third body is running → expanded.
		expect(bodies[2].getAttribute('class') ?? '').not.toContain('hidden');
	});

	it('expands a collapsed block when the chevron header is clicked', () => {
		const events = [
			makeTextEvent('e1', 'Task Agent', 'task body'),
			makeTextEvent('e2', 'Coder Agent', 'coder body'),
			makeTextEvent('e3', 'Reviewer Agent', 'reviewer running'),
		];
		const { container } = render(
			<SpaceTaskCardFeed events={events} taskId="task-1" maps={fakeMaps as any} />
		);

		// Every card (running or not) has a clickable header.
		const headers = container.querySelectorAll('[data-testid="compact-card-header"]');
		expect(headers.length).toBe(3);

		const bodies = container.querySelectorAll('[data-testid="compact-card-body"]');
		// Body 0 (non-running, non-terminal) is initially hidden.
		expect(bodies[0].getAttribute('class') ?? '').toContain('hidden');

		// Click the first header → it should expand.
		fireEvent.click(headers[0]);
		const bodiesAfter = container.querySelectorAll('[data-testid="compact-card-body"]');
		expect(bodiesAfter[0].getAttribute('class') ?? '').not.toContain('hidden');

		// Click again → collapses back.
		fireEvent.click(headers[0]);
		const bodiesAfterSecond = container.querySelectorAll('[data-testid="compact-card-body"]');
		expect(bodiesAfterSecond[0].getAttribute('class') ?? '').toContain('hidden');
	});

	it('sets aria-expanded correctly on the header button', () => {
		const events = [
			makeTextEvent('e1', 'Task Agent', 'task body'),
			makeTextEvent('e2', 'Coder Agent', 'coder running'),
		];
		const { container } = render(
			<SpaceTaskCardFeed events={events} taskId="task-1" maps={fakeMaps as any} />
		);

		// Only the non-running card has the compact-card testid on the wrapper.
		const header = container.querySelector('[data-testid="compact-card-header"]');
		expect(header).toBeTruthy();
		expect(header?.getAttribute('aria-expanded')).toBe('false');

		fireEvent.click(header as Element);
		expect(header?.getAttribute('aria-expanded')).toBe('true');
	});

	it('expands terminal blocks by default', () => {
		// Terminal block at position 0 (outside last-3 window when 4 blocks total),
		// always forced into view by applyCompactVisibilityRules.
		const events = [
			makeResultEvent('e1', 'Task Agent', 'error'), // terminal, early
			makeTextEvent('e2', 'Coder Agent', 'b'),
			makeTextEvent('e3', 'Reviewer Agent', 'c'),
			makeTextEvent('e4', 'Space Agent', 'd'), // running last
		];
		const { container } = render(
			<SpaceTaskCardFeed events={events} taskId="task-1" maps={fakeMaps as any} />
		);

		// 4 blocks visible: [T-terminal, C, R, S-running]. T is terminal,
		// C and R are collapsed, S is running (expanded).
		const bodies = container.querySelectorAll('[data-testid="compact-card-body"]');
		expect(bodies.length).toBe(4);

		// Terminal block body (first) should be expanded.
		expect(bodies[0].getAttribute('class') ?? '').not.toContain('hidden');
		// Middle blocks collapsed.
		expect(bodies[1].getAttribute('class') ?? '').toContain('hidden');
		expect(bodies[2].getAttribute('class') ?? '').toContain('hidden');
		// Running block expanded.
		expect(bodies[3].getAttribute('class') ?? '').not.toContain('hidden');
	});

	it('expands the running block by default', () => {
		const events = [
			makeTextEvent('e1', 'Task Agent', 'task body'),
			makeTextEvent('e2', 'Coder Agent', 'running body'),
		];
		const { container } = render(
			<SpaceTaskCardFeed events={events} taskId="task-1" maps={fakeMaps as any} />
		);

		// Running block body should be visible.
		expect(screen.getByText('running body')).toBeTruthy();

		const bodies = container.querySelectorAll('[data-testid="compact-card-body"]');
		// The running block body is the last one and should not be hidden.
		const lastBody = bodies[bodies.length - 1];
		expect(lastBody.getAttribute('class') ?? '').not.toContain('hidden');
	});

	// ── Chevron rotation ──────────────────────────────────────────────────────

	it('rotates the chevron -90deg when collapsed and 0deg when expanded', () => {
		const events = [
			makeTextEvent('e1', 'Task Agent', 'a'),
			makeTextEvent('e2', 'Coder Agent', 'running'),
		];
		const { container } = render(
			<SpaceTaskCardFeed events={events} taskId="task-1" maps={fakeMaps as any} />
		);

		// The collapsed card's chevron svg should have `-rotate-90`.
		const header = container.querySelector('[data-testid="compact-card-header"]');
		const chevron = header?.querySelector('svg');
		expect(chevron?.getAttribute('class') ?? '').toContain('-rotate-90');

		// Click to expand → chevron loses the -rotate-90 class.
		fireEvent.click(header as Element);
		const chevronAfter = container
			.querySelector('[data-testid="compact-card-header"]')
			?.querySelector('svg');
		expect(chevronAfter?.getAttribute('class') ?? '').not.toContain('-rotate-90');
	});

	// ── Empty input ───────────────────────────────────────────────────────────

	it('renders nothing (empty feed container) when there are no events', () => {
		const { container } = render(
			<SpaceTaskCardFeed events={[]} taskId="task-1" maps={fakeMaps as any} />
		);

		// Root feed wrapper is still present for layout consistency.
		expect(screen.getByTestId('space-task-event-feed-compact')).toBeTruthy();
		// But no cards inside.
		expect(container.querySelectorAll('[data-testid="compact-card"]').length).toBe(0);
		expect(container.querySelectorAll('[data-testid="compact-running-block"]').length).toBe(0);
	});
});
