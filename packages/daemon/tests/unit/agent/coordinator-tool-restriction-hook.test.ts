/**
 * Coordinator Tool Restriction Hook Tests
 *
 * Tests the PreToolUse/SubagentStart/SubagentStop hook mechanism
 * that enforces coordinator tool restrictions.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { createCoordinatorRestrictionHooks } from '../../../src/lib/agent/coordinator-tool-restriction-hook';
import type {
	PreToolUseHookInput,
	SubagentStartHookInput,
	SubagentStopHookInput,
	HookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import type { CoordinatorRestrictionHooks } from '../../../src/lib/agent/coordinator-tool-restriction-hook';

const mockSignal = new AbortController().signal;

function makePreToolUseInput(toolName: string): PreToolUseHookInput {
	return {
		hook_event_name: 'PreToolUse',
		tool_name: toolName,
		tool_input: {},
		session_id: 'test-session',
		transcript_path: '/test/path',
		cwd: '/test/cwd',
		tool_use_id: `tool-use-${toolName}`,
	};
}

function makeSubagentStartInput(agentType: string, agentId?: string): SubagentStartHookInput {
	return {
		hook_event_name: 'SubagentStart',
		agent_type: agentType,
		agent_id: agentId ?? `agent-${agentType}-${Date.now()}`,
		session_id: 'test-session',
		transcript_path: '/test/path',
		cwd: '/test/cwd',
	};
}

function makeSubagentStopInput(agentId: string): SubagentStopHookInput {
	return {
		hook_event_name: 'SubagentStop',
		agent_id: agentId,
		agent_transcript_path: '/test/transcript',
		stop_hook_active: false,
		session_id: 'test-session',
		transcript_path: '/test/path',
		cwd: '/test/cwd',
	};
}

function isDenied(result: HookJSONOutput): boolean {
	if ('hookSpecificOutput' in result && result.hookSpecificOutput) {
		const output = result.hookSpecificOutput as { permissionDecision?: string };
		return output.permissionDecision === 'deny';
	}
	if ('decision' in result) {
		return result.decision === 'block';
	}
	return false;
}

function isEmpty(result: HookJSONOutput): boolean {
	return Object.keys(result).length === 0;
}

describe('CoordinatorToolRestrictionHook', () => {
	let hooks: CoordinatorRestrictionHooks;

	beforeEach(() => {
		hooks = createCoordinatorRestrictionHooks();
	});

	describe('PreToolUse - coordinator context (no active sub-agents)', () => {
		it('should block Edit when no sub-agents are active', async () => {
			const result = await hooks.preToolUse(makePreToolUseInput('Edit'), 'tool-use-Edit', {
				signal: mockSignal,
			});

			expect(isDenied(result)).toBe(true);
		});

		it('should block Write when no sub-agents are active', async () => {
			const result = await hooks.preToolUse(makePreToolUseInput('Write'), 'tool-use-Write', {
				signal: mockSignal,
			});

			expect(isDenied(result)).toBe(true);
		});

		it('should block Bash when no sub-agents are active', async () => {
			const result = await hooks.preToolUse(makePreToolUseInput('Bash'), 'tool-use-Bash', {
				signal: mockSignal,
			});

			expect(isDenied(result)).toBe(true);
		});

		it('should block NotebookEdit when no sub-agents are active', async () => {
			const result = await hooks.preToolUse(
				makePreToolUseInput('NotebookEdit'),
				'tool-use-NotebookEdit',
				{ signal: mockSignal }
			);

			expect(isDenied(result)).toBe(true);
		});

		it('should block all coordinator disallowed tools (mutation tools)', async () => {
			const disallowedTools = ['Edit', 'Write', 'Bash', 'NotebookEdit'];

			for (const tool of disallowedTools) {
				const result = await hooks.preToolUse(makePreToolUseInput(tool), `tool-use-${tool}`, {
					signal: mockSignal,
				});

				expect(isDenied(result)).toBe(true);
			}
		});

		it('should allow read-only tools (Read, Grep, Glob)', async () => {
			for (const tool of ['Read', 'Grep', 'Glob']) {
				const result = await hooks.preToolUse(makePreToolUseInput(tool), `tool-use-${tool}`, {
					signal: mockSignal,
				});

				expect(isEmpty(result)).toBe(true);
			}
		});

		it('should allow Task tool (coordinator orchestration)', async () => {
			const result = await hooks.preToolUse(makePreToolUseInput('Task'), 'tool-use-Task', {
				signal: mockSignal,
			});

			expect(isEmpty(result)).toBe(true);
		});

		it('should allow TodoWrite tool (coordinator orchestration)', async () => {
			const result = await hooks.preToolUse(
				makePreToolUseInput('TodoWrite'),
				'tool-use-TodoWrite',
				{ signal: mockSignal }
			);

			expect(isEmpty(result)).toBe(true);
		});

		it('should allow AskUserQuestion tool', async () => {
			const result = await hooks.preToolUse(
				makePreToolUseInput('AskUserQuestion'),
				'tool-use-AskUserQuestion',
				{ signal: mockSignal }
			);

			expect(isEmpty(result)).toBe(true);
		});

		it('should allow TaskOutput tool', async () => {
			const result = await hooks.preToolUse(
				makePreToolUseInput('TaskOutput'),
				'tool-use-TaskOutput',
				{ signal: mockSignal }
			);

			expect(isEmpty(result)).toBe(true);
		});

		it('should include deny reason with tool name', async () => {
			const result = await hooks.preToolUse(makePreToolUseInput('Edit'), 'tool-use-Edit', {
				signal: mockSignal,
			});

			const output = result as {
				decision: string;
				reason: string;
				hookSpecificOutput: {
					hookEventName: string;
					permissionDecision: string;
					permissionDecisionReason: string;
				};
			};
			// Top-level decision
			expect(output.decision).toBe('block');
			expect(output.reason).toContain('Edit');
			expect(output.reason).toContain('Task');
			// hookSpecificOutput for SDK Tl4 processing
			expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
			expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
			expect(output.hookSpecificOutput.permissionDecisionReason).toContain('Edit');
		});
	});

	describe('PreToolUse - sub-agent context (active sub-agents)', () => {
		it('should allow Edit when a sub-agent is active', async () => {
			// Start a sub-agent
			await hooks.subagentStart(makeSubagentStartInput('Coder', 'coder-1'), undefined, {
				signal: mockSignal,
			});

			const result = await hooks.preToolUse(makePreToolUseInput('Edit'), 'tool-use-Edit', {
				signal: mockSignal,
			});

			expect(isEmpty(result)).toBe(true);
		});

		it('should allow all mutation tools when sub-agents are active', async () => {
			await hooks.subagentStart(makeSubagentStartInput('Coder', 'coder-1'), undefined, {
				signal: mockSignal,
			});

			const tools = ['Edit', 'Write', 'Bash', 'NotebookEdit', 'Read', 'Grep', 'Glob'];
			for (const tool of tools) {
				const result = await hooks.preToolUse(makePreToolUseInput(tool), `tool-use-${tool}`, {
					signal: mockSignal,
				});

				expect(isEmpty(result)).toBe(true);
			}
		});

		it('should block mutation tools again after sub-agent stops', async () => {
			// Start and stop a sub-agent
			await hooks.subagentStart(makeSubagentStartInput('Coder', 'coder-1'), undefined, {
				signal: mockSignal,
			});
			await hooks.subagentStop(makeSubagentStopInput('coder-1'), undefined, { signal: mockSignal });

			const result = await hooks.preToolUse(makePreToolUseInput('Edit'), 'tool-use-Edit', {
				signal: mockSignal,
			});

			expect(isDenied(result)).toBe(true);
		});
	});

	describe('SubagentStart/SubagentStop lifecycle', () => {
		it('should track multiple concurrent sub-agents', async () => {
			// Start two sub-agents
			await hooks.subagentStart(makeSubagentStartInput('Coder', 'coder-1'), undefined, {
				signal: mockSignal,
			});
			await hooks.subagentStart(makeSubagentStartInput('Tester', 'tester-1'), undefined, {
				signal: mockSignal,
			});

			// Mutation tools allowed (2 active)
			let result = await hooks.preToolUse(makePreToolUseInput('Edit'), 'tool-use-Edit', {
				signal: mockSignal,
			});
			expect(isEmpty(result)).toBe(true);

			// Stop first sub-agent
			await hooks.subagentStop(makeSubagentStopInput('coder-1'), undefined, { signal: mockSignal });

			// Mutation tools still allowed (1 active)
			result = await hooks.preToolUse(makePreToolUseInput('Edit'), 'tool-use-Edit', {
				signal: mockSignal,
			});
			expect(isEmpty(result)).toBe(true);

			// Stop second sub-agent
			await hooks.subagentStop(makeSubagentStopInput('tester-1'), undefined, {
				signal: mockSignal,
			});

			// Mutation tools blocked again (0 active)
			result = await hooks.preToolUse(makePreToolUseInput('Edit'), 'tool-use-Edit', {
				signal: mockSignal,
			});
			expect(isDenied(result)).toBe(true);
		});

		it('should not go below zero on extra stops', async () => {
			// Stop without start — should not go negative
			await hooks.subagentStop(makeSubagentStopInput('phantom-1'), undefined, {
				signal: mockSignal,
			});

			// Should still block (count clamped at 0)
			const result = await hooks.preToolUse(makePreToolUseInput('Edit'), 'tool-use-Edit', {
				signal: mockSignal,
			});

			expect(isDenied(result)).toBe(true);
		});

		it('should return empty for SubagentStart hooks', async () => {
			const result = await hooks.subagentStart(
				makeSubagentStartInput('Coder', 'coder-1'),
				undefined,
				{ signal: mockSignal }
			);

			expect(isEmpty(result)).toBe(true);
		});

		it('should return empty for SubagentStop hooks', async () => {
			const result = await hooks.subagentStop(makeSubagentStopInput('coder-1'), undefined, {
				signal: mockSignal,
			});

			expect(isEmpty(result)).toBe(true);
		});
	});

	describe('Hook event filtering', () => {
		it('preToolUse should ignore non-PreToolUse events', async () => {
			const input = {
				hook_event_name: 'PostToolUse',
				tool_name: 'Read',
				tool_input: {},
				session_id: 'test-session',
				transcript_path: '/test/path',
				cwd: '/test/cwd',
				tool_use_id: 'test-id',
				tool_response: 'response',
			};

			const result = await hooks.preToolUse(input as unknown as PreToolUseHookInput, 'test-id', {
				signal: mockSignal,
			});

			expect(isEmpty(result)).toBe(true);
		});

		it('subagentStart should ignore non-SubagentStart events', async () => {
			const input = {
				hook_event_name: 'PreToolUse',
				tool_name: 'Edit',
				tool_input: {},
				session_id: 'test-session',
				transcript_path: '/test/path',
				cwd: '/test/cwd',
				tool_use_id: 'test-id',
			};

			const result = await hooks.subagentStart(
				input as unknown as SubagentStartHookInput,
				'test-id',
				{ signal: mockSignal }
			);

			expect(isEmpty(result)).toBe(true);

			// Counter should not have incremented — Edit should still be blocked
			const preResult = await hooks.preToolUse(makePreToolUseInput('Edit'), 'tool-use-Edit', {
				signal: mockSignal,
			});
			expect(isDenied(preResult)).toBe(true);
		});

		it('subagentStop should ignore non-SubagentStop events', async () => {
			// Start a sub-agent first
			await hooks.subagentStart(makeSubagentStartInput('Coder', 'coder-1'), undefined, {
				signal: mockSignal,
			});

			// Send wrong event type to subagentStop
			const input = {
				hook_event_name: 'PreToolUse',
				tool_name: 'Edit',
				tool_input: {},
				session_id: 'test-session',
				transcript_path: '/test/path',
				cwd: '/test/cwd',
				tool_use_id: 'test-id',
			};

			await hooks.subagentStop(input as unknown as SubagentStopHookInput, 'test-id', {
				signal: mockSignal,
			});

			// Counter should NOT have decremented — Edit should still be allowed
			const preResult = await hooks.preToolUse(makePreToolUseInput('Edit'), 'tool-use-Edit', {
				signal: mockSignal,
			});
			expect(isEmpty(preResult)).toBe(true);
		});
	});

	describe('Isolation between hook instances', () => {
		it('separate createCoordinatorRestrictionHooks calls have independent state', async () => {
			const hooks2 = createCoordinatorRestrictionHooks();

			// Start sub-agent on first instance
			await hooks.subagentStart(makeSubagentStartInput('Coder', 'coder-1'), undefined, {
				signal: mockSignal,
			});

			// First instance allows Edit (sub-agent active)
			let result = await hooks.preToolUse(makePreToolUseInput('Edit'), 'tool-use-Edit', {
				signal: mockSignal,
			});
			expect(isEmpty(result)).toBe(true);

			// Second instance blocks Edit (no sub-agents in its scope)
			result = await hooks2.preToolUse(makePreToolUseInput('Edit'), 'tool-use-Edit', {
				signal: mockSignal,
			});
			expect(isDenied(result)).toBe(true);
		});
	});
});
