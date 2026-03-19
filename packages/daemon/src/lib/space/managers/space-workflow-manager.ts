/**
 * SpaceWorkflowManager
 *
 * Business logic layer for SpaceWorkflow operations within a Space.
 *
 * Responsibilities:
 * - Validate workflow integrity (unique name, step agent refs, gate security)
 * - Protect custom agents that are referenced by steps
 *
 * Workflow selection: either explicit workflowId provided by the caller, or
 * AI auto-select at runtime via list_workflows + start_workflow_run. There is
 * no default workflow concept.
 */

import type {
	SpaceWorkflow,
	WorkflowGate,
	WorkflowStepInput,
	CreateSpaceWorkflowParams,
	UpdateSpaceWorkflowParams,
} from '@neokai/shared';
import type { SpaceWorkflowRepository } from '../../../storage/repositories/space-workflow-repository';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Allowlisted command prefixes for quality_check gates.
 * Commands must start with one of these prefixes to be accepted.
 *
 * Each entry ends with a space (or is already a full command word) so that
 * prefix matching cannot be satisfied by a command that merely *starts with*
 * the same letters (e.g., 'tsc-wrapper' must not match 'tsc ').
 */
const QUALITY_CHECK_ALLOWLIST: readonly string[] = [
	'bun test',
	'bun run ',
	'npm test',
	'npm run ',
	'npx ',
	'yarn test',
	'yarn run ',
	'pnpm test',
	'pnpm run ',
	'make ',
	'cargo test',
	'cargo check',
	'go test ',
	'pytest ',
	'python -m pytest',
	'tsc ',
	'biome ',
	'eslint ',
	'oxlint ',
];

/**
 * Shell metacharacters (and control characters) that are rejected in gate
 * commands regardless of gate type.  The gate executor is expected to invoke
 * commands directly without a shell, but we validate at storage time so that
 * stored commands are safe even if the execution path changes.
 *
 * Covers: ; & | ` $ < > \ and the newline/carriage-return control characters.
 */
const SHELL_METACHAR_RE = /[;&|`$<>\\\n\r]/;

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
	/** Returns the SpaceAgent with the given UUID in the given space, or null if not found. */
	getAgentById(spaceId: string, id: string): { id: string; name: string } | null;
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
			const inputs: WorkflowStepInput[] = (params.steps ?? []).map(
				(s): WorkflowStepInput => ({
					name: s.name,
					agentId: s.agentId,
					entryGate: s.entryGate,
					exitGate: s.exitGate,
					instructions: s.instructions,
				})
			);
			this.validateSteps(existing.spaceId, inputs);
		}

		return this.repo.updateWorkflow(id, params);
	}

	// -------------------------------------------------------------------------
	// Delete
	// -------------------------------------------------------------------------

	deleteWorkflow(id: string): boolean {
		const existing = this.repo.getWorkflow(id);
		if (!existing) return false;
		return this.repo.deleteWorkflow(id);
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
		// name is already trimmed by callers (createWorkflow / updateWorkflow)
		if (!name) {
			throw new WorkflowValidationError('Workflow name must not be empty');
		}
		const existing = this.repo.listWorkflows(spaceId);
		for (const wf of existing) {
			if (wf.name === name && wf.id !== excludeId) {
				throw new WorkflowValidationError(
					`A workflow named "${name}" already exists in this space`
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
		if (!step.agentId || !step.agentId.trim()) {
			throw new WorkflowValidationError(
				`step[${index}]: agentId must be a non-empty SpaceAgent UUID`
			);
		}
		if (this.agentLookup) {
			const agent = this.agentLookup.getAgentById(spaceId, step.agentId);
			if (!agent) {
				throw new WorkflowValidationError(
					`step[${index}]: agentId "${step.agentId}" does not match any SpaceAgent in this space`
				);
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
		if (SHELL_METACHAR_RE.test(command)) {
			return false;
		}
		return true;
	}

	private validateCustomGateCommand(command: string, location: string): void {
		const trimmed = command.trim();

		// Reject shell metacharacters and control characters in the path.
		if (SHELL_METACHAR_RE.test(trimmed)) {
			throw new WorkflowValidationError(
				`${location}: custom gate command must not contain shell metacharacters or control characters: "${trimmed}"`
			);
		}

		// Must be a relative path (not absolute)
		if (trimmed.startsWith('/')) {
			throw new WorkflowValidationError(
				`${location}: custom gate command must be a relative path, not absolute: "${trimmed}"`
			);
		}

		// Must not contain '..' traversal
		const parts = trimmed.split(/[/]/);
		for (const part of parts) {
			if (part === '..') {
				throw new WorkflowValidationError(
					`${location}: custom gate command must not contain '..' path traversal: "${trimmed}"`
				);
			}
		}

		// Should start with './' for clarity
		if (!trimmed.startsWith('./')) {
			throw new WorkflowValidationError(
				`${location}: custom gate command must start with './' (relative to workspace root): "${trimmed}"`
			);
		}
	}
}
