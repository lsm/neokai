/**
 * Template Hash Utility
 *
 * Computes a deterministic canonical hash of a workflow's structural fingerprint
 * for template drift detection.
 *
 * The fingerprint covers node names, channel topology, gate internals (fields,
 * script, requiredLevel, resetOnCycle), description, instructions, per-agent
 * custom prompts, the workflow-level `completionAutonomyLevel`, and the
 * workflow-level `postApproval` route.
 * It does NOT include agent UUIDs (which differ per-space), layout coordinates,
 * or tags (which are cosmetic).
 */

import type { SpaceWorkflow } from '@neokai/shared';

/**
 * Canonical shape used for hashing — uses only template-portable fields.
 * Agent UUIDs are excluded because they differ per-space.
 */
interface WorkflowFingerprint {
	description: string;
	instructions: string;
	nodeNames: string[];
	channels: string[];
	/**
	 * Rich gate serialization covering id, requiredLevel, resetOnCycle,
	 * field names/types/checks, and a script prefix. This detects changes to
	 * gate internals (not just gate additions/removals).
	 */
	gates: string[];
	/**
	 * Per-agent custom prompt entries, sorted. Format:
	 * `<nodeName>|<agentName>|<customPrompt>` (empty string when absent).
	 * Captures the most frequently updated field — agent behavior changes.
	 */
	nodePrompts: string[];
	/**
	 * Minimum space autonomy level required to auto-close the workflow.
	 * Affects autonomy gating behavior.
	 */
	completionAutonomyLevel: number;
	/**
	 * Workflow-level post-approval route. Empty string when no route is
	 * declared. Format: `<targetAgent>|<instructions>`. Detects changes to the
	 * post-approval handoff — so seeder re-stamping triggers when the built-in
	 * templates gain or modify their `postApproval` entry.
	 */
	postApproval: string;
}

/**
 * Extract the canonical fingerprint of a workflow for hash comparison.
 * Sorts all collections to ensure deterministic output regardless of insertion order.
 */
export function buildWorkflowFingerprint(workflow: SpaceWorkflow): WorkflowFingerprint {
	const nodeNames = workflow.nodes.map((n) => n.name).sort();

	const channels = (workflow.channels ?? [])
		.map((c) => {
			const to = Array.isArray(c.to) ? [...c.to].sort().join(',') : c.to;
			return `${c.from}->${to}`;
		})
		.sort();

	// Serialize each gate including its structural internals.
	// Format: `<id>|<requiredLevel>|<resetOnCycle>|<sorted-fields>|<script-prefix>`
	// Fields: `<name>:<type>:<checkOp>[:<checkExtra>]` — sorted for stability.
	// Script: first 64 chars of source (captures script identity without full content).
	const gates = (workflow.gates ?? [])
		.map((g) => {
			const fields = (g.fields ?? [])
				.map((f) => {
					const check = f.check;
					let checkStr = check.op;
					if (check.op === 'count') {
						checkStr += `:${String(check.match)}:${check.min}`;
					} else if (check.op !== 'exists' && 'value' in check && check.value !== undefined) {
						checkStr += `:${String(check.value)}`;
					}
					return `${f.name}:${f.type}:${checkStr}`;
				})
				.sort()
				.join(',');
			const scriptPrefix = g.script ? g.script.source.slice(0, 64) : '';
			return `${g.id}|${g.requiredLevel ?? 0}|${g.resetOnCycle}|${fields}|${scriptPrefix}`;
		})
		.sort();

	// Serialize per-agent custom prompts.
	// Format: `<nodeName>|<agentName>|<customPrompt>` — empty string when absent.
	const nodePrompts = workflow.nodes
		.flatMap((n) => n.agents.map((a) => `${n.name}|${a.name}|${a.customPrompt?.value ?? ''}`))
		.sort();

	// Serialize workflow-level post-approval route.
	// Format: `<targetAgent>|<instructions>` (empty string when absent).
	const postApproval = workflow.postApproval
		? `${workflow.postApproval.targetAgent}|${workflow.postApproval.instructions ?? ''}`
		: '';

	return {
		description: workflow.description ?? '',
		instructions: workflow.instructions ?? '',
		nodeNames,
		channels,
		gates,
		nodePrompts,
		completionAutonomyLevel: workflow.completionAutonomyLevel,
		postApproval,
	};
}

/**
 * Compute the SHA-256 hex hash of a workflow's canonical fingerprint.
 * Used to track template versions and detect drift.
 */
export function computeWorkflowHash(workflow: SpaceWorkflow): string {
	const fp = buildWorkflowFingerprint(workflow);
	const json = JSON.stringify(fp);
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update(json);
	return hasher.digest('hex');
}

/**
 * Returns true when two workflows have the same structural fingerprint.
 * Uses hash comparison internally.
 */
export function workflowsMatchFingerprint(a: SpaceWorkflow, b: SpaceWorkflow): boolean {
	return computeWorkflowHash(a) === computeWorkflowHash(b);
}
