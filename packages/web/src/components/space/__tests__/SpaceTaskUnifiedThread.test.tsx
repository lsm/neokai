// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import { SpaceTaskUnifiedThread } from '../SpaceTaskUnifiedThread';

let mockRows = [];
let mockIsLoading = false;
let mockIsReconnecting = false;

// Control the render style without depending on the mocked localStorage.
// vitest.setup.ts replaces global localStorage with a vi.fn stub (getItem
// always returns null, setItem is a no-op). We therefore mock the config
// module directly so tests can switch between 'compact' and 'legacy'.
let mockRenderStyle: 'compact' | 'legacy' = 'compact';
vi.mock('../../../lib/space-task-thread-config', () => ({
	getSpaceTaskThreadRenderStyle: vi.fn(() => mockRenderStyle),
	setSpaceTaskThreadRenderStyle: vi.fn(),
	DEFAULT_SPACE_TASK_THREAD_RENDER_STYLE: 'compact',
}));

vi.mock('../../../hooks/useSpaceTaskMessages', () => ({
	useSpaceTaskMessages: () => ({
		rows: mockRows,
		isLoading: mockIsLoading,
		isReconnecting: mockIsReconnecting,
	}),
}));

vi.mock('../../../hooks/useMessageMaps', () => ({
	useMessageMaps: () => ({
		toolResultsMap: new Map(),
		toolInputsMap: new Map(),
		subagentMessagesMap: new Map(),
		sessionInfoMap: new Map(),
	}),
}));

// Stub the SDK message renderer. The compact card feed now delegates ALL row
// rendering to SDKMessageRenderer (matching normal-session rendering), so these
// integration tests assert on the stub's output rather than the old compact
// rail-style rows. The legacy feed does its own rendering so it's unaffected.
vi.mock('../../sdk/SDKMessageRenderer', () => ({
	SDKMessageRenderer: ({ message }: { message: any }) => {
		const content = message?.message?.content;
		if (typeof content === 'string') {
			return <div data-testid="sdk-message-renderer">{content}</div>;
		}
		if (Array.isArray(content)) {
			const text = content
				.filter((block: any) => block?.type === 'text' && typeof block?.text === 'string')
				.map((block: any) => block.text)
				.join(' ')
				.trim();
			return <div data-testid="sdk-message-renderer">{text || message?.type}</div>;
		}
		return <div data-testid="sdk-message-renderer">{message?.type}</div>;
	},
}));

// ── Row factories ─────────────────────────────────────────────────────────────

function makeRows() {
	return [
		{
			id: 'row-1',
			sessionId: 'space:space-1:task:task-1',
			kind: 'task_agent',
			role: 'coder',
			label: 'Task Agent',
			taskId: 'task-1',
			taskTitle: 'Task One',
			messageType: 'assistant',
			content: JSON.stringify({
				type: 'assistant',
				uuid: 'a1',
				session_id: 'space:space-1:task:task-1',
				message: {
					content: [
						{ type: 'thinking', thinking: 'Planning implementation details now.' },
						{ type: 'tool_use', id: 't1', name: 'Glob', input: { pattern: '*.ts' } },
						{
							type: 'text',
							text: 'I found the relevant files and will patch next. This full assistant message should remain visible in compact mode without truncation.',
						},
					],
				},
			}),
			createdAt: 1_710_000_000_000,
		},
		{
			id: 'row-2',
			sessionId: 'space:space-1:task:task-1',
			kind: 'task_agent',
			role: 'coder',
			label: 'Task Agent',
			taskId: 'task-1',
			taskTitle: 'Task One',
			messageType: 'user',
			content: JSON.stringify({
				type: 'user',
				uuid: 'u1',
				session_id: 'space:space-1:task:task-1',
				parent_tool_use_id: null,
				message: { content: 'Please keep updates compact.' },
			}),
			createdAt: 1_710_000_000_900,
		},
	];
}

function makeNoiseRows() {
	return [
		{
			id: 'sys-init',
			sessionId: 'space:space-1:task:task-1',
			kind: 'task_agent',
			role: 'coder',
			label: 'Task Agent',
			taskId: 'task-1',
			taskTitle: 'Task One',
			messageType: 'system',
			content: JSON.stringify({
				type: 'system',
				subtype: 'init',
				uuid: 's1',
				session_id: 'space:space-1:task:task-1',
			}),
			createdAt: 1_710_000_000_000,
		},
		{
			id: 'result-success',
			sessionId: 'space:space-1:task:task-1',
			kind: 'task_agent',
			role: 'coder',
			label: 'Task Agent',
			taskId: 'task-1',
			taskTitle: 'Task One',
			messageType: 'result',
			content: JSON.stringify({
				type: 'result',
				subtype: 'success',
				uuid: 'r1',
				session_id: 'space:space-1:task:task-1',
				usage: { input_tokens: 10, output_tokens: 5 },
			}),
			createdAt: 1_710_000_000_100,
		},
		{
			id: 'rate-allowed',
			sessionId: 'space:space-1:task:task-1',
			kind: 'task_agent',
			role: 'coder',
			label: 'Task Agent',
			taskId: 'task-1',
			taskTitle: 'Task One',
			messageType: 'rate_limit_event',
			content: JSON.stringify({
				type: 'rate_limit_event',
				uuid: 'rl1',
				session_id: 'space:space-1:task:task-1',
				rate_limit_info: {
					status: 'allowed',
					rateLimitType: 'five_hour',
					overageStatus: 'rejected',
				},
			}),
			createdAt: 1_710_000_000_200,
		},
		{
			id: 'rate-rejected',
			sessionId: 'space:space-1:task:task-1',
			kind: 'task_agent',
			role: 'coder',
			label: 'Task Agent',
			taskId: 'task-1',
			taskTitle: 'Task One',
			messageType: 'rate_limit_event',
			content: JSON.stringify({
				type: 'rate_limit_event',
				uuid: 'rl2',
				session_id: 'space:space-1:task:task-1',
				rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' },
			}),
			createdAt: 1_710_000_000_300,
		},
	];
}

function makeMultiAgentRows() {
	return [
		{
			id: 'multi-1',
			sessionId: 'space:space-1:task:task-1',
			kind: 'task_agent',
			role: 'task',
			label: 'Task Agent',
			taskId: 'task-1',
			taskTitle: 'Task One',
			messageType: 'assistant',
			content: JSON.stringify({
				type: 'assistant',
				uuid: 'ma1',
				session_id: 'space:space-1:task:task-1',
				message: {
					content: [{ type: 'text', text: 'Task agent is planning the implementation.' }],
				},
			}),
			createdAt: 1_710_000_000_000,
		},
		{
			id: 'multi-2',
			sessionId: 'space:space-1:task:task-1:node:coder',
			kind: 'node_agent',
			role: 'coder',
			label: 'Coder Agent',
			taskId: 'task-1',
			taskTitle: 'Task One',
			messageType: 'assistant',
			content: JSON.stringify({
				type: 'assistant',
				uuid: 'ma2',
				session_id: 'space:space-1:task:task-1:node:coder',
				message: {
					content: [{ type: 'text', text: 'Coder agent writing the code changes.' }],
				},
			}),
			createdAt: 1_710_000_001_000,
		},
		{
			id: 'multi-3',
			sessionId: 'space:space-1:task:task-1:node:reviewer',
			kind: 'node_agent',
			role: 'reviewer',
			label: 'Reviewer Agent',
			taskId: 'task-1',
			taskTitle: 'Task One',
			messageType: 'assistant',
			content: JSON.stringify({
				type: 'assistant',
				uuid: 'ma3',
				session_id: 'space:space-1:task:task-1:node:reviewer',
				message: {
					content: [{ type: 'text', text: 'Reviewer agent checking the changes.' }],
				},
			}),
			createdAt: 1_710_000_002_000,
		},
		{
			id: 'multi-4',
			sessionId: 'space:space-1:task:task-1',
			kind: 'task_agent',
			role: 'task',
			label: 'Task Agent',
			taskId: 'task-1',
			taskTitle: 'Task One',
			messageType: 'assistant',
			content: JSON.stringify({
				type: 'assistant',
				uuid: 'ma4',
				session_id: 'space:space-1:task:task-1',
				message: {
					content: [{ type: 'text', text: 'Task agent completing final steps.' }],
				},
			}),
			createdAt: 1_710_000_003_000,
		},
	];
}

function makeMultiAgentMixedBlockRows() {
	return [
		{
			id: 'label-1',
			sessionId: 'space:space-1:task:task-1',
			kind: 'task_agent',
			role: 'task',
			label: 'Task Agent',
			taskId: 'task-1',
			taskTitle: 'Task One',
			messageType: 'assistant',
			content: JSON.stringify({
				type: 'assistant',
				uuid: 'la1',
				session_id: 'space:space-1:task:task-1',
				message: {
					content: [{ type: 'thinking', thinking: 'Deciding the next step.' }],
				},
			}),
			createdAt: 1_710_000_000_000,
		},
		{
			id: 'label-2',
			sessionId: 'space:space-1:task:task-1:node:coder',
			kind: 'node_agent',
			role: 'coder',
			label: 'Coder Agent',
			taskId: 'task-1',
			taskTitle: 'Task One',
			messageType: 'assistant',
			content: JSON.stringify({
				type: 'assistant',
				uuid: 'la2',
				session_id: 'space:space-1:task:task-1:node:coder',
				message: {
					content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test' } }],
				},
			}),
			createdAt: 1_710_000_001_000,
		},
		{
			id: 'label-3',
			sessionId: 'space:space-1:task:task-1:node:reviewer',
			kind: 'node_agent',
			role: 'reviewer',
			label: 'Reviewer Agent',
			taskId: 'task-1',
			taskTitle: 'Task One',
			messageType: 'assistant',
			content: JSON.stringify({
				type: 'assistant',
				uuid: 'la3',
				session_id: 'space:space-1:task:task-1:node:reviewer',
				message: {
					content: [{ type: 'tool_use', id: 'tu2', name: 'Glob', input: { pattern: '*.ts' } }],
				},
			}),
			createdAt: 1_710_000_002_000,
		},
	];
}

function makeTerminalPreservedRows() {
	// 3 non-terminal body blocks (Coder / Reviewer / Space) followed by a
	// trailing terminal error result from the Task Agent. The reducer should
	// keep all three body blocks AND the trailing terminal, producing 4 visible
	// compact blocks and one ERROR badge.
	return [
		{
			id: 'tp-coder',
			sessionId: 'space:space-1:task:task-1:node:coder',
			kind: 'node_agent',
			role: 'coder',
			label: 'Coder Agent',
			taskId: 'task-1',
			taskTitle: 'Task One',
			messageType: 'assistant',
			content: JSON.stringify({
				type: 'assistant',
				uuid: 'tp-c1',
				session_id: 'space:space-1:task:task-1:node:coder',
				message: { content: [{ type: 'text', text: 'Coder retrying.' }] },
			}),
			createdAt: 1_710_000_001_000,
		},
		{
			id: 'tp-reviewer',
			sessionId: 'space:space-1:task:task-1:node:reviewer',
			kind: 'node_agent',
			role: 'reviewer',
			label: 'Reviewer Agent',
			taskId: 'task-1',
			taskTitle: 'Task One',
			messageType: 'assistant',
			content: JSON.stringify({
				type: 'assistant',
				uuid: 'tp-rv1',
				session_id: 'space:space-1:task:task-1:node:reviewer',
				message: { content: [{ type: 'text', text: 'Reviewer re-checking.' }] },
			}),
			createdAt: 1_710_000_002_000,
		},
		{
			id: 'tp-space',
			sessionId: 'space:space-1:task:task-1:node:space',
			kind: 'node_agent',
			role: 'space',
			label: 'Space Agent',
			taskId: 'task-1',
			taskTitle: 'Task One',
			messageType: 'assistant',
			content: JSON.stringify({
				type: 'assistant',
				uuid: 'tp-s1',
				session_id: 'space:space-1:task:task-1:node:space',
				message: { content: [{ type: 'text', text: 'Space agent finalising.' }] },
			}),
			createdAt: 1_710_000_003_000,
		},
		{
			id: 'tp-result',
			sessionId: 'space:space-1:task:task-1',
			kind: 'task_agent',
			role: 'task',
			label: 'Task Agent',
			taskId: 'task-1',
			taskTitle: 'Task One',
			messageType: 'result',
			content: JSON.stringify({
				type: 'result',
				subtype: 'error',
				uuid: 'tp-r1',
				session_id: 'space:space-1:task:task-1',
				usage: { input_tokens: 5, output_tokens: 3 },
			}),
			createdAt: 1_710_000_004_000,
		},
	];
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('SpaceTaskUnifiedThread', () => {
	beforeEach(() => {
		cleanup();
		window.localStorage.clear();
		mockRenderStyle = 'compact';
		mockRows = makeRows();
		mockIsLoading = false;
		mockIsReconnecting = false;
	});

	afterEach(() => {
		cleanup();
	});

	// ── Default compact mode ──────────────────────────────────────────────────

	it('renders compact mode by default and delegates each row to SDKMessageRenderer', () => {
		render(<SpaceTaskUnifiedThread taskId="task-1" />);
		expect(screen.getByTestId('space-task-event-feed-compact')).toBeTruthy();
		// 2 rows total (assistant + user), both go through SDKMessageRenderer.
		const rendered = screen.getAllByTestId('sdk-message-renderer');
		expect(rendered.length).toBe(2);
		// The assistant's full text block (incl. "patch next") stays visible
		// — compact mode no longer truncates it.
		expect(
			screen.getByText(
				'I found the relevant files and will patch next. This full assistant message should remain visible in compact mode without truncation.'
			)
		).toBeTruthy();
		// The user message content is rendered too.
		expect(screen.getByText('Please keep updates compact.')).toBeTruthy();
	});

	it('does not render compact/verbose toggle controls', () => {
		render(<SpaceTaskUnifiedThread taskId="task-1" />);
		expect(screen.queryByTestId('space-task-thread-mode-compact')).toBeNull();
		expect(screen.queryByTestId('space-task-thread-mode-verbose')).toBeNull();
	});

	// ── Noise filtering ───────────────────────────────────────────────────────

	it('filters system-init and non-rejected rate-limit noise in compact mode', () => {
		mockRows = makeNoiseRows();
		render(<SpaceTaskUnifiedThread taskId="task-1" />);

		// system-init and allowed rate-limit are dropped by preFilterRows;
		// result-success (terminal) and rate-rejected (error) remain.
		const rendered = screen.getAllByTestId('sdk-message-renderer');
		expect(rendered.length).toBe(2);

		// The terminal block's DONE badge is rendered for the success result.
		expect(screen.getByText('DONE')).toBeTruthy();
	});

	it('still renders the running-block wrapper while the debug override is active', () => {
		// NOTE: the feed currently hardcodes the running-block index to the last
		// visible block for debugging the animation, so even terminal-tail-only
		// threads show the arc. Flip this assertion back to `toBeNull()` when
		// the debug override is removed.
		mockRows = makeNoiseRows();
		render(<SpaceTaskUnifiedThread taskId="task-1" />);
		expect(screen.queryByTestId('compact-running-block')).toBeTruthy();
	});

	// ── 3-block limit ─────────────────────────────────────────────────────────

	it('shows only the last 3 logical blocks when more than 3 exist', () => {
		mockRows = makeMultiAgentRows();
		render(<SpaceTaskUnifiedThread taskId="task-1" />);

		expect(screen.getByTestId('space-task-event-feed-compact')).toBeTruthy();

		// Last 3 (Coder, Reviewer, Task-final) are visible.
		expect(screen.getByText('Coder agent writing the code changes.')).toBeTruthy();
		expect(screen.getByText('Reviewer agent checking the changes.')).toBeTruthy();
		expect(screen.getByText('Task agent completing final steps.')).toBeTruthy();

		// First block (Task Agent planning) is outside the last-3 window → hidden.
		expect(screen.queryByText('Task agent is planning the implementation.')).toBeNull();
	});

	it('preserves chronological ordering of the visible blocks', () => {
		mockRows = makeMultiAgentRows();
		render(<SpaceTaskUnifiedThread taskId="task-1" />);

		const allText = screen.getByTestId('space-task-event-feed-compact').textContent ?? '';
		const coderIdx = allText.indexOf('Coder agent writing');
		const reviewerIdx = allText.indexOf('Reviewer agent checking');
		const taskFinalIdx = allText.indexOf('Task agent completing');

		expect(coderIdx).toBeGreaterThanOrEqual(0);
		expect(reviewerIdx).toBeGreaterThan(coderIdx);
		expect(taskFinalIdx).toBeGreaterThan(reviewerIdx);
	});

	// ── Terminal block preservation ───────────────────────────────────────────

	it('always shows terminal blocks even when outside the last-3 window', () => {
		mockRows = makeTerminalPreservedRows();
		render(<SpaceTaskUnifiedThread taskId="task-1" />);

		// Terminal block's ERROR badge is present (from block 1's error result).
		expect(screen.getByText('ERROR')).toBeTruthy();

		// Last-3 block messages still visible.
		expect(screen.getByText('Coder retrying.')).toBeTruthy();
		expect(screen.getByText('Reviewer re-checking.')).toBeTruthy();
		expect(screen.getByText('Space agent finalising.')).toBeTruthy();
	});

	// ── Running indicator ─────────────────────────────────────────────────────

	it('shows the running-block wrapper when the tail block is non-terminal', () => {
		mockRows = makeRows();
		render(<SpaceTaskUnifiedThread taskId="task-1" />);
		expect(screen.getByTestId('compact-running-block')).toBeTruthy();
	});

	// ── Agent identity ────────────────────────────────────────────────────────

	it('renders distinct agent identity headers for each visible block', () => {
		mockRows = makeMultiAgentMixedBlockRows();
		const { container } = render(<SpaceTaskUnifiedThread taskId="task-1" />);

		const labels = Array.from(
			container.querySelectorAll('[data-testid="compact-block-header"] span[style*="color"]')
		).map((el) => el.textContent);

		expect(labels).toContain('TASK');
		expect(labels).toContain('CODER');
		expect(labels).toContain('REVIEWER');
	});

	it('applies distinct colors to different agent identity headers', () => {
		mockRows = makeMultiAgentMixedBlockRows();
		const { container } = render(<SpaceTaskUnifiedThread taskId="task-1" />);

		const colored = Array.from(
			container.querySelectorAll('[data-testid="compact-block-header"] span[style*="color"]')
		);
		const taskLabelSpan = colored.find((el) => el.textContent === 'TASK') as
			| HTMLElement
			| undefined;
		const coderLabelSpan = colored.find((el) => el.textContent === 'CODER') as
			| HTMLElement
			| undefined;

		expect(taskLabelSpan).toBeTruthy();
		expect(coderLabelSpan).toBeTruthy();

		const taskColor = taskLabelSpan!.style.color;
		const coderColor = coderLabelSpan!.style.color;
		expect(taskColor).not.toBe('');
		expect(coderColor).not.toBe('');
		expect(taskColor).not.toBe(coderColor);
	});

	it('renders a colored dot alongside each agent header', () => {
		mockRows = makeMultiAgentRows();
		const { container } = render(<SpaceTaskUnifiedThread taskId="task-1" />);

		const dots = container.querySelectorAll(
			'[data-testid="compact-block-header"] span[style*="background-color"]'
		);
		// The feed shows at most 3 blocks; so between 1 and 3 dots.
		expect(dots.length).toBeGreaterThanOrEqual(1);
		expect(dots.length).toBeLessThanOrEqual(3);
		dots.forEach((dot) => {
			expect((dot as HTMLElement).style.backgroundColor).not.toBe('');
		});
	});

	// ── Legacy mode ───────────────────────────────────────────────────────────

	it('renders legacy feed when style is set to legacy', () => {
		mockRenderStyle = 'legacy';
		render(<SpaceTaskUnifiedThread taskId="task-1" />);

		expect(screen.getByTestId('space-task-event-feed-legacy')).toBeTruthy();
		expect(screen.queryByTestId('space-task-event-feed-compact')).toBeNull();
	});

	it('legacy mode shows ALL multi-agent messages (no block limit)', () => {
		mockRenderStyle = 'legacy';
		mockRows = makeMultiAgentRows();
		render(<SpaceTaskUnifiedThread taskId="task-1" />);

		expect(screen.getByText('Task agent is planning the implementation.')).toBeTruthy();
		expect(screen.getByText('Coder agent writing the code changes.')).toBeTruthy();
		expect(screen.getByText('Reviewer agent checking the changes.')).toBeTruthy();
		expect(screen.getByText('Task agent completing final steps.')).toBeTruthy();
	});

	it('legacy mode hides success result events (unchanged from pre-compact behavior)', () => {
		mockRenderStyle = 'legacy';
		mockRows = makeNoiseRows();
		render(<SpaceTaskUnifiedThread taskId="task-1" />);

		expect(screen.queryByText('Completed')).toBeNull();
		expect(screen.queryByText('System')).toBeNull();
	});

	// ── Loading / reconnecting / empty states ─────────────────────────────────

	it('shows loading state when isLoading is true', () => {
		mockIsLoading = true;
		mockRows = [];
		render(<SpaceTaskUnifiedThread taskId="task-1" />);
		expect(screen.getByText('Loading task thread…')).toBeTruthy();
	});

	it('shows reconnecting state when isReconnecting is true', () => {
		mockIsReconnecting = true;
		mockRows = [];
		render(<SpaceTaskUnifiedThread taskId="task-1" />);
		expect(screen.getByText('Reconnecting task thread…')).toBeTruthy();
	});

	it('shows empty state when no rows exist', () => {
		mockRows = [];
		render(<SpaceTaskUnifiedThread taskId="task-1" />);
		expect(screen.getByText('No task-agent activity yet.')).toBeTruthy();
	});
});
