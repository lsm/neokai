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
		// No result message — block is non-terminal.
		const rows = [
			makeRow({
				id: 'a1',
				label: 'Coder Agent',
				createdAt: t,
				message: assistantToolUse('a1', [{ name: 'Bash', input: { command: 'ls' } }]),
			}),
		];

		render(<MinimalThreadFeed parsedRows={rows} isAgentActive={false} />);
		const turn = screen.getByTestId('minimal-thread-turn');
		expect(turn.dataset.turnState).toBe('completed');
		expect(screen.queryByTestId('minimal-thread-active-rail')).toBeNull();
	});

	it('shows the completed stats line with tool-call and message counts', async () => {
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
	});
});
