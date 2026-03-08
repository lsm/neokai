/**
 * Tests for TaskConversationRenderer Component
 *
 * Verifies that the component:
 * - Renders messages fetched from task.getGroupMessages
 * - Calls onMessageCountChange when the message list changes
 * - Reacts to real-time state.groupMessages.delta events
 * - Supports pagination with "Load older messages" button
 * - Does NOT own a scroll container (no overflow-y-auto div)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, act, fireEvent } from '@testing-library/preact';

import { TaskConversationRenderer } from './TaskConversationRenderer';

// -------------------------------------------------------
// Mocks
// -------------------------------------------------------

const mockRequest = vi.fn();
let deltaHandler: ((event: { added: unknown[]; timestamp: number }) => void) | null = null;
const mockOnEvent = vi.fn((eventName: string, handler: (event: unknown) => void) => {
	if (eventName === 'state.groupMessages.delta') {
		deltaHandler = handler;
	}
	return () => {};
});
const mockJoinRoom = vi.fn();
const mockLeaveRoom = vi.fn();

vi.mock('../../hooks/useMessageHub.ts', () => ({
	useMessageHub: () => ({
		request: mockRequest,
		onEvent: mockOnEvent,
		joinRoom: mockJoinRoom,
		leaveRoom: mockLeaveRoom,
	}),
}));

// SDKMessageRenderer minimal mock
vi.mock('../sdk/SDKMessageRenderer.tsx', () => ({
	SDKMessageRenderer: ({ message }: { message: { uuid?: string } }) => (
		<div data-testid={`msg-${message.uuid ?? 'unknown'}`} />
	),
}));

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function makeRawMessage(id: number, role: string, uuid: string) {
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

function makeStatusMessage(id: number, text: string) {
	return {
		id,
		groupId: 'group-1',
		sessionId: null as string | null,
		role: 'system',
		messageType: 'status',
		content: text,
		createdAt: Date.now(),
	};
}

// Default API response format
type TestMessage = ReturnType<typeof makeRawMessage> | ReturnType<typeof makeStatusMessage>;

function makeApiResponse(
	messages: TestMessage[],
	options?: { hasOlder?: boolean; oldestCursor?: string | null }
) {
	return {
		messages,
		hasMore: false,
		nextCursor: messages.length > 0 ? 'cursor-end' : null,
		hasOlder: options?.hasOlder ?? false,
		oldestCursor: options?.oldestCursor ?? (messages.length > 0 ? 'cursor-start' : null),
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
		deltaHandler = null;
	});

	afterEach(() => {
		cleanup();
	});

	it('calls onMessageCountChange with the initial message count', async () => {
		const messages = [
			makeRawMessage(1, 'assistant', 'uuid-1'),
			makeRawMessage(2, 'assistant', 'uuid-2'),
		];
		mockRequest.mockImplementation(async () => makeApiResponse(messages));

		const onCountChange = vi.fn();
		render(<TaskConversationRenderer groupId="group-1" onMessageCountChange={onCountChange} />);

		await waitFor(() => {
			expect(onCountChange).toHaveBeenCalledWith(2);
		});
	});

	it('calls onMessageCountChange with 0 during loading', () => {
		// Request never resolves → still loading
		mockRequest.mockImplementation(() => new Promise(() => {}));

		const onCountChange = vi.fn();
		render(<TaskConversationRenderer groupId="group-1" onMessageCountChange={onCountChange} />);

		expect(onCountChange).toHaveBeenCalledWith(0);
	});

	it('calls onMessageCountChange with updated count on delta event', async () => {
		const initial = [makeRawMessage(1, 'assistant', 'uuid-1')];
		mockRequest.mockImplementation(async () => makeApiResponse(initial));

		const onCountChange = vi.fn();
		render(<TaskConversationRenderer groupId="group-1" onMessageCountChange={onCountChange} />);

		await waitFor(() => {
			expect(onCountChange).toHaveBeenCalledWith(1);
		});

		// Simulate a delta event adding one more message
		const newMsg = makeRawMessage(2, 'assistant', 'uuid-2');
		const parsed = JSON.parse(newMsg.content);
		act(() => {
			deltaHandler?.({ added: [parsed], timestamp: Date.now() });
		});

		await waitFor(() => {
			expect(onCountChange).toHaveBeenCalledWith(2);
		});
	});

	it('does NOT render a scroll container (no overflow-y-auto on root element)', async () => {
		const messages = [makeRawMessage(1, 'assistant', 'uuid-1')];
		mockRequest.mockImplementation(async () => makeApiResponse(messages));

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
		const messages = [makeStatusMessage(1, 'Task started')];
		mockRequest.mockImplementation(async () => makeApiResponse(messages));

		const { container } = render(
			<TaskConversationRenderer groupId="group-1" onMessageCountChange={vi.fn()} />
		);

		await waitFor(() => {
			expect(container.textContent).toContain('Task started');
		});
	});

	it('works without onMessageCountChange prop', async () => {
		const messages = [makeRawMessage(1, 'assistant', 'uuid-1')];
		mockRequest.mockImplementation(async () => makeApiResponse(messages));

		let container: Element | undefined;
		expect(() => {
			({ container } = render(<TaskConversationRenderer groupId="group-1" />));
		}).not.toThrow();

		// Component should mount and show the conversation (or loading/empty state)
		await waitFor(() => {
			expect(container?.firstChild).not.toBeNull();
		});
	});

	it('merges delta messages that arrive while the initial fetch is in-flight', async () => {
		// The fetch is delayed via a Promise that we resolve manually.
		let resolveFetch!: (value: ReturnType<typeof makeApiResponse>) => void;
		const initial = [makeRawMessage(1, 'assistant', 'uuid-1')];
		mockRequest.mockImplementation(
			() =>
				new Promise<ReturnType<typeof makeApiResponse>>((resolve) => {
					resolveFetch = resolve;
				})
		);

		const onCountChange = vi.fn();
		render(<TaskConversationRenderer groupId="group-1" onMessageCountChange={onCountChange} />);

		// Delta arrives BEFORE the fetch resolves — should be buffered
		const deltaMsg = makeRawMessage(2, 'assistant', 'uuid-2');
		const parsed = JSON.parse(deltaMsg.content) as { uuid?: string };
		act(() => {
			deltaHandler?.({ added: [parsed], timestamp: Date.now() });
		});

		// Resolve the fetch now
		act(() => {
			resolveFetch(makeApiResponse(initial));
		});

		// Both the fetched message AND the buffered delta should appear
		await waitFor(() => {
			expect(onCountChange).toHaveBeenCalledWith(2);
		});
	});

	it('deduplicates delta messages already included in the fetch response', async () => {
		// The delta fires with uuid-1, which is also returned by the fetch.
		let resolveFetch!: (value: ReturnType<typeof makeApiResponse>) => void;
		const initial = [makeRawMessage(1, 'assistant', 'uuid-1')];
		mockRequest.mockImplementation(
			() =>
				new Promise<ReturnType<typeof makeApiResponse>>((resolve) => {
					resolveFetch = resolve;
				})
		);

		const onCountChange = vi.fn();
		render(<TaskConversationRenderer groupId="group-1" onMessageCountChange={onCountChange} />);

		// Delta arrives with uuid-1 — same as the fetch result
		const parsed = JSON.parse(initial[0].content) as { uuid?: string };
		act(() => {
			deltaHandler?.({ added: [parsed], timestamp: Date.now() });
		});

		// Fetch resolves with uuid-1 — the delta duplicate should be dropped
		act(() => {
			resolveFetch(makeApiResponse(initial));
		});

		await waitFor(() => {
			// Should be 1, not 2 — the duplicate is deduplicated
			expect(onCountChange).toHaveBeenCalledWith(1);
		});
	});

	it('deduplicates within-buffer duplicates (same delta fires twice before fetch)', async () => {
		let resolveFetch!: (value: ReturnType<typeof makeApiResponse>) => void;
		const initial = [makeRawMessage(1, 'assistant', 'uuid-1')];
		mockRequest.mockImplementation(
			() =>
				new Promise<ReturnType<typeof makeApiResponse>>((resolve) => {
					resolveFetch = resolve;
				})
		);

		const onCountChange = vi.fn();
		render(<TaskConversationRenderer groupId="group-1" onMessageCountChange={onCountChange} />);

		// Same delta fires twice before the fetch resolves — buffer should deduplicate
		const deltaMsg = makeRawMessage(2, 'assistant', 'uuid-2');
		const parsed = JSON.parse(deltaMsg.content) as { uuid?: string };
		act(() => {
			deltaHandler?.({ added: [parsed], timestamp: Date.now() });
		});
		act(() => {
			deltaHandler?.({ added: [parsed], timestamp: Date.now() }); // duplicate
		});

		act(() => {
			resolveFetch(makeApiResponse(initial));
		});

		// 1 fetched + 1 unique buffered delta (duplicate dropped) = 2 total
		await waitFor(() => {
			expect(onCountChange).toHaveBeenCalledWith(2);
		});
		await act(async () => {}); // flush pending async effects
		expect(onCountChange).not.toHaveBeenCalledWith(3);
	});

	it('deduplicates live post-fetch delta replays (same uuid arrives again after fetch)', async () => {
		const initial = [makeRawMessage(1, 'assistant', 'uuid-1')];
		mockRequest.mockImplementation(async () => makeApiResponse(initial));

		const onCountChange = vi.fn();
		render(<TaskConversationRenderer groupId="group-1" onMessageCountChange={onCountChange} />);

		// Wait for initial fetch to complete
		await waitFor(() => {
			expect(onCountChange).toHaveBeenCalledWith(1);
		});

		// Same message replayed via delta after fetch (e.g. WebSocket reconnect)
		const parsed = JSON.parse(initial[0].content) as { uuid?: string };
		act(() => {
			deltaHandler?.({ added: [parsed], timestamp: Date.now() });
		});
		await act(async () => {}); // flush pending async effects

		// Count must remain 1 — replay is silently dropped
		expect(onCountChange).not.toHaveBeenCalledWith(2);
	});

	it('deduplicates status messages by turnId when buffered and fetched', async () => {
		// Status messages have no uuid — dedup uses _taskMeta.turnId instead.
		let resolveFetch!: (value: ReturnType<typeof makeApiResponse>) => void;
		const statusMsg = makeStatusMessage(1, 'Task started');
		mockRequest.mockImplementation(
			() =>
				new Promise<ReturnType<typeof makeApiResponse>>((resolve) => {
					resolveFetch = resolve;
				})
		);

		const onCountChange = vi.fn();
		render(<TaskConversationRenderer groupId="group-1" onMessageCountChange={onCountChange} />);

		// Delta sends the already-parsed SDKMessage form of the same status message
		const parsedStatus = {
			type: 'status',
			text: 'Task started',
			_taskMeta: {
				authorRole: 'system',
				authorSessionId: '',
				turnId: 'status-1',
				iteration: 0,
			},
		};
		act(() => {
			deltaHandler?.({ added: [parsedStatus], timestamp: Date.now() });
		});

		// Fetch resolves with the same status message — should deduplicate via turnId
		act(() => {
			resolveFetch(makeApiResponse([statusMsg]));
		});

		// Should be 1, not 2 — turnId-based dedup prevents the status divider appearing twice
		await waitFor(() => {
			expect(onCountChange).toHaveBeenCalledWith(1);
		});
		await act(async () => {}); // flush pending async effects
		expect(onCountChange).not.toHaveBeenCalledWith(2);
	});

	it('preserves buffered deltas when the initial fetch fails', async () => {
		// Use a deferred reject so the delta is guaranteed to be buffered before the error fires.
		let rejectFetch!: (err: Error) => void;
		mockRequest.mockImplementation(
			() =>
				new Promise<never>((_, reject) => {
					rejectFetch = reject;
				})
		);

		const onCountChange = vi.fn();
		render(<TaskConversationRenderer groupId="group-1" onMessageCountChange={onCountChange} />);

		// Delta arrives while the doomed fetch is in-flight (deterministically buffered now)
		const liveMsg = makeRawMessage(1, 'assistant', 'uuid-live');
		const parsed = JSON.parse(liveMsg.content) as { uuid?: string };
		act(() => {
			deltaHandler?.({ added: [parsed], timestamp: Date.now() });
		});

		// Reject the fetch now — delta is already in the buffer, guaranteed
		act(() => {
			rejectFetch(new Error('network error'));
		});

		// After the rejection, buffered delta should surface
		await waitFor(() => {
			expect(onCountChange).toHaveBeenCalledWith(1);
		});
	});
});

describe('TaskConversationRenderer — pagination', () => {
	beforeEach(() => {
		mockRequest.mockReset();
		mockOnEvent.mockClear();
		mockJoinRoom.mockReset();
		mockLeaveRoom.mockReset();
		deltaHandler = null;
	});

	afterEach(() => {
		cleanup();
	});

	it('shows "Load older messages" button when hasOlder is true', async () => {
		const messages = [makeRawMessage(1, 'assistant', 'uuid-1')];
		mockRequest.mockImplementation(async () =>
			makeApiResponse(messages, { hasOlder: true, oldestCursor: 'cursor-older' })
		);

		const { getByText } = render(
			<TaskConversationRenderer groupId="group-1" onMessageCountChange={vi.fn()} />
		);

		await waitFor(() => {
			expect(getByText('Load older messages')).toBeDefined();
		});
	});

	it('does not show "Load older messages" button when hasOlder is false', async () => {
		const messages = [makeRawMessage(1, 'assistant', 'uuid-1')];
		mockRequest.mockImplementation(async () =>
			makeApiResponse(messages, { hasOlder: false, oldestCursor: null })
		);

		const { queryByText } = render(
			<TaskConversationRenderer groupId="group-1" onMessageCountChange={vi.fn()} />
		);

		await waitFor(() => {
			expect(queryByText('Load older messages')).toBeNull();
		});
	});

	it('loads older messages when button is clicked', async () => {
		const initialMessages = [makeRawMessage(3, 'assistant', 'uuid-3')];
		const olderMessages = [
			makeRawMessage(1, 'assistant', 'uuid-1'),
			makeRawMessage(2, 'assistant', 'uuid-2'),
		];

		let callCount = 0;
		mockRequest.mockImplementation(async (method: string, params: { before?: string }) => {
			if (method === 'task.getGroupMessages') {
				callCount++;
				if (params.before) {
					// Second call - loading older
					return makeApiResponse(olderMessages, { hasOlder: false, oldestCursor: 'cursor-oldest' });
				}
				// First call - initial load
				return makeApiResponse(initialMessages, { hasOlder: true, oldestCursor: 'cursor-older' });
			}
			return {};
		});

		const onCountChange = vi.fn();
		const { getByText } = render(
			<TaskConversationRenderer groupId="group-1" onMessageCountChange={onCountChange} />
		);

		// Wait for initial load
		await waitFor(() => {
			expect(onCountChange).toHaveBeenCalledWith(1);
		});

		// Click "Load older messages"
		await act(async () => {
			fireEvent.click(getByText('Load older messages'));
		});

		// Should have called API twice (initial + load older)
		await waitFor(() => {
			expect(callCount).toBe(2);
		});

		// Should have 3 messages now (2 older + 1 initial)
		await waitFor(() => {
			expect(onCountChange).toHaveBeenCalledWith(3);
		});
	});

	it('shows loading state while loading older messages', async () => {
		const initialMessages = [makeRawMessage(1, 'assistant', 'uuid-1')];
		let resolveOlder: () => void;

		mockRequest.mockImplementation(async (method: string, params: { before?: string }) => {
			if (method === 'task.getGroupMessages') {
				if (params.before) {
					// Delay the older messages response
					return new Promise((resolve) => {
						resolveOlder = () => resolve(makeApiResponse([], { hasOlder: false }));
					});
				}
				return makeApiResponse(initialMessages, { hasOlder: true, oldestCursor: 'cursor-older' });
			}
			return {};
		});

		const { getByText, queryByText } = render(
			<TaskConversationRenderer groupId="group-1" onMessageCountChange={vi.fn()} />
		);

		// Wait for initial load
		await waitFor(() => {
			expect(getByText('Load older messages')).toBeDefined();
		});

		// Click "Load older messages"
		await act(async () => {
			fireEvent.click(getByText('Load older messages'));
		});

		// Button should show loading state
		await waitFor(() => {
			expect(getByText('Loading…')).toBeDefined();
		});

		// Resolve the older messages request
		await act(async () => {
			resolveOlder!();
		});

		// Button should return to normal state (hidden since no more older messages)
		await waitFor(() => {
			expect(queryByText('Loading…')).toBeNull();
		});
	});

	it('shows error message when initial fetch fails with no buffered messages', async () => {
		mockRequest.mockRejectedValue(new Error('Network error'));

		const { getByText } = render(
			<TaskConversationRenderer groupId="group-1" onMessageCountChange={vi.fn()} />
		);

		await waitFor(() => {
			expect(getByText('Network error')).toBeDefined();
		});

		// Should show retry button
		expect(getByText('Retry')).toBeDefined();
	});

	it('shows error message when loading older messages fails', async () => {
		const initialMessages = [makeRawMessage(1, 'assistant', 'uuid-1')];
		let olderCallCount = 0;

		mockRequest.mockImplementation(async (method: string, params: { before?: string }) => {
			if (method === 'task.getGroupMessages') {
				if (params.before) {
					olderCallCount++;
					throw new Error('Failed to load older');
				}
				return makeApiResponse(initialMessages, { hasOlder: true, oldestCursor: 'cursor-older' });
			}
			return {};
		});

		const { getByText } = render(
			<TaskConversationRenderer groupId="group-1" onMessageCountChange={vi.fn()} />
		);

		// Wait for initial load
		await waitFor(() => {
			expect(getByText('Load older messages')).toBeDefined();
		});

		// Click "Load older messages"
		await act(async () => {
			fireEvent.click(getByText('Load older messages'));
		});

		// Should show error message
		await waitFor(() => {
			expect(getByText('Failed to load older')).toBeDefined();
		});

		// Button should still be visible for retry
		expect(getByText('Load older messages')).toBeDefined();
	});
});
