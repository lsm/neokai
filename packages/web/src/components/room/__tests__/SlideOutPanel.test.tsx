/**
 * Tests for SlideOutPanel and ReadonlySessionChat components
 *
 * Covers:
 * - Session isolation (no sessionStore.select calls)
 * - Message loading via RPC
 * - Cross-session channel filter (rejection and acceptance)
 * - Panel open/close behavior
 * - Backdrop click and Escape key
 * - Agent label display with role colors
 * - Accessibility attributes
 * - data-testid attributes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/preact';
import { SlideOutPanel } from '../SlideOutPanel';
import { ReadonlySessionChat } from '../ReadonlySessionChat';

// -------------------------------------------------------
// Mocks
// -------------------------------------------------------

// Track the registered delta event handler so tests can fire events manually
type DeltaHandler = (data: { added?: unknown[] }, context: { channel?: string }) => void;
let registeredDeltaHandler: DeltaHandler | null = null;

const mockIsConnected = { value: true };

const mockOnEvent = vi.fn((eventName: string, handler: DeltaHandler) => {
	if (eventName === 'state.sdkMessages.delta') {
		registeredDeltaHandler = handler;
	}
	return () => {
		if (eventName === 'state.sdkMessages.delta') {
			registeredDeltaHandler = null;
		}
	};
});

type MockRPCResponse = { sdkMessages: unknown[]; hasMore: boolean } | Record<string, never>;
const mockRequest: ReturnType<typeof vi.fn> = vi.fn(
	async (method: string): Promise<MockRPCResponse> => {
		if (method === 'state.sdkMessages') {
			return { sdkMessages: [], hasMore: false };
		}
		if (method === 'message.sdkMessages') {
			return { sdkMessages: [], hasMore: false };
		}
		return {};
	}
);

const mockJoinRoom = vi.fn();
const mockLeaveRoom = vi.fn();

vi.mock('../../../hooks/useMessageHub.ts', () => ({
	useMessageHub: () => ({
		request: mockRequest,
		onEvent: mockOnEvent,
		// Use a getter so tests can flip mockIsConnected.value after module load
		get isConnected() {
			return mockIsConnected.value;
		},
		joinRoom: mockJoinRoom,
		leaveRoom: mockLeaveRoom,
	}),
}));

// Minimal SDKMessageRenderer mock — shows uuid so tests can assert presence
vi.mock('../../sdk/SDKMessageRenderer.tsx', () => ({
	SDKMessageRenderer: (props: { message: { uuid?: string } }) => (
		<div data-testid={`msg-${props.message?.uuid ?? 'unknown'}`} />
	),
}));

// Mock useMessageMaps to avoid needing fully-shaped SDKMessage objects
vi.mock('../../../hooks/useMessageMaps.ts', () => ({
	useMessageMaps: () => ({
		toolResultsMap: new Map(),
		toolInputsMap: new Map(),
		sessionInfoMap: new Map(),
		subagentMessagesMap: new Map(),
	}),
}));

// Mock sessionStore to spy on select — value starts null and must stay null
const mockSessionStoreSelect = vi.fn();
const mockActiveSessionId = { value: null as string | null };
vi.mock('../../../lib/session-store.ts', () => ({
	sessionStore: {
		select: mockSessionStoreSelect,
		get activeSessionId() {
			return mockActiveSessionId;
		},
		sdkMessages: { value: [] },
	},
}));

// -------------------------------------------------------
// Helpers
// -------------------------------------------------------

function makeMessage(uuid: string) {
	return { uuid, type: 'assistant', timestamp: Date.now() };
}

// -------------------------------------------------------
// Tests
// -------------------------------------------------------

describe('SlideOutPanel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		registeredDeltaHandler = null;
		mockIsConnected.value = true;
		mockActiveSessionId.value = null;
	});

	afterEach(() => {
		cleanup();
	});

	// --- Session isolation ---

	it('should NEVER call sessionStore.select when ReadonlySessionChat mounts', async () => {
		render(
			<SlideOutPanel isOpen={true} sessionId="session-abc" agentLabel="Worker" onClose={() => {}} />
		);
		await waitFor(() => expect(mockRequest).toHaveBeenCalled());
		expect(mockSessionStoreSelect).not.toHaveBeenCalled();
		// activeSessionId must be unchanged — ReadonlySessionChat must not modify it
		expect(mockActiveSessionId.value).toBeNull();
	});

	it('should fetch messages via state.sdkMessages RPC with the given sessionId', async () => {
		render(<SlideOutPanel isOpen={true} sessionId="session-xyz" onClose={() => {}} />);
		await waitFor(() =>
			expect(mockRequest).toHaveBeenCalledWith('state.sdkMessages', { sessionId: 'session-xyz' })
		);
	});

	// --- Cross-session channel filter ---

	it('should reject delta events from a different channel', async () => {
		const { container } = render(
			<SlideOutPanel isOpen={true} sessionId="session-abc" onClose={() => {}} />
		);
		await waitFor(() => expect(mockOnEvent).toHaveBeenCalled());

		const foreignMsg = makeMessage('foreign-msg-uuid');
		act(() => {
			registeredDeltaHandler?.({ added: [foreignMsg] }, { channel: 'session:other-id' });
		});

		expect(container.querySelector('[data-testid="msg-foreign-msg-uuid"]')).toBeNull();
	});

	it('should accept delta events from the correct channel', async () => {
		const { container } = render(
			<SlideOutPanel isOpen={true} sessionId="session-abc" onClose={() => {}} />
		);
		await waitFor(() => expect(mockOnEvent).toHaveBeenCalled());

		const ownMsg = makeMessage('own-msg-uuid');
		act(() => {
			registeredDeltaHandler?.({ added: [ownMsg] }, { channel: 'session:session-abc' });
		});

		await waitFor(() =>
			expect(container.querySelector('[data-testid="msg-own-msg-uuid"]')).not.toBeNull()
		);
	});

	// --- Panel visibility ---

	it('should have translate-x-full class when closed', () => {
		const { container } = render(
			<SlideOutPanel isOpen={false} sessionId="session-abc" onClose={() => {}} />
		);
		const panel = container.querySelector('[data-testid="slide-out-panel"]');
		expect(panel?.className).toContain('translate-x-full');
	});

	it('should have translate-x-0 class when open', () => {
		const { container } = render(
			<SlideOutPanel isOpen={true} sessionId="session-abc" onClose={() => {}} />
		);
		const panel = container.querySelector('[data-testid="slide-out-panel"]');
		expect(panel?.className).toContain('translate-x-0');
	});

	it('should mount ReadonlySessionChat when open with a sessionId', () => {
		const { container } = render(
			<SlideOutPanel isOpen={true} sessionId="session-abc" onClose={() => {}} />
		);
		expect(container.querySelector('[data-testid="readonly-session-chat"]')).not.toBeNull();
	});

	it('should NOT mount ReadonlySessionChat when closed', () => {
		const { container } = render(
			<SlideOutPanel isOpen={false} sessionId="session-abc" onClose={() => {}} />
		);
		expect(container.querySelector('[data-testid="readonly-session-chat"]')).toBeNull();
	});

	it('should NOT mount ReadonlySessionChat when sessionId is null', () => {
		const { container } = render(
			<SlideOutPanel isOpen={true} sessionId={null} onClose={() => {}} />
		);
		expect(container.querySelector('[data-testid="readonly-session-chat"]')).toBeNull();
	});

	// --- Close interactions ---

	it('should call onClose when close button is clicked', () => {
		const onClose = vi.fn();
		const { container } = render(
			<SlideOutPanel isOpen={true} sessionId="session-abc" onClose={onClose} />
		);
		const closeBtn = container.querySelector('[data-testid="slide-out-panel-close"]');
		fireEvent.click(closeBtn!);
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('should call onClose when backdrop is clicked', () => {
		const onClose = vi.fn();
		const { container } = render(
			<SlideOutPanel isOpen={true} sessionId="session-abc" onClose={onClose} />
		);
		const backdrop = container.querySelector('[data-testid="slide-out-backdrop"]');
		fireEvent.click(backdrop!);
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('should call onClose when Escape key is pressed', () => {
		const onClose = vi.fn();
		render(<SlideOutPanel isOpen={true} sessionId="session-abc" onClose={onClose} />);
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(onClose).toHaveBeenCalledOnce();
	});

	it('should NOT call onClose for Escape when panel is closed', () => {
		const onClose = vi.fn();
		render(<SlideOutPanel isOpen={false} sessionId="session-abc" onClose={onClose} />);
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(onClose).not.toHaveBeenCalled();
	});

	// --- Agent label display ---

	it('should show agent label in header', () => {
		const { container } = render(
			<SlideOutPanel
				isOpen={true}
				sessionId="session-abc"
				agentLabel="Leader"
				agentRole="leader"
				onClose={() => {}}
			/>
		);
		const header = container.querySelector('[data-testid="slide-out-panel-header"]');
		expect(header?.textContent).toContain('Leader');
	});

	it('should apply role color class to agent label', () => {
		const { container } = render(
			<SlideOutPanel
				isOpen={true}
				sessionId="session-abc"
				agentLabel="Leader"
				agentRole="leader"
				onClose={() => {}}
			/>
		);
		const header = container.querySelector('[data-testid="slide-out-panel-header"]');
		const labelEl = header?.querySelector('span');
		expect(labelEl?.className).toContain('text-purple-400');
	});

	it('should apply coder role color', () => {
		const { container } = render(
			<SlideOutPanel
				isOpen={true}
				sessionId="session-abc"
				agentLabel="Coder"
				agentRole="coder"
				onClose={() => {}}
			/>
		);
		const header = container.querySelector('[data-testid="slide-out-panel-header"]');
		const labelEl = header?.querySelector('span');
		expect(labelEl?.className).toContain('text-blue-400');
	});

	// --- Accessibility ---

	it('should have role="dialog" on panel element', () => {
		const { container } = render(
			<SlideOutPanel isOpen={true} sessionId="session-abc" onClose={() => {}} />
		);
		const panel = container.querySelector('[data-testid="slide-out-panel"]');
		expect(panel?.getAttribute('role')).toBe('dialog');
	});

	it('should have aria-modal="true" on panel element', () => {
		const { container } = render(
			<SlideOutPanel isOpen={true} sessionId="session-abc" onClose={() => {}} />
		);
		const panel = container.querySelector('[data-testid="slide-out-panel"]');
		expect(panel?.getAttribute('aria-modal')).toBe('true');
	});

	it('should have aria-label on panel element', () => {
		const { container } = render(
			<SlideOutPanel isOpen={true} sessionId="session-abc" agentLabel="Worker" onClose={() => {}} />
		);
		const panel = container.querySelector('[data-testid="slide-out-panel"]');
		expect(panel?.getAttribute('aria-label')).toContain('Worker');
	});

	// --- data-testid attributes ---

	it('should have all required data-testid attributes', () => {
		const { container } = render(
			<SlideOutPanel isOpen={true} sessionId="session-abc" onClose={() => {}} />
		);
		expect(container.querySelector('[data-testid="slide-out-panel"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="slide-out-panel-header"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="slide-out-panel-close"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="slide-out-backdrop"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="readonly-session-chat"]')).not.toBeNull();
	});

	// --- Channel join/leave ---

	it('should join the session channel when connected and open', async () => {
		render(<SlideOutPanel isOpen={true} sessionId="session-join-test" onClose={() => {}} />);
		await waitFor(() => expect(mockJoinRoom).toHaveBeenCalledWith('session:session-join-test'));
	});

	it('should subscribe to state.sdkMessages.delta', async () => {
		render(<SlideOutPanel isOpen={true} sessionId="session-abc" onClose={() => {}} />);
		await waitFor(() =>
			expect(mockOnEvent).toHaveBeenCalledWith('state.sdkMessages.delta', expect.any(Function))
		);
	});

	it('should call leaveRoom with the session channel on unmount', async () => {
		const { unmount } = render(
			<SlideOutPanel isOpen={true} sessionId="session-leave-test" onClose={() => {}} />
		);
		await waitFor(() => expect(mockJoinRoom).toHaveBeenCalledWith('session:session-leave-test'));
		unmount();
		expect(mockLeaveRoom).toHaveBeenCalledWith('session:session-leave-test');
	});

	// --- Pagination (load older) ---

	it('should show load-older button when initial fetch returns hasMore=true', async () => {
		mockRequest.mockImplementationOnce(async (method: string) => {
			if (method === 'state.sdkMessages') {
				return {
					sdkMessages: [{ uuid: 'msg-old', type: 'assistant', timestamp: 1000 }],
					hasMore: true,
				};
			}
			return {};
		});

		const { container } = render(
			<SlideOutPanel isOpen={true} sessionId="session-abc" onClose={() => {}} />
		);
		await waitFor(() => expect(container.querySelector('button[disabled]')).toBeNull());
		await waitFor(() => expect(container.textContent).toContain('Load older messages'));
	});

	it('should call message.sdkMessages with numeric before timestamp when load-older clicked', async () => {
		const oldTimestamp = 12345678;
		mockRequest.mockImplementation(async (method: string) => {
			if (method === 'state.sdkMessages') {
				return {
					sdkMessages: [{ uuid: 'msg-first', type: 'assistant', timestamp: oldTimestamp }],
					hasMore: true,
				};
			}
			if (method === 'message.sdkMessages') {
				return { sdkMessages: [], hasMore: false };
			}
			return {};
		});

		const { container } = render(
			<SlideOutPanel isOpen={true} sessionId="session-pg" onClose={() => {}} />
		);

		await waitFor(() => expect(container.textContent).toContain('Load older messages'));

		// Find the "Load older" button specifically (not the close button)
		const allButtons = container.querySelectorAll('button');
		const loadBtn = Array.from(allButtons).find((b) =>
			b.textContent?.includes('Load older')
		) as HTMLButtonElement;
		expect(loadBtn).toBeTruthy();
		fireEvent.click(loadBtn);

		await waitFor(() =>
			expect(mockRequest).toHaveBeenCalledWith('message.sdkMessages', {
				sessionId: 'session-pg',
				before: oldTimestamp,
				limit: 100,
			})
		);
	});
});

// -------------------------------------------------------
// ReadonlySessionChat (direct mount)
// -------------------------------------------------------

describe('ReadonlySessionChat', () => {
	beforeEach(() => {
		vi.resetAllMocks();
		registeredDeltaHandler = null;
		mockIsConnected.value = true;
		mockActiveSessionId.value = null;
		// Restore default mock implementations after resetAllMocks
		mockOnEvent.mockImplementation((eventName: string, handler: DeltaHandler) => {
			if (eventName === 'state.sdkMessages.delta') {
				registeredDeltaHandler = handler;
			}
			return () => {
				if (eventName === 'state.sdkMessages.delta') {
					registeredDeltaHandler = null;
				}
			};
		});
		mockRequest.mockResolvedValue({ sdkMessages: [], hasMore: false });
	});

	afterEach(() => {
		cleanup();
	});

	it('should render data-testid="readonly-session-chat"', async () => {
		const { container } = render(<ReadonlySessionChat sessionId="direct-test" />);
		await waitFor(() => expect(mockRequest).toHaveBeenCalled());
		expect(container.querySelector('[data-testid="readonly-session-chat"]')).not.toBeNull();
	});

	it('should NOT call sessionStore.select on mount', async () => {
		render(<ReadonlySessionChat sessionId="direct-test" />);
		await waitFor(() => expect(mockRequest).toHaveBeenCalled());
		expect(mockSessionStoreSelect).not.toHaveBeenCalled();
		expect(mockActiveSessionId.value).toBeNull();
	});

	it('should fetch via state.sdkMessages with the given sessionId', async () => {
		render(<ReadonlySessionChat sessionId="direct-session-99" />);
		await waitFor(() =>
			expect(mockRequest).toHaveBeenCalledWith('state.sdkMessages', {
				sessionId: 'direct-session-99',
			})
		);
	});

	it('should join the session channel on mount', async () => {
		render(<ReadonlySessionChat sessionId="chan-test" />);
		await waitFor(() => expect(mockJoinRoom).toHaveBeenCalledWith('session:chan-test'));
	});

	it('should subscribe to state.sdkMessages.delta on mount', async () => {
		render(<ReadonlySessionChat sessionId="delta-sub-test" />);
		await waitFor(() =>
			expect(mockOnEvent).toHaveBeenCalledWith('state.sdkMessages.delta', expect.any(Function))
		);
	});

	it('should leave room on unmount', async () => {
		const { unmount } = render(<ReadonlySessionChat sessionId="unmount-test" />);
		await waitFor(() => expect(mockJoinRoom).toHaveBeenCalledWith('session:unmount-test'));
		unmount();
		expect(mockLeaveRoom).toHaveBeenCalledWith('session:unmount-test');
	});

	it('cross-session rejection: delta from wrong channel should not render message', async () => {
		const { container } = render(<ReadonlySessionChat sessionId="target-session" />);
		await waitFor(() => expect(mockOnEvent).toHaveBeenCalled());

		act(() => {
			registeredDeltaHandler?.(
				{ added: [makeMessage('msg-wrong-channel')] },
				{ channel: 'session:other-session' }
			);
		});

		expect(container.querySelector('[data-testid="msg-msg-wrong-channel"]')).toBeNull();
	});

	it('cross-session acceptance: delta from correct channel should render message', async () => {
		const { container } = render(<ReadonlySessionChat sessionId="target-session" />);
		await waitFor(() => expect(mockOnEvent).toHaveBeenCalled());

		act(() => {
			registeredDeltaHandler?.(
				{ added: [makeMessage('msg-correct-channel')] },
				{ channel: 'session:target-session' }
			);
		});

		await waitFor(() =>
			expect(container.querySelector('[data-testid="msg-msg-correct-channel"]')).not.toBeNull()
		);
	});

	it('should show "No messages yet" when initial fetch returns empty list', async () => {
		const { container } = render(<ReadonlySessionChat sessionId="empty-session" />);
		await waitFor(() => expect(container.textContent).toContain('No messages yet'));
	});

	it('should show error message when initial fetch fails', async () => {
		mockRequest.mockRejectedValueOnce(new Error('Network error'));
		const { container } = render(<ReadonlySessionChat sessionId="err-session" />);
		await waitFor(() => expect(container.textContent).toContain('Network error'));
	});

	it('should discard stale fetch response when sessionId changes before response resolves', async () => {
		let resolveFirst: (v: { sdkMessages: unknown[]; hasMore: boolean }) => void;
		const firstFetch = new Promise<{ sdkMessages: unknown[]; hasMore: boolean }>((res) => {
			resolveFirst = res;
		});

		mockRequest
			.mockReturnValueOnce(firstFetch)
			.mockResolvedValue({ sdkMessages: [], hasMore: false });

		const { rerender, container } = render(<ReadonlySessionChat sessionId="session-a" />);

		// Re-render with new sessionId before first fetch resolves
		rerender(<ReadonlySessionChat sessionId="session-b" />);

		// Now resolve the stale first request with a message
		act(() => {
			resolveFirst!({
				sdkMessages: [makeMessage('stale-msg-uuid')],
				hasMore: false,
			});
		});

		// Stale message must NOT appear
		await waitFor(() => expect(container.textContent).toContain('No messages yet'));
		expect(container.querySelector('[data-testid="msg-stale-msg-uuid"]')).toBeNull();
	});

	// --- Disconnected guard path ---

	it('should not call joinRoom or fetch when isConnected is false', () => {
		mockIsConnected.value = false;
		render(<ReadonlySessionChat sessionId="disconnected-session" />);
		expect(mockJoinRoom).not.toHaveBeenCalled();
		expect(mockRequest).not.toHaveBeenCalled();
	});

	it('should not subscribe to delta events when isConnected is false', () => {
		mockIsConnected.value = false;
		render(<ReadonlySessionChat sessionId="disconnected-session" />);
		expect(mockOnEvent).not.toHaveBeenCalled();
	});

	it('should fetch and join when isConnected transitions from false to true', async () => {
		mockIsConnected.value = false;
		const { rerender } = render(<ReadonlySessionChat sessionId="reconnect-session" />);
		expect(mockJoinRoom).not.toHaveBeenCalled();
		expect(mockRequest).not.toHaveBeenCalled();

		// Simulate reconnection by toggling isConnected and re-rendering
		mockIsConnected.value = true;
		rerender(<ReadonlySessionChat sessionId="reconnect-session" />);

		await waitFor(() => expect(mockJoinRoom).toHaveBeenCalledWith('session:reconnect-session'));
		await waitFor(() =>
			expect(mockRequest).toHaveBeenCalledWith('state.sdkMessages', {
				sessionId: 'reconnect-session',
			})
		);
	});
});
