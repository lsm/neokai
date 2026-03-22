/**
 * Tests for TaskConversationRenderer Component
 *
 * Verifies that the component:
 * - Renders messages delivered via liveQuery.snapshot (initial load)
 * - Calls onMessageCountChange when the message list changes
 * - Reacts to real-time liveQuery.delta events
 * - Does NOT own a scroll container (no overflow-y-auto div)
 * - Renders status messages as centered dividers
 * - Passes correct session/question state to SDKMessageRenderer
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, act } from '@testing-library/preact';

import { TaskConversationRenderer } from './TaskConversationRenderer';
import { resetSubscriptionCounterForTesting } from '../../hooks/useGroupMessages';

// -------------------------------------------------------
// Mocks
// -------------------------------------------------------

let snapshotHandler:
	| ((event: { subscriptionId: string; rows: unknown[]; version: number }) => void)
	| null = null;
let deltaHandler:
	| ((event: { subscriptionId: string; added: unknown[]; version: number }) => void)
	| null = null;
let lastSubscriptionId: string | null = null;

// state.session handlers keyed by the channel passed when the handler fires,
// allowing tests to fire session-state events scoped to a specific session channel.
type SessionStateHandler = (data: unknown, context: { channel?: string }) => void;
const sessionStateHandlers: SessionStateHandler[] = [];

const mockIsConnected = { value: true };

const mockOnEvent = vi.fn(
	(eventName: string, handler: (data: unknown, context?: { channel?: string }) => void) => {
		if (eventName === 'liveQuery.snapshot') {
			snapshotHandler = handler as typeof snapshotHandler;
		} else if (eventName === 'liveQuery.delta') {
			deltaHandler = handler as typeof deltaHandler;
		} else if (eventName === 'state.session') {
			sessionStateHandlers.push(handler as SessionStateHandler);
		}
		return () => {};
	}
);

const mockRequest = vi.fn(async (method: string, params: Record<string, unknown>) => {
	if (method === 'liveQuery.subscribe') {
		lastSubscriptionId = params.subscriptionId as string;
		return { ok: true };
	}
	if (method === 'liveQuery.unsubscribe') {
		return { ok: true };
	}
	if (method === 'session.get') {
		return { session: null };
	}
	return {};
});

const mockJoinRoom = vi.fn();
const mockLeaveRoom = vi.fn();

vi.mock('../../hooks/useMessageHub.ts', () => ({
	useMessageHub: () => ({
		request: mockRequest,
		onEvent: mockOnEvent,
		isConnected: mockIsConnected.value,
		joinRoom: mockJoinRoom,
		leaveRoom: mockLeaveRoom,
	}),
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

type TestMessage = {
	id: number;
	groupId: string;
	sessionId: string | null;
	role: string;
	messageType: string;
	content: string;
	createdAt: number;
};

function makeRawMessage(id: number, role: string, uuid: string): TestMessage {
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

function makeStatusMessage(id: number, text: string): TestMessage {
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

/** Fire snapshot event with the given raw messages */
function fireSnapshot(rawMessages: TestMessage[]): void {
	snapshotHandler?.({ subscriptionId: lastSubscriptionId!, rows: rawMessages, version: 1 });
}

/** Fire delta event with the given raw messages */
function fireDelta(rawMessages: TestMessage[]): void {
	deltaHandler?.({ subscriptionId: lastSubscriptionId!, added: rawMessages, version: 2 });
}

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe('TaskConversationRenderer — onMessageCountChange', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		mockRequest.mockImplementation(async (method: string, params: Record<string, unknown>) => {
			if (method === 'liveQuery.subscribe') {
				lastSubscriptionId = params.subscriptionId as string;
				return { ok: true };
			}
			if (method === 'liveQuery.unsubscribe') {
				return { ok: true };
			}
			if (method === 'session.get') {
				return { session: null };
			}
			return {};
		});
		mockOnEvent.mockClear();
		mockJoinRoom.mockReset();
		mockLeaveRoom.mockReset();
		snapshotHandler = null;
		deltaHandler = null;
		lastSubscriptionId = null;
		sessionStateHandlers.length = 0;
		capturedSDKProps.length = 0;
		resetSubscriptionCounterForTesting();
	});

	afterEach(() => {
		cleanup();
	});

	it('calls onMessageCountChange with the initial message count', async () => {
		const onCountChange = vi.fn();
		render(<TaskConversationRenderer groupId="group-1" onMessageCountChange={onCountChange} />);

		// Fire snapshot with 2 messages
		await act(async () => {
			fireSnapshot([
				makeRawMessage(1, 'assistant', 'uuid-1'),
				makeRawMessage(2, 'assistant', 'uuid-2'),
			]);
		});

		await waitFor(() => {
			expect(onCountChange).toHaveBeenCalledWith(2);
		});
	});

	it('calls onMessageCountChange with 0 during loading', async () => {
		const onCountChange = vi.fn();
		render(<TaskConversationRenderer groupId="group-1" onMessageCountChange={onCountChange} />);

		// No snapshot fired yet — should be called with 0 (loading state, 0 messages)
		await waitFor(() => {
			expect(onCountChange).toHaveBeenCalledWith(0);
		});
	});

	it('calls onMessageCountChange with updated count on delta event', async () => {
		const onCountChange = vi.fn();
		const { rerender } = render(
			<TaskConversationRenderer groupId="group-1" onMessageCountChange={onCountChange} />
		);

		// Initial snapshot with 1 message
		await act(async () => {
			fireSnapshot([makeRawMessage(1, 'assistant', 'uuid-1')]);
		});

		await waitFor(() => {
			expect(onCountChange).toHaveBeenCalledWith(1);
		});

		// Delta adds one more message
		await act(async () => {
			fireDelta([makeRawMessage(2, 'assistant', 'uuid-2')]);
		});

		await waitFor(() => {
			expect(onCountChange).toHaveBeenCalledWith(2);
		});

		// suppress unused variable warning
		void rerender;
	});

	it('does NOT render a scroll container (no overflow-y-auto on root element)', async () => {
		const { container } = render(
			<TaskConversationRenderer groupId="group-1" onMessageCountChange={vi.fn()} />
		);

		await act(async () => {
			fireSnapshot([makeRawMessage(1, 'assistant', 'uuid-1')]);
		});

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
		const { container } = render(
			<TaskConversationRenderer groupId="group-1" onMessageCountChange={vi.fn()} />
		);

		await act(async () => {
			fireSnapshot([makeStatusMessage(1, 'Task started')]);
		});

		await waitFor(() => {
			expect(container.textContent).toContain('Task started');
		});
	});

	it('works without onMessageCountChange prop', async () => {
		let container: Element | undefined;
		expect(() => {
			({ container } = render(<TaskConversationRenderer groupId="group-1" />));
		}).not.toThrow();

		// Component should mount and show loading or empty state
		await waitFor(() => {
			expect(container?.firstChild).not.toBeNull();
		});
	});

	it('disposes subscription on component unmount', async () => {
		const { unmount } = render(
			<TaskConversationRenderer groupId="group-1" onMessageCountChange={vi.fn()} />
		);

		// Wait for subscribe to be called
		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith(
				'liveQuery.subscribe',
				expect.objectContaining({ queryName: 'sessionGroupMessages.byGroup' })
			);
		});

		unmount();

		// After unmount, unsubscribe should have been called
		await waitFor(() => {
			expect(mockRequest).toHaveBeenCalledWith(
				'liveQuery.unsubscribe',
				expect.objectContaining({ subscriptionId: expect.any(String) })
			);
		});
	});
});

describe('TaskConversationRenderer — session question state props', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		mockRequest.mockImplementation(async (method: string, params: Record<string, unknown>) => {
			if (method === 'liveQuery.subscribe') {
				lastSubscriptionId = params.subscriptionId as string;
				return { ok: true };
			}
			if (method === 'liveQuery.unsubscribe') {
				return { ok: true };
			}
			if (method === 'session.get') {
				return { session: null };
			}
			return {};
		});
		mockOnEvent.mockClear();
		mockJoinRoom.mockReset();
		mockLeaveRoom.mockReset();
		snapshotHandler = null;
		deltaHandler = null;
		lastSubscriptionId = null;
		sessionStateHandlers.length = 0;
		capturedSDKProps.length = 0;
		resetSubscriptionCounterForTesting();
	});

	afterEach(() => {
		cleanup();
	});

	it('accepts leaderSessionId and workerSessionId props without errors', async () => {
		const { container } = render(
			<TaskConversationRenderer
				groupId="group-1"
				leaderSessionId="leader-session-123"
				workerSessionId="worker-session-456"
				onMessageCountChange={vi.fn()}
			/>
		);

		await act(async () => {
			fireSnapshot([makeRawMessage(1, 'assistant', 'uuid-1')]);
		});

		await waitFor(() => {
			expect(container.querySelector('[data-testid^="msg-"]')).not.toBeNull();
		});
	});

	it('renders without leaderSessionId or workerSessionId (backward-compatible)', async () => {
		const { container } = render(
			<TaskConversationRenderer groupId="group-1" onMessageCountChange={vi.fn()} />
		);

		await act(async () => {
			fireSnapshot([makeRawMessage(1, 'assistant', 'uuid-1')]);
		});

		await waitFor(() => {
			expect(container.querySelector('[data-testid^="msg-"]')).not.toBeNull();
		});
	});

	it('joins session channels for leader and worker when both session IDs provided', async () => {
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
			expect(joinedRooms).toContain('session:leader-session-123');
			expect(joinedRooms).toContain('session:worker-session-456');
			// TaskConversationRenderer no longer joins the group channel itself
			expect(joinedRooms).not.toContain('group:group-1');
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

		render(
			<TaskConversationRenderer
				groupId="group-1"
				leaderSessionId="leader-session-123"
				workerSessionId="worker-session-456"
				onMessageCountChange={vi.fn()}
			/>
		);

		await act(async () => {
			fireSnapshot([leaderMsg]);
		});

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

		render(
			<TaskConversationRenderer
				groupId="group-1"
				leaderSessionId="leader-session-123"
				workerSessionId="worker-session-456"
				onMessageCountChange={vi.fn()}
			/>
		);

		await act(async () => {
			fireSnapshot([leaderMsg, workerMsg]);
		});

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

		render(
			<TaskConversationRenderer
				groupId="group-1"
				leaderSessionId="leader-session-123"
				workerSessionId="worker-session-456"
				onMessageCountChange={vi.fn()}
			/>
		);

		await act(async () => {
			fireSnapshot([unknownMsg]);
		});

		await waitFor(() => {
			const props = capturedSDKProps.find((p) => p.uuid === 'uuid-unknown');
			expect(props).toBeDefined();
			// Unknown session should get no-op state: no sessionId from question state but
			// authorSessionId is still passed as sessionId prop to allow form rendering for known tools
			expect(props?.pendingQuestion).toBeNull();
		});
	});
});

describe('TaskConversationRenderer — isReconnecting state', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		mockRequest.mockImplementation(async (method: string, params: Record<string, unknown>) => {
			if (method === 'liveQuery.subscribe') {
				lastSubscriptionId = params.subscriptionId as string;
				return { ok: true };
			}
			if (method === 'liveQuery.unsubscribe') return { ok: true };
			if (method === 'session.get') return { session: null };
			return {};
		});
		mockOnEvent.mockClear();
		snapshotHandler = null;
		deltaHandler = null;
		lastSubscriptionId = null;
		sessionStateHandlers.length = 0;
		capturedSDKProps.length = 0;
		resetSubscriptionCounterForTesting();
		// Reset to connected by default.
		mockIsConnected.value = true;
	});

	afterEach(() => {
		cleanup();
	});

	it('renders "Reconnecting…" when WebSocket is disconnected and groupId is set', async () => {
		// Simulate a WebSocket disconnect while the component is mounted with a group.
		mockIsConnected.value = false;

		const { container } = render(<TaskConversationRenderer groupId="group-1" />);

		// isReconnecting = !isConnected && groupId !== null → true
		// The component should show "Reconnecting…" not "Waiting for agent activity…"
		await waitFor(() => {
			expect(container.textContent).toContain('Reconnecting');
		});
		expect(container.textContent).not.toContain('Waiting for agent activity');
	});

	it('renders "Loading conversation…" when connected but snapshot has not arrived yet', async () => {
		mockIsConnected.value = true;

		const { container } = render(<TaskConversationRenderer groupId="group-1" />);

		// isReconnecting = false (connected), isLoading = true (snapshot pending)
		await waitFor(() => {
			expect(container.textContent).toContain('Loading conversation');
		});
		expect(container.textContent).not.toContain('Reconnecting');
	});

	it('renders messages normally once snapshot arrives after reconnect', async () => {
		// Start disconnected.
		mockIsConnected.value = false;
		const { container, rerender } = render(<TaskConversationRenderer groupId="group-1" />);

		await waitFor(() => {
			expect(container.textContent).toContain('Reconnecting');
		});

		// Reconnect.
		mockIsConnected.value = true;
		rerender(<TaskConversationRenderer groupId="group-1" />);

		// Now in loading state (connected, waiting for snapshot).
		await waitFor(() => {
			expect(container.textContent).toContain('Loading conversation');
		});

		// Snapshot arrives.
		await act(async () => {
			fireSnapshot([makeRawMessage(1, 'assistant', 'uuid-reconnect-1')]);
		});

		await waitFor(() => {
			expect(container.querySelector('[data-testid="msg-uuid-reconnect-1"]')).not.toBeNull();
		});
		expect(container.textContent).not.toContain('Reconnecting');
		expect(container.textContent).not.toContain('Loading conversation');
	});
});
