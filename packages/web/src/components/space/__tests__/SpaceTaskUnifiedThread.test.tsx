// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
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
	SDKMessageRenderer: ({ message }: { message: { type: string } }) => (
		<div data-testid="sdk-message-renderer">{message.type}</div>
	),
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
						{ type: 'text', text: 'I found the relevant files and will patch next.' },
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
		expect(screen.getByText('Tool · Glob')).toBeTruthy();
	});

	it('switches to roster mode', () => {
		render(<SpaceTaskUnifiedThread taskId="task-1" />);
		fireEvent.click(screen.getByTestId('space-task-thread-mode-roster'));
		expect(screen.getByTestId('space-task-event-feed-roster')).toBeTruthy();
	});

	it('switches to verbose mode and renders SDKMessageRenderer rows', () => {
		render(<SpaceTaskUnifiedThread taskId="task-1" />);
		fireEvent.click(screen.getByTestId('space-task-thread-mode-verbose'));
		expect(screen.getByTestId('space-task-event-feed-verbose')).toBeTruthy();
		expect(screen.getAllByTestId('sdk-message-renderer')).toHaveLength(2);
	});

	it('filters init/success/non-error-rate-limit noise in compact mode', () => {
		mockRows = makeNoiseRows();
		render(<SpaceTaskUnifiedThread taskId="task-1" />);
		expect(screen.queryByText('Completed')).toBeNull();
		expect(screen.queryByText('System')).toBeNull();
		expect(screen.getByText('Rate Limit')).toBeTruthy();
		expect(screen.getByText('five hour · rejected')).toBeTruthy();
	});
});
