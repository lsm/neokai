// @ts-nocheck
import { signal } from '@preact/signals';
import { act, cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockAgentWorking = signal(false);
let mockDraftContent = '';

const mockSetContent = vi.fn(() => {});
const mockClearDraft = vi.fn(() => {});
const mockClearAttachments = vi.fn(() => {});
const mockGetImagesForSend = vi.fn(() => undefined);
const mockRequest = vi.fn(async () => ({ messages: [] }));

function setQueueResponses({
	queued = [],
	saved = [],
}: {
	queued?: Array<Record<string, unknown>>;
	saved?: Array<Record<string, unknown>>;
}) {
	mockRequest.mockImplementation(async (_method: string, payload: { status?: string }) => {
		if (payload?.status === 'queued') {
			return { messages: queued };
		}
		if (payload?.status === 'saved') {
			return { messages: saved };
		}
		return { messages: [] };
	});
}

vi.mock('../../lib/state.ts', () => ({
	get isAgentWorking() {
		return {
			get value() {
				return mockAgentWorking.value;
			},
		};
	},
}));

vi.mock('../../hooks', () => ({
	useInputDraft: () => ({
		content: mockDraftContent,
		setContent: mockSetContent,
		clear: mockClearDraft,
	}),
	useModelSwitcher: () => ({
		currentModel: 'mock-model',
		currentModelInfo: null,
		availableModels: [],
		switching: false,
		loading: false,
		switchModel: vi.fn(async () => {}),
	}),
	useModal: () => ({
		isOpen: false,
		toggle: vi.fn(() => {}),
		close: vi.fn(() => {}),
	}),
	useCommandAutocomplete: () => ({
		showAutocomplete: false,
		filteredCommands: [],
		selectedIndex: 0,
		handleSelect: vi.fn(() => {}),
		close: vi.fn(() => {}),
		handleKeyDown: vi.fn(() => false),
	}),
	useFileAttachments: () => ({
		attachments: [],
		fileInputRef: { current: null },
		handleFileSelect: vi.fn(() => {}),
		handleFileDrop: vi.fn(async () => {}),
		handleRemove: vi.fn(() => {}),
		clear: mockClearAttachments,
		openFilePicker: vi.fn(() => {}),
		getImagesForSend: mockGetImagesForSend,
		handlePaste: vi.fn(() => {}),
	}),
	useInterrupt: () => ({
		interrupting: false,
		handleInterrupt: vi.fn(async () => {}),
	}),
}));

vi.mock('../../lib/connection-manager', () => ({
	connectionManager: {
		getHubIfConnected: () => ({ request: mockRequest }),
	},
}));

import MessageInput from '../MessageInput';

describe('MessageInput queue mode', () => {
	beforeEach(() => {
		cleanup();
		mockDraftContent = '';
		mockAgentWorking.value = false;
		mockSetContent.mockClear();
		mockClearDraft.mockClear();
		mockClearAttachments.mockClear();
		mockGetImagesForSend.mockClear();
		mockGetImagesForSend.mockReturnValue(undefined);
		mockRequest.mockClear();
		setQueueResponses({});

		Object.defineProperty(window, 'matchMedia', {
			writable: true,
			value: vi.fn().mockReturnValue({
				matches: false,
				media: '(pointer: coarse)',
				onchange: null,
				addListener: vi.fn(),
				removeListener: vi.fn(),
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				dispatchEvent: vi.fn(),
			}),
		});
	});

	afterEach(() => {
		cleanup();
	});

	it('sends next-turn delivery mode with Tab while agent is working', async () => {
		mockDraftContent = 'follow-up for next turn';
		mockAgentWorking.value = true;
		const onSend = vi.fn(async () => {});

		const { container } = render(<MessageInput sessionId="session-1" onSend={onSend} />);
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

		await act(async () => {
			fireEvent.keyDown(textarea, { key: 'Tab' });
		});

		expect(onSend).toHaveBeenCalledTimes(1);
		expect(onSend).toHaveBeenCalledWith('follow-up for next turn', undefined, 'next_turn');
	});

	it('sends immediately with Enter while agent is working', async () => {
		mockDraftContent = 'inject now';
		mockAgentWorking.value = true;
		const onSend = vi.fn(async () => {});

		const { container } = render(<MessageInput sessionId="session-1" onSend={onSend} />);
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

		await act(async () => {
			fireEvent.keyDown(textarea, { key: 'Enter' });
		});

		expect(onSend).toHaveBeenCalledTimes(1);
		expect(onSend).toHaveBeenCalledWith('inject now', undefined, 'current_turn');
		expect(container.textContent).not.toContain('Agent is running. Press Enter to send now');
	});

	it('does not queue on Tab when agent is idle', async () => {
		mockDraftContent = 'should not send';
		mockAgentWorking.value = false;
		const onSend = vi.fn(async () => {});

		const { container } = render(<MessageInput sessionId="session-1" onSend={onSend} />);
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

		await act(async () => {
			fireEvent.keyDown(textarea, { key: 'Tab' });
		});

		expect(onSend).not.toHaveBeenCalled();
	});

	it('does not queue on Shift+Tab while agent is working', async () => {
		mockDraftContent = 'shift tab should not queue';
		mockAgentWorking.value = true;
		const onSend = vi.fn(async () => {});

		const { container } = render(<MessageInput sessionId="session-1" onSend={onSend} />);
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

		await act(async () => {
			fireEvent.keyDown(textarea, { key: 'Tab', shiftKey: true });
		});

		expect(onSend).not.toHaveBeenCalled();
	});

	it('keeps Enter as newline on touch devices (no send)', async () => {
		mockDraftContent = 'mobile enter';
		mockAgentWorking.value = true;
		const onSend = vi.fn(async () => {});

		Object.defineProperty(window, 'matchMedia', {
			writable: true,
			value: vi.fn().mockReturnValue({
				matches: true,
				media: '(pointer: coarse)',
				onchange: null,
				addListener: vi.fn(),
				removeListener: vi.fn(),
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				dispatchEvent: vi.fn(),
			}),
		});

		const { container } = render(<MessageInput sessionId="session-1" onSend={onSend} />);
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

		await act(async () => {
			fireEvent.keyDown(textarea, { key: 'Enter' });
		});

		expect(onSend).not.toHaveBeenCalled();
	});

	it('sends with meta+Enter even on touch devices', async () => {
		mockDraftContent = 'force send';
		mockAgentWorking.value = true;
		const onSend = vi.fn(async () => {});

		Object.defineProperty(window, 'matchMedia', {
			writable: true,
			value: vi.fn().mockReturnValue({
				matches: true,
				media: '(pointer: coarse)',
				onchange: null,
				addListener: vi.fn(),
				removeListener: vi.fn(),
				addEventListener: vi.fn(),
				removeEventListener: vi.fn(),
				dispatchEvent: vi.fn(),
			}),
		});

		const { container } = render(<MessageInput sessionId="session-1" onSend={onSend} />);
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

		await act(async () => {
			fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
		});

		expect(onSend).toHaveBeenCalledWith('force send', undefined, 'current_turn');
	});

	it('does not send when disabled', async () => {
		mockDraftContent = 'disabled send';
		mockAgentWorking.value = true;
		const onSend = vi.fn(async () => {});

		const { container } = render(
			<MessageInput sessionId="session-1" onSend={onSend} disabled={true} />
		);
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

		await act(async () => {
			fireEvent.keyDown(textarea, { key: 'Enter' });
			fireEvent.keyDown(textarea, { key: 'Tab' });
		});

		expect(onSend).not.toHaveBeenCalled();
		expect(container.querySelector('[data-testid="queue-overlay"]')).toBeNull();
	});

	it('renders queued-next-turn list from server state', async () => {
		mockAgentWorking.value = true;
		setQueueResponses({
			saved: [
				{
					dbId: 'db-1',
					uuid: 'msg-1',
					text: 'saved on server',
					timestamp: Date.now(),
					status: 'saved',
				},
			],
		});

		const onSend = vi.fn(async () => {});
		const { container } = render(<MessageInput sessionId="session-1" onSend={onSend} />);

		await act(async () => {
			await Promise.resolve();
		});

		expect(container.querySelector('[data-testid="queued-next-turn-bubble"]')).toBeTruthy();
		expect(container.textContent).toContain('saved on server');
	});

	it('renders queued-current-turn bubbles from server state', async () => {
		mockAgentWorking.value = true;
		setQueueResponses({
			queued: [
				{
					dbId: 'db-1',
					uuid: 'msg-1',
					text: 'queued for current turn',
					timestamp: Date.now(),
					status: 'queued',
				},
			],
		});

		const onSend = vi.fn(async () => {});
		const { container } = render(<MessageInput sessionId="session-1" onSend={onSend} />);

		await act(async () => {
			await Promise.resolve();
		});

		expect(container.querySelector('[data-testid="queued-current-turn-bubble"]')).toBeTruthy();
		expect(container.textContent).toContain('queued for current turn');
		expect(container.querySelector('[data-testid="queued-next-turn-bubble"]')).toBeNull();
	});

	it('renders both current-turn and next-turn queue sections', async () => {
		mockAgentWorking.value = true;
		setQueueResponses({
			queued: [
				{
					dbId: 'db-q1',
					uuid: 'q1',
					text: 'current-turn pending item',
					timestamp: Date.now(),
					status: 'queued',
				},
			],
			saved: [
				{
					dbId: 'db-s1',
					uuid: 's1',
					text: 'next-turn queued item',
					timestamp: Date.now(),
					status: 'saved',
				},
			],
		});

		const onSend = vi.fn(async () => {});
		const { container } = render(<MessageInput sessionId="session-1" onSend={onSend} />);

		await act(async () => {
			await Promise.resolve();
		});

		expect(container.querySelector('[data-testid="queued-current-turn-bubble"]')).toBeTruthy();
		expect(container.querySelector('[data-testid="queued-next-turn-bubble"]')).toBeTruthy();
		expect(container.textContent).toContain('current-turn pending item');
		expect(container.textContent).toContain('next-turn queued item');
	});

	it('shows Now/Next label only on first bubble of each type', async () => {
		mockAgentWorking.value = true;
		setQueueResponses({
			queued: [
				{ dbId: 'db-q1', uuid: 'q1', text: 'first now', timestamp: Date.now(), status: 'queued' },
				{ dbId: 'db-q2', uuid: 'q2', text: 'second now', timestamp: Date.now(), status: 'queued' },
			],
			saved: [
				{ dbId: 'db-s1', uuid: 's1', text: 'first next', timestamp: Date.now(), status: 'saved' },
				{ dbId: 'db-s2', uuid: 's2', text: 'second next', timestamp: Date.now(), status: 'saved' },
			],
		});

		const onSend = vi.fn(async () => {});
		const { container } = render(<MessageInput sessionId="session-1" onSend={onSend} />);
		await act(async () => {
			await Promise.resolve();
		});

		const text = container.textContent || '';
		expect((text.match(/Now/g) || []).length).toBe(1);
		expect((text.match(/Next/g) || []).length).toBe(1);
	});

	it('updates current-turn pending overlay after Enter send while running', async () => {
		mockAgentWorking.value = true;
		mockDraftContent = 'send now';
		setQueueResponses({});
		const onSend = vi.fn(async () => {
			setQueueResponses({
				queued: [
					{
						dbId: 'db-q2',
						uuid: 'q2',
						text: 'newly pending current-turn item',
						timestamp: Date.now(),
						status: 'queued',
					},
				],
			});
		});

		const { container } = render(<MessageInput sessionId="session-1" onSend={onSend} />);
		const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

		await act(async () => {
			fireEvent.keyDown(textarea, { key: 'Enter' });
		});
		await act(async () => {
			await Promise.resolve();
		});

		expect(onSend).toHaveBeenCalledWith('send now', undefined, 'current_turn');
		expect(container.querySelector('[data-testid="queued-current-turn-bubble"]')).toBeTruthy();
		expect(container.textContent).toContain('newly pending current-turn item');
	});

	it('renders queue overlay above the input row', async () => {
		mockAgentWorking.value = true;
		setQueueResponses({
			queued: [
				{
					dbId: 'db-1',
					uuid: 'msg-1',
					text: 'position check',
					timestamp: Date.now(),
					status: 'queued',
				},
			],
		});

		const onSend = vi.fn(async () => {});
		const { container } = render(<MessageInput sessionId="session-1" onSend={onSend} />);

		await act(async () => {
			await Promise.resolve();
		});

		const form = container.querySelector('form') as HTMLFormElement;
		const orderedNodes = form.querySelectorAll('[data-testid="queue-overlay"], textarea');
		expect(orderedNodes[0]?.getAttribute('data-testid')).toBe('queue-overlay');
		expect(orderedNodes[1]?.tagName).toBe('TEXTAREA');
		const overlay = container.querySelector('[data-testid="queue-overlay"]') as HTMLElement;
		expect(overlay.className).toContain('flex-col');
	});

	it('shows overflow indicator when more than three queued messages exist', async () => {
		mockAgentWorking.value = true;
		setQueueResponses({
			saved: [
				{ dbId: 'db-1', uuid: 'u1', text: 'one', timestamp: Date.now(), status: 'saved' },
				{ dbId: 'db-2', uuid: 'u2', text: 'two', timestamp: Date.now(), status: 'saved' },
				{ dbId: 'db-3', uuid: 'u3', text: 'three', timestamp: Date.now(), status: 'saved' },
				{ dbId: 'db-4', uuid: 'u4', text: 'four', timestamp: Date.now(), status: 'saved' },
			],
		});

		const onSend = vi.fn(async () => {});
		const { container } = render(<MessageInput sessionId="session-1" onSend={onSend} />);

		await act(async () => {
			await Promise.resolve();
		});

		expect(container.textContent).toContain('+1 more queued');
	});

	it('polls server queue while active', async () => {
		vi.useFakeTimers();
		try {
			mockAgentWorking.value = true;
			setQueueResponses({});
			const onSend = vi.fn(async () => {});

			render(<MessageInput sessionId="session-1" onSend={onSend} />);
			await act(async () => {
				await Promise.resolve();
			});

			const initialCalls = mockRequest.mock.calls.length;
			await act(async () => {
				vi.advanceTimersByTime(1700);
			});

			expect(mockRequest.mock.calls.length).toBeGreaterThan(initialCalls);
			expect(mockRequest).toHaveBeenCalledWith('session.messages.byStatus', {
				sessionId: 'session-1',
				status: 'queued',
				limit: 20,
			});
			expect(mockRequest).toHaveBeenCalledWith('session.messages.byStatus', {
				sessionId: 'session-1',
				status: 'saved',
				limit: 20,
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it('clears pending overlay when polled queue becomes empty', async () => {
		vi.useFakeTimers();
		try {
			mockAgentWorking.value = true;
			let queuedCalls = 0;
			mockRequest.mockImplementation(async (_method: string, payload: { status?: string }) => {
				if (payload?.status === 'queued') {
					queuedCalls++;
					if (queuedCalls === 1) {
						return {
							messages: [
								{
									dbId: 'db-q1',
									uuid: 'q1',
									text: 'transient queued item',
									timestamp: Date.now(),
									status: 'queued',
								},
							],
						};
					}
					return { messages: [] };
				}
				return { messages: [] };
			});

			const onSend = vi.fn(async () => {});
			const { container } = render(<MessageInput sessionId="session-1" onSend={onSend} />);
			await act(async () => {
				await Promise.resolve();
			});

			expect(container.querySelector('[data-testid="queue-overlay"]')).toBeTruthy();
			expect(container.textContent).toContain('transient queued item');

			await act(async () => {
				vi.advanceTimersByTime(800);
				await Promise.resolve();
			});

			expect(container.querySelector('[data-testid="queue-overlay"]')).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it('switches bubble style when message moves from next-turn to current-turn', async () => {
		vi.useFakeTimers();
		try {
			mockAgentWorking.value = true;
			let queuedCalls = 0;
			let savedCalls = 0;
			mockRequest.mockImplementation(async (_method: string, payload: { status?: string }) => {
				if (payload?.status === 'queued') {
					queuedCalls++;
					if (queuedCalls >= 2) {
						return {
							messages: [
								{
									dbId: 'db-x1',
									uuid: 'x1',
									text: 'status transition item',
									timestamp: Date.now(),
									status: 'queued',
								},
							],
						};
					}
					return { messages: [] };
				}
				if (payload?.status === 'saved') {
					savedCalls++;
					if (savedCalls === 1) {
						return {
							messages: [
								{
									dbId: 'db-x1',
									uuid: 'x1',
									text: 'status transition item',
									timestamp: Date.now(),
									status: 'saved',
								},
							],
						};
					}
					return { messages: [] };
				}
				return { messages: [] };
			});

			const onSend = vi.fn(async () => {});
			const { container } = render(<MessageInput sessionId="session-1" onSend={onSend} />);
			await act(async () => {
				await Promise.resolve();
			});

			expect(container.querySelector('[data-testid="queued-next-turn-bubble"]')).toBeTruthy();
			expect(container.querySelector('[data-testid="queued-current-turn-bubble"]')).toBeNull();
			expect(container.textContent).toContain('Next');

			await act(async () => {
				vi.advanceTimersByTime(800);
				await Promise.resolve();
			});

			expect(container.querySelector('[data-testid="queued-current-turn-bubble"]')).toBeTruthy();
			expect(container.querySelector('[data-testid="queued-next-turn-bubble"]')).toBeNull();
			expect(container.textContent).toContain('Now');
		} finally {
			vi.useRealTimers();
		}
	});
});
