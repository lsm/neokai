/**
 * Tests for TaskConversationRenderer Component
 *
 * Verifies that the component:
 * - Renders messages from the useGroupMessages hook
 * - Calls onMessageCountChange when the message list changes
 * - Shows loading state while the hook is loading
 * - Reacts to live updates when the hook delivers new messages
 * - Does NOT own a scroll container (no overflow-y-auto div)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, act } from '@testing-library/preact';

import { TaskConversationRenderer } from './TaskConversationRenderer';
import type { SessionGroupMessage } from '../../hooks/useGroupMessages';

// -------------------------------------------------------
// Mocks
// -------------------------------------------------------

const mockRequest = vi.fn();

// state.session handlers keyed by the channel passed when the handler fires,
// allowing tests to fire session-state events scoped to a specific session channel.
type SessionStateHandler = (data: unknown, context: { channel?: string }) => void;
const sessionStateHandlers: SessionStateHandler[] = [];

const mockOnEvent = vi.fn(
	(eventName: string, handler: (data: unknown, context?: { channel?: string }) => void) => {
		if (eventName === 'state.session') {
			sessionStateHandlers.push(handler as SessionStateHandler);
		}
		return () => {};
	}
);
const mockJoinRoom = vi.fn();
const mockLeaveRoom = vi.fn();

vi.mock('../../hooks/useMessageHub.ts', () => ({
	useMessageHub: () => ({
		request: mockRequest,
		onEvent: mockOnEvent,
		joinRoom: mockJoinRoom,
		leaveRoom: mockLeaveRoom,
		isConnected: true,
	}),
}));

// useGroupMessages mock — module-level result variable so tests can update it
let mockGroupMessagesResult: { messages: SessionGroupMessage[]; isLoading: boolean } = {
	messages: [],
	isLoading: false,
};

vi.mock('../../hooks/useGroupMessages.ts', () => ({
	useGroupMessages: () => mockGroupMessagesResult,
}));

// SDKMessageRenderer mock that captures rendered props for inspection
type CapturedRendererProps = {
	uuid: string;
	sessionId: string | undefined;
	pendingQuestion: unknown;
	resolvedQuestions: unknown;
};
const capturedSDKProps: CapturedRendererProps[] = [];

vi.mock('../sdk/SDKMessageRenderer.tsx', () => ({
	SDKMessageRenderer: (props: {
		message: { uuid?: string };
		sessionId?: string;
		pendingQuestion?: unknown;
		resolvedQuestions?: unknown;
	}) => {
		capturedSDKProps.push({
			uuid: props.message?.uuid ?? 'unknown',
			sessionId: props.sessionId,
			pendingQuestion: props.pendingQuestion,
			resolvedQuestions: props.resolvedQuestions,
		});
		return <div data-testid={`msg-${props.message?.uuid ?? 'unknown'}`} />;
	},
}));

/** Fire a state.session event on the given channel to all registered handlers */
function fireSessionStateEvent(channel: string, data: unknown): void {
	for (const handler of sessionStateHandlers) {
		handler(data, { channel });
	}
}

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function makeRawMessage(id: number, role: string, uuid: string): SessionGroupMessage {
	return {
		id,
		groupId: 'group-1',
		sessionId: 'sess-1',
		role,
		messageType: 'assistant',
		content: JSON.stringify({ type: 'assistant', uuid, message: { content: [] } }),
		createdAt: Date.now(),
	};
}

function makeStatusMessage(id: number, text: string): SessionGroupMessage {
	return {
		id,
		groupId: 'group-1',
		sessionId: null,
		role: 'system',
		messageType: 'status',
		content: text,
		createdAt: Date.now(),
	};
}

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe('TaskConversationRenderer — onMessageCountChange', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		mockOnEvent.mockClear();
		mockJoinRoom.mockReset();
		mockLeaveRoom.mockReset();
		sessionStateHandlers.length = 0;
		capturedSDKProps.length = 0;
		mockGroupMessagesResult = { messages: [], isLoading: false };
	});

	afterEach(() => {
		cleanup();
	});

	it('calls onMessageCountChange with the initial message count', async () => {
		const messages = [
			makeRawMessage(1, 'assistant', 'uuid-1'),
			makeRawMessage(2, 'assistant', 'uuid-2'),
		];
		mockGroupMessagesResult = { messages, isLoading: false };

		const onCountChange = vi.fn();
		render(<TaskConversationRenderer groupId="group-1" onMessageCountChange={onCountChange} />);

		await waitFor(() => {
			expect(onCountChange).toHaveBeenCalledWith(2);
		});
	});

	it('calls onMessageCountChange with 0 while the hook is loading', () => {
		mockGroupMessagesResult = { messages: [], isLoading: true };

		const onCountChange = vi.fn();
		render(<TaskConversationRenderer groupId="group-1" onMessageCountChange={onCountChange} />);

		expect(onCountChange).toHaveBeenCalledWith(0);
	});

	it('calls onMessageCountChange with updated count when hook delivers new messages (live update)', async () => {
		// Start with one message
		mockGroupMessagesResult = {
			messages: [makeRawMessage(1, 'assistant', 'uuid-1')],
			isLoading: false,
		};

		const onCountChange = vi.fn();
		const { rerender } = render(
			<TaskConversationRenderer groupId="group-1" onMessageCountChange={onCountChange} />
		);

		await waitFor(() => {
			expect(onCountChange).toHaveBeenCalledWith(1);
		});

		// Simulate a new message arriving via the hook (LiveQuery delta)
		mockGroupMessagesResult = {
			messages: [
				makeRawMessage(1, 'assistant', 'uuid-1'),
				makeRawMessage(2, 'assistant', 'uuid-2'),
			],
			isLoading: false,
		};

		await act(async () => {
			rerender(<TaskConversationRenderer groupId="group-1" onMessageCountChange={onCountChange} />);
		});

		await waitFor(() => {
			expect(onCountChange).toHaveBeenCalledWith(2);
		});
	});

	it('does NOT render a scroll container (no overflow-y-auto on root element)', async () => {
		const messages = [makeRawMessage(1, 'assistant', 'uuid-1')];
		mockGroupMessagesResult = { messages, isLoading: false };

		const { container } = render(
			<TaskConversationRenderer groupId="group-1" onMessageCountChange={vi.fn()} />
		);

		await waitFor(() => {
			// Messages rendered means loading is done
			expect(container.querySelector('[data-testid^="msg-"]')).not.toBeNull();
		});

		// The root element rendered by the component should NOT have overflow-y-auto
		// (scroll ownership moved to TaskView)
		const rootEl = container.firstChild as HTMLElement;
		expect(rootEl?.className).not.toContain('overflow-y-auto');
	});

	it('renders status messages as centered dividers', async () => {
		mockGroupMessagesResult = {
			messages: [makeStatusMessage(1, 'Task started')],
			isLoading: false,
		};

		const { container } = render(
			<TaskConversationRenderer groupId="group-1" onMessageCountChange={vi.fn()} />
		);

		await waitFor(() => {
			expect(container.textContent).toContain('Task started');
		});
	});

	it('works without onMessageCountChange prop', async () => {
		mockGroupMessagesResult = {
			messages: [makeRawMessage(1, 'assistant', 'uuid-1')],
			isLoading: false,
		};

		let container: Element | undefined;
		expect(() => {
			({ container } = render(<TaskConversationRenderer groupId="group-1" />));
		}).not.toThrow();

		// Component should mount and show the conversation (or loading/empty state)
		await waitFor(() => {
			expect(container?.firstChild).not.toBeNull();
		});
	});

	it('shows loading state while the hook is loading', async () => {
		mockGroupMessagesResult = { messages: [], isLoading: true };

		const { container } = render(
			<TaskConversationRenderer groupId="group-1" onMessageCountChange={vi.fn()} />
		);

		await waitFor(() => {
			expect(container.textContent).toContain('Loading conversation');
		});
	});

	it('shows waiting state when hook has no messages and is not loading', async () => {
		mockGroupMessagesResult = { messages: [], isLoading: false };

		const { container } = render(
			<TaskConversationRenderer groupId="group-1" onMessageCountChange={vi.fn()} />
		);

		await waitFor(() => {
			expect(container.textContent).toContain('Waiting for agent activity');
		});
	});
});

describe('TaskConversationRenderer — session question state props', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		mockOnEvent.mockClear();
		mockJoinRoom.mockReset();
		mockLeaveRoom.mockReset();
		sessionStateHandlers.length = 0;
		capturedSDKProps.length = 0;
		mockGroupMessagesResult = { messages: [], isLoading: false };
	});

	afterEach(() => {
		cleanup();
	});

	it('accepts leaderSessionId and workerSessionId props without errors', async () => {
		mockGroupMessagesResult = {
			messages: [makeRawMessage(1, 'assistant', 'uuid-1')],
			isLoading: false,
		};

		const { container } = render(
			<TaskConversationRenderer
				groupId="group-1"
				leaderSessionId="leader-session-123"
				workerSessionId="worker-session-456"
				onMessageCountChange={vi.fn()}
			/>
		);
		await waitFor(() => {
			expect(container.querySelector('[data-testid^="msg-"]')).not.toBeNull();
		});
	});

	it('renders without leaderSessionId or workerSessionId (backward-compatible)', async () => {
		mockGroupMessagesResult = {
			messages: [makeRawMessage(1, 'assistant', 'uuid-1')],
			isLoading: false,
		};

		const { container } = render(
			<TaskConversationRenderer groupId="group-1" onMessageCountChange={vi.fn()} />
		);
		await waitFor(() => {
			expect(container.querySelector('[data-testid^="msg-"]')).not.toBeNull();
		});
	});

	it('joins session channels for leader and worker when both session IDs provided', async () => {
		mockGroupMessagesResult = {
			messages: [makeRawMessage(1, 'assistant', 'uuid-1')],
			isLoading: false,
		};

		render(
			<TaskConversationRenderer
				groupId="group-1"
				leaderSessionId="leader-session-123"
				workerSessionId="worker-session-456"
				onMessageCountChange={vi.fn()}
			/>
		);

		await waitFor(() => {
			const joinedRooms = mockJoinRoom.mock.calls.map((c: string[]) => c[0]);
			// Session channels are joined by useSessionQuestionState for question state
			expect(joinedRooms).toContain('session:leader-session-123');
			expect(joinedRooms).toContain('session:worker-session-456');
		});
	});

	it('passes sessionId from authorSessionId to SDKMessageRenderer', async () => {
		const leaderMsg = makeRawMessage(1, 'assistant', 'uuid-leader');
		const parsed = JSON.parse(leaderMsg.content);
		parsed._taskMeta = {
			authorRole: 'leader',
			authorSessionId: 'leader-session-123',
			turnId: 'turn-1',
			iteration: 0,
		};
		leaderMsg.content = JSON.stringify(parsed);

		mockGroupMessagesResult = { messages: [leaderMsg], isLoading: false };

		render(
			<TaskConversationRenderer
				groupId="group-1"
				leaderSessionId="leader-session-123"
				workerSessionId="worker-session-456"
				onMessageCountChange={vi.fn()}
			/>
		);

		await waitFor(() => {
			const leaderProps = capturedSDKProps.find((p) => p.uuid === 'uuid-leader');
			expect(leaderProps).toBeDefined();
			expect(leaderProps?.sessionId).toBe('leader-session-123');
		});
	});

	it('passes pendingQuestion to SDKMessageRenderer for the correct session after state.session event', async () => {
		// Leader message
		const leaderMsg = makeRawMessage(1, 'assistant', 'uuid-leader');
		const parsedLeader = JSON.parse(leaderMsg.content);
		parsedLeader._taskMeta = {
			authorRole: 'leader',
			authorSessionId: 'leader-session-123',
			turnId: 'turn-1',
			iteration: 0,
		};
		leaderMsg.content = JSON.stringify(parsedLeader);

		// Worker message
		const workerMsg = makeRawMessage(2, 'assistant', 'uuid-worker');
		const parsedWorker = JSON.parse(workerMsg.content);
		parsedWorker._taskMeta = {
			authorRole: 'coder',
			authorSessionId: 'worker-session-456',
			turnId: 'turn-2',
			iteration: 0,
		};
		workerMsg.content = JSON.stringify(parsedWorker);

		mockGroupMessagesResult = { messages: [leaderMsg, workerMsg], isLoading: false };

		render(
			<TaskConversationRenderer
				groupId="group-1"
				leaderSessionId="leader-session-123"
				workerSessionId="worker-session-456"
				onMessageCountChange={vi.fn()}
			/>
		);

		// Wait for initial render
		await waitFor(() => {
			expect(capturedSDKProps.length).toBeGreaterThanOrEqual(2);
		});

		capturedSDKProps.length = 0; // Reset to capture fresh render

		// Fire a state.session event for the LEADER session with waiting_for_input
		const leaderPendingQuestion = {
			toolUseId: 'tool-123',
			questions: [
				{ question: 'How should I proceed?', header: 'Decision', options: [], multiSelect: false },
			],
			askedAt: Date.now(),
		};
		await act(async () => {
			fireSessionStateEvent('session:leader-session-123', {
				agentState: { status: 'waiting_for_input', pendingQuestion: leaderPendingQuestion },
				sessionInfo: null,
			});
		});

		await waitFor(() => {
			// Use the last captured render for each uuid to avoid stale intermediate snapshots
			const leaderProps = [...capturedSDKProps].reverse().find((p) => p.uuid === 'uuid-leader');
			const workerProps = [...capturedSDKProps].reverse().find((p) => p.uuid === 'uuid-worker');
			// Leader message should receive the pending question
			expect(leaderProps?.pendingQuestion).toEqual(leaderPendingQuestion);
			// Worker message should NOT receive the leader's pending question (no cross-session contamination)
			expect(workerProps?.pendingQuestion).toBeNull();
		});
	});

	it('uses no-op question state for messages with unknown authorSessionId', async () => {
		const unknownMsg = makeRawMessage(1, 'assistant', 'uuid-unknown');
		const parsedUnknown = JSON.parse(unknownMsg.content);
		parsedUnknown._taskMeta = {
			authorRole: 'general',
			authorSessionId: 'unknown-session-xyz',
			turnId: 'turn-1',
			iteration: 0,
		};
		unknownMsg.content = JSON.stringify(parsedUnknown);

		mockGroupMessagesResult = { messages: [unknownMsg], isLoading: false };

		render(
			<TaskConversationRenderer
				groupId="group-1"
				leaderSessionId="leader-session-123"
				workerSessionId="worker-session-456"
				onMessageCountChange={vi.fn()}
			/>
		);

		await waitFor(() => {
			const props = capturedSDKProps.find((p) => p.uuid === 'uuid-unknown');
			expect(props).toBeDefined();
			// Unknown session should get no-op state: no sessionId from question state but
			// authorSessionId is still passed as sessionId prop to allow form rendering for known tools
			expect(props?.pendingQuestion).toBeNull();
		});
	});
});
