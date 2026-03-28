/**
 * Tests for NeoChatView
 *
 * Verifies:
 * - Empty state renders when no messages
 * - User messages render as right-aligned bubbles
 * - Assistant messages render with sparkle avatar
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

// Mock MarkdownRenderer
vi.mock('../chat/MarkdownRenderer.tsx', () => ({
	default: ({ content }: { content: string }) => (
		<div data-testid="markdown-renderer">{content}</div>
	),
}));

import { NeoChatView } from './NeoChatView.tsx';
import { neoStore } from '../../lib/neo-store.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserMsg(id: string, text: string) {
	return {
		id,
		sessionId: 'sess-1',
		messageType: 'user',
		messageSubtype: null,
		content: JSON.stringify([{ type: 'text', text }]),
		createdAt: Date.now(),
		sendStatus: null,
		origin: 'human',
	};
}

function makeAssistantMsg(id: string, text: string) {
	return {
		id,
		sessionId: 'sess-1',
		messageType: 'assistant',
		messageSubtype: null,
		content: JSON.stringify([{ type: 'text', text }]),
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

	it('renders assistant message with sparkle avatar', () => {
		neoStore.messages.value = [makeAssistantMsg('1', 'Hello from Neo')];
		const { getByTestId, getByText } = render(<NeoChatView />);
		expect(getByTestId('neo-assistant-message')).toBeTruthy();
		expect(getByText('Hello from Neo')).toBeTruthy();
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
});
