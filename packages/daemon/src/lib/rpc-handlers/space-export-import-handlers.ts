/**
 * Space Export/Import RPC Handlers
 *
 * Export namespace (spaceExport.*):
 *   spaceExport.agents    { spaceId, agentIds? }                       → { bundle: SpaceExportBundle }
 *   spaceExport.workflows { spaceId, workflowIds? }                    → { bundle: SpaceExportBundle }
 *   spaceExport.bundle    { spaceId, agentIds?, workflowIds? }         → { bundle: SpaceExportBundle }
 *
 * Import namespace (spaceImport.*):
 *   spaceImport.preview   { bundle, spaceId }                          → ImportPreviewResult
 *   spaceImport.execute   { spaceId, bundle, conflictResolution? }     → ImportExecuteResult
 *
 * Cross-reference rules:
 * - Exported workflow steps store the agent's display **name** (`agentRef`), not UUID.
 * - On import, agent names are resolved to UUIDs by checking:
 *     1. Agents being imported in the same bundle (by original bundle name)
 *     2. Agents already present in the target space (by name)
 * - If a name cannot be resolved, preview flags it as a validation error;
 *   execute throws and aborts import of that workflow.
 * - Rule `appliesTo` lists step **names** in the exported format and are
 *   remapped to new step UUIDs on import.
 */

import { generateUUID } from '@neokai/shared';
import type {
	MessageHub,
	Space,
	SpaceAgent,
	CreateSpaceAgentParams,
	CreateSpaceWorkflowParams,
	WorkflowStepInput,
	WorkflowTransitionInput,
	WorkflowRuleInput,
	SpaceExportBundle,
	ExportedSpaceAgent,
	ExportedSpaceWorkflow,
} from '@neokai/shared';
import type { SpaceManager } from '../space/managers/space-manager';
import type { SpaceWorkflowManager } from '../space/managers/space-workflow-manager';
import type { SpaceAgentRepository } from '../../storage/repositories/space-agent-repository';
import type { SpaceWorkflowRepository } from '../../storage/repositories/space-workflow-repository';
import { exportBundle, validateExportBundle } from '../space/export-format';

// ============================================================================
// Public types
// ============================================================================

export interface ImportPreview {
	name: string;
	action: 'create' | 'conflict';
	existingId?: string;
}

export interface ImportPreviewResult {
	agents: ImportPreview[];
	workflows: ImportPreview[];
	validationErrors: string[];
}

export type ConflictResolutionStrategy = 'skip' | 'rename' | 'replace';

export interface ImportConflictResolution {
	agents?: Record<string, ConflictResolutionStrategy>;
	workflows?: Record<string, ConflictResolutionStrategy>;
}

export interface ImportedItem {
	name: string;
	id: string;
	action: 'created' | 'skipped' | 'renamed' | 'replaced';
}

export interface ImportExecuteResult {
	agents: ImportedItem[];
	workflows: ImportedItem[];
	warnings: string[];
}

// ============================================================================
// Private helpers
// ============================================================================

async function requireSpace(spaceManager: SpaceManager, spaceId: string): Promise<Space> {
	if (!spaceId) throw new Error('spaceId is required');
	const space = await spaceManager.getSpace(spaceId);
	if (!space) throw new Error(`Space not found: ${spaceId}`);
	return space;
}

/** Generate a name that does not collide with anything in `existingNames`. */
function generateUniqueName(baseName: string, existingNames: Set<string>): string {
	if (!existingNames.has(baseName)) return baseName;
	let counter = 1;
	while (existingNames.has(`${baseName} (${counter})`)) counter++;
	return `${baseName} (${counter})`;
}

function buildAgentCreateParams(
	spaceId: string,
	name: string,
	exported: ExportedSpaceAgent
): CreateSpaceAgentParams {
	const params: CreateSpaceAgentParams = { spaceId, name, role: exported.role };
	if (exported.description !== undefined) params.description = exported.description;
	if (exported.model !== undefined) params.model = exported.model;
	if (exported.provider !== undefined) params.provider = exported.provider;
	if (exported.systemPrompt !== undefined) params.systemPrompt = exported.systemPrompt;
	if (exported.tools !== undefined) params.tools = exported.tools;
	return params;
}

/**
 * Convert an `ExportedSpaceWorkflow` into `CreateSpaceWorkflowParams` suitable
 * for `SpaceWorkflowRepository.createWorkflow()`.
 *
 * Step names are assigned fresh UUIDs; rule `appliesTo` arrays are remapped from
 * step names to those new UUIDs; agent refs are resolved via the two lookup maps.
 *
 * @returns params ready for the repository, the step-name→UUID map (for rule
 *          appliesTo remapping), and any warnings about unresolved agent refs.
 */
function buildWorkflowCreateParams(
	spaceId: string,
	name: string,
	exported: ExportedSpaceWorkflow,
	importedAgentNameToId: Map<string, string>,
	existingAgentNameToId: Map<string, string>
): { params: CreateSpaceWorkflowParams; stepNameToId: Map<string, string>; warnings: string[] } {
	const warnings: string[] = [];

	// Assign fresh UUIDs to each step (provides stable cross-reference within this import)
	const stepNameToId = new Map<string, string>();
	for (const step of exported.steps) {
		stepNameToId.set(step.name, generateUUID());
	}

	// Build WorkflowStepInput list — resolve agentRef names → UUIDs
	const steps: WorkflowStepInput[] = exported.steps.map((exportedStep) => {
		const agentId =
			importedAgentNameToId.get(exportedStep.agentRef) ??
			existingAgentNameToId.get(exportedStep.agentRef) ??
			null;

		if (!agentId) {
			warnings.push(
				`step "${exportedStep.name}" references unknown agent "${exportedStep.agentRef}"`
			);
		}

		const step: WorkflowStepInput = {
			id: stepNameToId.get(exportedStep.name)!,
			name: exportedStep.name,
			agentId: agentId ?? '',
		};
		if (exportedStep.instructions !== undefined) step.instructions = exportedStep.instructions;
		return step;
	});

	// Build WorkflowTransitionInput list — remap step names → new step UUIDs
	const transitions: WorkflowTransitionInput[] = exported.transitions.map((t) => {
		const tr: WorkflowTransitionInput = {
			from: stepNameToId.get(t.fromStep) ?? t.fromStep,
			to: stepNameToId.get(t.toStep) ?? t.toStep,
		};
		if (t.condition !== undefined) tr.condition = t.condition;
		if (t.order !== undefined) tr.order = t.order;
		return tr;
	});

	// Resolve startStep name → new UUID
	const startStepId = stepNameToId.get(exported.startStep);

	// Build WorkflowRuleInput list — remap appliesTo step names → new step UUIDs
	const rules: WorkflowRuleInput[] = exported.rules.map((rule) => {
		const ruleOut: WorkflowRuleInput = { name: rule.name, content: rule.content };
		if (rule.appliesTo?.length) {
			const stepIds = rule.appliesTo
				.map((stepName) => stepNameToId.get(stepName))
				.filter((id): id is string => id !== undefined);
			if (stepIds.length > 0) ruleOut.appliesTo = stepIds;
		}
		return ruleOut;
	});

	const params: CreateSpaceWorkflowParams = {
		spaceId,
		name,
		steps,
		transitions,
		rules,
		tags: exported.tags,
	};
	if (startStepId) params.startStepId = startStepId;
	if (exported.description !== undefined) params.description = exported.description;
	if (exported.config !== undefined) params.config = exported.config;

	return { params, stepNameToId, warnings };
}

/**
 * Validate cross-references and condition expressions in an exported workflow.
 * Returns a list of human-readable error strings (empty = valid).
 *
 * @param importedAgentNames - Set of agent names being imported in the same bundle
 * @param existingAgentNameToId - Map of existing agent names → UUIDs in target space
 */
function validateWorkflowForPreview(
	exported: ExportedSpaceWorkflow,
	importedAgentNames: Set<string>,
	existingAgentNameToId: Map<string, string>
): string[] {
	const errors: string[] = [];

	// Unresolved agent refs
	for (const step of exported.steps) {
		if (!importedAgentNames.has(step.agentRef) && !existingAgentNameToId.has(step.agentRef)) {
			errors.push(
				`step "${step.name}" references unknown agent "${step.agentRef}" — not found in bundle or target space`
			);
		}
	}

	// Condition expression validation (mirrors SpaceWorkflowManager.validateCondition)
	for (let i = 0; i < exported.transitions.length; i++) {
		const t = exported.transitions[i];
		if (t.condition?.type === 'condition' && !t.condition.expression?.trim()) {
			errors.push(`transition[${i}]: 'condition' type requires a non-empty expression`);
		}
	}

	return errors;
}

// ============================================================================
// Setup
// ============================================================================

export function setupSpaceExportImportHandlers(
	messageHub: MessageHub,
	spaceManager: SpaceManager,
	agentRepo: SpaceAgentRepository,
	workflowRepo: SpaceWorkflowRepository,
	workflowManager: SpaceWorkflowManager
): void {
	// ─── spaceExport.agents ──────────────────────────────────────────────────
	messageHub.onRequest('spaceExport.agents', async (data) => {
		const params = data as { spaceId: string; agentIds?: string[] };
		const space = await requireSpace(spaceManager, params.spaceId);

		let agents: SpaceAgent[] = agentRepo.getBySpaceId(params.spaceId);
		if (params.agentIds?.length) {
			const idSet = new Set(params.agentIds);
			agents = agents.filter((a) => idSet.has(a.id));
		}

		const bundle = exportBundle(agents, [], `${space.name} agents`, {
			exportedFrom: params.spaceId,
		});
		return { bundle };
	});

	// ─── spaceExport.workflows ───────────────────────────────────────────────
	messageHub.onRequest('spaceExport.workflows', async (data) => {
		const params = data as { spaceId: string; workflowIds?: string[] };
		const space = await requireSpace(spaceManager, params.spaceId);

		let workflows = workflowRepo.listWorkflows(params.spaceId);
		if (params.workflowIds?.length) {
			const idSet = new Set(params.workflowIds);
			workflows = workflows.filter((w) => idSet.has(w.id));
		}

		// All space agents are needed for correct agentId→name resolution inside exportBundle
		const allAgents = agentRepo.getBySpaceId(params.spaceId);

		// Export with full agent set so step agentRefs resolve to names, then trim the
		// bundle's agents array to only those actually referenced by the exported workflows.
		const full = exportBundle(allAgents, workflows, `${space.name} workflows`, {
			exportedFrom: params.spaceId,
		});

		const referencedNames = new Set<string>();
		for (const wf of full.workflows) {
			for (const step of wf.steps) referencedNames.add(step.agentRef);
		}

		const bundle: SpaceExportBundle = {
			...full,
			agents: full.agents.filter((a) => referencedNames.has(a.name)),
		};

		return { bundle };
	});

	// ─── spaceExport.bundle ──────────────────────────────────────────────────
	messageHub.onRequest('spaceExport.bundle', async (data) => {
		const params = data as { spaceId: string; agentIds?: string[]; workflowIds?: string[] };
		const space = await requireSpace(spaceManager, params.spaceId);

		let agents = agentRepo.getBySpaceId(params.spaceId);
		if (params.agentIds?.length) {
			const idSet = new Set(params.agentIds);
			agents = agents.filter((a) => idSet.has(a.id));
		}

		let workflows = workflowRepo.listWorkflows(params.spaceId);
		if (params.workflowIds?.length) {
			const idSet = new Set(params.workflowIds);
			workflows = workflows.filter((w) => idSet.has(w.id));
		}

		const bundle = exportBundle(agents, workflows, `${space.name} bundle`, {
			exportedFrom: params.spaceId,
		});
		return { bundle };
	});

	// ─── spaceImport.preview ─────────────────────────────────────────────────
	messageHub.onRequest('spaceImport.preview', async (data) => {
		const params = data as { bundle: unknown; spaceId: string };
		await requireSpace(spaceManager, params.spaceId);

		// Validate bundle structure and version
		const validation = validateExportBundle(params.bundle);
		if (!validation.ok) {
			const result: ImportPreviewResult = {
				agents: [],
				workflows: [],
				validationErrors: [validation.error],
			};
			return result;
		}
		const bundle = validation.value;

		// Load existing entities in target space
		const existingAgents = agentRepo.getBySpaceId(params.spaceId);
		const existingWorkflows = workflowRepo.listWorkflows(params.spaceId);

		const existingAgentByName = new Map(existingAgents.map((a) => [a.name, a]));
		const existingWorkflowByName = new Map(existingWorkflows.map((w) => [w.name, w]));
		const existingAgentNameToId = new Map(existingAgents.map((a) => [a.name, a.id]));

		// Agent previews
		const agentPreviews: ImportPreview[] = bundle.agents.map((a) => {
			const existing = existingAgentByName.get(a.name);
			if (existing) return { name: a.name, action: 'conflict', existingId: existing.id };
			return { name: a.name, action: 'create' };
		});

		// Workflow previews + validation
		const workflowPreviews: ImportPreview[] = [];
		const validationErrors: string[] = [];

		const importedAgentNames = new Set(bundle.agents.map((a) => a.name));

		for (const wf of bundle.workflows) {
			const existing = existingWorkflowByName.get(wf.name);
			if (existing) {
				workflowPreviews.push({ name: wf.name, action: 'conflict', existingId: existing.id });
			} else {
				workflowPreviews.push({ name: wf.name, action: 'create' });
			}

			// Cross-reference and condition validation
			const errors = validateWorkflowForPreview(wf, importedAgentNames, existingAgentNameToId);
			for (const err of errors) {
				validationErrors.push(`Workflow "${wf.name}": ${err}`);
			}
		}

		const result: ImportPreviewResult = {
			agents: agentPreviews,
			workflows: workflowPreviews,
			validationErrors,
		};
		return result;
	});

	// ─── spaceImport.execute ─────────────────────────────────────────────────
	messageHub.onRequest('spaceImport.execute', async (data) => {
		const params = data as {
			spaceId: string;
			bundle: unknown;
			conflictResolution?: ImportConflictResolution;
		};
		await requireSpace(spaceManager, params.spaceId);

		// Re-validate bundle (guards against stale previews)
		const validation = validateExportBundle(params.bundle);
		if (!validation.ok) {
			throw new Error(`Invalid bundle: ${validation.error}`);
		}
		const bundle = validation.value;
		const resolution = params.conflictResolution ?? {};

		// Snapshot of existing entities (before any mutations)
		const existingAgents = agentRepo.getBySpaceId(params.spaceId);
		const existingWorkflows = workflowRepo.listWorkflows(params.spaceId);

		const existingAgentByName = new Map(existingAgents.map((a) => [a.name, a]));
		const existingWorkflowByName = new Map(existingWorkflows.map((w) => [w.name, w]));
		const existingAgentNameToId = new Map(existingAgents.map((a) => [a.name, a.id]));

		// Mutable sets for uniqueness tracking across the import batch
		const usedAgentNames = new Set(existingAgents.map((a) => a.name));
		const usedWorkflowNames = new Set(existingWorkflows.map((w) => w.name));

		// ── Phase 1: import agents ──────────────────────────────────────────
		// Maps original bundle agent name → assigned UUID (used for workflow cross-refs)
		const importedAgentNameToId = new Map<string, string>();
		const agentResults: ImportedItem[] = [];

		for (const exportedAgent of bundle.agents) {
			const existing = existingAgentByName.get(exportedAgent.name);

			if (!existing) {
				// No conflict — create new agent
				const created = agentRepo.create(
					buildAgentCreateParams(params.spaceId, exportedAgent.name, exportedAgent)
				);
				usedAgentNames.add(exportedAgent.name);
				importedAgentNameToId.set(exportedAgent.name, created.id);
				agentResults.push({ name: exportedAgent.name, id: created.id, action: 'created' });
				continue;
			}

			// Conflict — apply resolution strategy (default: skip)
			const strategy: ConflictResolutionStrategy =
				resolution.agents?.[exportedAgent.name] ?? 'skip';

			if (strategy === 'skip') {
				importedAgentNameToId.set(exportedAgent.name, existing.id);
				agentResults.push({ name: exportedAgent.name, id: existing.id, action: 'skipped' });
			} else if (strategy === 'replace') {
				// Update existing agent in place (preserve its UUID and spaceId)
				const updated = agentRepo.update(existing.id, {
					role: exportedAgent.role,
					description: exportedAgent.description,
					model: exportedAgent.model,
					provider: exportedAgent.provider,
					systemPrompt: exportedAgent.systemPrompt,
					tools: exportedAgent.tools,
				});
				const id = updated?.id ?? existing.id;
				importedAgentNameToId.set(exportedAgent.name, id);
				agentResults.push({ name: exportedAgent.name, id, action: 'replaced' });
			} else {
				// rename — create with a unique name, keep original name as the bundle key
				const finalName = generateUniqueName(exportedAgent.name, usedAgentNames);
				const created = agentRepo.create(
					buildAgentCreateParams(params.spaceId, finalName, exportedAgent)
				);
				usedAgentNames.add(finalName);
				importedAgentNameToId.set(exportedAgent.name, created.id);
				agentResults.push({ name: finalName, id: created.id, action: 'renamed' });
			}
		}

		// ── Phase 2: import workflows ────────────────────────────────────────
		const workflowResults: ImportedItem[] = [];
		const allWarnings: string[] = [];

		for (const exportedWorkflow of bundle.workflows) {
			const existing = existingWorkflowByName.get(exportedWorkflow.name);

			let finalName = exportedWorkflow.name;
			let action: ImportedItem['action'] = 'created';

			if (!existing) {
				// No conflict — create as-is
			} else {
				const strategy: ConflictResolutionStrategy =
					resolution.workflows?.[exportedWorkflow.name] ?? 'skip';

				if (strategy === 'skip') {
					workflowResults.push({ name: exportedWorkflow.name, id: existing.id, action: 'skipped' });
					continue;
				}

				if (strategy === 'replace') {
					// Delete the existing workflow so the name becomes available again
					workflowRepo.deleteWorkflow(existing.id);
					usedWorkflowNames.delete(exportedWorkflow.name);
					action = 'replaced';
				} else {
					// rename
					finalName = generateUniqueName(exportedWorkflow.name, usedWorkflowNames);
					action = 'renamed';
				}
			}

			const { params: createParams, warnings } = buildWorkflowCreateParams(
				params.spaceId,
				finalName,
				exportedWorkflow,
				importedAgentNameToId,
				existingAgentNameToId
			);

			// Fail fast on unresolved agent refs — they would produce invalid DB rows
			if (warnings.length > 0) {
				for (const w of warnings) {
					allWarnings.push(`Workflow "${finalName}": ${w}`);
				}
				throw new Error(
					`Cannot import workflow "${finalName}": unresolved agent reference(s) — run spaceImport.preview to see details`
				);
			}

			// workflowManager.createWorkflow validates steps/transitions/conditions and writes to DB
			const created = workflowManager.createWorkflow(createParams);
			usedWorkflowNames.add(finalName);
			workflowResults.push({ name: finalName, id: created.id, action });
		}

		const result: ImportExecuteResult = {
			agents: agentResults,
			workflows: workflowResults,
			warnings: allWarnings,
		};
		return result;
	});
}
