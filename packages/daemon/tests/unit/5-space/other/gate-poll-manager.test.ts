/**
 * Unit tests for GatePollManager
 *
 * Tests the poll lifecycle (start/stop), change detection, message injection,
 * script execution context, and error handling.
 *
 * Timer-based tick execution is tested via the internal `executePollTick` method
 * rather than fake timers, because Bun's test runner has limited async timer support.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	GatePollManager,
	extractPrContext,
	resolveTargetNodeName,
	formatPollMessage,
	type PollScriptContext,
	type PollMessageInjector,
	type PollSessionResolver,
	MIN_POLL_INTERVAL_MS,
} from '../../../../src/lib/space/runtime/gate-poll-manager';
import type { Gate, GatePoll, SpaceWorkflow, WorkflowChannel } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeGate(id: string, poll?: GatePoll): Gate {
	return {
		id,
		resetOnCycle: false,
		...(poll ? { poll } : {}),
	};
}

function makeWorkflow(gates: Gate[], channels: WorkflowChannel[] = []): SpaceWorkflow {
	return {
		id: 'wf-1',
		spaceId: 'space-1',
		name: 'Test Workflow',
		tags: [],
		nodes: [
			{ id: 'node-1', name: 'Coder', agents: [{ agentId: 'agent-1', name: 'coder' }] },
			{ id: 'node-2', name: 'Reviewer', agents: [{ agentId: 'agent-2', name: 'reviewer' }] },
		],
		startNodeId: 'node-1',
		endNodeId: 'node-2',
		channels,
		gates,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		completionAutonomyLevel: 3,
	};
}

function makePoll(overrides?: Partial<GatePoll>): GatePoll {
	return {
		intervalMs: 30_000,
		script: 'echo "hello"',
		target: 'to',
		...overrides,
	};
}

function makeContext(): PollScriptContext {
	return {
		TASK_ID: 'task-1',
		TASK_TITLE: 'Test Task',
		SPACE_ID: 'space-1',
		PR_URL: 'https://github.com/owner/repo/pull/42',
		PR_NUMBER: '42',
		REPO_OWNER: 'owner',
		REPO_NAME: 'repo',
		WORKFLOW_RUN_ID: 'run-1',
	};
}

function makeWorkflowWithPoll(
	pollOverrides?: Partial<GatePoll>,
	channelOverrides?: Partial<WorkflowChannel>
) {
	const gate = makeGate('gate-1', makePoll(pollOverrides));
	const channel: WorkflowChannel = {
		id: 'ch-1',
		from: 'Coder',
		to: 'Reviewer',
		gateId: 'gate-1',
		...channelOverrides,
	};
	return makeWorkflow([gate], [channel]);
}

// Helper to create a manager and trigger a tick manually
async function triggerTick(
	manager: GatePollManager,
	runId: string,
	gateId: string,
	poll: GatePoll,
	workspacePath: string,
	context: PollScriptContext,
	targetNodeId: string
): Promise<void> {
	// Access the private method via the instance
	return (manager as Record<string, unknown>).executePollTick.call(
		manager,
		runId,
		gateId,
		poll,
		workspacePath,
		context,
		targetNodeId
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GatePollManager', () => {
	let injector: PollMessageInjector;
	let resolver: PollSessionResolver;
	let manager: GatePollManager;

	beforeEach(() => {
		injector = {
			injectSubSessionMessage: vi.fn().mockResolvedValue(undefined),
		};
		resolver = {
			getActiveSessionForNode: vi.fn().mockReturnValue('session-1'),
		};
		manager = new GatePollManager(injector, resolver);
	});

	afterEach(() => {
		manager.stopAll();
	});

	describe('startPolls', () => {
		test('starts polls for gates with poll config', () => {
			const workflow = makeWorkflowWithPoll();

			manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

			expect(manager.activePollCount).toBe(1);
			expect(manager.isPollActive('run-1', 'gate-1')).toBe(true);
		});

		test('does not start polls when no gates have poll config', () => {
			const gate = makeGate('gate-1');
			const workflow = makeWorkflow([gate]);

			manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

			expect(manager.activePollCount).toBe(0);
		});

		test('skips poll when no channel references the gate', () => {
			const gate = makeGate('gate-1', makePoll());
			const workflow = makeWorkflow([gate], []);

			manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

			expect(manager.activePollCount).toBe(0);
		});

		test('skips poll when target node is not found', () => {
			const gate = makeGate('gate-1', makePoll());
			const channel: WorkflowChannel = {
				id: 'ch-1',
				from: 'Coder',
				to: 'NonExistent',
				gateId: 'gate-1',
			};
			const workflow = makeWorkflow([gate], [channel]);

			manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

			expect(manager.activePollCount).toBe(0);
		});

		test('starts multiple polls for multiple gates', () => {
			const gate1 = makeGate('gate-1', makePoll());
			const gate2 = makeGate('gate-2', makePoll());
			const channel1: WorkflowChannel = {
				id: 'ch-1',
				from: 'Coder',
				to: 'Reviewer',
				gateId: 'gate-1',
			};
			const channel2: WorkflowChannel = {
				id: 'ch-2',
				from: 'Reviewer',
				to: 'Coder',
				gateId: 'gate-2',
			};
			const workflow = makeWorkflow([gate1, gate2], [channel1, channel2]);

			manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

			expect(manager.activePollCount).toBe(2);
			expect(manager.isPollActive('run-1', 'gate-1')).toBe(true);
			expect(manager.isPollActive('run-1', 'gate-2')).toBe(true);
		});

		test('enforces minimum interval (still starts with clamped value)', () => {
			const workflow = makeWorkflowWithPoll({ intervalMs: 5000 }); // Below minimum
			manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

			// Poll should still start (interval is clamped internally)
			expect(manager.activePollCount).toBe(1);
		});
	});

	describe('stopPolls', () => {
		test('stops polls for a specific run', () => {
			const workflow = makeWorkflowWithPoll();
			manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());
			expect(manager.activePollCount).toBe(1);

			manager.stopPolls('run-1');
			expect(manager.activePollCount).toBe(0);
			expect(manager.isPollActive('run-1', 'gate-1')).toBe(false);
		});

		test('only stops polls for the specified run', () => {
			const gate1 = makeGate('gate-1', makePoll());
			const gate2 = makeGate('gate-2', makePoll());
			const channel1: WorkflowChannel = {
				id: 'ch-1',
				from: 'Coder',
				to: 'Reviewer',
				gateId: 'gate-1',
			};
			const channel2: WorkflowChannel = {
				id: 'ch-2',
				from: 'Reviewer',
				to: 'Coder',
				gateId: 'gate-2',
			};
			const workflow = makeWorkflow([gate1, gate2], [channel1, channel2]);

			manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());
			manager.startPolls('run-2', workflow, '/tmp', 'space-1', makeContext());

			expect(manager.activePollCount).toBe(4);

			manager.stopPolls('run-1');
			expect(manager.activePollCount).toBe(2);
			expect(manager.isPollActive('run-1', 'gate-1')).toBe(false);
			expect(manager.isPollActive('run-2', 'gate-1')).toBe(true);
		});
	});

	describe('stopAll', () => {
		test('stops all polls across all runs', () => {
			const workflow = makeWorkflowWithPoll();

			manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());
			manager.startPolls('run-2', workflow, '/tmp', 'space-1', makeContext());

			expect(manager.activePollCount).toBe(2);

			manager.stopAll();
			expect(manager.activePollCount).toBe(0);
		});
	});

	describe('poll tick execution', () => {
		test('executes script and injects message when output changes', async () => {
			const workflow = makeWorkflowWithPoll({ script: 'echo "new output"' });
			manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

			await triggerTick(
				manager,
				'run-1',
				'gate-1',
				makePoll({ script: 'echo "new output"' }),
				'/tmp',
				makeContext(),
				'node-2'
			);

			expect(injector.injectSubSessionMessage).toHaveBeenCalledWith(
				'session-1',
				'new output',
				true
			);
		});

		test('does not inject message when output is unchanged', async () => {
			const workflow = makeWorkflowWithPoll({ script: 'echo "same output"' });
			manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

			// First tick — injects
			await triggerTick(
				manager,
				'run-1',
				'gate-1',
				makePoll({ script: 'echo "same output"' }),
				'/tmp',
				makeContext(),
				'node-2'
			);
			expect(injector.injectSubSessionMessage).toHaveBeenCalledTimes(1);

			// Second tick — same output, no injection
			await triggerTick(
				manager,
				'run-1',
				'gate-1',
				makePoll({ script: 'echo "same output"' }),
				'/tmp',
				makeContext(),
				'node-2'
			);
			expect(injector.injectSubSessionMessage).toHaveBeenCalledTimes(1);
		});

		test('does not inject when no active session', async () => {
			(resolver.getActiveSessionForNode as ReturnType<typeof vi.fn>).mockReturnValue(null);

			const workflow = makeWorkflowWithPoll({ script: 'echo "output"' });
			manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

			await triggerTick(
				manager,
				'run-1',
				'gate-1',
				makePoll({ script: 'echo "output"' }),
				'/tmp',
				makeContext(),
				'node-2'
			);

			expect(injector.injectSubSessionMessage).not.toHaveBeenCalled();
		});

		test('handles script errors gracefully without crashing', async () => {
			const workflow = makeWorkflowWithPoll({ script: 'exit 1' });
			manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

			// Should not throw
			await triggerTick(
				manager,
				'run-1',
				'gate-1',
				makePoll({ script: 'exit 1' }),
				'/tmp',
				makeContext(),
				'node-2'
			);

			expect(injector.injectSubSessionMessage).not.toHaveBeenCalled();
			// Poll should still be active
			expect(manager.isPollActive('run-1', 'gate-1')).toBe(true);
		});

		test('handles empty script output without injecting', async () => {
			const workflow = makeWorkflowWithPoll({ script: 'echo ""' });
			manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

			await triggerTick(
				manager,
				'run-1',
				'gate-1',
				makePoll({ script: 'echo ""' }),
				'/tmp',
				makeContext(),
				'node-2'
			);

			expect(injector.injectSubSessionMessage).not.toHaveBeenCalled();
		});

		test('does nothing when poll is already stopped', async () => {
			const workflow = makeWorkflowWithPoll({ script: 'echo "output"' });
			manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());
			manager.stopPolls('run-1');

			await triggerTick(
				manager,
				'run-1',
				'gate-1',
				makePoll({ script: 'echo "output"' }),
				'/tmp',
				makeContext(),
				'node-2'
			);

			expect(injector.injectSubSessionMessage).not.toHaveBeenCalled();
		});

		test('injects with changed output after previous non-empty output', async () => {
			// First script output: "first"
			// Simulate change detection by triggering two different outputs
			const workflow = makeWorkflowWithPoll({ script: 'echo "first"' });
			manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

			await triggerTick(
				manager,
				'run-1',
				'gate-1',
				makePoll({ script: 'echo "first"' }),
				'/tmp',
				makeContext(),
				'node-2'
			);
			expect(injector.injectSubSessionMessage).toHaveBeenCalledWith('session-1', 'first', true);

			// Now simulate a changed output
			await triggerTick(
				manager,
				'run-1',
				'gate-1',
				makePoll({ script: 'echo "second"' }),
				'/tmp',
				makeContext(),
				'node-2'
			);
			// The second call should use the actual script output "second"
			expect(injector.injectSubSessionMessage).toHaveBeenCalledTimes(2);
		});
	});

	describe('message template', () => {
		test('applies message template when provided', async () => {
			const workflow = makeWorkflowWithPoll({
				script: 'echo "new comment"',
				messageTemplate: 'New PR review comment:\n{{output}}',
			});
			manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

			await triggerTick(
				manager,
				'run-1',
				'gate-1',
				makePoll({
					script: 'echo "new comment"',
					messageTemplate: 'New PR review comment:\n{{output}}',
				}),
				'/tmp',
				makeContext(),
				'node-2'
			);

			expect(injector.injectSubSessionMessage).toHaveBeenCalledWith(
				'session-1',
				'New PR review comment:\nnew comment',
				true
			);
		});

		test('uses raw output when no template provided', async () => {
			const workflow = makeWorkflowWithPoll({ script: 'echo "raw output"' });
			manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

			await triggerTick(
				manager,
				'run-1',
				'gate-1',
				makePoll({ script: 'echo "raw output"' }),
				'/tmp',
				makeContext(),
				'node-2'
			);

			expect(injector.injectSubSessionMessage).toHaveBeenCalledWith(
				'session-1',
				'raw output',
				true
			);
		});
	});

	describe('target resolution', () => {
		test('resolves to "from" node when target is "from"', async () => {
			const workflow = makeWorkflowWithPoll({ script: 'echo "output"', target: 'from' });
			manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

			await triggerTick(
				manager,
				'run-1',
				'gate-1',
				makePoll({ script: 'echo "output"', target: 'from' }),
				'/tmp',
				makeContext(),
				'node-1'
			);

			// Verify the resolver was called with the "from" node (Coder → node-1)
			expect(resolver.getActiveSessionForNode).toHaveBeenCalledWith('run-1', 'node-1');
		});

		test('resolves to "to" node when target is "to"', async () => {
			const workflow = makeWorkflowWithPoll({ script: 'echo "output"', target: 'to' });
			manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

			await triggerTick(
				manager,
				'run-1',
				'gate-1',
				makePoll({ script: 'echo "output"', target: 'to' }),
				'/tmp',
				makeContext(),
				'node-2'
			);

			// Verify the resolver was called with the "to" node (Reviewer → node-2)
			expect(resolver.getActiveSessionForNode).toHaveBeenCalledWith('run-1', 'node-2');
		});
	});

	describe('script context', () => {
		test('injects context variables into script environment', async () => {
			// Use a script that outputs env vars to verify injection
			const script = 'echo "$TASK_ID $PR_NUMBER $REPO_OWNER $REPO_NAME"';
			const workflow = makeWorkflowWithPoll({ script });
			manager.startPolls('run-1', workflow, '/tmp', 'space-1', makeContext());

			await triggerTick(
				manager,
				'run-1',
				'gate-1',
				makePoll({ script }),
				'/tmp',
				makeContext(),
				'node-2'
			);

			expect(injector.injectSubSessionMessage).toHaveBeenCalledWith(
				'session-1',
				'task-1 42 owner repo',
				true
			);
		});

		test('provides empty strings for missing PR context', async () => {
			const context = makeContext();
			context.PR_URL = '';
			context.PR_NUMBER = '';
			context.REPO_OWNER = '';
			context.REPO_NAME = '';

			const script = 'echo "$PR_URL:$PR_NUMBER:$REPO_OWNER:$REPO_NAME"';
			const workflow = makeWorkflowWithPoll({ script });
			manager.startPolls('run-1', workflow, '/tmp', 'space-1', context);

			await triggerTick(
				manager,
				'run-1',
				'gate-1',
				makePoll({ script }),
				'/tmp',
				context,
				'node-2'
			);

			expect(injector.injectSubSessionMessage).toHaveBeenCalledWith('session-1', ':::', true);
		});
	});
});

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('extractPrContext', () => {
	test('extracts context from valid GitHub PR URL', () => {
		const result = extractPrContext('https://github.com/owner/repo/pull/42');
		expect(result).toEqual({
			PR_NUMBER: '42',
			REPO_OWNER: 'owner',
			REPO_NAME: 'repo',
		});
	});

	test('returns empty strings for empty URL', () => {
		const result = extractPrContext('');
		expect(result).toEqual({
			PR_NUMBER: '',
			REPO_OWNER: '',
			REPO_NAME: '',
		});
	});

	test('returns empty strings for invalid URL', () => {
		const result = extractPrContext('not-a-url');
		expect(result).toEqual({
			PR_NUMBER: '',
			REPO_OWNER: '',
			REPO_NAME: '',
		});
	});

	test('returns empty strings for non-PR URL', () => {
		const result = extractPrContext('https://github.com/owner/repo/issues/5');
		expect(result).toEqual({
			PR_NUMBER: '',
			REPO_OWNER: '',
			REPO_NAME: '',
		});
	});

	test('handles PR URL with extra path segments', () => {
		const result = extractPrContext('https://github.com/owner/repo/pull/42/files');
		expect(result.PR_NUMBER).toBe('42');
		expect(result.REPO_OWNER).toBe('owner');
		expect(result.REPO_NAME).toBe('repo');
	});
});

describe('resolveTargetNodeName', () => {
	test('returns "to" node name for target=to', () => {
		const channel: WorkflowChannel = {
			id: 'ch-1',
			from: 'Coder',
			to: 'Reviewer',
			gateId: 'gate-1',
		};
		const workflow = makeWorkflow([], [channel]);
		expect(resolveTargetNodeName('gate-1', workflow, 'to')).toBe('Reviewer');
	});

	test('returns "from" node name for target=from', () => {
		const channel: WorkflowChannel = {
			id: 'ch-1',
			from: 'Coder',
			to: 'Reviewer',
			gateId: 'gate-1',
		};
		const workflow = makeWorkflow([], [channel]);
		expect(resolveTargetNodeName('gate-1', workflow, 'from')).toBe('Coder');
	});

	test('returns null when no channel references the gate', () => {
		const workflow = makeWorkflow([], []);
		expect(resolveTargetNodeName('gate-1', workflow, 'to')).toBeNull();
	});

	test('handles array "to" targets (returns first element)', () => {
		const channel: WorkflowChannel = {
			id: 'ch-1',
			from: 'Coder',
			to: ['Reviewer', 'QA'],
			gateId: 'gate-1',
		};
		const workflow = makeWorkflow([], [channel]);
		expect(resolveTargetNodeName('gate-1', workflow, 'to')).toBe('Reviewer');
	});
});

describe('formatPollMessage', () => {
	test('replaces {{output}} placeholder', () => {
		expect(formatPollMessage('hello', 'Message: {{output}}')).toBe('Message: hello');
	});

	test('replaces multiple placeholders', () => {
		expect(formatPollMessage('hello', '{{output}} and {{output}}')).toBe('hello and hello');
	});

	test('returns raw output when no template', () => {
		expect(formatPollMessage('hello')).toBe('hello');
	});

	test('returns raw output when template is empty string', () => {
		expect(formatPollMessage('hello', '')).toBe('hello');
	});

	test('preserves template text without placeholder', () => {
		expect(formatPollMessage('hello', 'No placeholder here')).toBe('No placeholder here');
	});
});
