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
		// Task Agent message at time 0
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
		// Coder Agent message at time 1
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
		// Reviewer Agent message at time 2
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
		// Task Agent again at time 3 (interleaved)
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

// Rows containing thinking/tool events to produce inline agent-label spans.
// The compact mode renders agent identity via block-level headers using shortAgentLabel.
function makeMultiAgentNonTextRows() {
	return [
		// Task Agent: thinking block
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
		// Coder Agent: tool_use block
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
		// Reviewer Agent: tool_use block
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

// Rows that produce a terminal result block followed by more activity —
// used to test that the terminal block is preserved even outside the last-3 window.
function makeTerminalPreservedRows() {
	// 4 distinct agent blocks; result is in block 1 (outside last-3 window).
	return [
		// Block 1 (terminal): Task Agent sends result
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
			createdAt: 1_710_000_000_000,
		},
		// Block 2: Coder Agent
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
		// Block 3: Reviewer Agent
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
		// Block 4: Space Agent
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
	];
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('SpaceTaskUnifiedThread', () => {
	beforeEach(() => {
		cleanup();
		window.localStorage.clear();
		mockRenderStyle = 'compact'; // reset to default before each test
		mockRows = makeRows();
		mockIsLoading = false;
		mockIsReconnecting = false;
	});

	afterEach(() => {
		cleanup();
	});

	// ── Default compact mode ──────────────────────────────────────────────────

	it('renders compact mode by default with flattened event rows', () => {
		render(<SpaceTaskUnifiedThread taskId="task-1" />);
		expect(screen.getByTestId('space-task-event-feed-compact')).toBeTruthy();
		// makeRows() produces 1 logical block (all Task Agent events) → all 4 events rendered
		expect(screen.getAllByTestId('space-task-event-row').length).toBeGreaterThanOrEqual(4);
		expect(screen.getByText('Thinking')).toBeTruthy();
		expect(
			screen.getByText(
				(_, element) =>
					element?.tagName.toLowerCase() === 'span' && element?.textContent === 'Glob: *.ts'
			)
		).toBeTruthy();
		expect(screen.queryByText('pattern: *.ts')).toBeNull();
		expect(screen.queryByText('Response')).toBeNull();
		expect(
			screen.getByText(
				'I found the relevant files and will patch next. This full assistant message should remain visible in compact mode without truncation.'
			)
		).toBeTruthy();
	});

	it('does not render compact/verbose toggle controls', () => {
		render(<SpaceTaskUnifiedThread taskId="task-1" />);
		expect(screen.queryByTestId('space-task-thread-mode-compact')).toBeNull();
		expect(screen.queryByTestId('space-task-thread-mode-verbose')).toBeNull();
	});

	// ── Noise filtering ───────────────────────────────────────────────────────

	it('filters system-init and non-error rate-limit noise in compact mode', () => {
		mockRows = makeNoiseRows();
		render(<SpaceTaskUnifiedThread taskId="task-1" />);

		// system init is filtered out
		expect(screen.queryByText('System')).toBeNull();
		// non-error rate-limit is filtered out
		expect(screen.queryByText('five hour · allowed')).toBeNull();

		// Compact mode preserves result blocks (terminal), so "Completed" IS visible
		// (unlike the legacy mode which hid success results)
		expect(screen.getByText('Completed')).toBeTruthy();

		// Rejected rate-limit IS shown (it's an error)
		expect(screen.getByText('Rate Limit')).toBeTruthy();
		expect(screen.getByText('five hour · rejected')).toBeTruthy();
	});

	// ── 3-block limit ─────────────────────────────────────────────────────────

	it('shows only the last 3 logical blocks when more than 3 exist', () => {
		// makeMultiAgentRows() has 4 logical blocks (Task→Coder→Reviewer→Task).
		// Compact mode shows the last 3: Coder, Reviewer, Task (completing).
		mockRows = makeMultiAgentRows();
		render(<SpaceTaskUnifiedThread taskId="task-1" />);

		expect(screen.getByTestId('space-task-event-feed-compact')).toBeTruthy();

		// These 3 (last) blocks are shown
		expect(screen.getByText('Coder agent writing the code changes.')).toBeTruthy();
		expect(screen.getByText('Reviewer agent checking the changes.')).toBeTruthy();
		expect(screen.getByText('Task agent completing final steps.')).toBeTruthy();

		// First block (Task Agent planning) is outside the last-3 window → hidden
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
		// makeTerminalPreservedRows() has 4 blocks; block 1 is a result-error
		// (terminal). The last-3 window covers blocks 2–4, so block 1 would
		// normally be hidden — but terminal blocks are always forced in.
		mockRows = makeTerminalPreservedRows();
		render(<SpaceTaskUnifiedThread taskId="task-1" />);

		// Terminal block (Error) is preserved
		expect(screen.getByText('Error')).toBeTruthy();

		// Last-3 blocks also visible
		expect(screen.getByText('Coder retrying.')).toBeTruthy();
		expect(screen.getByText('Reviewer re-checking.')).toBeTruthy();
		expect(screen.getByText('Space agent finalising.')).toBeTruthy();
	});

	// ── Running indicator ─────────────────────────────────────────────────────

	it('shows running indicator on the last block when thread is not terminal', () => {
		// makeRows() ends with a non-terminal block → running indicator expected
		mockRows = makeRows();
		render(<SpaceTaskUnifiedThread taskId="task-1" />);
		expect(screen.getByTestId('compact-running-block')).toBeTruthy();
	});

	it('does not show running indicator when the last block is terminal', () => {
		// makeNoiseRows() includes a result-success event; after filtering,
		// the last visible block contains that result event (terminal).
		mockRows = makeNoiseRows();
		render(<SpaceTaskUnifiedThread taskId="task-1" />);
		expect(screen.queryByTestId('compact-running-block')).toBeNull();
	});

	// ── Agent identity ────────────────────────────────────────────────────────

	it('renders distinct agent identity headers for each block', () => {
		mockRows = makeMultiAgentNonTextRows();
		const { container } = render(<SpaceTaskUnifiedThread taskId="task-1" />);

		// In compact mode, each block renders a header span with shortAgentLabel.
		// "Task Agent" → "TASK", "Coder Agent" → "CODER", "Reviewer Agent" → "REVIEWER"
		const allSpans = container.querySelectorAll('span[style]');
		const labelTexts = Array.from(allSpans).map((el) => el.textContent);

		expect(labelTexts.some((t) => t === 'TASK')).toBe(true);
		expect(labelTexts.some((t) => t === 'CODER')).toBe(true);
		expect(labelTexts.some((t) => t === 'REVIEWER')).toBe(true);
	});

	it('applies distinct colors to different agent identity headers', () => {
		mockRows = makeMultiAgentNonTextRows();
		const { container } = render(<SpaceTaskUnifiedThread taskId="task-1" />);

		const allSpans = container.querySelectorAll('span[style]');
		const taskLabelSpan = Array.from(allSpans).find((el) => el.textContent === 'TASK');
		const coderLabelSpan = Array.from(allSpans).find((el) => el.textContent === 'CODER');

		expect(taskLabelSpan).toBeTruthy();
		expect(coderLabelSpan).toBeTruthy();

		const taskColor = (taskLabelSpan as HTMLElement).style.color;
		const coderColor = (coderLabelSpan as HTMLElement).style.color;
		expect(taskColor).not.toBe('');
		expect(coderColor).not.toBe('');
		// Task Agent (#66A7FF) and Coder Agent (#42C7B5) must have different colors
		expect(taskColor).not.toBe(coderColor);
	});

	it('renders event rows with colored side rails (border-color) for each event', () => {
		// makeMultiAgentRows() has 4 blocks; compact shows last 3 (3 events, 1 per block).
		mockRows = makeMultiAgentRows();
		const { container } = render(<SpaceTaskUnifiedThread taskId="task-1" />);

		const borderedElements = container.querySelectorAll('[style*="border-color"]');
		expect(borderedElements.length).toBeGreaterThanOrEqual(3);

		// At least 3 distinct agent border colors (Coder, Reviewer, Task)
		const borderColors = new Set<string>();
		borderedElements.forEach((el) => {
			const color = (el as HTMLElement).style.borderColor;
			if (color) borderColors.add(color);
		});
		expect(borderColors.size).toBeGreaterThanOrEqual(3);
	});

	// ── Legacy mode ───────────────────────────────────────────────────────────

	it('renders legacy feed when style is set to legacy', () => {
		mockRenderStyle = 'legacy';
		render(<SpaceTaskUnifiedThread taskId="task-1" />);

		// Legacy feed has its own data-testid
		expect(screen.getByTestId('space-task-event-feed-legacy')).toBeTruthy();
		// New compact feed is NOT rendered in legacy mode
		expect(screen.queryByTestId('space-task-event-feed-compact')).toBeNull();
	});

	it('legacy mode shows ALL multi-agent messages (no block limit)', () => {
		mockRenderStyle = 'legacy';
		mockRows = makeMultiAgentRows();
		render(<SpaceTaskUnifiedThread taskId="task-1" />);

		// Legacy feed has no block limit — all 4 messages are visible
		expect(screen.getByText('Task agent is planning the implementation.')).toBeTruthy();
		expect(screen.getByText('Coder agent writing the code changes.')).toBeTruthy();
		expect(screen.getByText('Reviewer agent checking the changes.')).toBeTruthy();
		expect(screen.getByText('Task agent completing final steps.')).toBeTruthy();
	});

	it('legacy mode hides success result events (unchanged from pre-compact behavior)', () => {
		mockRenderStyle = 'legacy';
		mockRows = makeNoiseRows();
		render(<SpaceTaskUnifiedThread taskId="task-1" />);

		// Legacy mode filters success results
		expect(screen.queryByText('Completed')).toBeNull();
		// System init is also filtered
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
