/**
 * Space Export/Import Format
 *
 * Functions for serializing SpaceAgent and SpaceWorkflow instances to a
 * portable JSON format and validating imported data with Zod schemas.
 *
 * Key remappings performed during export:
 * - Step `id` fields are stripped (regenerated on import)
 * - Rule `appliesTo` step UUIDs → step order indices (stable across re-import)
 * - Custom agent `agentRef` UUIDs → agent names (portable across Space instances)
 *
 * Version policy:
 * - Accept: version === 1
 * - Reject with "requires newer version": version > 1 (or version >= 2)
 * - Reject as invalid: version missing, null, < 1, or non-integer
 */

import { z } from 'zod';
import type {
	SpaceAgent,
	SpaceWorkflow,
	ExportedSpaceAgent,
	ExportedSpaceWorkflow,
	ExportedWorkflowStep,
	ExportedWorkflowRule,
	SpaceExportBundle,
} from '@neokai/shared';

// ============================================================================
// Zod schemas
// ============================================================================

const workflowGateSchema = z.object({
	type: z.enum(['auto', 'human_approval', 'quality_check', 'pr_review', 'custom']),
	command: z.string().optional(),
	description: z.string().optional(),
	maxRetries: z.number().int().nonnegative().optional(),
	timeoutMs: z.number().int().nonnegative().optional(),
});

const exportedWorkflowStepSchema = z.discriminatedUnion('agentRefType', [
	z.object({
		agentRefType: z.literal('builtin'),
		agentRef: z.enum(['planner', 'coder', 'general']),
		name: z.string().min(1),
		entryGate: workflowGateSchema.optional(),
		exitGate: workflowGateSchema.optional(),
		instructions: z.string().optional(),
		order: z.number().int().nonnegative(),
	}),
	z.object({
		agentRefType: z.literal('custom'),
		agentRef: z.string().min(1),
		name: z.string().min(1),
		entryGate: workflowGateSchema.optional(),
		exitGate: workflowGateSchema.optional(),
		instructions: z.string().optional(),
		order: z.number().int().nonnegative(),
	}),
]);

const exportedWorkflowRuleSchema = z.object({
	name: z.string().min(1),
	content: z.string().min(1),
	appliesTo: z.array(z.number().int().nonnegative()).optional(),
});

/** Validates the version field; returns an error string or null. */
function checkVersion(version: unknown): string | null {
	if (version === null || version === undefined) return 'invalid: version is required';
	if (typeof version !== 'number') return 'invalid: version must be a number';
	if (!Number.isInteger(version) || version < 1)
		return 'invalid: version must be a positive integer';
	if (version > 1)
		return `requires newer version: this client supports version 1 but received version ${version}`;
	return null;
}

const exportedAgentBaseSchema = z.object({
	type: z.literal('agent'),
	name: z.string().min(1),
	description: z.string().optional(),
	model: z.string().optional(),
	provider: z.string().optional(),
	role: z.enum(['planner', 'coder', 'general']),
	systemPrompt: z.string().optional(),
	tools: z.record(z.string(), z.unknown()).optional(),
	config: z.record(z.string(), z.unknown()).optional(),
});

const exportedWorkflowBaseSchema = z.object({
	type: z.literal('workflow'),
	name: z.string().min(1),
	description: z.string().optional(),
	steps: z.array(exportedWorkflowStepSchema),
	rules: z.array(exportedWorkflowRuleSchema),
	tags: z.array(z.string()),
	config: z.record(z.string(), z.unknown()).optional(),
});

const exportBundleBaseSchema = z.object({
	type: z.literal('bundle'),
	name: z.string().min(1),
	description: z.string().optional(),
	agents: z.array(exportedAgentBaseSchema),
	workflows: z.array(exportedWorkflowBaseSchema),
	exportedAt: z.number().int().positive(),
	exportedFrom: z.string().optional(),
});

// ============================================================================
// Validation result type
// ============================================================================

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

// ============================================================================
// Export functions
// ============================================================================

/**
 * Convert a SpaceAgent to the portable export format.
 * Strips `id`, `spaceId`, `createdAt`, `updatedAt`.
 */
export function exportAgent(agent: SpaceAgent): ExportedSpaceAgent {
	const exported: ExportedSpaceAgent = {
		version: 1,
		type: 'agent',
		name: agent.name,
		role: agent.role,
	};
	if (agent.description !== undefined) exported.description = agent.description;
	if (agent.model !== undefined) exported.model = agent.model;
	if (agent.provider !== undefined) exported.provider = agent.provider;
	if (agent.systemPrompt !== undefined) exported.systemPrompt = agent.systemPrompt;
	if (agent.toolConfig !== undefined) exported.tools = agent.toolConfig;
	return exported;
}

/**
 * Convert a SpaceWorkflow to the portable export format.
 *
 * Remappings:
 * 1. Step `id` fields are stripped.
 * 2. `rules[].appliesTo` is converted from step UUIDs to step order indices.
 * 3. For steps with `agentRefType: 'custom'`, `agentRef` UUID is replaced with
 *    the matching agent's name. If no matching agent is found, `agentRef` is
 *    preserved as-is (graceful degradation).
 */
export function exportWorkflow(
	workflow: SpaceWorkflow,
	agents: SpaceAgent[]
): ExportedSpaceWorkflow {
	// Build a map from step UUID → order index for rule appliesTo remapping
	const stepIdToOrder = new Map<string, number>();
	for (const step of workflow.steps) {
		stepIdToOrder.set(step.id, step.order);
	}

	// Build a map from agent UUID → agent name for custom agentRef remapping
	const agentIdToName = new Map<string, string>();
	for (const agent of agents) {
		agentIdToName.set(agent.id, agent.name);
	}

	// Export steps — strip `id`, remap custom agentRef UUID → name
	const exportedSteps: ExportedWorkflowStep[] = workflow.steps.map((step) => {
		const base = {
			name: step.name,
			order: step.order,
			...(step.entryGate !== undefined ? { entryGate: step.entryGate } : {}),
			...(step.exitGate !== undefined ? { exitGate: step.exitGate } : {}),
			...(step.instructions !== undefined ? { instructions: step.instructions } : {}),
		};

		if (step.agentRefType === 'builtin') {
			return { agentRefType: 'builtin', agentRef: step.agentRef, ...base };
		} else {
			// custom: remap UUID → name (fallback to UUID if agent not found)
			const agentName = agentIdToName.get(step.agentRef) ?? step.agentRef;
			return { agentRefType: 'custom', agentRef: agentName, ...base };
		}
	});

	// Export rules — strip `id`, remap appliesTo UUID[] → order index[]
	const exportedRules: ExportedWorkflowRule[] = workflow.rules.map((rule) => {
		const exported: ExportedWorkflowRule = {
			name: rule.name,
			content: rule.content,
		};
		if (rule.appliesTo !== undefined && rule.appliesTo.length > 0) {
			const orderIndices = rule.appliesTo
				.map((stepId) => stepIdToOrder.get(stepId))
				.filter((idx): idx is number => idx !== undefined);
			// If all referenced step UUIDs are absent from the workflow (e.g., stale data),
			// orderIndices will be empty and `appliesTo` is omitted. This changes the rule
			// semantics from "applies to specific steps" to "applies to all steps" — an
			// intentional graceful degradation: a rule that can't resolve its targets is
			// treated as a global rule rather than silently dropped.
			if (orderIndices.length > 0) {
				exported.appliesTo = orderIndices;
			}
		}
		return exported;
	});

	const result: ExportedSpaceWorkflow = {
		version: 1,
		type: 'workflow',
		name: workflow.name,
		steps: exportedSteps,
		rules: exportedRules,
		tags: workflow.tags,
	};
	if (workflow.description !== undefined) result.description = workflow.description;
	if (workflow.config !== undefined) result.config = workflow.config;
	return result;
}

/**
 * Create a SpaceExportBundle from a set of agents and workflows.
 */
export function exportBundle(
	agents: SpaceAgent[],
	workflows: SpaceWorkflow[],
	name: string,
	options?: { description?: string; exportedFrom?: string }
): SpaceExportBundle {
	const exportedAgents = agents.map(exportAgent);
	const exportedWorkflows = workflows.map((wf) => exportWorkflow(wf, agents));
	const bundle: SpaceExportBundle = {
		version: 1,
		type: 'bundle',
		name,
		agents: exportedAgents,
		workflows: exportedWorkflows,
		exportedAt: Date.now(),
	};
	if (options?.description !== undefined) bundle.description = options.description;
	if (options?.exportedFrom !== undefined) bundle.exportedFrom = options.exportedFrom;
	return bundle;
}

// ============================================================================
// Validation functions
// ============================================================================

/**
 * Validate an unknown value as an ExportedSpaceAgent.
 *
 * Version handling:
 * - version === 1 → accepted
 * - version > 1 → error: "requires newer version: ..."
 * - version < 1 or missing/non-integer → error: "invalid: ..."
 */
export function validateExportedAgent(data: unknown): ValidationResult<ExportedSpaceAgent> {
	if (typeof data !== 'object' || data === null) {
		return { ok: false, error: 'invalid: expected an object' };
	}
	const versionError = checkVersion((data as Record<string, unknown>).version);
	if (versionError) return { ok: false, error: versionError };

	const result = exportedAgentBaseSchema.safeParse(data);
	if (!result.success) {
		return { ok: false, error: `invalid: ${result.error.issues.map((i) => i.message).join('; ')}` };
	}
	return { ok: true, value: { version: 1, ...result.data } };
}

/**
 * Validate an unknown value as an ExportedSpaceWorkflow.
 *
 * Version handling: same as validateExportedAgent.
 */
export function validateExportedWorkflow(data: unknown): ValidationResult<ExportedSpaceWorkflow> {
	if (typeof data !== 'object' || data === null) {
		return { ok: false, error: 'invalid: expected an object' };
	}
	const versionError = checkVersion((data as Record<string, unknown>).version);
	if (versionError) return { ok: false, error: versionError };

	const result = exportedWorkflowBaseSchema.safeParse(data);
	if (!result.success) {
		return { ok: false, error: `invalid: ${result.error.issues.map((i) => i.message).join('; ')}` };
	}
	return { ok: true, value: { version: 1, ...result.data } };
}

/**
 * Validate an unknown value as a SpaceExportBundle.
 *
 * Version handling: same as validateExportedAgent.
 * Each embedded agent and workflow is validated individually via
 * `validateExportedAgent` / `validateExportedWorkflow` so that nested version
 * checks (e.g. a v2 agent inside a v1 bundle) are caught and reported.
 */
export function validateExportBundle(data: unknown): ValidationResult<SpaceExportBundle> {
	if (typeof data !== 'object' || data === null) {
		return { ok: false, error: 'invalid: expected an object' };
	}
	const versionError = checkVersion((data as Record<string, unknown>).version);
	if (versionError) return { ok: false, error: versionError };

	const result = exportBundleBaseSchema.safeParse(data);
	if (!result.success) {
		return { ok: false, error: `invalid: ${result.error.issues.map((i) => i.message).join('; ')}` };
	}

	// Validate each nested agent and workflow using the full per-item validators
	// so that their individual version fields are also checked.
	const raw = data as Record<string, unknown>;
	const rawAgents = Array.isArray(raw.agents) ? raw.agents : [];
	for (let i = 0; i < rawAgents.length; i++) {
		const agentResult = validateExportedAgent(rawAgents[i]);
		if (!agentResult.ok) {
			return { ok: false, error: `invalid: agents[${i}]: ${agentResult.error}` };
		}
	}
	const rawWorkflows = Array.isArray(raw.workflows) ? raw.workflows : [];
	for (let i = 0; i < rawWorkflows.length; i++) {
		const wfResult = validateExportedWorkflow(rawWorkflows[i]);
		if (!wfResult.ok) {
			return { ok: false, error: `invalid: workflows[${i}]: ${wfResult.error}` };
		}
	}

	return {
		ok: true,
		value: {
			version: 1,
			type: 'bundle',
			name: result.data.name,
			...(result.data.description !== undefined ? { description: result.data.description } : {}),
			agents: result.data.agents.map((a) => ({ version: 1 as const, ...a })),
			workflows: result.data.workflows.map((w) => ({ version: 1 as const, ...w })),
			exportedAt: result.data.exportedAt,
			...(result.data.exportedFrom !== undefined ? { exportedFrom: result.data.exportedFrom } : {}),
		},
	};
}
