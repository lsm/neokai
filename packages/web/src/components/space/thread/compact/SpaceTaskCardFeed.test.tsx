// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import type { ParsedThreadRow } from '../space-task-thread-events';
import { SpaceTaskCardFeed } from './SpaceTaskCardFeed';

const { mockSpaceOverlaySessionIdSignal, mockSpaceOverlayAgentNameSignal } = vi.hoisted(() => ({
	mockSpaceOverlaySessionIdSignal: { value: null as string | null },
	mockSpaceOverlayAgentNameSignal: { value: null as string | null },
}));

vi.mock('../../../../lib/signals', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		get spaceOverlaySessionIdSignal() {
			return mockSpaceOverlaySessionIdSignal;
		},
		get spaceOverlayAgentNameSignal() {
			return mockSpaceOverlayAgentNameSignal;
		},
	};
});

vi.mock('../../../sdk/SDKMessageRenderer', () => ({
	SDKMessageRenderer: ({
		message,
		taskContext,
		showSubagentMessages,
		showToolResultUserMessages,
		flattenSubagentTools,
		isRunning,
	}: {
		message: any;
		taskContext?: boolean;
		showSubagentMessages?: boolean;
		showToolResultUserMessages?: boolean;
		flattenSubagentTools?: boolean;
		isRunning?: boolean;
	}) => {
		const content = message?.message?.content;
		let text = message?.type ?? '';
		if (typeof content === 'string') text = content;
		if (Array.isArray(content)) {
			text =
				content
					.filter((b: any) => b?.type === 'text' && typeof b?.text === 'string')
					.map((b: any) => b.text)
					.join(' ')
					.trim() || text;
		}
		return (
			<div
				data-testid="sdk-message-renderer"
				data-task-context={taskContext ? '1' : '0'}
				data-show-subagents={showSubagentMessages ? '1' : '0'}
				data-show-tool-result-users={showToolResultUserMessages ? '1' : '0'}
				data-flatten-subagent-tools={flattenSubagentTools ? '1' : '0'}
				data-running={isRunning ? '1' : '0'}
			>
				{text}
			</div>
		);
	},
}));

const fakeMaps = {
	toolResultsMap: new Map(),
	toolInputsMap: new Map(),
	subagentMessagesMap: new Map(),
	sessionInfoMap: new Map(),
} as const;

function defaultSessionIdForLabel(label: string): string {
	return `sess-${label.trim().toLowerCase().replace(/\s+/g, '-')}`;
}

function makeAssistantTextRow(
	id: string,
	label: string,
	text: string,
	sessionId = defaultSessionIdForLabel(label),
	parentToolUseId?: string
): ParsedThreadRow {
	return {
		id,
		sessionId,
		label,
		taskId: 'task-1',
		taskTitle: 'Task One',
		createdAt: Number(id.replace(/\D/g, '') || 0),
		turnIndex: undefined,
		turnHiddenMessageCount: undefined,
		message: {
			type: 'assistant',
			uuid: id,
			parent_tool_use_id: parentToolUseId ?? null,
			message: { content: [{ type: 'text', text }] },
		} as any,
		fallbackText: null,
	};
}

function makeToolUseRow(
	id: string,
	label: string,
	toolName = 'Bash',
	sessionId = defaultSessionIdForLabel(label)
): ParsedThreadRow {
	return {
		id,
		sessionId,
		label,
		taskId: 'task-1',
		taskTitle: 'Task One',
		createdAt: Number(id.replace(/\D/g, '') || 0),
		turnIndex: undefined,
		turnHiddenMessageCount: undefined,
		message: {
			type: 'assistant',
			uuid: id,
			message: { content: [{ type: 'tool_use', id: `tu-${id}`, name: toolName, input: {} }] },
		} as any,
		fallbackText: null,
	};
}

function makeUserRow(
	id: string,
	label: string,
	text: string,
	sessionId = defaultSessionIdForLabel(label),
	isSynthetic = false
): ParsedThreadRow {
	return {
		id,
		sessionId,
		label,
		taskId: 'task-1',
		taskTitle: 'Task One',
		createdAt: Number(id.replace(/\D/g, '') || 0),
		turnIndex: undefined,
		turnHiddenMessageCount: undefined,
		message: {
			type: 'user',
			uuid: id,
			isSynthetic,
			message: { content: text },
		} as any,
		fallbackText: null,
	};
}

function makeResultRow(
	id: string,
	label: string,
	subtype: 'success' | 'error_during_execution' = 'success',
	sessionId = defaultSessionIdForLabel(label),
	parentToolUseId?: string
): ParsedThreadRow {
	return {
		id,
		sessionId,
		label,
		taskId: 'task-1',
		taskTitle: 'Task One',
		createdAt: Number(id.replace(/\D/g, '') || 0),
		turnIndex: undefined,
		turnHiddenMessageCount: undefined,
		message: {
			type: 'result',
			uuid: id,
			subtype,
			parent_tool_use_id: parentToolUseId ?? null,
		} as any,
		fallbackText: null,
	};
}

describe('SpaceTaskCardFeed', () => {
	beforeEach(() => {
		cleanup();
		mockSpaceOverlaySessionIdSignal.value = null;
		mockSpaceOverlayAgentNameSignal.value = null;
	});
	afterEach(() => cleanup());

	it('renders all compact rows while preserving agent-turn block grouping', () => {
		const rows = [
			makeUserRow('u1', 'Task Agent', 'Initial ask'),
			makeAssistantTextRow('a1', 'Task Agent', 'msg-1'),
			makeAssistantTextRow('a2', 'Coder Agent', 'msg-2'),
			makeAssistantTextRow('a3', 'Reviewer Agent', 'msg-3'),
			makeAssistantTextRow('a4', 'Task Agent', 'msg-4'),
			makeAssistantTextRow('a5', 'Task Agent', 'msg-5'),
			makeAssistantTextRow('a6', 'Task Agent', 'msg-6'),
		];
		const { container } = render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const rendered = Array.from(
			container.querySelectorAll('[data-testid="sdk-message-renderer"]')
		).map((el) => el.textContent);
		expect(rendered).toEqual(['Initial ask', 'msg-1', 'msg-4', 'msg-5', 'msg-6', 'msg-2', 'msg-3']);
		expect(screen.queryByTestId('compact-flat-hidden-divider')).toBeNull();
	});

	it('groups interleaved messages by agent/session turn and orders by turn start', () => {
		const rows = [
			{ ...makeUserRow('u1', 'Coder Agent', 'coder-init', 'sess-coder'), turnIndex: 1 },
			{ ...makeUserRow('u2', 'Reviewer Agent', 'review-init', 'sess-reviewer'), turnIndex: 1 },
			{
				...makeAssistantTextRow('a1', 'Coder Agent', 'coder-progress', 'sess-coder'),
				turnIndex: 1,
			},
			{
				...makeAssistantTextRow('a2', 'Reviewer Agent', 'review-progress', 'sess-reviewer'),
				turnIndex: 1,
			},
			{ ...makeResultRow('r1', 'Coder Agent', 'success', 'sess-coder'), turnIndex: 1 },
			{
				...makeAssistantTextRow('a3', 'Reviewer Agent', 'review-tail', 'sess-reviewer'),
				turnIndex: 1,
			},
		];
		render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const turnGroups = screen.getAllByTestId('compact-turn-group');
		expect(turnGroups.length).toBe(2);
		expect(screen.queryByTestId('compact-turn-divider')).toBeNull();
		const turn1Msgs = within(turnGroups[0]).getAllByTestId('sdk-message-renderer');
		expect(turn1Msgs.map((el) => el.textContent)).toEqual([
			'coder-init',
			'coder-progress',
			'result',
		]);
		const turn2Msgs = within(turnGroups[1]).getAllByTestId('sdk-message-renderer');
		expect(turn2Msgs.map((el) => el.textContent)).toEqual([
			'review-init',
			'review-progress',
			'review-tail',
		]);
	});

	it('renders agent headers and color siderails within turns', () => {
		const rows = [
			makeUserRow('u1', 'Task Agent', 'Prompt'),
			makeAssistantTextRow('a1', 'Task Agent', 'task-msg-1', 'sess-task'),
			makeAssistantTextRow('a2', 'Task Agent', 'task-msg-2', 'sess-task'),
			makeAssistantTextRow('a3', 'Coder Agent', 'coder-msg', 'sess-coder'),
		];
		const { container } = render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const headers = container.querySelectorAll('[data-testid="compact-block-header"]');
		expect(headers.length).toBe(3);
		expect(container.textContent).toContain('TASK');
		expect(container.textContent).toContain('CODER');
		expect(container.textContent).not.toContain('Agent Turn');

		const brackets = container.querySelectorAll('[data-testid="compact-block-bracket"]');
		expect(brackets.length).toBe(3);
		brackets.forEach((el) => {
			expect((el as HTMLElement).style.borderColor).not.toBe('');
		});
	});

	it('clicking agent header opens the slide-out session for that block', () => {
		const rows = [
			makeUserRow('u1', 'Task Agent', 'Prompt'),
			makeAssistantTextRow('a1', 'Task Agent', 'task-msg', 'sess-task'),
			makeAssistantTextRow('a2', 'Coder Agent', 'coder-msg', 'sess-coder'),
		];
		render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const headers = screen.getAllByTestId('compact-block-header');
		fireEvent.click(headers[2]); // coder block header
		expect(mockSpaceOverlaySessionIdSignal.value).toBe('sess-coder');
		expect(mockSpaceOverlayAgentNameSignal.value).toBe('Coder Agent');
	});

	it('marks the last row as running only when active and the tail row is tool_use', () => {
		const rows = [
			makeUserRow('u1', 'Task Agent', 'Prompt'),
			makeAssistantTextRow('a1', 'Task Agent', 'plain'),
			makeToolUseRow('a2', 'Task Agent', 'Read', 'sess-task'),
		];
		const { container } = render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={true}
			/>
		);

		const wrapper = screen.getByTestId('compact-running-block');
		expect(wrapper).toBeTruthy();
		const runningRendered = wrapper.querySelector('[data-testid="sdk-message-renderer"]');
		expect(runningRendered?.getAttribute('data-running')).toBe('1');

		const allRendered = container.querySelectorAll('[data-testid="sdk-message-renderer"]');
		expect(
			Array.from(allRendered).filter((el) => el.getAttribute('data-running') === '1').length
		).toBe(1);
	});

	it('keeps default subagent rendering flags (no forced flatten)', () => {
		const rows = [makeAssistantTextRow('a1', 'Task Agent', 'hello')];
		const { container } = render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const rendered = container.querySelector('[data-testid="sdk-message-renderer"]') as HTMLElement;
		expect(rendered.getAttribute('data-task-context')).toBe('1');
		expect(rendered.getAttribute('data-show-subagents')).toBe('1');
		expect(rendered.getAttribute('data-show-tool-result-users')).toBe('0');
		expect(rendered.getAttribute('data-flatten-subagent-tools')).toBe('0');
	});

	it('renders turn-level earlier divider after initial user message', () => {
		const rows = [
			{
				...makeUserRow('u1', 'Task Agent', 'Initial ask', 'sess-task', true),
				turnIndex: 2,
				turnHiddenMessageCount: 4,
			},
			{
				...makeAssistantTextRow('a1', 'Task Agent', 'msg-1', 'sess-task'),
				turnIndex: 2,
				turnHiddenMessageCount: 4,
			},
			{
				...makeAssistantTextRow('a2', 'Task Agent', 'msg-2', 'sess-task'),
				turnIndex: 2,
				turnHiddenMessageCount: 4,
			},
			{
				...makeResultRow('r1', 'Task Agent', 'success', 'sess-task'),
				turnIndex: 2,
				turnHiddenMessageCount: 4,
			},
		];
		render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const divider = screen.getByTestId('compact-turn-hidden-divider');
		expect(divider.textContent).toContain('4 earlier messages');
		const initialUser = screen.getByText('Initial ask');
		expect(
			initialUser.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});

	it('clicking the earlier-messages pill opens the agent slide-out chat', () => {
		const rows = [
			{
				...makeUserRow('u1', 'Coder Agent', 'Initial ask', 'sess-coder', true),
				turnIndex: 2,
				turnHiddenMessageCount: 3,
			},
			{
				...makeAssistantTextRow('a1', 'Coder Agent', 'msg-1', 'sess-coder'),
				turnIndex: 2,
				turnHiddenMessageCount: 3,
			},
		];
		render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const pill = screen.getByTestId('compact-turn-hidden-divider-button');
		expect(pill.textContent).toContain('3 earlier messages');
		expect(pill.textContent?.toLowerCase()).toContain('open chat');
		fireEvent.click(pill);
		expect(mockSpaceOverlaySessionIdSignal.value).toBe('sess-coder');
		expect(mockSpaceOverlayAgentNameSignal.value).toBe('Coder Agent');
	});

	/**
	 * Regression guard: the agent pill should have consistent breathing room
	 * above the first body row regardless of which SDK block type is first
	 * (system:init, text, thinking, tool_use). Previously `pt-0.5` on the
	 * body wrapper left the `Session Started` card butted up against the
	 * agent header pill.
	 */
	describe('agent header spacing (first block type parity)', () => {
		const firstBlockScenarios: Array<{
			name: string;
			build: () => ParsedThreadRow[];
		}> = [
			{
				name: 'system:init first',
				build: () => [
					{
						id: '1',
						sessionId: 'sess-coder',
						label: 'Coder Agent',
						taskId: 'task-1',
						taskTitle: 'Task One',
						createdAt: 1,
						turnIndex: undefined,
						turnHiddenMessageCount: undefined,
						message: {
							type: 'system',
							subtype: 'init',
							model: 'sonnet-4-5',
							permissionMode: 'default',
							tools: ['Read', 'Write'],
							mcp_servers: [],
						} as any,
						fallbackText: null,
					},
				],
			},
			{
				name: 'text first',
				build: () => [makeAssistantTextRow('1', 'Coder Agent', 'hello world')],
			},
			{
				name: 'tool_use first',
				build: () => [makeToolUseRow('1', 'Coder Agent', 'Read')],
			},
			{
				name: 'user message first',
				build: () => [makeUserRow('1', 'Coder Agent', 'Start coding please')],
			},
		];

		for (const scenario of firstBlockScenarios) {
			it(`applies consistent body top-padding when ${scenario.name}`, () => {
				const { container } = render(
					<SpaceTaskCardFeed
						parsedRows={scenario.build()}
						taskId="task-1"
						maps={fakeMaps as any}
						isAgentActive={false}
					/>
				);
				const body = container.querySelector('[data-testid="compact-block-body"]') as HTMLElement;
				expect(body).toBeTruthy();
				// The body wrapper must apply a non-minimal top padding so the
				// first block does not butt against the agent header pill.
				// We check the class list rather than the computed style
				// because jsdom doesn't resolve Tailwind utility classes.
				expect(body.className).toContain('pt-2');
				expect(body.className).not.toContain('pt-0.5');
			});
		}
	});

	it('renders subagent result/error rows (no filtering)', () => {
		const rows = [
			makeToolUseRow('a1', 'Task Agent', 'Task', 'sess-task'),
			makeAssistantTextRow('a2', 'Coder Agent', 'child step', 'sess-coder', 'tu-a1'),
			makeResultRow('r1', 'Coder Agent', 'error_during_execution', 'sess-coder', 'tu-a1'),
		];
		const { container } = render(
			<SpaceTaskCardFeed
				parsedRows={rows}
				taskId="task-1"
				maps={fakeMaps as any}
				isAgentActive={false}
			/>
		);

		const rendered = Array.from(
			container.querySelectorAll('[data-testid="sdk-message-renderer"]')
		).map((el) => el.textContent);
		expect(rendered).toEqual(['assistant', 'child step', 'result']);
	});
});
