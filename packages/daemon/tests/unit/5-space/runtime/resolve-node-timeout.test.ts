/**
 * resolveTimeoutForExecution — unit tests
 *
 * Verifies that per-node timeout resolution is driven entirely by the
 * workflow definition. The runtime no longer carries a role-name → timeout
 * lookup table; this helper replaces it.
 */

import { describe, expect, test } from 'bun:test';
import type { SpaceWorkflow } from '@neokai/shared';
import { resolveTimeoutForExecution } from '../../../../src/lib/space/runtime/resolve-node-timeout.ts';

function makeWorkflow(
	nodes: Array<{
		id: string;
		name: string;
		agents: Array<{ agentId: string; name: string; timeoutMs?: number }>;
	}>
): Pick<SpaceWorkflow, 'nodes'> {
	return { nodes };
}

describe('resolveTimeoutForExecution', () => {
	test('returns the slot timeoutMs when set', () => {
		const wf = makeWorkflow([
			{
				id: 'node-1',
				name: 'Coding',
				agents: [{ agentId: 'a-1', name: 'coder', timeoutMs: 600_000 }],
			},
		]);

		const result = resolveTimeoutForExecution({ workflowNodeId: 'node-1', agentName: 'coder' }, wf);
		expect(result).toBe(600_000);
	});

	test('returns undefined when the slot has no timeoutMs', () => {
		const wf = makeWorkflow([
			{
				id: 'node-1',
				name: 'Coding',
				agents: [{ agentId: 'a-1', name: 'coder' }],
			},
		]);

		const result = resolveTimeoutForExecution({ workflowNodeId: 'node-1', agentName: 'coder' }, wf);
		expect(result).toBeUndefined();
	});

	test('returns undefined when the workflow has no matching node', () => {
		const wf = makeWorkflow([
			{
				id: 'node-1',
				name: 'Coding',
				agents: [{ agentId: 'a-1', name: 'coder', timeoutMs: 600_000 }],
			},
		]);

		const result = resolveTimeoutForExecution(
			{ workflowNodeId: 'unknown-node', agentName: 'coder' },
			wf
		);
		expect(result).toBeUndefined();
	});

	test('returns undefined when the node has no slot with the matching name', () => {
		const wf = makeWorkflow([
			{
				id: 'node-1',
				name: 'Coding',
				agents: [{ agentId: 'a-1', name: 'reviewer', timeoutMs: 600_000 }],
			},
		]);

		const result = resolveTimeoutForExecution({ workflowNodeId: 'node-1', agentName: 'coder' }, wf);
		expect(result).toBeUndefined();
	});

	test('returns undefined when execution.agentName is null', () => {
		const wf = makeWorkflow([
			{
				id: 'node-1',
				name: 'Coding',
				agents: [{ agentId: 'a-1', name: 'coder', timeoutMs: 600_000 }],
			},
		]);

		const result = resolveTimeoutForExecution({ workflowNodeId: 'node-1', agentName: null }, wf);
		expect(result).toBeUndefined();
	});

	test('rejects non-positive timeoutMs values', () => {
		for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			const wf = makeWorkflow([
				{
					id: 'node-1',
					name: 'Coding',
					agents: [{ agentId: 'a-1', name: 'coder', timeoutMs: bad }],
				},
			]);

			const result = resolveTimeoutForExecution(
				{ workflowNodeId: 'node-1', agentName: 'coder' },
				wf
			);
			expect(result).toBeUndefined();
		}
	});

	test('picks the matching slot when a node has multiple agents', () => {
		const wf = makeWorkflow([
			{
				id: 'node-1',
				name: 'PlanAndCode',
				agents: [
					{ agentId: 'a-1', name: 'planner', timeoutMs: 1_200_000 },
					{ agentId: 'a-2', name: 'coder', timeoutMs: 1_800_000 },
				],
			},
		]);

		expect(resolveTimeoutForExecution({ workflowNodeId: 'node-1', agentName: 'planner' }, wf)).toBe(
			1_200_000
		);
		expect(resolveTimeoutForExecution({ workflowNodeId: 'node-1', agentName: 'coder' }, wf)).toBe(
			1_800_000
		);
	});

	test('matches agentName by exact slot name (case-sensitive)', () => {
		// Slot names are derived from the SpaceAgent name and stored verbatim;
		// agent matching here must be exact, mirroring how the runtime stores
		// the slot name in `node_executions.agent_name`.
		const wf = makeWorkflow([
			{
				id: 'node-1',
				name: 'Coding',
				agents: [{ agentId: 'a-1', name: 'Coder', timeoutMs: 600_000 }],
			},
		]);

		const result = resolveTimeoutForExecution({ workflowNodeId: 'node-1', agentName: 'coder' }, wf);
		expect(result).toBeUndefined();
	});
});
