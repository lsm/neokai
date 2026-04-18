// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import type { ParsedThreadRow } from '../space-task-thread-events';

// ── Signal mocks ─────────────────────────────────────────────────────────────
// Hoisted plain holders the component mutates; we assert against them in tests.
const { mockSpaceOverlaySessionIdSignal, mockSpaceOverlayAgentNameSignal } = vi.hoisted(() => ({
	mockSpaceOverlaySessionIdSignal: { value: null as string | null },
	mockSpaceOverlayAgentNameSignal: { value: null as string | null },
}));
vi.mock('../../../../lib/signals', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		get spaceOverlaySessionIdSignal() {
			return mockSpaceOverlaySessionIdSignal;
		},
		get spaceOverlayAgentNameSignal() {
			return mockSpaceOverlayAgentNameSignal;
		},
	};
});

// Import the component AFTER vi.mock so the mocked signals are picked up.
import { SpaceTaskCardFeed } from './SpaceTaskCardFeed';

// Stub SDKMessageRenderer so these tests can focus on the feed's grouping,
// visibility, agent-header and running-block behavior without pulling in the
// full SDK render tree. The stub echoes text/user content when available and
// falls back to the message `type` so terminal/result rows still render
// something detectable.
vi.mock('../../../sdk/SDKMessageRenderer', () => ({
	SDKMessageRenderer: ({
		message,
		taskContext,
		isRunning,
	}: {
		message: any;
		taskContext?: boolean;
		isRunning?: boolean;
	}) => {
		const content = message?.message?.content;
		const attrs = {
			'data-testid': 'sdk-message-renderer',
			'data-task-context': taskContext ? '1' : '0',
			'data-running': isRunning ? '1' : '0',
		};
		if (typeof content === 'string') {
			return <div {...attrs}>{content}</div>;
		}
		if (Array.isArray(content)) {
			const text = content
				.filter((b: any) => b?.type === 'text' && typeof b?.text === 'string')
				.map((b: any) => b.text)
				.join(' ')
				.trim();
			return <div {...attrs}>{text || message?.type || ''}</div>;
		}
		return <div {...attrs}>{message?.type || ''}</div>;
	},
}));

const fakeMaps = {
	toolResultsMap: new Map(),
	toolInputsMap: new Map(),
	subagentMessagesMap: new Map(),
	sessionInfoMap: new Map(),
} as const;

// ── Row factories ────────────────────────────────────────────────────────────

function makeAssistantTextRow(
	id: string,
	label: string,
	text: string,
	sessionId: string | null = null
): ParsedThreadRow {
	return {
		id,
		sessionId,
		label,
		taskId: 'task-1',
		taskTitle: 'Task One',
		createdAt: Date.now(),
		message: {
			type: 'assistant',
			uuid: id,
			message: { content: [{ type: 'text', text }] },
		} as any,
		fallbackText: null,
	};
}

/** Assistant row whose content includes a tool_use block — triggers the running border. */
function makeToolUseRow(
	id: string,
	label: string,
	toolName = 'bash',
	sessionId: string | null = null
): ParsedThreadRow {
	return {
		id,
		sessionId,
		label,
		taskId: 'task-1',
		taskTitle: 'Task One',
		createdAt: Date.now(),
		message: {
			type: 'assistant',
			uuid: id,
			message: {
				content: [{ type: 'tool_use', id: `tu-${id}`, name: toolName, input: {} }],
			},
		} as any,
		fallbackText: null,
	};
}

function makeResultRow(
	id: string,
	label: string,
	subtype: 'success' | 'error' = 'success'
): ParsedThreadRow {
	return {
		id,
		sessionId: null,
		label,
		taskId: 'task-1',
		taskTitle: 'Task One',
		createdAt: Date.now(),
		message: {
			type: 'result',
			subtype,
			uuid: id,
			usage: { input_tokens: 1, output_tokens: 1 },
		} as any,
		fallbackText: null,
	};
}

function makeSystemInitRow(
	id: string,
	label: string,
	overrides: Record<string, unknown> = {}
): ParsedThreadRow {
	return {
		id,
		sessionId: null,
		label,
		taskId: 'task-1',
		taskTitle: 'Task One',
		createdAt: Date.now(),
		message: {
			type: 'system',
			subtype: 'init',
			uuid: id,
			model: 'claude-opus-4-5',
			permissionMode: 'default',
			cwd: '/tmp/work',
			tools: ['Bash', 'Read', 'Edit'],
			mcp_servers: [],
			slash_commands: [],
			agents: [],
			apiKeySource: 'user',
			output_style: 'text',
			session_id: 'session-1',
			...overrides,
		} as any,
		fallbackText: null,
	};
}

function makeRateLimitRow(
	id: string,
	label: string,
	status: 'allowed' | 'allowed_warning' | 'rejected'
): ParsedThreadRow {
	return {
		id,
		sessionId: null,
		label,
		taskId: 'task-1',
		taskTitle: 'Task One',
		createdAt: Date.now(),
		message: {
			type: 'rate_limit_event',
			uuid: id,
			rate_limit_info: { status, rateLimitType: 'five_hour' },
		} as any,
		fallbackText: null,
	};
}

function makeEmptyUserRow(id: string, label: string): ParsedThreadRow {
	return {
		id,
		sessionId: null,
		label,
		taskId: 'task-1',
		taskTitle: 'Task One',
		createdAt: Date.now(),
		message: {
			type: 'user',
			uuid: id,
			message: { content: '' },
		} as any,
		fallbackText: null,
	};
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SpaceTaskCardFeed', () => {
	beforeEach(() => {
		cleanup();
		mockSpaceOverlaySessionIdSignal.value = null;
		mockSpaceOverlayAgentNameSignal.value = null;
	});
	afterEach(() => cleanup());

	// ── Delegation to SDKMessageRenderer (the whole point of this refactor) ──

	it('delegates every visible row to SDKMessageRenderer with taskContext=true', () => {
		const rows = [
			makeAssistantTextRow('r1', 'Task Agent', 'task said hello'),
			makeAssistantTextRow('r2', 'Coder Agent', 'coder said hi'),
		];
		const { container } = render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const rendered = container.querySelectorAll('[data-testid="sdk-message-renderer"]');
		expect(rendered.length).toBe(2);
		expect(rendered[0].textContent).toBe('task said hello');
		expect(rendered[1].textContent).toBe('coder said hi');
		// taskContext must be forwarded so system-init/subagent handling is correct.
		rendered.forEach((el) => expect(el.getAttribute('data-task-context')).toBe('1'));
	});

	it('does NOT wrap each block in an outer bordered card', () => {
		// The whole point of this refactor: no outer per-block border — each
		// SDK message renders its own chrome (ToolResultCard, ThinkingBlock, …).
		const rows = [
			makeAssistantTextRow('r1', 'Task Agent', 'a'),
			makeAssistantTextRow('r2', 'Coder Agent', 'b'),
		];
		const { container } = render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const blocks = container.querySelectorAll('[data-testid="compact-block"]');
		expect(blocks.length).toBe(2); // All block sections use compact-block; running-block chrome is on the last row inside the tail block.

		blocks.forEach((blockEl) => {
			const className = blockEl.getAttribute('class') ?? '';
			expect(className).not.toContain('border');
			expect(className).not.toContain('rounded-lg');
		});
	});

	// ── Running-block wrapper ────────────────────────────────────────────────

	it('marks the last tool-use row as running and passes isRunning to SDKMessageRenderer', () => {
		// The running border only fires when the last visible event is a tool_use block.
		const rows = [
			makeAssistantTextRow('r1', 'Task Agent', 'prior text'),
			makeToolUseRow('r2', 'Coder Agent', 'bash'),
		];
		const { container } = render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={true}
			/>
		);

		// The testid wrapper must exist on the last row.
		const runningWrapper = screen.getByTestId('compact-running-block');
		expect(runningWrapper).toBeTruthy();

		// The SDKMessageRenderer inside must receive isRunning=true.
		const rendererEl = runningWrapper.querySelector('[data-testid="sdk-message-renderer"]');
		expect(rendererEl?.getAttribute('data-running')).toBe('1');

		// Non-running rows must NOT have isRunning=true.
		const allRenderers = container.querySelectorAll('[data-testid="sdk-message-renderer"]');
		const nonRunning = Array.from(allRenderers).filter(
			(el) => el.getAttribute('data-running') !== '1'
		);
		expect(nonRunning.length).toBe(1); // only 'prior text' row is non-running
	});

	it('suppresses running-block when last visible row is not a tool_use block', () => {
		// Plain text bubbles should not get the animated border even when agent is active.
		const rows = [
			makeAssistantTextRow('r1', 'Task Agent', 'prior'),
			makeAssistantTextRow('r2', 'Coder Agent', 'just text, no tool use'),
		];
		render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={true}
			/>
		);

		expect(screen.queryByTestId('compact-running-block')).toBeNull();
	});

	it('suppresses running-block when isAgentActive is false even with non-terminal tool-use rows', () => {
		const rows = [
			makeAssistantTextRow('r1', 'Task Agent', 'prior'),
			makeToolUseRow('r2', 'Coder Agent', 'read_file'),
		];
		render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		// No running-block wrapper when agent is not active.
		expect(screen.queryByTestId('compact-running-block')).toBeNull();
	});

	it('suppresses running-block when all visible blocks are terminal', () => {
		// All-terminal means the task completed — no border animation.
		const rows = [
			makeAssistantTextRow('r1', 'Task Agent', 'prior'),
			makeResultRow('r2', 'Task Agent', 'success'),
		];
		render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={true}
			/>
		);

		expect(screen.queryByTestId('compact-running-block')).toBeNull();
	});

	// ── Agent identity header ────────────────────────────────────────────────

	it('renders a colored agent-identity header for each visible block', () => {
		const rows = [
			makeAssistantTextRow('r1', 'Task Agent', 'a'),
			makeAssistantTextRow('r2', 'Coder Agent', 'b'),
			makeAssistantTextRow('r3', 'Reviewer Agent', 'c'),
		];
		const { container } = render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const headers = container.querySelectorAll('[data-testid="compact-block-header"]');
		expect(headers.length).toBe(3);

		const labels = Array.from(
			container.querySelectorAll('[data-testid="compact-block-header"] span[style*="color"]')
		).map((el) => el.textContent);
		expect(labels).toContain('TASK');
		expect(labels).toContain('CODER');
		expect(labels).toContain('REVIEWER');
	});

	it('applies distinct colors to different agent headers', () => {
		const rows = [
			makeAssistantTextRow('r1', 'Task Agent', 'a'),
			makeAssistantTextRow('r2', 'Coder Agent', 'b'),
		];
		const { container } = render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const colored = Array.from(
			container.querySelectorAll('[data-testid="compact-block-header"] span[style*="color"]')
		);
		const taskSpan = colored.find((el) => el.textContent === 'TASK') as HTMLElement | undefined;
		const coderSpan = colored.find((el) => el.textContent === 'CODER') as HTMLElement | undefined;
		expect(taskSpan).toBeTruthy();
		expect(coderSpan).toBeTruthy();
		expect(taskSpan!.style.color).not.toBe('');
		expect(taskSpan!.style.color).not.toBe(coderSpan!.style.color);
	});

	it('renders a colored dot alongside the agent label', () => {
		const rows = [makeAssistantTextRow('r1', 'Task Agent', 'a')];
		const { container } = render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const dot = container.querySelector(
			'[data-testid="compact-block-header"] span[style*="background-color"]'
		);
		expect(dot).toBeTruthy();
		expect((dot as HTMLElement).style.backgroundColor).not.toBe('');
	});

	// ── Click-to-open agent slide-out ────────────────────────────────────────

	it('opens the agent overlay when the agent-name header is clicked', () => {
		const rows = [makeAssistantTextRow('r1', 'Task Agent', 'hello', 'session-abc')];
		render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const header = screen.getByTestId('compact-block-header');
		expect(header.getAttribute('data-clickable')).toBe('1');
		expect(header.getAttribute('role')).toBe('button');
		expect(header.getAttribute('tabindex')).toBe('0');

		fireEvent.click(header);

		expect(mockSpaceOverlaySessionIdSignal.value).toBe('session-abc');
		expect(mockSpaceOverlayAgentNameSignal.value).toBe('Task Agent');
	});

	it('opens the agent overlay when Enter is pressed on the focused header', () => {
		const rows = [makeAssistantTextRow('r1', 'Coder Agent', 'hi', 'sess-coder')];
		render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const header = screen.getByTestId('compact-block-header');
		fireEvent.keyDown(header, { key: 'Enter' });

		expect(mockSpaceOverlaySessionIdSignal.value).toBe('sess-coder');
		expect(mockSpaceOverlayAgentNameSignal.value).toBe('Coder Agent');
	});

	it('opens the agent overlay when Space is pressed on the focused header', () => {
		const rows = [makeAssistantTextRow('r1', 'Reviewer Agent', 'hi', 'sess-rev')];
		render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const header = screen.getByTestId('compact-block-header');
		fireEvent.keyDown(header, { key: ' ' });

		expect(mockSpaceOverlaySessionIdSignal.value).toBe('sess-rev');
		expect(mockSpaceOverlayAgentNameSignal.value).toBe('Reviewer Agent');
	});

	it('does NOT open the overlay when the block has no sessionId on any row', () => {
		const rows = [
			makeAssistantTextRow('r1', 'Task Agent', 'hello' /* sessionId defaults to null */),
		];
		render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const header = screen.getByTestId('compact-block-header');
		expect(header.getAttribute('data-clickable')).toBe('0');
		expect(header.getAttribute('role')).toBeNull();
		expect(header.getAttribute('tabindex')).toBeNull();

		// Clicking a non-clickable header is a no-op.
		fireEvent.click(header);
		expect(mockSpaceOverlaySessionIdSignal.value).toBeNull();
		expect(mockSpaceOverlayAgentNameSignal.value).toBeNull();
	});

	it('uses the first row with a non-null sessionId to derive the block sessionId', () => {
		// r1 has no sessionId (fallback row scenario), r2 has 'sess-2'.
		// Both are the same agent → one block; the overlay should open with 'sess-2'.
		const rows = [
			makeAssistantTextRow('r1', 'Task Agent', 'first'),
			makeAssistantTextRow('r2', 'Task Agent', 'second', 'sess-2'),
		];
		render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const header = screen.getByTestId('compact-block-header');
		fireEvent.click(header);
		expect(mockSpaceOverlaySessionIdSignal.value).toBe('sess-2');
	});

	it('each block opens its own agent overlay independently', () => {
		const rows = [
			makeAssistantTextRow('r1', 'Task Agent', 'task msg', 'sess-task'),
			makeAssistantTextRow('r2', 'Coder Agent', 'coder msg', 'sess-coder'),
		];
		render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const headers = screen.getAllByTestId('compact-block-header');
		expect(headers.length).toBe(2);

		// Click the Coder header → signals point to Coder.
		fireEvent.click(headers[1]);
		expect(mockSpaceOverlaySessionIdSignal.value).toBe('sess-coder');
		expect(mockSpaceOverlayAgentNameSignal.value).toBe('Coder Agent');

		// Click the Task header → signals swap to Task.
		fireEvent.click(headers[0]);
		expect(mockSpaceOverlaySessionIdSignal.value).toBe('sess-task');
		expect(mockSpaceOverlayAgentNameSignal.value).toBe('Task Agent');
	});

	// ── Terminal badge ───────────────────────────────────────────────────────

	it('renders a DONE badge on success terminal blocks', () => {
		const rows = [
			makeAssistantTextRow('r1', 'Task Agent', 'prior'),
			makeResultRow('r2', 'Task Agent', 'success'),
		];
		render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const badges = screen.getAllByTestId('compact-block-badge');
		expect(badges.length).toBe(1);
		expect(badges[0].textContent).toBe('DONE');
	});

	it('renders an ERROR badge on error terminal blocks', () => {
		const rows = [
			makeAssistantTextRow('r1', 'Task Agent', 'prior'),
			makeResultRow('r2', 'Task Agent', 'error'),
		];
		render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const badges = screen.getAllByTestId('compact-block-badge');
		expect(badges.length).toBe(1);
		expect(badges[0].textContent).toBe('ERROR');
	});

	// ── Visibility: 3-block limit + terminal preservation ────────────────────

	it('shows at most the last 3 logical blocks', () => {
		// 4 distinct agents → only last 3 should survive.
		const rows = [
			makeAssistantTextRow('r1', 'Task Agent', 'first'),
			makeAssistantTextRow('r2', 'Coder Agent', 'second'),
			makeAssistantTextRow('r3', 'Reviewer Agent', 'third'),
			makeAssistantTextRow('r4', 'Space Agent', 'fourth'),
		];
		const { container } = render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const rendered = container.querySelectorAll('[data-testid="sdk-message-renderer"]');
		const textSet = new Set(Array.from(rendered).map((el) => el.textContent));
		expect(textSet.has('first')).toBe(false); // First block is outside the last-3 window.
		expect(textSet.has('second')).toBe(true);
		expect(textSet.has('third')).toBe(true);
		expect(textSet.has('fourth')).toBe(true);
	});

	it('preserves the trailing terminal tail; scattered non-trailing terminals drop out of the window', () => {
		// Trailing tail: b4, b5 are terminal at the end → always kept.
		// Body window (last 3 of [b1, b2, b3]) renders first, tail appended.
		const rows = [
			makeAssistantTextRow('r1', 'Task Agent', 'first'),
			makeAssistantTextRow('r2', 'Coder Agent', 'second'),
			makeAssistantTextRow('r3', 'Reviewer Agent', 'third'),
			makeResultRow('r4', 'Space Agent', 'error'),
			makeResultRow('r5', 'Completer Agent', 'success'),
		];
		const { container } = render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const badges = screen.getAllByTestId('compact-block-badge');
		expect(badges.length).toBe(2); // b4 ERROR + b5 DONE
		expect(badges.map((b) => b.textContent).sort()).toEqual(['DONE', 'ERROR']);

		// 5 compact-block wrappers: [r1, r2, r3] body window + [r4, r5] terminal tail.
		const compactBlocks = container.querySelectorAll('[data-testid="compact-block"]').length;
		expect(compactBlocks).toBe(5);
	});

	it('drops scattered non-trailing terminal blocks that fall outside the last-3 window', () => {
		// r1 is a terminal error but it's NOT part of the trailing tail because
		// r2, r3, r4 are non-terminal rows that follow. Only the last-3 body
		// window [r2, r3, r4] is shown; r1 is dropped.
		const rows = [
			makeResultRow('r1', 'Task Agent', 'error'),
			makeAssistantTextRow('r2', 'Coder Agent', 'second'),
			makeAssistantTextRow('r3', 'Reviewer Agent', 'third'),
			makeAssistantTextRow('r4', 'Space Agent', 'fourth'),
		];
		const { container } = render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		expect(screen.queryAllByTestId('compact-block-badge').length).toBe(0);
		const compactBlocks = container.querySelectorAll('[data-testid="compact-block"]').length;
		expect(compactBlocks).toBe(3);
	});

	// ── Hidden-count indicator ───────────────────────────────────────────────

	it('shows per-block hidden-count when a block has more than 3 rows', () => {
		// One block with 5 rows → 2 hidden, last 3 shown.
		const rows = [
			makeAssistantTextRow('r1', 'Task Agent', 'a'),
			makeAssistantTextRow('r2', 'Task Agent', 'b'),
			makeAssistantTextRow('r3', 'Task Agent', 'c'),
			makeAssistantTextRow('r4', 'Task Agent', 'd'),
			makeAssistantTextRow('r5', 'Task Agent', 'e'),
		];
		render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const label = screen.getByTestId('compact-block-hidden-count');
		expect(label.textContent).toContain('2');
		expect(label.textContent?.toLowerCase()).toContain('messages');
	});

	it('uses singular "message" when exactly 1 row is hidden in a block', () => {
		// One block with 4 rows → 1 hidden.
		const rows = [
			makeAssistantTextRow('r1', 'Task Agent', 'a'),
			makeAssistantTextRow('r2', 'Task Agent', 'b'),
			makeAssistantTextRow('r3', 'Task Agent', 'c'),
			makeAssistantTextRow('r4', 'Task Agent', 'd'),
		];
		render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const label = screen.getByTestId('compact-block-hidden-count');
		expect(label.textContent).toContain('1');
		// Should be "message" not "messages".
		expect(label.textContent).not.toContain('messages');
		expect(label.textContent?.toLowerCase()).toContain('message');
	});

	it('does NOT render a hidden-count label when a block has 3 or fewer rows', () => {
		const rows = [
			makeAssistantTextRow('r1', 'Task Agent', 'a'),
			makeAssistantTextRow('r2', 'Task Agent', 'b'),
			makeAssistantTextRow('r3', 'Task Agent', 'c'),
		];
		render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		expect(screen.queryByTestId('compact-block-hidden-count')).toBeNull();
	});

	it('does NOT render the hidden-count label when parsedRows is empty', () => {
		render(
			<SpaceTaskCardFeed
				parsedRows={[]}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		expect(screen.queryByTestId('compact-block-hidden-count')).toBeNull();
	});

	it('only shows the last 3 rows of a block when more exist', () => {
		const rows = [
			makeAssistantTextRow('r1', 'Task Agent', 'hidden-a'),
			makeAssistantTextRow('r2', 'Task Agent', 'hidden-b'),
			makeAssistantTextRow('r3', 'Task Agent', 'shown-c'),
			makeAssistantTextRow('r4', 'Task Agent', 'shown-d'),
			makeAssistantTextRow('r5', 'Task Agent', 'shown-e'),
		];
		const { container } = render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const renderers = container.querySelectorAll('[data-testid="sdk-message-renderer"]');
		// Only last 3 rows rendered.
		expect(renderers.length).toBe(3);
		expect(renderers[0].textContent).toBe('shown-c');
		expect(renderers[1].textContent).toBe('shown-d');
		expect(renderers[2].textContent).toBe('shown-e');
	});

	// ── System-init rendering ────────────────────────────────────────────────

	it('renders a system-init row as a SpaceSystemInitCard alongside other rows', () => {
		const rows = [
			makeSystemInitRow('s1', 'Task Agent'),
			makeAssistantTextRow('r1', 'Task Agent', 'visible content'),
		];
		const { container } = render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		// The init row must NOT be filtered — it must produce a compact init card.
		const initCards = container.querySelectorAll('[data-testid="compact-system-init-card"]');
		expect(initCards.length).toBe(1);
		expect(initCards[0].textContent).toContain('Session Started');

		// The normal assistant row still renders via SDKMessageRenderer.
		const rendered = container.querySelectorAll('[data-testid="sdk-message-renderer"]');
		expect(rendered.length).toBe(1);
		expect(rendered[0].textContent).toBe('visible content');
	});

	it('shows collapsed header with model + tool count on the system-init card', () => {
		const rows = [
			makeSystemInitRow('s1', 'Task Agent', {
				tools: ['Bash', 'Read', 'Edit', 'Write'],
				mcp_servers: [{ name: 'chrome-devtools', status: 'connected' }],
			}),
		];
		render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const toggle = screen.getByTestId('compact-system-init-toggle');
		// Model is shown without the `claude-` prefix, and permission mode is appended.
		expect(toggle.textContent).toContain('opus-4-5');
		expect(toggle.textContent).toContain('default');
		// Counts visible in the collapsed state.
		expect(toggle.textContent).toContain('4 tools');
		expect(toggle.textContent).toContain('1 MCP');
	});

	it('expands the system-init card when clicked and reveals cwd + mcp details', () => {
		const rows = [
			makeSystemInitRow('s1', 'Task Agent', {
				cwd: '/Users/dev/focus/neokai',
				mcp_servers: [
					{ name: 'chrome-devtools', status: 'connected' },
					{ name: 'stale-server', status: 'disconnected' },
				],
			}),
		];
		render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		// Details are hidden until the user clicks the toggle.
		expect(screen.queryByTestId('compact-system-init-details')).toBeNull();

		fireEvent.click(screen.getByTestId('compact-system-init-toggle'));

		const details = screen.getByTestId('compact-system-init-details');
		expect(details.textContent).toContain('/Users/dev/focus/neokai');
		expect(details.textContent).toContain('chrome-devtools');
		expect(details.textContent).toContain('stale-server');

		// A second click collapses again.
		fireEvent.click(screen.getByTestId('compact-system-init-toggle'));
		expect(screen.queryByTestId('compact-system-init-details')).toBeNull();
	});

	it('does NOT dispatch system-init rows through SDKMessageRenderer (avoids the pill fallback)', () => {
		const rows = [makeSystemInitRow('s1', 'Task Agent')];
		const { container } = render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		// Only the init card renders — no SDK renderer for this row.
		expect(container.querySelectorAll('[data-testid="compact-system-init-card"]').length).toBe(1);
		expect(container.querySelectorAll('[data-testid="sdk-message-renderer"]').length).toBe(0);
	});

	// ── Pre-filter (noise removal) ───────────────────────────────────────────

	it('filters out non-rejected rate-limit rows', () => {
		const rows = [
			makeRateLimitRow('rl1', 'Task Agent', 'allowed'),
			makeRateLimitRow('rl2', 'Task Agent', 'allowed_warning'),
			makeAssistantTextRow('r1', 'Task Agent', 'visible content'),
			makeRateLimitRow('rl3', 'Task Agent', 'rejected'),
		];
		const { container } = render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		// allowed & allowed_warning filtered; visible-content + rejected remain.
		const rendered = container.querySelectorAll('[data-testid="sdk-message-renderer"]');
		expect(rendered.length).toBe(2);
	});

	it('filters out empty user rows', () => {
		const rows = [
			makeEmptyUserRow('u1', 'Task Agent'),
			makeAssistantTextRow('r1', 'Task Agent', 'visible content'),
		];
		const { container } = render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const rendered = container.querySelectorAll('[data-testid="sdk-message-renderer"]');
		expect(rendered.length).toBe(1);
		expect(rendered[0].textContent).toBe('visible content');
	});

	// ── Empty input ──────────────────────────────────────────────────────────

	it('renders the root container and no blocks when given no rows', () => {
		const { container } = render(
			<SpaceTaskCardFeed
				parsedRows={[]}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		expect(screen.getByTestId('space-task-event-feed-compact')).toBeTruthy();
		expect(container.querySelectorAll('[data-testid="compact-block"]').length).toBe(0);
		expect(container.querySelectorAll('[data-testid="compact-running-block"]').length).toBe(0);
	});
});
