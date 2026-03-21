/**
 * Space Export/Import Format
 *
 * Functions for serializing SpaceAgent and SpaceWorkflow instances to a
 * portable JSON format and validating imported data with Zod schemas.
 *
 * Key remappings performed during export:
 * - Step `id` fields are stripped (regenerated on import)
 * - Step `agentId` UUID → agent name (`agentRef`) — portable across Spaces
 * - Transition `id` stripped; `from`/`to` step UUIDs → step names
 * - `startStepId` UUID → step name (`startStep`)
 * - Rule `appliesTo` step UUIDs → step names (stable across re-import)
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
	ExportedWorkflowTransition,
	ExportedWorkflowRule,
	SpaceExportBundle,
} from '@neokai/shared';

// ============================================================================
// Zod schemas
// ============================================================================

const workflowConditionSchema = z
	.object({
		type: z.enum(['always', 'human', 'condition', 'task_result']),
		expression: z.string().optional(),
		description: z.string().optional(),
		maxRetries: z.number().int().nonnegative().optional(),
		timeoutMs: z.number().int().nonnegative().optional(),
	})
	.superRefine((val, ctx) => {
		if (val.type === 'condition' && (!val.expression || !val.expression.trim())) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: "'condition' type requires a non-empty expression",
				path: ['expression'],
			});
		}
	});

const exportedWorkflowStepSchema = z.object({
	agentRef: z.string().min(1),
	name: z.string().min(1),
	instructions: z.string().optional(),
});

const exportedWorkflowTransitionSchema = z.object({
	fromStep: z.string().min(1),
	toStep: z.string().min(1),
	condition: workflowConditionSchema.optional(),
	order: z.number().int().optional(),
	isCyclic: z.boolean().optional(),
});

const exportedWorkflowRuleSchema = z.object({
	name: z.string().min(1),
	content: z.string().min(1),
	appliesTo: z.array(z.string()).optional(),
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
	role: z.string().min(1),
	systemPrompt: z.string().optional(),
	tools: z.array(z.string()).optional(),
	injectWorkflowContext: z.boolean().optional(),
	config: z.record(z.string(), z.unknown()).optional(),
});

const exportedWorkflowBaseSchema = z.object({
	type: z.literal('workflow'),
	name: z.string().min(1),
	description: z.string().optional(),
	steps: z.array(exportedWorkflowStepSchema),
	transitions: z.array(exportedWorkflowTransitionSchema),
	startStep: z.string().min(1),
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
 *
 * `SpaceAgent.toolConfig` (per-tool configuration map) is intentionally **not**
 * exported — it is an implementation detail of the runtime and is not part of the
 * portable format. Only `tools` (the list of tool names) is exported.
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
	if (agent.tools !== undefined) exported.tools = agent.tools;
	if (agent.injectWorkflowContext === true) exported.injectWorkflowContext = true;
	return exported;
}

/**
 * Convert a SpaceWorkflow to the portable export format.
 *
 * Remappings:
 * 1. Step `id` fields are stripped; step `agentId` UUID → agent name (`agentRef`).
 *    Falls back to the UUID string when no matching agent is found in `agents`.
 * 2. Transition `id` stripped; `from`/`to` step UUIDs → step names.
 *    Falls back to the UUID string when no matching step is found.
 * 3. `startStepId` UUID → step name (`startStep`).
 * 4. Rule `appliesTo` step UUIDs → step names (stable cross-references on re-import).
 *    If a UUID has no matching step (stale data), it is silently dropped from
 *    `appliesTo`. If all UUIDs are stale the field is omitted, treating the rule
 *    as global (applies to all steps) rather than discarding it entirely.
 */
export function exportWorkflow(
	workflow: SpaceWorkflow,
	agents: SpaceAgent[]
): ExportedSpaceWorkflow {
	// Build a map from step UUID → step name
	const stepIdToName = new Map<string, string>();
	for (const step of workflow.steps) {
		stepIdToName.set(step.id, step.name);
	}

	// Build a map from agent UUID → agent name
	const agentIdToName = new Map<string, string>();
	for (const agent of agents) {
		agentIdToName.set(agent.id, agent.name);
	}

	// Export steps — strip `id`, remap agentId UUID → agent name
	const exportedSteps: ExportedWorkflowStep[] = workflow.steps.map((step) => {
		const agentRef = agentIdToName.get(step.agentId) ?? step.agentId;
		const exported: ExportedWorkflowStep = { agentRef, name: step.name };
		if (step.instructions !== undefined) exported.instructions = step.instructions;
		return exported;
	});

	// Export transitions — strip `id`, remap from/to step UUIDs → step names
	const exportedTransitions: ExportedWorkflowTransition[] = workflow.transitions.map((t) => {
		const fromStep = stepIdToName.get(t.from) ?? t.from;
		const toStep = stepIdToName.get(t.to) ?? t.to;
		const exported: ExportedWorkflowTransition = { fromStep, toStep };
		if (t.condition !== undefined) exported.condition = t.condition;
		if (t.order !== undefined) exported.order = t.order;
		if (t.isCyclic !== undefined) exported.isCyclic = t.isCyclic;
		return exported;
	});

	// Export startStepId UUID → step name
	const startStep = stepIdToName.get(workflow.startStepId) ?? workflow.startStepId;

	// Export rules — strip `id`, remap appliesTo step UUIDs → step names
	const exportedRules: ExportedWorkflowRule[] = workflow.rules.map((rule) => {
		const exported: ExportedWorkflowRule = { name: rule.name, content: rule.content };
		if (rule.appliesTo !== undefined && rule.appliesTo.length > 0) {
			const stepNames = rule.appliesTo
				.map((stepId) => stepIdToName.get(stepId))
				.filter((n): n is string => n !== undefined);
			// If all referenced step UUIDs are absent from the workflow (e.g., stale data),
			// stepNames will be empty and `appliesTo` is omitted. This changes the rule
			// semantics from "applies to specific steps" to "applies to all steps" — an
			// intentional graceful degradation: a rule that can't resolve its targets is
			// treated as global rather than silently dropped.
			if (stepNames.length > 0) {
				exported.appliesTo = stepNames;
			}
		}
		return exported;
	});

	const result: ExportedSpaceWorkflow = {
		version: 1,
		type: 'workflow',
		name: workflow.name,
		steps: exportedSteps,
		transitions: exportedTransitions,
		startStep,
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

	// Referential integrity checks — enforce the cross-reference invariants that
	// the rest of the format depends on (step names as stable cross-reference keys).
	const stepNameSet = new Set<string>();
	for (const step of result.data.steps) {
		if (stepNameSet.has(step.name)) {
			return { ok: false, error: `invalid: duplicate step name: "${step.name}"` };
		}
		stepNameSet.add(step.name);
	}
	// startStep must reference a known step name (skip check when steps is empty)
	if (result.data.steps.length > 0 && !stepNameSet.has(result.data.startStep)) {
		return {
			ok: false,
			error: `invalid: startStep "${result.data.startStep}" does not reference a known step name`,
		};
	}
	// Transition endpoints must reference known step names
	for (let i = 0; i < result.data.transitions.length; i++) {
		const t = result.data.transitions[i];
		if (!stepNameSet.has(t.fromStep)) {
			return {
				ok: false,
				error: `invalid: transitions[${i}].fromStep "${t.fromStep}" does not reference a known step name`,
			};
		}
		if (!stepNameSet.has(t.toStep)) {
			return {
				ok: false,
				error: `invalid: transitions[${i}].toStep "${t.toStep}" does not reference a known step name`,
			};
		}
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
			return { ok: false, error: `agents[${i}]: ${agentResult.error}` };
		}
	}
	const rawWorkflows = Array.isArray(raw.workflows) ? raw.workflows : [];
	for (let i = 0; i < rawWorkflows.length; i++) {
		const wfResult = validateExportedWorkflow(rawWorkflows[i]);
		if (!wfResult.ok) {
			return { ok: false, error: `workflows[${i}]: ${wfResult.error}` };
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
