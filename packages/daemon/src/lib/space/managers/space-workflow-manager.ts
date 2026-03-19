/**
 * SpaceWorkflowManager
 *
 * Business logic layer for SpaceWorkflow operations within a Space.
 *
 * Responsibilities:
 * - Validate workflow integrity (unique name, step agent refs, gate security)
 * - Enforce default workflow invariants (single default per space)
 * - Protect custom agents that are referenced by steps
 */

import type {
	SpaceWorkflow,
	WorkflowGate,
	WorkflowStepInput,
	CreateSpaceWorkflowParams,
	UpdateSpaceWorkflowParams,
	BuiltinAgentRole,
} from '@neokai/shared';
import type { SpaceWorkflowRepository } from '../../../storage/repositories/space-workflow-repository';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Valid builtin agent roles for workflow steps.
 * NOTE: 'leader' is intentionally excluded — it is always implicit in SpaceRuntime.
 */
const VALID_BUILTIN_ROLES: ReadonlySet<BuiltinAgentRole> = new Set(['planner', 'coder', 'general']);

/**
 * Allowlisted command prefixes for quality_check gates.
 * Commands must start with one of these prefixes to be accepted.
 */
const QUALITY_CHECK_ALLOWLIST: readonly string[] = [
	'bun test',
	'bun run',
	'npm test',
	'npm run',
	'npx ',
	'yarn test',
	'yarn run',
	'pnpm test',
	'pnpm run',
	'make ',
	'cargo test',
	'cargo check',
	'go test',
	'pytest',
	'python -m pytest',
	'tsc',
	'biome ',
	'eslint ',
	'oxlint ',
];

/** Maximum allowed timeout for gate evaluation (ms) */
const MAX_GATE_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Dependency interfaces
// ---------------------------------------------------------------------------

/**
 * Minimal interface the manager needs from SpaceAgentManager to validate
 * custom agent references in workflow steps.
 */
export interface SpaceAgentLookup {
	/** Returns the SpaceAgent with the given name in the given space, or null if not found. */
	getAgentByName(spaceId: string, name: string): { id: string; name: string } | null;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class WorkflowValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WorkflowValidationError';
	}
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class SpaceWorkflowManager {
	constructor(
		private repo: SpaceWorkflowRepository,
		private agentLookup: SpaceAgentLookup | null = null
	) {}

	// -------------------------------------------------------------------------
	// Create
	// -------------------------------------------------------------------------

	createWorkflow(params: CreateSpaceWorkflowParams): SpaceWorkflow {
		const trimmedName = params.name.trim();
		this.validateName(params.spaceId, trimmedName, null);
		this.validateSteps(params.spaceId, params.steps ?? []);

		// If this new workflow should be the default, unset any current default first
		if (params.isDefault) {
			this.repo.clearDefaultWorkflow(params.spaceId);
		}

		return this.repo.createWorkflow({ ...params, name: trimmedName });
	}

	// -------------------------------------------------------------------------
	// Read
	// -------------------------------------------------------------------------

	getWorkflow(id: string): SpaceWorkflow | null {
		return this.repo.getWorkflow(id);
	}

	listWorkflows(spaceId: string): SpaceWorkflow[] {
		return this.repo.listWorkflows(spaceId);
	}

	getDefaultWorkflow(spaceId: string): SpaceWorkflow | null {
		return this.repo.getDefaultWorkflow(spaceId);
	}

	// -------------------------------------------------------------------------
	// Update
	// -------------------------------------------------------------------------

	updateWorkflow(id: string, params: UpdateSpaceWorkflowParams): SpaceWorkflow | null {
		const existing = this.repo.getWorkflow(id);
		if (!existing) return null;

		if (params.name !== undefined) {
			const trimmedName = params.name.trim();
			this.validateName(existing.spaceId, trimmedName, id);
			params = { ...params, name: trimmedName };
		}
		if (params.steps !== undefined) {
			// UpdateSpaceWorkflowParams uses WorkflowStep[] (with id/order) — treat as inputs
			const inputs: WorkflowStepInput[] = (params.steps ?? []).map((s): WorkflowStepInput => {
				if (s.agentRefType === 'custom') {
					return {
						name: s.name,
						agentRefType: 'custom',
						agentRef: s.agentRef,
						entryGate: s.entryGate,
						exitGate: s.exitGate,
						instructions: s.instructions,
					};
				}
				return {
					name: s.name,
					agentRefType: 'builtin',
					agentRef: s.agentRef,
					entryGate: s.entryGate,
					exitGate: s.exitGate,
					instructions: s.instructions,
				};
			});
			this.validateSteps(existing.spaceId, inputs);
		}

		// If switching isDefault to true, clear any existing default
		if (params.isDefault === true && !existing.isDefault) {
			this.repo.clearDefaultWorkflow(existing.spaceId);
		}

		return this.repo.updateWorkflow(id, params);
	}

	// -------------------------------------------------------------------------
	// Delete
	// -------------------------------------------------------------------------

	deleteWorkflow(id: string): boolean {
		const existing = this.repo.getWorkflow(id);
		if (!existing) return false;

		const deleted = this.repo.deleteWorkflow(id);

		// If we deleted the default workflow, the foreign key CASCADE handles DB cleanup.
		// No further action needed — callers can create a new default if desired.

		return deleted;
	}

	// -------------------------------------------------------------------------
	// Default workflow management
	// -------------------------------------------------------------------------

	/**
	 * Set a workflow as the default for its space.
	 * Atomically clears any previous default and marks the new one.
	 */
	setDefaultWorkflow(spaceId: string, workflowId: string): boolean {
		return this.repo.setDefaultWorkflow(spaceId, workflowId);
	}

	// -------------------------------------------------------------------------
	// Agent reference protection
	// -------------------------------------------------------------------------

	/**
	 * Returns all workflows whose steps reference the given custom agent.
	 * Used by SpaceAgentManager to block deletion of in-use agents.
	 */
	getWorkflowsReferencingAgent(agentId: string): SpaceWorkflow[] {
		return this.repo.getWorkflowsReferencingAgent(agentId);
	}

	// -------------------------------------------------------------------------
	// Validation
	// -------------------------------------------------------------------------

	private validateName(spaceId: string, name: string, excludeId: string | null): void {
		const trimmed = name.trim();
		if (!trimmed) {
			throw new WorkflowValidationError('Workflow name must not be empty');
		}
		const existing = this.repo.listWorkflows(spaceId);
		for (const wf of existing) {
			if (wf.name === trimmed && wf.id !== excludeId) {
				throw new WorkflowValidationError(
					`A workflow named "${trimmed}" already exists in this space`
				);
			}
		}
	}

	private validateSteps(spaceId: string, steps: WorkflowStepInput[]): void {
		if (steps.length === 0) {
			throw new WorkflowValidationError('A workflow must have at least one step');
		}

		for (let i = 0; i < steps.length; i++) {
			const step = steps[i];
			this.validateStepAgentRef(spaceId, step, i);
			if (step.entryGate) this.validateGate(step.entryGate, `step[${i}].entryGate`);
			if (step.exitGate) this.validateGate(step.exitGate, `step[${i}].exitGate`);
		}
	}

	private validateStepAgentRef(spaceId: string, step: WorkflowStepInput, index: number): void {
		if (step.agentRefType === 'builtin') {
			if (!VALID_BUILTIN_ROLES.has(step.agentRef as BuiltinAgentRole)) {
				throw new WorkflowValidationError(
					`step[${index}]: invalid builtin agentRef "${step.agentRef}". ` +
						`Must be one of: ${[...VALID_BUILTIN_ROLES].join(', ')}. ` +
						`Note: 'leader' is not a valid workflow step agent.`
				);
			}
		} else {
			// custom ref — validate that a SpaceAgent with this name exists
			if (!step.agentRef || !step.agentRef.trim()) {
				throw new WorkflowValidationError(
					`step[${index}]: custom agentRef must be a non-empty SpaceAgent name`
				);
			}
			if (this.agentLookup) {
				const agent = this.agentLookup.getAgentByName(spaceId, step.agentRef);
				if (!agent) {
					throw new WorkflowValidationError(
						`step[${index}]: custom agentRef "${step.agentRef}" does not match any SpaceAgent in this space`
					);
				}
			}
		}
	}

	private validateGate(gate: WorkflowGate, location: string): void {
		if (gate.timeoutMs !== undefined) {
			if (gate.timeoutMs < 0 || gate.timeoutMs > MAX_GATE_TIMEOUT_MS) {
				throw new WorkflowValidationError(
					`${location}: timeoutMs must be between 0 and ${MAX_GATE_TIMEOUT_MS}, got ${gate.timeoutMs}`
				);
			}
		}

		if (gate.type === 'quality_check') {
			if (!gate.command || !gate.command.trim()) {
				throw new WorkflowValidationError(`${location}: quality_check gate requires a command`);
			}
			if (!this.isAllowlistedCommand(gate.command)) {
				throw new WorkflowValidationError(
					`${location}: quality_check gate command "${gate.command}" is not in the allowlist. ` +
						`Allowlisted prefixes: ${QUALITY_CHECK_ALLOWLIST.join(', ')}`
				);
			}
		}

		if (gate.type === 'custom') {
			if (!gate.command || !gate.command.trim()) {
				throw new WorkflowValidationError(
					`${location}: custom gate requires a command (relative path to script)`
				);
			}
			this.validateCustomGateCommand(gate.command, location);
		}
	}

	private isAllowlistedCommand(command: string): boolean {
		const trimmed = command.trim().toLowerCase();
		if (!QUALITY_CHECK_ALLOWLIST.some((prefix) => trimmed.startsWith(prefix.toLowerCase()))) {
			return false;
		}
		// Reject shell metacharacters that could be used to inject arbitrary commands.
		// The gate executor is expected to run the command directly (not via a shell),
		// but we validate here so that stored commands are safe regardless of executor.
		if (/[;&|`$<>\\]/.test(command)) {
			return false;
		}
		return true;
	}

	private validateCustomGateCommand(command: string, location: string): void {
		const trimmed = command.trim();

		// Must be a relative path (not absolute)
		if (trimmed.startsWith('/')) {
			throw new WorkflowValidationError(
				`${location}: custom gate command must be a relative path, not absolute: "${trimmed}"`
			);
		}

		// Must not contain '..' traversal
		const parts = trimmed.split(/[/\\]/);
		for (const part of parts) {
			if (part === '..') {
				throw new WorkflowValidationError(
					`${location}: custom gate command must not contain '..' path traversal: "${trimmed}"`
				);
			}
		}

		// Should start with './' for clarity
		if (!trimmed.startsWith('./') && !trimmed.startsWith('.\\')) {
			throw new WorkflowValidationError(
				`${location}: custom gate command must start with './' (relative to workspace root): "${trimmed}"`
			);
		}
	}
}
