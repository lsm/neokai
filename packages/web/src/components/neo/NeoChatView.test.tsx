/**
 * Tests for NeoChatView
 *
 * Verifies:
 * - Empty state renders when no messages
 * - User messages render as right-aligned bubbles with correct text
 * - Assistant messages render with sparkle avatar using SDKMessageRenderer
 * - SDK messages with content arrays are parsed and rendered correctly
 * - Tool call messages render via SDKMessageRenderer
 * - Sending a message calls neoStore.sendMessage
 * - Enter key submits; Shift+Enter does not
 * - Send button disabled when input is empty or sending
 * - Typing indicator shown while sending
 * - Error cards rendered for provider_unavailable, no_credentials, model_unavailable
 * - NeoConfirmationCard shown when pendingConfirmation exists
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, waitFor, act } from '@testing-library/preact';

// ---------------------------------------------------------------------------
// Mock neoStore — all signals defined inside factory using async import
// ---------------------------------------------------------------------------

vi.mock('../../lib/neo-store.ts', async () => {
	const { signal: s } = await import('@preact/signals');
	const messages = s<unknown[]>([]);
	const loading = s(false);
	const pendingConfirmation = s<{ actionId: string; description: string } | null>(null);
	const sendMessage = vi.fn();
	return {
		neoStore: { messages, loading, pendingConfirmation, sendMessage },
	};
});

// Mock NeoConfirmationCard to avoid deep dependency
vi.mock('./NeoConfirmationCard.tsx', () => ({
	NeoConfirmationCard: ({ actionId, description }: { actionId: string; description: string }) => (
		<div data-testid="mock-confirmation-card" data-action-id={actionId}>
			{description}
		</div>
	),
}));

// Mock SDKMessageRenderer — renders text content from the SDK message for assertions
vi.mock('../sdk/SDKMessageRenderer.tsx', () => ({
	SDKMessageRenderer: ({ message }: { message: unknown }) => {
		const msg = message as {
			type: string;
			message?: {
				content?: Array<{ type: string; text?: string }> | string;
			};
		};
		let text = '';
		if (msg.type === 'assistant') {
			const content = msg.message?.content;
			if (Array.isArray(content)) {
				text = content
					.filter((b) => b.type === 'text')
					.map((b) => b.text ?? '')
					.join('\n');
			}
		}
		return (
			<div data-testid="sdk-message-renderer" data-message-type={msg.type}>
				{text}
			</div>
		);
	},
}));

import { NeoChatView } from './NeoChatView.tsx';
import { neoStore } from '../../lib/neo-store.ts';

// ---------------------------------------------------------------------------
// Helpers — build realistic SDK message JSON strings
// ---------------------------------------------------------------------------

function makeUserMsg(id: string, text: string) {
	const sdkMsg = {
		type: 'user',
		message: {
			role: 'user',
			content: [{ type: 'text', text }],
		},
		parent_tool_use_id: null,
		session_id: 'sess-1',
	};
	return {
		id,
		sessionId: 'sess-1',
		messageType: 'user',
		messageSubtype: null,
		content: JSON.stringify(sdkMsg),
		createdAt: Date.now(),
		sendStatus: null,
		origin: 'human',
	};
}

function makeAssistantMsg(id: string, text: string) {
	const sdkMsg = {
		type: 'assistant',
		message: {
			id: `msg-${id}`,
			content: [{ type: 'text', text }],
			model: 'claude-3-5-sonnet-20241022',
			role: 'assistant',
			stop_reason: 'end_turn',
			usage: { input_tokens: 10, output_tokens: 5 },
		},
		parent_tool_use_id: null,
		uuid: id,
		session_id: 'sess-1',
	};
	return {
		id,
		sessionId: 'sess-1',
		messageType: 'assistant',
		messageSubtype: null,
		content: JSON.stringify(sdkMsg),
		createdAt: Date.now(),
		sendStatus: null,
		origin: null,
	};
}

function makeAssistantMsgWithToolCall(id: string, toolName: string) {
	const sdkMsg = {
		type: 'assistant',
		message: {
			id: `msg-${id}`,
			content: [
				{
					type: 'tool_use',
					id: `tool-${id}`,
					name: toolName,
					input: { query: 'test' },
				},
			],
			model: 'claude-3-5-sonnet-20241022',
			role: 'assistant',
			stop_reason: 'tool_use',
			usage: { input_tokens: 10, output_tokens: 5 },
		},
		parent_tool_use_id: null,
		uuid: id,
		session_id: 'sess-1',
	};
	return {
		id,
		sessionId: 'sess-1',
		messageType: 'assistant',
		messageSubtype: null,
		content: JSON.stringify(sdkMsg),
		createdAt: Date.now(),
		sendStatus: null,
		origin: null,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NeoChatView', () => {
	beforeEach(() => {
		neoStore.messages.value = [];
		neoStore.loading.value = false;
		neoStore.pendingConfirmation.value = null;
		(neoStore.sendMessage as ReturnType<typeof vi.fn>).mockReset();
	});

	afterEach(() => {
		cleanup();
	});

	it('renders empty state when no messages', () => {
		const { getByTestId } = render(<NeoChatView />);
		expect(getByTestId('neo-empty-state')).toBeTruthy();
	});

	it('does not show empty state when messages exist', () => {
		neoStore.messages.value = [makeUserMsg('1', 'Hello')];
		const { queryByTestId } = render(<NeoChatView />);
		expect(queryByTestId('neo-empty-state')).toBeNull();
	});

	it('renders user message as right-aligned bubble', () => {
		neoStore.messages.value = [makeUserMsg('1', 'Hi there')];
		const { getByTestId, getByText } = render(<NeoChatView />);
		expect(getByTestId('neo-user-message')).toBeTruthy();
		expect(getByText('Hi there')).toBeTruthy();
	});

	it('renders assistant message with sparkle avatar and SDKMessageRenderer', () => {
		neoStore.messages.value = [makeAssistantMsg('1', 'Hello from Neo')];
		const { getByTestId } = render(<NeoChatView />);
		expect(getByTestId('neo-assistant-message')).toBeTruthy();
		expect(getByTestId('sdk-message-renderer')).toBeTruthy();
	});

	it('renders assistant text content via SDKMessageRenderer', () => {
		neoStore.messages.value = [makeAssistantMsg('1', 'Hello from Neo')];
		const { getByText } = render(<NeoChatView />);
		expect(getByText('Hello from Neo')).toBeTruthy();
	});

	it('passes correct SDK message type to SDKMessageRenderer', () => {
		neoStore.messages.value = [makeAssistantMsg('1', 'Hey!')];
		const { getByTestId } = render(<NeoChatView />);
		const renderer = getByTestId('sdk-message-renderer');
		expect(renderer.getAttribute('data-message-type')).toBe('assistant');
	});

	it('renders tool call messages via SDKMessageRenderer', () => {
		neoStore.messages.value = [makeAssistantMsgWithToolCall('1', 'list_rooms')];
		const { getByTestId } = render(<NeoChatView />);
		expect(getByTestId('neo-assistant-message')).toBeTruthy();
		expect(getByTestId('sdk-message-renderer')).toBeTruthy();
	});

	it('skips result and system messages', () => {
		neoStore.messages.value = [
			{ ...makeUserMsg('1', 'hi'), messageType: 'result' },
			{ ...makeUserMsg('2', 'hi'), messageType: 'system' },
		];
		const { queryByTestId } = render(<NeoChatView />);
		expect(queryByTestId('neo-user-message')).toBeNull();
		expect(queryByTestId('neo-assistant-message')).toBeNull();
	});

	it('renders the chat input', () => {
		const { getByTestId } = render(<NeoChatView />);
		expect(getByTestId('neo-chat-input')).toBeTruthy();
	});

	it('send button is disabled when input is empty', () => {
		const { getByTestId } = render(<NeoChatView />);
		const btn = getByTestId('neo-send-button') as HTMLButtonElement;
		expect(btn.disabled).toBe(true);
	});

	it('send button is enabled when input has text', () => {
		const { getByTestId } = render(<NeoChatView />);
		const input = getByTestId('neo-chat-input') as HTMLTextAreaElement;
		fireEvent.input(input, { target: { value: 'hello' } });
		const btn = getByTestId('neo-send-button') as HTMLButtonElement;
		expect(btn.disabled).toBe(false);
	});

	it('calls sendMessage on send button click', async () => {
		(neoStore.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
		const { getByTestId } = render(<NeoChatView />);
		const input = getByTestId('neo-chat-input') as HTMLTextAreaElement;
		fireEvent.input(input, { target: { value: 'What rooms do I have?' } });
		await act(async () => {
			fireEvent.click(getByTestId('neo-send-button'));
		});
		expect(neoStore.sendMessage).toHaveBeenCalledWith('What rooms do I have?');
	});

	it('clears input after send', async () => {
		(neoStore.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
		const { getByTestId } = render(<NeoChatView />);
		const input = getByTestId('neo-chat-input') as HTMLTextAreaElement;
		fireEvent.input(input, { target: { value: 'hello' } });
		await act(async () => {
			fireEvent.click(getByTestId('neo-send-button'));
		});
		expect(input.value).toBe('');
	});

	it('submits on Enter key', async () => {
		(neoStore.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ success: true });
		const { getByTestId } = render(<NeoChatView />);
		const input = getByTestId('neo-chat-input') as HTMLTextAreaElement;
		fireEvent.input(input, { target: { value: 'hello' } });
		await act(async () => {
			fireEvent.keyDown(input, { key: 'Enter', shiftKey: false });
		});
		expect(neoStore.sendMessage).toHaveBeenCalledWith('hello');
	});

	it('does NOT submit on Shift+Enter', () => {
		const { getByTestId } = render(<NeoChatView />);
		const input = getByTestId('neo-chat-input') as HTMLTextAreaElement;
		fireEvent.input(input, { target: { value: 'hello' } });
		fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
		expect(neoStore.sendMessage).not.toHaveBeenCalled();
	});

	it('shows typing indicator while sending', async () => {
		let resolveSend!: (v: { success: boolean }) => void;
		(neoStore.sendMessage as ReturnType<typeof vi.fn>).mockReturnValue(
			new Promise((res) => (resolveSend = res))
		);

		const { getByTestId, queryByTestId } = render(<NeoChatView />);
		const input = getByTestId('neo-chat-input') as HTMLTextAreaElement;
		fireEvent.input(input, { target: { value: 'hello' } });
		fireEvent.click(getByTestId('neo-send-button'));

		await waitFor(() => {
			expect(queryByTestId('neo-typing-indicator')).toBeTruthy();
		});

		await act(async () => {
			resolveSend({ success: true });
		});

		await waitFor(() => {
			expect(queryByTestId('neo-typing-indicator')).toBeNull();
		});
	});

	it('renders provider_unavailable error card', async () => {
		(neoStore.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: false,
			errorCode: 'provider_unavailable',
			error: 'Rate limited',
		});
		const { getByTestId } = render(<NeoChatView />);
		const input = getByTestId('neo-chat-input') as HTMLTextAreaElement;
		fireEvent.input(input, { target: { value: 'hi' } });
		await act(async () => {
			fireEvent.click(getByTestId('neo-send-button'));
		});
		await waitFor(() => {
			expect(getByTestId('neo-error-provider-unavailable')).toBeTruthy();
		});
	});

	it('renders no_credentials error card', async () => {
		(neoStore.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: false,
			errorCode: 'no_credentials',
			error: 'No API key',
		});
		const { getByTestId } = render(<NeoChatView />);
		const input = getByTestId('neo-chat-input') as HTMLTextAreaElement;
		fireEvent.input(input, { target: { value: 'hi' } });
		await act(async () => {
			fireEvent.click(getByTestId('neo-send-button'));
		});
		await waitFor(() => {
			expect(getByTestId('neo-error-no-credentials')).toBeTruthy();
		});
	});

	it('renders model_unavailable error card', async () => {
		(neoStore.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: false,
			errorCode: 'model_unavailable',
			error: 'Model not found',
		});
		const { getByTestId } = render(<NeoChatView />);
		const input = getByTestId('neo-chat-input') as HTMLTextAreaElement;
		fireEvent.input(input, { target: { value: 'hi' } });
		await act(async () => {
			fireEvent.click(getByTestId('neo-send-button'));
		});
		await waitFor(() => {
			expect(getByTestId('neo-error-model-unavailable')).toBeTruthy();
		});
	});

	it('shows NeoConfirmationCard when pendingConfirmation exists', () => {
		neoStore.messages.value = [makeAssistantMsg('1', 'Please confirm the action')];
		neoStore.pendingConfirmation.value = { actionId: 'action-123', description: 'Delete room' };
		const { getByTestId } = render(<NeoChatView />);
		const card = getByTestId('mock-confirmation-card');
		expect(card).toBeTruthy();
		expect(card.getAttribute('data-action-id')).toBe('action-123');
	});

	it('confirmation card only appears on the last assistant message', () => {
		neoStore.messages.value = [
			makeAssistantMsg('1', 'First response'),
			makeAssistantMsg('2', 'Second response'),
		];
		neoStore.pendingConfirmation.value = { actionId: 'act-1', description: 'Do something' };
		const { getAllByTestId, queryAllByTestId } = render(<NeoChatView />);
		// Two assistant messages but only one confirmation card
		expect(getAllByTestId('neo-assistant-message')).toHaveLength(2);
		expect(queryAllByTestId('mock-confirmation-card')).toHaveLength(1);
	});

	it('preserves input text when send fails', async () => {
		(neoStore.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: false,
			errorCode: 'provider_unavailable',
			error: 'Rate limited',
		});
		const { getByTestId } = render(<NeoChatView />);
		const input = getByTestId('neo-chat-input') as HTMLTextAreaElement;
		fireEvent.input(input, { target: { value: 'my important message' } });
		await act(async () => {
			fireEvent.click(getByTestId('neo-send-button'));
		});
		// Input should NOT be cleared on failure
		expect(input.value).toBe('my important message');
	});

	it('error card can be dismissed', async () => {
		(neoStore.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
			success: false,
			errorCode: 'provider_unavailable',
			error: 'Rate limited',
		});
		const { getByTestId, queryByTestId } = render(<NeoChatView />);
		const input = getByTestId('neo-chat-input') as HTMLTextAreaElement;
		fireEvent.input(input, { target: { value: 'hi' } });
		await act(async () => {
			fireEvent.click(getByTestId('neo-send-button'));
		});
		await waitFor(() => {
			expect(getByTestId('neo-error-provider-unavailable')).toBeTruthy();
		});
		act(() => {
			fireEvent.click(getByTestId('neo-error-dismiss'));
		});
		expect(queryByTestId('neo-error-provider-unavailable')).toBeNull();
	});

	it('renders multiple messages in order', () => {
		neoStore.messages.value = [
			makeUserMsg('1', 'What rooms do I have?'),
			makeAssistantMsg('2', 'You have 3 rooms: Alpha, Beta, Gamma.'),
		];
		const { getAllByTestId } = render(<NeoChatView />);
		expect(getAllByTestId('neo-user-message')).toHaveLength(1);
		expect(getAllByTestId('neo-assistant-message')).toHaveLength(1);
	});

	it('renders user message with string content from SDK message', () => {
		// User message with string content (not array)
		const sdkMsg = {
			type: 'user',
			message: { role: 'user', content: 'Hello as a string' },
			parent_tool_use_id: null,
			session_id: 'sess-1',
		};
		neoStore.messages.value = [
			{
				id: '1',
				sessionId: 'sess-1',
				messageType: 'user',
				messageSubtype: null,
				content: JSON.stringify(sdkMsg),
				createdAt: Date.now(),
				sendStatus: null,
				origin: 'human',
			},
		];
		const { getByTestId, getByText } = render(<NeoChatView />);
		expect(getByTestId('neo-user-message')).toBeTruthy();
		expect(getByText('Hello as a string')).toBeTruthy();
	});
});
