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

const mockRequest = vi.fn(async (method: string) => {
	if (method === 'state.sdkMessages') {
		return { sdkMessages: [], hasMore: false };
	}
	if (method === 'message.sdkMessages') {
		return { sdkMessages: [], hasMore: false };
	}
	return {};
});

const mockJoinRoom = vi.fn();
const mockLeaveRoom = vi.fn();

vi.mock('../../../hooks/useMessageHub.ts', () => ({
	useMessageHub: () => ({
		request: mockRequest,
		onEvent: mockOnEvent,
		isConnected: mockIsConnected.value,
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

// Mock sessionStore to spy on select
const mockSessionStoreSelect = vi.fn();
vi.mock('../../../lib/session-store.ts', () => ({
	sessionStore: {
		select: mockSessionStoreSelect,
		activeSessionId: { value: null },
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
});
