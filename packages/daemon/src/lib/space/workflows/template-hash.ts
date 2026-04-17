/**
 * Template Hash Utility
 *
 * Computes a deterministic canonical hash of a workflow's structural fingerprint
 * for template drift detection.
 *
 * The fingerprint covers node names, channel topology, gate names, description,
 * and instructions. It does NOT include agent UUIDs (which differ per-space)
 * or layout coordinates (which are cosmetic).
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
	gateNames: string[];
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

	const gateNames = (workflow.gates ?? []).map((g) => g.id).sort();

	return {
		description: workflow.description ?? '',
		instructions: workflow.instructions ?? '',
		nodeNames,
		channels,
		gateNames,
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
