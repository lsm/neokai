import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render } from '@testing-library/preact';
import type { ChatComposerProps } from '../../ChatComposer';

// Mock useModelSwitcher — avoids real WebSocket/RPC calls in unit tests
vi.mock('../../../hooks', () => ({
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
			/>
		);
	},
}));

import { TaskSessionChatComposer } from '../TaskSessionChatComposer';

const mentionCandidates = [
	{ id: 'a1', name: 'Coder' },
	{ id: 'a2', name: 'Reviewer' },
];

function renderComposer(overrides: Partial<Parameters<typeof TaskSessionChatComposer>[0]> = {}) {
	const onSend = vi.fn().mockResolvedValue(true);
	const view = render(
		<TaskSessionChatComposer
			sessionId="task-session-id"
			mentionCandidates={mentionCandidates}
			hasTaskAgentSession={true}
			canSend={true}
			isSending={false}
			isProcessing={false}
			errorMessage={null}
			onSend={onSend}
			{...overrides}
		/>
	);
	return { ...view, onSend };
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

	it('renders a non-interactive readability scrim behind the floating composer', () => {
		const { container, getByTestId } = renderComposer();
		const scrim = getByTestId('task-composer-readability-scrim');
		expect(scrim.className).toContain('pointer-events-none');
		expect(container.querySelector('.bg-gradient-to-t')).toBeTruthy();
		expect(container.querySelector('.backdrop-blur-\\[1px\\]')).toBeTruthy();
		expect(scrim.getAttribute('aria-hidden')).toBe('true');
	});

	it('passes sessionId to ChatComposer', () => {
		renderComposer({ sessionId: 'my-session' });
		expect(lastChatComposerProps?.sessionId).toBe('my-session');
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
		expect(lastChatComposerProps?.inputPlaceholder).toBe('Message task agent...');
	});

	it('uses auto-start placeholder when hasTaskAgentSession is false', () => {
		renderComposer({ hasTaskAgentSession: false });
		expect(lastChatComposerProps?.inputPlaceholder).toBe('Message task agent (auto-start)...');
	});

	it('forwards isProcessing to ChatComposer', () => {
		renderComposer({ isProcessing: true });
		expect(lastChatComposerProps?.isProcessing).toBe(true);
	});
});
