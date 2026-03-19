/**
 * Space Agent Manager
 *
 * Business logic for creating, updating, and deleting Space agents.
 * Enforces:
 *   - Name uniqueness within a Space (DB-level check via LOWER())
 *   - Tool names must come from KNOWN_TOOLS
 *   - Model must be recognized; when a provider is also given, validation is
 *     scoped to that provider via the provider-aware isValidModel() API
 *   - Deletion blocked when agent is referenced by workflow steps
 */

import { KNOWN_TOOLS } from '@neokai/shared';
import type { SpaceAgent, CreateSpaceAgentParams, UpdateSpaceAgentParams } from '@neokai/shared';
import type { SpaceAgentRepository } from '../../../storage/repositories/space-agent-repository';
import { isValidModel, getAvailableModels } from '../../model-service';

export type SpaceAgentResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: string; details?: string[] };

export class SpaceAgentManager {
	constructor(private repo: SpaceAgentRepository) {}

	/**
	 * Create a new agent within a Space.
	 */
	async create(params: CreateSpaceAgentParams): Promise<SpaceAgentResult<SpaceAgent>> {
		// Validate name uniqueness (DB-level, case-insensitive)
		if (this.repo.isNameTaken(params.spaceId, params.name)) {
			return {
				ok: false,
				error: `An agent named "${params.name}" already exists in this Space`,
			};
		}

		// Validate tools
		const toolsError = this.validateTools(params.tools);
		if (toolsError) return { ok: false, error: toolsError.error, details: toolsError.details };

		// Validate model (provider-aware when provider is supplied)
		if (params.model) {
			const modelError = await this.validateModel(params.model, params.provider);
			if (modelError) return { ok: false, error: modelError };
		}

		const agent = this.repo.create(params);
		return { ok: true, value: agent };
	}

	/**
	 * Update an existing agent.
	 */
	async update(id: string, params: UpdateSpaceAgentParams): Promise<SpaceAgentResult<SpaceAgent>> {
		const existing = this.repo.getById(id);
		if (!existing) return { ok: false, error: `Agent not found: ${id}` };

		// Validate name uniqueness if name is being changed
		if (params.name !== undefined && params.name !== existing.name) {
			if (this.repo.isNameTaken(existing.spaceId, params.name, id)) {
				return {
					ok: false,
					error: `An agent named "${params.name}" already exists in this Space`,
				};
			}
		}

		// Validate tools if being updated
		if (params.tools !== undefined) {
			const toolsError = this.validateTools(params.tools);
			if (toolsError) return { ok: false, error: toolsError.error, details: toolsError.details };
		}

		// Validate model if being set to a non-null value
		// Use updated provider if provided; otherwise fall back to existing agent's provider
		if (params.model) {
			const provider =
				params.provider !== undefined ? (params.provider ?? undefined) : existing.provider;
			const modelError = await this.validateModel(params.model, provider);
			if (modelError) return { ok: false, error: modelError };
		}

		const updated = this.repo.update(id, params);
		if (!updated) return { ok: false, error: `Agent not found after update: ${id}` };
		return { ok: true, value: updated };
	}

	/**
	 * Delete an agent, unless it is referenced by workflow steps.
	 */
	delete(id: string): SpaceAgentResult<void> {
		const existing = this.repo.getById(id);
		if (!existing) return { ok: false, error: `Agent not found: ${id}` };

		const { referenced, workflowNames } = this.repo.isAgentReferenced(id);
		if (referenced) {
			return {
				ok: false,
				error: `Cannot delete agent "${existing.name}" - it is referenced by workflow steps`,
				details: workflowNames.map((n) => `Workflow: ${n}`),
			};
		}

		this.repo.delete(id);
		return { ok: true, value: undefined };
	}

	/**
	 * Get a single agent by ID.
	 */
	getById(id: string): SpaceAgent | null {
		return this.repo.getById(id);
	}

	/**
	 * List all agents for a space.
	 */
	listBySpaceId(spaceId: string): SpaceAgent[] {
		return this.repo.getBySpaceId(spaceId);
	}

	/**
	 * Batch-fetch agents by IDs.
	 */
	getAgentsByIds(ids: string[]): SpaceAgent[] {
		return this.repo.getAgentsByIds(ids);
	}

	// ---------------------------------------------------------------------------
	// Private helpers
	// ---------------------------------------------------------------------------

	private validateTools(tools?: string[]): { error: string; details: string[] } | null {
		if (!tools || tools.length === 0) return null;
		const knownSet = new Set<string>(KNOWN_TOOLS);
		const unknown = tools.filter((t) => !knownSet.has(t));
		if (unknown.length === 0) return null;
		return {
			error: `Unknown tools: ${unknown.join(', ')}`,
			details: unknown.map((t) => `"${t}" is not a recognized tool`),
		};
	}

	/**
	 * Validate that a model is recognized.
	 * Skips validation entirely when the models cache is empty (not yet loaded).
	 * When a provider is known, uses the provider-aware isValidModel() API so
	 * that e.g. a GLM model cannot be validated as an Anthropic model.
	 * Falls back to a synchronous unfiltered check when no provider is given.
	 */
	private async validateModel(model: string, provider?: string | null): Promise<string | null> {
		// Skip all validation if the models cache is not yet populated
		const available = getAvailableModels('global');
		if (available.length === 0) return null;

		if (provider) {
			// Provider-aware async validation
			const valid = await isValidModel(model, 'global', provider);
			return valid ? null : `Unrecognized model "${model}" for provider "${provider}"`;
		}

		// No provider — unfiltered synchronous check
		const found = available.find((m) => m.id === model || m.alias === model);
		return found ? null : `Unrecognized model: "${model}"`;
	}
}
