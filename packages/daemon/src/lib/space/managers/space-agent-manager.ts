/**
 * Space Agent Manager
 *
 * Business logic for creating, updating, and deleting Space agents.
 * Enforces:
 *   - Name uniqueness within a Space
 *   - Tool names must come from KNOWN_TOOLS
 *   - Model must be recognized (if models cache is populated)
 *   - Deletion blocked when agent is referenced by workflow steps
 */

import { KNOWN_TOOLS } from '@neokai/shared';
import type { SpaceAgent, CreateSpaceAgentParams, UpdateSpaceAgentParams } from '@neokai/shared';
import type { SpaceAgentRepository } from '../../../storage/repositories/space-agent-repository';
import { getAvailableModels } from '../../model-service';

export type SpaceAgentResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: string; details?: string[] };

export class SpaceAgentManager {
	constructor(private repo: SpaceAgentRepository) {}

	/**
	 * Create a new agent within a Space.
	 */
	create(params: CreateSpaceAgentParams): SpaceAgentResult<SpaceAgent> {
		// Validate name uniqueness
		const nameError = this.validateNameUnique(params.spaceId, params.name);
		if (nameError) return { ok: false, error: nameError };

		// Validate tools
		const toolsError = this.validateTools(params.tools);
		if (toolsError) return { ok: false, error: toolsError.error, details: toolsError.details };

		// Validate model (advisory — only when models cache is populated)
		if (params.model) {
			const modelError = this.validateModel(params.model);
			if (modelError) return { ok: false, error: modelError };
		}

		const agent = this.repo.create(params);
		return { ok: true, value: agent };
	}

	/**
	 * Update an existing agent.
	 */
	update(id: string, params: UpdateSpaceAgentParams): SpaceAgentResult<SpaceAgent> {
		const existing = this.repo.getById(id);
		if (!existing) return { ok: false, error: `Agent not found: ${id}` };

		// Validate name uniqueness if name is being changed
		if (params.name !== undefined && params.name !== existing.name) {
			const nameError = this.validateNameUnique(existing.spaceId, params.name, id);
			if (nameError) return { ok: false, error: nameError };
		}

		// Validate tools if being updated
		if (params.tools !== undefined) {
			const toolsError = this.validateTools(params.tools);
			if (toolsError) return { ok: false, error: toolsError.error, details: toolsError.details };
		}

		// Validate model if being updated (advisory — only when cache is populated)
		if (params.model) {
			const modelError = this.validateModel(params.model);
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
				error: `Cannot delete agent "${existing.name}" — it is referenced by workflow steps`,
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

	private validateNameUnique(spaceId: string, name: string, excludeId?: string): string | null {
		const existing = this.repo.getBySpaceId(spaceId);
		const conflict = existing.find(
			(a) => a.name.toLowerCase() === name.toLowerCase() && a.id !== excludeId
		);
		return conflict ? `An agent named "${name}" already exists in this Space` : null;
	}

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

	private validateModel(model: string): string | null {
		const available = getAvailableModels('global');
		// If the cache is empty (models not yet loaded), skip validation
		if (available.length === 0) return null;
		const found = available.find((m) => m.id === model || m.alias === model);
		return found ? null : `Unrecognized model: "${model}"`;
	}
}
