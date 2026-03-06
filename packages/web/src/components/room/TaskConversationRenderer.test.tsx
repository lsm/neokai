// @ts-nocheck
/**
 * Tests for TaskConversationRenderer Component
 *
 * Verifies that the component:
 * - Renders messages fetched from task.getGroupMessages
 * - Calls onMessageCountChange when the message list changes
 * - Reacts to real-time state.groupMessages.delta events
 * - Does NOT own a scroll container (no overflow-y-auto div)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor, act } from '@testing-library/preact';

// -------------------------------------------------------
// Mocks
// -------------------------------------------------------

const mockRequest = vi.fn();
let deltaHandler: ((event: { added: unknown[]; timestamp: number }) => void) | null = null;
const mockOnEvent = vi.fn((eventName: string, handler) => {
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

import { TaskConversationRenderer } from './TaskConversationRenderer';

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
		mockRequest.mockImplementation(async () => ({ messages, hasMore: false }));

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
		mockRequest.mockImplementation(async () => ({ messages: initial, hasMore: false }));

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
		mockRequest.mockImplementation(async () => ({ messages, hasMore: false }));

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
		mockRequest.mockImplementation(async () => ({ messages, hasMore: false }));

		const { container } = render(
			<TaskConversationRenderer groupId="group-1" onMessageCountChange={vi.fn()} />
		);

		await waitFor(() => {
			expect(container.textContent).toContain('Task started');
		});
	});

	it('works without onMessageCountChange prop', async () => {
		const messages = [makeRawMessage(1, 'assistant', 'uuid-1')];
		mockRequest.mockImplementation(async () => ({ messages, hasMore: false }));

		// Should not throw even without the optional prop
		expect(() => render(<TaskConversationRenderer groupId="group-1" />)).not.toThrow();

		await waitFor(() => {
			// Just ensure it renders without crashing
		});
	});
});
