// @ts-nocheck

import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseThreadRow } from '../space-task-thread-events';
import { MinimalThreadFeed } from './MinimalThreadFeed';

// Stub MarkdownRenderer to a synchronous text renderer so tests can assert
// content without waiting on the lazy-loaded marked import.
vi.mock('../../../chat/MarkdownRenderer.tsx', () => ({
	default: ({ content }: { content: string }) => <div data-testid="md">{content}</div>,
}));

function makeRow(opts: {
	id: string;
	label: string;
	createdAt: number;
	message: unknown;
	sessionId?: string;
}) {
	return parseThreadRow({
		id: opts.id,
		sessionId: opts.sessionId ?? 'space:s:task:t',
		kind: 'task_agent',
		role: 'task',
		label: opts.label,
		taskId: 't',
		taskTitle: 'Task',
		messageType: 'assistant',
		content: JSON.stringify(opts.message),
		createdAt: opts.createdAt,
	});
}

function assistantText(uuid: string, text: string) {
	return {
		type: 'assistant',
		uuid,
		message: { content: [{ type: 'text', text }] },
	};
}

function assistantToolUse(
	uuid: string,
	tools: Array<{ name: string; input: Record<string, unknown> }>
) {
	return {
		type: 'assistant',
		uuid,
		message: {
			content: tools.map((t, i) => ({
				type: 'tool_use',
				id: `tu-${uuid}-${i}`,
				name: t.name,
				input: t.input,
			})),
		},
	};
}

function resultMessage(uuid: string) {
	return {
		type: 'result',
		uuid,
		subtype: 'success',
		usage: { input_tokens: 100, output_tokens: 50 },
	};
}

function humanUserMessage(uuid: string, text: string) {
	return {
		type: 'user',
		uuid,
		message: { content: text },
	};
}

function syntheticPeerMessage(
	uuid: string,
	text: string,
	from: { name?: string; sessionId?: string }
) {
	return {
		type: 'user',
		uuid,
		isSynthetic: true,
		origin: { kind: 'peer', from: from.sessionId ?? 'session-x', name: from.name },
		message: { content: [{ type: 'text', text }] },
	};
}

function neoOriginMessage(uuid: string, text: string) {
	return {
		type: 'user',
		uuid,
		origin: 'neo',
		message: { content: text },
	};
}

function replayUserMessage(uuid: string, text: string) {
	// Replay messages have isReplay: true and may carry no origin metadata —
	// the agent→agent handoff case the daemon currently emits.
	return {
		type: 'user',
		uuid,
		isReplay: true,
		message: { content: text },
	};
}

describe('MinimalThreadFeed', () => {
	beforeEach(() => cleanup());
	afterEach(() => cleanup());

	it('renders nothing when there are no rows', () => {
		const { container } = render(<MinimalThreadFeed parsedRows={[]} />);
		expect(container.querySelector('[data-testid="space-task-event-feed-minimal"]')).toBeNull();
	});

	it('renders one turn row per agent block with name and clock', () => {
		const baseTime = new Date('2026-04-25T18:00:00Z').getTime();
		const rows = [
			makeRow({
				id: 'a1',
				label: 'Coder Agent',
				createdAt: baseTime,
				message: assistantText('a1', 'first'),
			}),
			makeRow({
				id: 'r1',
				label: 'Coder Agent',
				createdAt: baseTime + 1000,
				message: resultMessage('r1'),
			}),
			makeRow({
				id: 'a2',
				label: 'Reviewer Agent',
				createdAt: baseTime + 5000,
				message: assistantText('a2', 'looks good'),
			}),
			makeRow({
				id: 'r2',
				label: 'Reviewer Agent',
				createdAt: baseTime + 6000,
				message: resultMessage('r2'),
			}),
		];

		render(<MinimalThreadFeed parsedRows={rows} />);
		const turns = screen.getAllByTestId('minimal-thread-turn');
		expect(turns.length).toBe(2);
		expect(turns[0].dataset.agentLabel).toBe('Coder Agent');
		expect(turns[1].dataset.agentLabel).toBe('Reviewer Agent');
		// Names appear in their short uppercase form.
		expect(turns[0].textContent).toContain('CODER');
		expect(turns[1].textContent).toContain('REVIEWER');
		// Both blocks contain a result row → both rendered as completed turns.
		expect(turns.every((t) => t.dataset.turnState === 'completed')).toBe(true);
	});

	it('renders the last assistant text of a completed block as its message body', async () => {
		const t = Date.now();
		const rows = [
			makeRow({
				id: 'a1',
				label: 'Coder Agent',
				createdAt: t,
				message: assistantText('a1', 'preliminary'),
			}),
			makeRow({
				id: 'a2',
				label: 'Coder Agent',
				createdAt: t + 1000,
				message: assistantText('a2', 'final answer ready'),
			}),
			makeRow({
				id: 'r1',
				label: 'Coder Agent',
				createdAt: t + 2000,
				message: resultMessage('r1'),
			}),
		];

		render(<MinimalThreadFeed parsedRows={rows} />);
		await waitFor(() => {
			expect(screen.getByText('final answer ready')).toBeTruthy();
		});
		// Doesn't pick the earlier text once a later assistant text exists.
		expect(screen.queryByText('preliminary')).toBeNull();
	});

	it('renders the active rail and tool roster for the live turn when isAgentActive', () => {
		const t = Date.now();
		const rows = [
			makeRow({
				id: 'a1',
				label: 'Coder Agent',
				createdAt: t,
				message: assistantToolUse('a1', [
					{ name: 'Bash', input: { command: 'bun run typecheck' } },
					{ name: 'Read', input: { file_path: 'packages/web/src/foo.ts' } },
				]),
			}),
			makeRow({
				id: 'a2',
				label: 'Coder Agent',
				createdAt: t + 1000,
				message: assistantToolUse('a2', [
					{ name: 'Grep', input: { pattern: 'provisionExistingSpaces' } },
					{ name: 'Bash', input: { command: 'git status' } },
				]),
			}),
		];

		render(<MinimalThreadFeed parsedRows={rows} isAgentActive={true} />);

		const turn = screen.getByTestId('minimal-thread-turn');
		expect(turn.dataset.turnState).toBe('active');

		// Rail wrapper appears only on active turns.
		expect(screen.getByTestId('minimal-thread-active-rail')).toBeTruthy();

		// All four tool entries appear in the roster.
		const entries = screen.getAllByTestId('minimal-thread-roster-entry');
		expect(entries.length).toBe(4);
		const text = entries.map((e) => e.textContent).join('\n');
		expect(text).toContain('Bash');
		expect(text).toContain('bun run typecheck');
		expect(text).toContain('Read');
		expect(text).toContain('packages/web/src/foo.ts');
		expect(text).toContain('Grep');
		expect(text).toContain('provisionExistingSpaces');
		expect(text).toContain('git status');

		// Status text comes from the active body.
		expect(turn.textContent).toContain('Running');
	});

	it('caps the active roster at 4 most-recent tool calls', () => {
		const t = Date.now();
		// 6 tool calls in one block — only the last 4 should render.
		const tools = [
			{ name: 'Bash', input: { command: 'echo 1' } },
			{ name: 'Bash', input: { command: 'echo 2' } },
			{ name: 'Bash', input: { command: 'echo 3' } },
			{ name: 'Bash', input: { command: 'echo 4' } },
			{ name: 'Bash', input: { command: 'echo 5' } },
			{ name: 'Bash', input: { command: 'echo 6' } },
		];
		const rows = [
			makeRow({
				id: 'a1',
				label: 'Coder Agent',
				createdAt: t,
				message: assistantToolUse('a1', tools),
			}),
		];

		render(<MinimalThreadFeed parsedRows={rows} isAgentActive={true} />);
		const entries = screen.getAllByTestId('minimal-thread-roster-entry');
		expect(entries.length).toBe(4);
		expect(entries[0].textContent).toContain('echo 3');
		expect(entries[3].textContent).toContain('echo 6');
		// The very oldest two were trimmed.
		const allText = entries.map((e) => e.textContent).join('\n');
		expect(allText).not.toContain('echo 1');
		expect(allText).not.toContain('echo 2');
	});

	it('does not show the active rail on completed blocks', () => {
		const t = Date.now();
		const rows = [
			makeRow({
				id: 'a1',
				label: 'Coder Agent',
				createdAt: t,
				message: assistantText('a1', 'done'),
			}),
			makeRow({
				id: 'r1',
				label: 'Coder Agent',
				createdAt: t + 1000,
				message: resultMessage('r1'),
			}),
		];

		render(<MinimalThreadFeed parsedRows={rows} isAgentActive={true} />);
		expect(screen.queryByTestId('minimal-thread-active-rail')).toBeNull();
		expect(screen.getByTestId('minimal-thread-turn').dataset.turnState).toBe('completed');
	});

	it('treats the last block as completed when isAgentActive is false', () => {
		const t = Date.now();
		// No result message — block is non-terminal. Need an assistant text row
		// alongside the tool-use so the completed turn has surfaceable text and
		// is not dropped by the empty-completed-turn filter.
		const rows = [
			makeRow({
				id: 'a1',
				label: 'Coder Agent',
				createdAt: t,
				message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'ls' } }]),
			}),
			makeRow({
				id: 'a2',
				label: 'Coder Agent',
				createdAt: t + 1000,
				message: assistantText('a2', 'inspecting'),
			}),
		];

		render(<MinimalThreadFeed parsedRows={rows} isAgentActive={false} />);
		const turn = screen.getByTestId('minimal-thread-turn');
		expect(turn.dataset.turnState).toBe('completed');
		expect(screen.queryByTestId('minimal-thread-active-rail')).toBeNull();
	});

	it('renders a human user message as a message turn with User → recipient header', async () => {
		const t = Date.now();
		const rows = [
			makeRow({
				id: 'u1',
				label: 'Coder Agent',
				createdAt: t,
				message: humanUserMessage('u1', 'help me add dark mode'),
			}),
			makeRow({
				id: 'a1',
				label: 'Coder Agent',
				createdAt: t + 1000,
				message: assistantText('a1', 'on it'),
			}),
		];

		render(<MinimalThreadFeed parsedRows={rows} />);
		const turns = screen.getAllByTestId('minimal-thread-turn');
		// One message turn + one agent turn.
		expect(turns.length).toBe(2);

		const messageTurn = turns[0];
		expect(messageTurn.dataset.turnState).toBe('message');
		expect(messageTurn.dataset.fromLabel).toBe('User');
		expect(messageTurn.dataset.toLabel).toBe('Coder Agent');
		// Human bubbles are iMessage-style — sender labels are encoded on the
		// dataset (asserted above) but not surfaced as visible text.
		expect(messageTurn.dataset.messageKind).toBe('human');
		await waitFor(() => {
			expect(screen.getByText('help me add dark mode')).toBeTruthy();
		});

		// Agent turn follows.
		expect(turns[1].dataset.turnState).toBe('completed');
		expect(turns[1].dataset.agentLabel).toBe('Coder Agent');
	});

	it('renders a synthetic peer-origin message as Sender → recipient with handoff badge', async () => {
		const t = Date.now();
		const rows = [
			makeRow({
				id: 'u1',
				label: 'Coder Agent',
				createdAt: t,
				message: syntheticPeerMessage('u1', 'please address the failing test', {
					name: 'Reviewer Agent',
					sessionId: 'session-rev',
				}),
			}),
			makeRow({
				id: 'a1',
				label: 'Coder Agent',
				createdAt: t + 1000,
				message: assistantText('a1', 'fixed'),
			}),
		];

		render(<MinimalThreadFeed parsedRows={rows} />);
		const messageTurn = screen.getAllByTestId('minimal-thread-turn')[0];
		expect(messageTurn.dataset.turnState).toBe('message');
		expect(messageTurn.dataset.fromLabel).toBe('Reviewer Agent');
		expect(messageTurn.dataset.toLabel).toBe('Coder Agent');
		expect(messageTurn.textContent).toContain('REVIEWER');
		expect(messageTurn.textContent).toContain('CODER');
		// Synthetic handoffs render with a "Synthetic" badge (was "handoff" earlier;
		// renamed when the bubble was redesigned to mirror the Thinking block).
		expect(messageTurn.textContent?.toLowerCase()).toContain('synthetic');
		await waitFor(() => {
			expect(screen.getByText('please address the failing test')).toBeTruthy();
		});
	});

	it('labels neo-origin user messages as Neo and marks them as synthetic', () => {
		const t = Date.now();
		const rows = [
			makeRow({
				id: 'u1',
				label: 'Task Agent',
				createdAt: t,
				message: neoOriginMessage('u1', 'starting up'),
			}),
		];

		render(<MinimalThreadFeed parsedRows={rows} />);
		const messageTurn = screen.getByTestId('minimal-thread-turn');
		expect(messageTurn.dataset.turnState).toBe('message');
		expect(messageTurn.dataset.fromLabel).toBe('Neo');
		expect(messageTurn.dataset.toLabel).toBe('Task Agent');
		// Synthetic badge replaces the older "handoff" wording.
		expect(messageTurn.textContent?.toLowerCase()).toContain('synthetic');
	});

	it('infers sender from previous block when a replay message has no origin', async () => {
		const t = Date.now();
		const rows = [
			// Reviewer ran first.
			makeRow({
				id: 'a-rev',
				label: 'Reviewer Agent',
				createdAt: t,
				message: assistantText('a-rev', 'looks good but please fix x'),
			}),
			makeRow({
				id: 'r-rev',
				label: 'Reviewer Agent',
				createdAt: t + 100,
				message: resultMessage('r-rev'),
			}),
			// Synthetic handoff lands in Coder's session with no origin info.
			makeRow({
				id: 'u1',
				label: 'Coder Agent',
				createdAt: t + 200,
				message: replayUserMessage('u1', 'address the review feedback'),
			}),
			makeRow({
				id: 'a-coder',
				label: 'Coder Agent',
				createdAt: t + 300,
				message: assistantText('a-coder', 'on it'),
			}),
		];

		render(<MinimalThreadFeed parsedRows={rows} />);
		const turns = screen.getAllByTestId('minimal-thread-turn');
		// Reviewer agent turn → message turn (handoff) → Coder agent turn.
		expect(turns.length).toBe(3);
		expect(turns[1].dataset.turnState).toBe('message');
		expect(turns[1].dataset.fromLabel).toBe('Reviewer Agent');
		expect(turns[1].dataset.toLabel).toBe('Coder Agent');
		await waitFor(() => {
			expect(screen.getByText('address the review feedback')).toBeTruthy();
		});
	});

	it('orders the message turn before the recipient agent turn within a block', () => {
		const t = Date.now();
		const rows = [
			makeRow({
				id: 'u1',
				label: 'Coder Agent',
				createdAt: t,
				message: humanUserMessage('u1', 'hello'),
			}),
			makeRow({
				id: 'a1',
				label: 'Coder Agent',
				createdAt: t + 1000,
				message: assistantText('a1', 'hi back'),
			}),
		];

		render(<MinimalThreadFeed parsedRows={rows} />);
		const turns = screen.getAllByTestId('minimal-thread-turn');
		expect(turns[0].dataset.turnState).toBe('message');
		expect(turns[1].dataset.turnState).toBe('completed');
	});

	it('still treats the trailing block as active when a user message precedes the assistant rows', () => {
		const t = Date.now();
		const rows = [
			makeRow({
				id: 'u1',
				label: 'Coder Agent',
				createdAt: t,
				message: humanUserMessage('u1', 'go'),
			}),
			makeRow({
				id: 'a1',
				label: 'Coder Agent',
				createdAt: t + 1000,
				message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'ls' } }]),
			}),
		];

		render(<MinimalThreadFeed parsedRows={rows} isAgentActive={true} />);
		const turns = screen.getAllByTestId('minimal-thread-turn');
		expect(turns[0].dataset.turnState).toBe('message');
		expect(turns[1].dataset.turnState).toBe('active');
		expect(screen.getByTestId('minimal-thread-active-rail')).toBeTruthy();
	});

	it('shows the completed stats line under the agent name (not inside the bubble)', async () => {
		const t = Date.now();
		const rows = [
			makeRow({
				id: 'a1',
				label: 'Coder Agent',
				createdAt: t,
				message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'ls' } }]),
			}),
			makeRow({
				id: 'a2',
				label: 'Coder Agent',
				createdAt: t + 30_000,
				message: assistantText('a2', 'all done'),
			}),
			makeRow({
				id: 'r1',
				label: 'Coder Agent',
				createdAt: t + 31_000,
				message: resultMessage('r1'),
			}),
		];

		render(<MinimalThreadFeed parsedRows={rows} />);
		const turn = screen.getByTestId('minimal-thread-turn');
		// 1 tool call, 3 messages, ~31s duration.
		expect(turn.textContent).toContain('1 tool call');
		expect(turn.textContent).toContain('3 messages');

		// The meta line lives in the header under the agent name now —
		// outside the reply bubble so it reads as "subtitle of the turn"
		// rather than "first line of the agent's reply".
		const meta = screen.getByTestId('minimal-thread-agent-meta');
		expect(meta).toBeTruthy();
		expect(meta.textContent).toContain('1 tool call');
		expect(meta.textContent).toContain('3 messages');

		// Assert the meta line is NOT inside the agent reply bubble.
		const bubble = screen.getByTestId('minimal-thread-agent-bubble');
		expect(bubble.contains(meta)).toBe(false);
		expect(bubble.textContent).not.toContain('1 tool call');
	});

	it('includes assistant text messages in the active roster alongside tool calls', () => {
		const t = Date.now();
		// Sequence: text → tool → text → tool. All four entries should appear
		// in the roster in order, with kinds tagged on the data attribute.
		const rows = [
			makeRow({
				id: 'a1',
				label: 'Coder Agent',
				createdAt: t,
				message: {
					type: 'assistant',
					uuid: 'a1',
					message: {
						content: [
							{ type: 'text', text: 'Investigating the failing test' },
							{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } },
						],
					},
				},
			}),
			makeRow({
				id: 'a2',
				label: 'Coder Agent',
				createdAt: t + 1000,
				message: {
					type: 'assistant',
					uuid: 'a2',
					message: {
						content: [
							{ type: 'text', text: 'Now editing the broken assertion' },
							{ type: 'tool_use', id: 'tu-2', name: 'Edit', input: { file_path: 'foo.ts' } },
						],
					},
				},
			}),
		];

		render(<MinimalThreadFeed parsedRows={rows} isAgentActive={true} />);

		const entries = screen.getAllByTestId('minimal-thread-roster-entry');
		expect(entries.length).toBe(4);
		expect(entries[0].dataset.rosterKind).toBe('message');
		expect(entries[0].textContent).toContain('Investigating the failing test');
		expect(entries[1].dataset.rosterKind).toBe('tool');
		expect(entries[1].textContent).toContain('Bash');
		expect(entries[2].dataset.rosterKind).toBe('message');
		expect(entries[2].textContent).toContain('Now editing the broken assertion');
		expect(entries[3].dataset.rosterKind).toBe('tool');
		expect(entries[3].textContent).toContain('Edit');
	});

	it('skips empty/whitespace assistant text blocks when building the roster', () => {
		const t = Date.now();
		const rows = [
			makeRow({
				id: 'a1',
				label: 'Coder Agent',
				createdAt: t,
				message: {
					type: 'assistant',
					uuid: 'a1',
					message: {
						content: [
							{ type: 'text', text: '   ' }, // whitespace-only
							{ type: 'text', text: '' }, // empty string
							{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls' } },
						],
					},
				},
			}),
		];

		render(<MinimalThreadFeed parsedRows={rows} isAgentActive={true} />);
		const entries = screen.getAllByTestId('minimal-thread-roster-entry');
		// Only the tool entry survives — the empty/whitespace text blocks
		// are filtered out so they don't pollute the rail.
		expect(entries.length).toBe(1);
		expect(entries[0].dataset.rosterKind).toBe('tool');
	});

	it('caps the active roster at 4 most-recent entries even with mixed kinds', () => {
		const t = Date.now();
		// 6 mixed entries — only the last 4 should render.
		const rows = [
			makeRow({
				id: 'a1',
				label: 'Coder Agent',
				createdAt: t,
				message: {
					type: 'assistant',
					uuid: 'a1',
					message: {
						content: [
							{ type: 'text', text: 'msg-1' },
							{ type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'echo 1' } },
							{ type: 'text', text: 'msg-2' },
							{ type: 'tool_use', id: 'tu-2', name: 'Bash', input: { command: 'echo 2' } },
							{ type: 'text', text: 'msg-3' },
							{ type: 'tool_use', id: 'tu-3', name: 'Bash', input: { command: 'echo 3' } },
						],
					},
				},
			}),
		];

		render(<MinimalThreadFeed parsedRows={rows} isAgentActive={true} />);
		const entries = screen.getAllByTestId('minimal-thread-roster-entry');
		expect(entries.length).toBe(4);
		const allText = entries.map((e) => e.textContent).join('\n');
		// Oldest two trimmed.
		expect(allText).not.toContain('msg-1');
		expect(allText).not.toContain('echo 1');
		// Latest four kept.
		expect(allText).toContain('msg-2');
		expect(allText).toContain('echo 2');
		expect(allText).toContain('msg-3');
		expect(allText).toContain('echo 3');
	});
});
