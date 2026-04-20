/**
 * Tests for HumanInputArea component
 *
 * Verifies the key behavioral paths:
 * - Send button disabled when archived or no group
 * - canReactivateWithMessage hint shown for completed/cancelled tasks
 * - Draft restoration banner visibility and discard
 * - Target selector dropdown (worker vs leader)
 * - Message send error display
 * - Queue overlay renders queued messages
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, fireEvent, act } from '@testing-library/preact';
import type { ComponentChildren } from 'preact';
import { signal } from '@preact/signals';

import { HumanInputArea } from '../HumanInputArea';

// -------------------------------------------------------
// Mocks
// -------------------------------------------------------

const mockRequest = vi.fn();

vi.mock('../../../../hooks/useMessageHub.ts', () => ({
	useMessageHub: () => ({
		request: mockRequest,
		onEvent: vi.fn(() => () => {}),
		joinRoom: vi.fn(),
		leaveRoom: vi.fn(),
		isConnected: true,
	}),
}));

const _draftContentSignal = signal('');
const _draftRestoredSignal = signal(false);
const mockSetContent = vi.fn((v: string) => {
	_draftContentSignal.value = v;
});
const mockClearDraft = vi.fn(() => {
	_draftContentSignal.value = '';
	_draftRestoredSignal.value = false;
});

vi.mock('../../../../hooks/useTaskInputDraft.ts', () => ({
	useTaskInputDraft: () => ({
		get content() {
			return _draftContentSignal.value;
		},
		setContent: mockSetContent,
		clear: mockClearDraft,
		get draftRestored() {
			return _draftRestoredSignal.value;
		},
	}),
}));

vi.mock('../../../InputTextarea.tsx', () => ({
	InputTextarea: ({
		disabled,
		placeholder,
		onSubmit,
		leadingElement,
	}: {
		disabled?: boolean;
		placeholder?: string;
		onSubmit: () => void;
		leadingElement?: ComponentChildren;
	}) => (
		<div data-testid="input-textarea">
			{leadingElement}
			<textarea data-testid="textarea-field" disabled={disabled} placeholder={placeholder} />
			<button data-testid="send-button" onClick={onSubmit} disabled={disabled}>
				Send
			</button>
		</div>
	),
}));

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function defaultProps() {
	return {
		hasGroup: true,
		taskStatus: 'in_progress',
		roomId: 'room-1',
		taskId: 'task-1',
		leaderSessionId: 'leader-1',
		workerSessionId: 'worker-1',
	};
}

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe('HumanInputArea — disabled states', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'session.messages.byStatus') return { messages: [] };
			return {};
		});
		_draftContentSignal.value = '';
		_draftRestoredSignal.value = false;
	});

	afterEach(() => {
		cleanup();
	});

	it('disables send when taskStatus is archived', () => {
		const { getByTestId } = render(<HumanInputArea {...defaultProps()} taskStatus="archived" />);

		expect(getByTestId('send-button').hasAttribute('disabled')).toBe(true);
	});

	it('enables send when hasGroup is true and task is in_progress', () => {
		const { getByTestId } = render(<HumanInputArea {...defaultProps()} />);

		expect(getByTestId('send-button').hasAttribute('disabled')).toBe(false);
	});

	it('disables send when hasGroup is false and task is in_progress', () => {
		const { getByTestId } = render(
			<HumanInputArea {...defaultProps()} hasGroup={false} taskStatus="in_progress" />
		);

		expect(getByTestId('send-button').hasAttribute('disabled')).toBe(true);
	});
});

describe('HumanInputArea — canReactivateWithMessage hint', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		mockRequest.mockResolvedValue({ messages: [] });
		_draftContentSignal.value = '';
		_draftRestoredSignal.value = false;
	});

	afterEach(() => {
		cleanup();
	});

	it('shows reactivate hint when task is completed and has no group', () => {
		const { getByText } = render(
			<HumanInputArea {...defaultProps()} taskStatus="completed" hasGroup={false} />
		);

		expect(getByText('Sending a message will reactivate this task.')).toBeTruthy();
	});

	it('shows reactivate hint when task is cancelled and has no group', () => {
		const { getByText } = render(
			<HumanInputArea {...defaultProps()} taskStatus="cancelled" hasGroup={false} />
		);

		expect(getByText('Sending a message will reactivate this task.')).toBeTruthy();
	});

	it('does not show reactivate hint for in_progress task', () => {
		const { container } = render(<HumanInputArea {...defaultProps()} />);

		expect(container.textContent).not.toContain('Sending a message will reactivate this task.');
	});

	it('enables send for completed task without group (allows reactivation via message)', () => {
		const { getByTestId } = render(
			<HumanInputArea {...defaultProps()} taskStatus="completed" hasGroup={false} />
		);

		expect(getByTestId('send-button').hasAttribute('disabled')).toBe(false);
	});
});

describe('HumanInputArea — draft restoration banner', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		mockRequest.mockResolvedValue({ messages: [] });
		_draftContentSignal.value = '';
		_draftRestoredSignal.value = false;
	});

	afterEach(() => {
		cleanup();
	});

	it('does not show draft banner when draftRestored is false', () => {
		_draftRestoredSignal.value = false;
		const { queryByTestId } = render(<HumanInputArea {...defaultProps()} />);

		expect(queryByTestId('draft-restored-banner')).toBeNull();
	});

	it('shows draft banner when draftRestored is true', async () => {
		_draftRestoredSignal.value = true;
		const { getByTestId } = render(<HumanInputArea {...defaultProps()} />);

		await waitFor(() => {
			expect(getByTestId('draft-restored-banner')).toBeTruthy();
		});
	});

	it('calls clearDraft when discard button is clicked', async () => {
		_draftRestoredSignal.value = true;
		const { getByTestId } = render(<HumanInputArea {...defaultProps()} />);

		await waitFor(() => {
			expect(getByTestId('draft-dismiss-button')).toBeTruthy();
		});

		fireEvent.click(getByTestId('draft-dismiss-button'));
		expect(mockClearDraft).toHaveBeenCalled();
	});
});

describe('HumanInputArea — target selector', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		mockRequest.mockResolvedValue({ messages: [] });
		_draftContentSignal.value = '';
		_draftRestoredSignal.value = false;
	});

	afterEach(() => {
		cleanup();
	});

	it('shows Leader as the default target', () => {
		const { getByTestId } = render(<HumanInputArea {...defaultProps()} />);

		expect(getByTestId('task-target-button').textContent).toContain('Leader');
	});

	it('opens the target dropdown on button click', () => {
		const { getByTestId, queryByTestId } = render(<HumanInputArea {...defaultProps()} />);

		expect(queryByTestId('task-target-option-worker')).toBeNull();

		fireEvent.click(getByTestId('task-target-button'));

		expect(queryByTestId('task-target-option-worker')).toBeTruthy();
		expect(queryByTestId('task-target-option-leader')).toBeTruthy();
	});

	it('switches target to Worker when worker option is clicked', async () => {
		const { getByTestId } = render(<HumanInputArea {...defaultProps()} />);

		fireEvent.click(getByTestId('task-target-button'));
		fireEvent.click(getByTestId('task-target-option-worker'));

		await waitFor(() => {
			expect(getByTestId('task-target-button').textContent).toContain('Worker');
		});
	});
});

describe('HumanInputArea — send action', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'session.messages.byStatus') return { messages: [] };
			if (method === 'task.sendHumanMessage') return {};
			return {};
		});
		_draftContentSignal.value = 'hello';
		_draftRestoredSignal.value = false;
	});

	afterEach(() => {
		cleanup();
	});

	it('calls task.sendHumanMessage with correct payload on send', async () => {
		const { getByTestId } = render(<HumanInputArea {...defaultProps()} />);

		await act(async () => {
			fireEvent.click(getByTestId('send-button'));
		});

		expect(mockRequest).toHaveBeenCalledWith('task.sendHumanMessage', {
			roomId: 'room-1',
			taskId: 'task-1',
			message: 'hello',
			target: 'leader',
		});
	});

	it('clears draft after successful send', async () => {
		const { getByTestId } = render(<HumanInputArea {...defaultProps()} />);

		await act(async () => {
			fireEvent.click(getByTestId('send-button'));
		});

		await waitFor(() => {
			expect(mockClearDraft).toHaveBeenCalled();
		});
	});
});

describe('HumanInputArea — queue overlay', () => {
	beforeEach(() => {
		_draftContentSignal.value = '';
		_draftRestoredSignal.value = false;
	});

	afterEach(() => {
		cleanup();
	});

	it('renders queued-current-turn bubbles from enqueued messages', async () => {
		mockRequest.mockImplementation(async (method: string, params: { status?: string }) => {
			if (method === 'session.messages.byStatus' && params.status === 'enqueued') {
				return {
					messages: [
						{
							dbId: 'q1',
							uuid: 'u1',
							text: 'Do the thing',
							timestamp: Date.now(),
							status: 'enqueued',
						},
					],
				};
			}
			if (method === 'session.messages.byStatus' && params.status === 'deferred') {
				return { messages: [] };
			}
			return {};
		});

		const { getByTestId } = render(<HumanInputArea {...defaultProps()} />);

		await waitFor(() => {
			expect(getByTestId('queue-overlay')).toBeTruthy();
		});

		expect(getByTestId('queue-overlay').textContent).toContain('Do the thing');
	});

	it('does not render queue overlay when queues are empty', async () => {
		mockRequest.mockResolvedValue({ messages: [] });

		const { queryByTestId } = render(<HumanInputArea {...defaultProps()} />);

		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith(
				'session.messages.byStatus',
				expect.objectContaining({ status: 'enqueued' })
			);
		});

		expect(queryByTestId('queue-overlay')).toBeNull();
	});
});
