// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import { SpaceTaskUnifiedThread } from '../SpaceTaskUnifiedThread';

let mockRows = [];
let mockIsLoading = false;
let mockIsReconnecting = false;

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
		// Task Agent message (task_agent kind) at time 0
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
		// Coder Agent message (node_agent kind) at time 1
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
		// Reviewer Agent message (node_agent kind) at time 2
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

// Rows containing thinking/tool events so agent-label spans are rendered in compact mode.
// (Text events use a simplified code path that omits the inline agent-label span; tool/thinking
// events use the generic compact path which always shows the label.)
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

describe('SpaceTaskUnifiedThread', () => {
	beforeEach(() => {
		cleanup();
		window.localStorage.clear();
		mockRows = makeRows();
		mockIsLoading = false;
		mockIsReconnecting = false;
	});

	afterEach(() => {
		cleanup();
	});

	it('renders compact mode by default with flattened event rows', () => {
		render(<SpaceTaskUnifiedThread taskId="task-1" />);
		expect(screen.getByTestId('space-task-event-feed-compact')).toBeTruthy();
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

	it('filters init/success/non-error-rate-limit noise in compact mode', () => {
		mockRows = makeNoiseRows();
		render(<SpaceTaskUnifiedThread taskId="task-1" />);
		expect(screen.queryByText('Completed')).toBeNull();
		expect(screen.queryByText('System')).toBeNull();
		// Rejected rate-limit IS shown (it's an error)
		expect(screen.getByText('Rate Limit')).toBeTruthy();
		expect(screen.getByText('five hour · rejected')).toBeTruthy();
		// Allowed rate-limit is filtered out (non-error noise)
		expect(screen.queryByText('five hour · allowed')).toBeNull();
	});

	it('renders messages from multiple agents (task_agent + node_agent) in compact mode', () => {
		mockRows = makeMultiAgentRows();
		render(<SpaceTaskUnifiedThread taskId="task-1" />);

		expect(screen.getByTestId('space-task-event-feed-compact')).toBeTruthy();

		// All four text messages should be visible
		expect(screen.getByText('Task agent is planning the implementation.')).toBeTruthy();
		expect(screen.getByText('Coder agent writing the code changes.')).toBeTruthy();
		expect(screen.getByText('Reviewer agent checking the changes.')).toBeTruthy();
		expect(screen.getByText('Task agent completing final steps.')).toBeTruthy();
	});

	it('renders messages from different agents with distinct colored side rails', () => {
		mockRows = makeMultiAgentRows();
		const { container } = render(<SpaceTaskUnifiedThread taskId="task-1" />);

		// All event rows should have border-color side rails
		const borderedElements = container.querySelectorAll('[style*="border-color"]');
		expect(borderedElements.length).toBeGreaterThanOrEqual(4);

		// Collect all border-color values
		const borderColors = new Set<string>();
		borderedElements.forEach((el) => {
			const color = (el as HTMLElement).style.borderColor;
			if (color) borderColors.add(color);
		});

		// makeMultiAgentRows has 3 distinct agent labels (Task Agent, Coder Agent, Reviewer Agent)
		// so at least 3 distinct border colors must be present
		expect(borderColors.size).toBeGreaterThanOrEqual(3);
	});

	it('renders task agent messages visually distinct from node agent messages via agent labels', () => {
		// Use rows with thinking/tool events: these render the inline agent-label span in compact mode.
		// (Text events use a simplified path that omits the label span.)
		mockRows = makeMultiAgentNonTextRows();
		const { container } = render(<SpaceTaskUnifiedThread taskId="task-1" />);

		// shortAgentLabel strips " Agent" suffix and uppercases, so:
		// "Task Agent" → "TASK", "Coder Agent" → "CODER", "Reviewer Agent" → "REVIEWER"
		const allSpans = container.querySelectorAll('span[style]');
		const labelTexts = Array.from(allSpans).map((el) => el.textContent);

		expect(labelTexts.some((t) => t === 'TASK')).toBe(true);
		expect(labelTexts.some((t) => t === 'CODER')).toBe(true);
		expect(labelTexts.some((t) => t === 'REVIEWER')).toBe(true);
	});

	it('applies correct color to Task Agent vs node agent agent labels', () => {
		// Use rows with thinking/tool events to get agent-label spans rendered.
		mockRows = makeMultiAgentNonTextRows();
		const { container } = render(<SpaceTaskUnifiedThread taskId="task-1" />);

		const allSpans = container.querySelectorAll('span[style]');
		const taskLabelSpan = Array.from(allSpans).find((el) => el.textContent === 'TASK');
		const coderLabelSpan = Array.from(allSpans).find((el) => el.textContent === 'CODER');

		expect(taskLabelSpan).toBeTruthy();
		expect(coderLabelSpan).toBeTruthy();

		// Task Agent (#66A7FF) and Coder Agent (#42C7B5) must have different colors.
		const taskColor = (taskLabelSpan as HTMLElement).style.color;
		const coderColor = (coderLabelSpan as HTMLElement).style.color;
		expect(taskColor).not.toBe('');
		expect(coderColor).not.toBe('');
		expect(taskColor).not.toBe(coderColor);
	});

	it('preserves chronological ordering of messages across agents', () => {
		mockRows = makeMultiAgentRows();
		render(<SpaceTaskUnifiedThread taskId="task-1" />);

		// All four messages must appear in chronological order
		const allText = screen.getByTestId('space-task-event-feed-compact').textContent ?? '';
		const taskPlanIdx = allText.indexOf('Task agent is planning');
		const coderIdx = allText.indexOf('Coder agent writing');
		const reviewerIdx = allText.indexOf('Reviewer agent checking');
		const taskFinalIdx = allText.indexOf('Task agent completing');

		expect(taskPlanIdx).toBeGreaterThanOrEqual(0);
		expect(coderIdx).toBeGreaterThan(taskPlanIdx);
		expect(reviewerIdx).toBeGreaterThan(coderIdx);
		expect(taskFinalIdx).toBeGreaterThan(reviewerIdx);
	});

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
