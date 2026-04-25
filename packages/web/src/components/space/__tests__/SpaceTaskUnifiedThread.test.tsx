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
		if (typeof content === 'string') return <div data-testid="sdk-message-renderer">{content}</div>;
		if (Array.isArray(content)) {
			const text = content
				.filter((b: any) => b?.type === 'text' && typeof b?.text === 'string')
				.map((b: any) => b.text)
				.join(' ')
				.trim();
			return <div data-testid="sdk-message-renderer">{text || message?.type}</div>;
		}
		return <div data-testid="sdk-message-renderer">{message?.type}</div>;
	},
}));

function makeRow(
	id: string,
	label: string,
	message: unknown,
	createdAt: number,
	sessionId = 'space:space-1:task:task-1'
) {
	return {
		id,
		sessionId,
		kind: 'task_agent',
		role: 'task',
		label,
		taskId: 'task-1',
		taskTitle: 'Task One',
		messageType: typeof message === 'object' ? (message as any).type : 'assistant',
		content: JSON.stringify(message),
		createdAt,
	};
}

function makeCompactRows() {
	return [
		makeRow(
			'u1',
			'Task Agent',
			{
				type: 'user',
				uuid: 'u1',
				session_id: 'space:space-1:task:task-1',
				message: { content: 'Initial ask' },
			},
			1
		),
		makeRow(
			'a1',
			'Task Agent',
			{ type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'old-1' }] } },
			2
		),
		makeRow(
			'a2',
			'Coder Agent',
			{ type: 'assistant', uuid: 'a2', message: { content: [{ type: 'text', text: 'old-2' }] } },
			3
		),
		makeRow(
			'a3',
			'Reviewer Agent',
			{ type: 'assistant', uuid: 'a3', message: { content: [{ type: 'text', text: 'old-3' }] } },
			4
		),
		makeRow(
			'a4',
			'Task Agent',
			{ type: 'assistant', uuid: 'a4', message: { content: [{ type: 'text', text: 'tail-1' }] } },
			5
		),
		makeRow(
			'a5',
			'Task Agent',
			{ type: 'assistant', uuid: 'a5', message: { content: [{ type: 'text', text: 'tail-2' }] } },
			6
		),
		makeRow(
			'a6',
			'Task Agent',
			{ type: 'assistant', uuid: 'a6', message: { content: [{ type: 'text', text: 'tail-3' }] } },
			7
		),
		makeRow(
			'a7',
			'Task Agent',
			{ type: 'assistant', uuid: 'a7', message: { content: [{ type: 'text', text: 'tail-4' }] } },
			8
		),
		makeRow(
			'a8',
			'Task Agent',
			{ type: 'assistant', uuid: 'a8', message: { content: [{ type: 'text', text: 'tail-5' }] } },
			9
		),
	];
}

describe('SpaceTaskUnifiedThread', () => {
	beforeEach(() => {
		cleanup();
		mockRows = makeCompactRows();
		mockIsLoading = false;
		mockIsReconnecting = false;
	});

	afterEach(() => cleanup());

	it('renders compact feed with full history grouped by turn', () => {
		render(<SpaceTaskUnifiedThread taskId="task-1" />);

		expect(screen.getByTestId('space-task-event-feed-compact')).toBeTruthy();
		expect(screen.getByText('Initial ask')).toBeTruthy();
		expect(screen.getByText('old-1')).toBeTruthy();
		expect(screen.getByText('old-2')).toBeTruthy();
		expect(screen.getByText('old-3')).toBeTruthy();
		expect(screen.getByText('tail-1')).toBeTruthy();
		expect(screen.getByText('tail-5')).toBeTruthy();
		expect(screen.queryByTestId('compact-flat-hidden-divider')).toBeNull();
		expect(screen.queryByTestId('compact-turn-divider')).toBeNull();
	});

	it('renders the floating agent tag', () => {
		render(<SpaceTaskUnifiedThread taskId="task-1" />);
		const tag = screen.getByTestId('agent-name-tag');
		expect(tag).toBeTruthy();
		expect(tag.textContent).toContain('TASK');
	});

	it('shows loading state when loading', () => {
		mockIsLoading = true;
		mockRows = [];
		render(<SpaceTaskUnifiedThread taskId="task-1" />);
		expect(screen.getByText('Loading task thread…')).toBeTruthy();
	});

	it('shows reconnecting state when reconnecting', () => {
		mockIsReconnecting = true;
		mockRows = [];
		render(<SpaceTaskUnifiedThread taskId="task-1" />);
		expect(screen.getByText('Reconnecting task thread…')).toBeTruthy();
	});

	it('shows empty state when no rows', () => {
		mockRows = [];
		render(<SpaceTaskUnifiedThread taskId="task-1" />);
		expect(screen.getByText('No task-agent activity yet.')).toBeTruthy();
	});
});
