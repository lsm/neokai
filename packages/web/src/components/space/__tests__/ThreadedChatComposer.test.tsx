// @ts-nocheck
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';

const mockAgentWorking = signal(false);
const mockHandleInterrupt = vi.fn(async () => {});

vi.mock('../../../lib/state.ts', () => ({
	get isAgentWorking() {
		return {
			get value() {
				return mockAgentWorking.value;
			},
		};
	},
}));

vi.mock('../../../hooks', () => ({
	useInterrupt: () => ({
		interrupting: false,
		handleInterrupt: mockHandleInterrupt,
	}),
}));

import { ThreadedChatComposer } from '../ThreadedChatComposer';

const mentionCandidates = [
	{ id: 'a1', name: 'Coder' },
	{ id: 'a2', name: 'Reviewer' },
];

function renderComposer(overrides: Partial<Parameters<typeof ThreadedChatComposer>[0]> = {}) {
	const onSend = vi.fn().mockResolvedValue(true);
	const view = render(
		<ThreadedChatComposer
			taskSessionId="test-session-id"
			mentionCandidates={mentionCandidates}
			hasTaskAgentSession={true}
			canSend={true}
			isSending={false}
			errorMessage={null}
			onSend={onSend}
			{...overrides}
		/>
	);
	return { ...view, onSend };
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
	Object.defineProperty(textarea, 'selectionStart', {
		get: () => value.length,
		configurable: true,
	});
	fireEvent.input(textarea, { target: { value } });
}

describe('ThreadedChatComposer', () => {
	beforeEach(() => {
		cleanup();
		mockAgentWorking.value = false;
		mockHandleInterrupt.mockClear();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders MessageInput-style send button and session placeholder', () => {
		const { getByPlaceholderText, getByTestId } = renderComposer();
		expect(getByPlaceholderText('Message task agent...')).toBeTruthy();
		expect(getByTestId('send-button')).toBeTruthy();
	});

	it('renders auto-ensure placeholder when no task session exists', () => {
		const { getByPlaceholderText } = renderComposer({ hasTaskAgentSession: false });
		expect(getByPlaceholderText('Message task agent (auto-start)...')).toBeTruthy();
	});

	it('submits with send button and clears draft on success', async () => {
		const { getByPlaceholderText, getByTestId, onSend } = renderComposer();
		const textarea = getByPlaceholderText('Message task agent...') as HTMLTextAreaElement;

		setTextareaValue(textarea, 'Ship it');
		fireEvent.click(getByTestId('send-button'));

		await waitFor(() => expect(onSend).toHaveBeenCalledWith('Ship it'));
		await waitFor(() => expect(textarea.value).toBe(''));
	});

	it('does not clear draft when send returns false', async () => {
		const onSend = vi.fn().mockResolvedValue(false);
		const { getByPlaceholderText, getByTestId } = renderComposer({ onSend });
		const textarea = getByPlaceholderText('Message task agent...') as HTMLTextAreaElement;

		setTextareaValue(textarea, 'Needs retry');
		fireEvent.click(getByTestId('send-button'));

		await waitFor(() => expect(onSend).toHaveBeenCalledWith('Needs retry'));
		expect(textarea.value).toBe('Needs retry');
	});

	it('uses Enter to select mention when mention list is open', async () => {
		const { getByPlaceholderText, getByTestId, queryByTestId, onSend } = renderComposer();
		const textarea = getByPlaceholderText('Message task agent...') as HTMLTextAreaElement;

		setTextareaValue(textarea, '@Co');
		await waitFor(() => expect(getByTestId('mention-autocomplete')).toBeTruthy());

		fireEvent.keyDown(textarea, { key: 'Enter' });
		await waitFor(() => expect(queryByTestId('mention-autocomplete')).toBeNull());
		expect(textarea.value).toContain('@Coder');
		expect(onSend).not.toHaveBeenCalled();
	});

	it('does not submit on Shift+Enter', () => {
		const { getByPlaceholderText, onSend } = renderComposer();
		const textarea = getByPlaceholderText('Message task agent...');

		setTextareaValue(textarea as HTMLTextAreaElement, 'line one');
		fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
		expect(onSend).not.toHaveBeenCalled();
	});

	it('should show stop button when agent is working and textarea is empty', () => {
		mockAgentWorking.value = true;
		const { getByTestId, queryByTestId } = renderComposer();

		expect(getByTestId('stop-button')).toBeTruthy();
		expect(queryByTestId('send-button')).toBeNull();
	});

	it('should show send button when agent is working but has content', () => {
		mockAgentWorking.value = true;
		const { getByPlaceholderText, getByTestId, queryByTestId } = renderComposer();
		const textarea = getByPlaceholderText('Message task agent...') as HTMLTextAreaElement;

		setTextareaValue(textarea, 'Queued follow-up');

		expect(getByTestId('send-button')).toBeTruthy();
		expect(queryByTestId('stop-button')).toBeNull();
	});
});
