import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import type { ChatComposerProps } from '../../ChatComposer';

// Mock useTargetSessionContext — avoids real WebSocket/RPC calls in unit tests
vi.mock('../../../hooks', () => ({
	useTargetSessionContext: () => ({
		targetSessionId: 'target-session-id',
		currentModel: 'claude-sonnet-4-6',
		currentModelInfo: null,
		availableModels: [],
		modelSwitching: false,
		modelLoading: false,
		thinkingLevel: 'auto',
		isProcessing: false,
		isStarted: true,
		switchModel: vi.fn(async () => {}),
		setThinkingLevel: vi.fn(async () => {}),
	}),
	useModelSwitcher: () => ({
		currentModel: 'claude-sonnet-4-6',
		currentModelInfo: null,
		availableModels: [],
		switching: false,
		loading: false,
		switchModel: vi.fn(async () => {}),
	}),
}));

// Mock ChatComposer — it depends on MessageInput, SessionStatusBar, and other
// components that require WebSocket connections and complex browser APIs.
// Capture the props passed to it so tests can inspect them.
let lastChatComposerProps: ChatComposerProps | null = null;
vi.mock('../../ChatComposer', () => ({
	ChatComposer: (props: ChatComposerProps) => {
		lastChatComposerProps = props;
		return (
			<div
				data-testid="mock-chat-composer"
				data-session-id={props.sessionId}
				data-is-waiting={String(props.isWaitingForInput)}
				data-placeholder={props.inputPlaceholder}
				data-thinking-level={props.thinkingLevel}
			>
				{props.inputLeadingElement}
			</div>
		);
	},
}));

import { TaskSessionChatComposer } from '../TaskSessionChatComposer';

const mentionCandidates = [
	{ id: 'a1', name: 'Coder' },
	{ id: 'a2', name: 'Reviewer' },
];
const targets = [
	{
		id: 'node:n1:coder',
		kind: 'node_agent' as const,
		label: 'Coder',
		agentName: 'coder',
		nodeName: 'Coding',
		state: 'Active',
	},
	{ id: 'task-agent', kind: 'task_agent' as const, label: 'Task Agent' },
];

const activityMembers = [
	{
		id: 'member-1',
		sessionId: 'coder-session-id',
		kind: 'node_agent' as const,
		label: 'Coder',
		role: 'coder',
		state: 'active' as const,
		processingStatus: 'idle' as const,
		messageCount: 0,
	},
];

function renderComposer(overrides: Partial<Parameters<typeof TaskSessionChatComposer>[0]> = {}) {
	const onSend = vi.fn().mockResolvedValue(true);
	const onTargetSelect = vi.fn();
	const view = render(
		<TaskSessionChatComposer
			sessionId="task-session-id"
			mentionCandidates={mentionCandidates}
			targets={targets}
			selectedTargetId="node:n1:coder"
			hasTaskAgentSession={true}
			canSend={true}
			isSending={false}
			autoScroll={true}
			errorMessage={null}
			activityMembers={activityMembers}
			onAutoScrollChange={vi.fn()}
			onTargetSelect={onTargetSelect}
			onSend={onSend}
			{...overrides}
		/>
	);
	return { ...view, onSend, onTargetSelect };
}

describe('TaskSessionChatComposer', () => {
	beforeEach(() => {
		cleanup();
		lastChatComposerProps = null;
	});

	afterEach(() => {
		cleanup();
	});

	it('renders the wrapper with correct data-testid', () => {
		const { getByTestId } = renderComposer();
		expect(getByTestId('task-session-chat-composer')).toBeTruthy();
	});

	it('renders the inner ChatComposer', () => {
		const { getByTestId } = renderComposer();
		expect(getByTestId('mock-chat-composer')).toBeTruthy();
	});

	it('anchors the shared floating ChatComposer shell locally', () => {
		const { queryByTestId, getByTestId } = renderComposer();
		expect(getByTestId('task-session-chat-composer').className).toContain('relative');
		expect(queryByTestId('task-composer-readability-scrim')).toBeNull();
	});

	it('passes target sessionId to ChatComposer', () => {
		renderComposer({ sessionId: 'my-session' });
		expect(lastChatComposerProps?.sessionId).toBe('target-session-id');
	});

	it('passes agentMentionCandidates to ChatComposer', () => {
		renderComposer();
		expect(lastChatComposerProps?.agentMentionCandidates).toEqual(mentionCandidates);
	});

	it('passes errorMessage to ChatComposer when provided', () => {
		renderComposer({ errorMessage: 'Something went wrong' });
		expect(lastChatComposerProps?.errorMessage).toBe('Something went wrong');
	});

	it('passes null errorMessage to ChatComposer when not provided', () => {
		renderComposer({ errorMessage: null });
		expect(lastChatComposerProps?.errorMessage).toBeNull();
	});

	it('disables input when canSend is false', () => {
		renderComposer({ canSend: false, isSending: false });
		expect(lastChatComposerProps?.isWaitingForInput).toBe(true);
	});

	it('disables input when isSending is true', () => {
		renderComposer({ canSend: true, isSending: true });
		expect(lastChatComposerProps?.isWaitingForInput).toBe(true);
	});

	it('enables input when canSend is true and not sending', () => {
		renderComposer({ canSend: true, isSending: false });
		expect(lastChatComposerProps?.isWaitingForInput).toBe(false);
	});

	it('uses task agent session placeholder when hasTaskAgentSession is true', () => {
		renderComposer({ hasTaskAgentSession: true });
		expect(lastChatComposerProps?.inputPlaceholder).toBe('Message Coder...');
	});

	it('uses auto-start placeholder when hasTaskAgentSession is false', () => {
		renderComposer({ hasTaskAgentSession: false, targets: [], selectedTargetId: null });
		expect(lastChatComposerProps?.inputPlaceholder).toBe('Message task agent (auto-start)...');
	});

	it('forwards auto-scroll state to ChatComposer', () => {
		const onAutoScrollChange = vi.fn();
		renderComposer({ autoScroll: false, onAutoScrollChange });
		expect(lastChatComposerProps?.autoScroll).toBe(false);
		expect(lastChatComposerProps?.onAutoScrollChange).toBe(onAutoScrollChange);
	});

	it('renders a recipient picker in the input leading slot', () => {
		const { getByTestId } = renderComposer();
		const trigger = getByTestId('task-composer-target-trigger');
		expect(trigger.textContent).toBe('C');
		expect(trigger.getAttribute('title')).toBe('Send to Coder');
		expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
		expect(lastChatComposerProps?.inputLeadingPaddingClass).toBe('pl-12');
		expect(lastChatComposerProps?.inputLeadingElement).toBeTruthy();
	});

	it('calls onTargetSelect when a recipient is selected', () => {
		const { getByTestId, getAllByTestId, onTargetSelect } = renderComposer();
		fireEvent.click(getByTestId('task-composer-target-trigger'));
		fireEvent.click(getAllByTestId('task-composer-target-option')[1]);
		expect(onTargetSelect).toHaveBeenCalledWith('task-agent');
	});

	it('passes thinkingLevel to ChatComposer', () => {
		renderComposer();
		expect(lastChatComposerProps?.thinkingLevel).toBe('auto');
	});

	it('passes disabled session features to ChatComposer', () => {
		renderComposer();
		expect(lastChatComposerProps?.features).toEqual({
			coordinator: false,
			worktree: false,
			rewind: false,
			archive: false,
			sessionInfo: false,
		});
	});

	it('wires onOpenTools to ChatComposer', () => {
		renderComposer();
		expect(typeof lastChatComposerProps?.onOpenTools).toBe('function');
	});

	it('wires onThinkingLevelChange to ChatComposer', () => {
		renderComposer();
		expect(typeof lastChatComposerProps?.onThinkingLevelChange).toBe('function');
	});
});
