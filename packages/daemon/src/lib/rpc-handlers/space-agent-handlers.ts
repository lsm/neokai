/**
 * Space Agent RPC Handlers
 *
 * RPC handlers for Space agent CRUD operations:
 * - spaceAgent.listBuiltInTemplates - List built-in agent templates from seeding source
 * - spaceAgent.create           - Create an agent in a Space
 * - spaceAgent.list             - List all agents in a Space
 * - spaceAgent.get              - Get a single agent by ID
 * - spaceAgent.update           - Update an agent's fields
 * - spaceAgent.delete           - Delete an agent (error if referenced by workflows)
 * - spaceAgent.getDriftReport   - Compare preset-tracked agents to live preset definitions
 * - spaceAgent.syncFromTemplate - Reset a preset-tracked agent to the current preset definition
 */

import type { MessageHub } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { SpaceAgentManager } from '../space/managers/space-agent-manager';
import type { SpaceManager } from '../space/managers/space-manager';
import { getPresetAgentTemplates } from '../space/agents/seed-agents';
import { Logger } from '../logger';

const log = new Logger('space-agent-handlers');

export function setupSpaceAgentHandlers(
	messageHub: MessageHub,
	daemonHub: DaemonHub,
	spaceAgentManager: SpaceAgentManager,
	spaceManager: SpaceManager
): void {
	// spaceAgent.listBuiltInTemplates — return built-in templates from seeding source
	messageHub.onRequest('spaceAgent.listBuiltInTemplates', async (data) => {
		const params = data as { spaceId: string };
		if (!params.spaceId) throw new Error('spaceId is required');

		// Keep validation consistent with spaceWorkflow.listBuiltInTemplates.
		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) throw new Error(`Space not found: ${params.spaceId}`);

		return { templates: getPresetAgentTemplates() };
	});

	// spaceAgent.create — create a new agent within a Space
	messageHub.onRequest('spaceAgent.create', async (data) => {
		const params = data as {
			spaceId: string;
			name: string;
			description?: string;
			model?: string;
			thinkingLevel?: import('@neokai/shared').ThinkingLevel;
			provider?: string;
			customPrompt?: string | null;
		};

		if (!params.spaceId) throw new Error('spaceId is required');
		if (!params.name) throw new Error('name is required');

		const result = await spaceAgentManager.create({
			spaceId: params.spaceId,
			name: params.name,
			description: params.description,
			model: params.model,
			thinkingLevel: params.thinkingLevel,
			provider: params.provider,
			customPrompt: params.customPrompt,
		});

		if (!result.ok) throw new Error(result.error);

		daemonHub
			.emit('spaceAgent.created', {
				sessionId: `space:${result.value.spaceId}`,
				spaceId: result.value.spaceId,
				agent: result.value,
			})
			.catch((err) => {
				log.warn('Failed to emit spaceAgent.created:', err);
			});

		return { agent: result.value };
	});

	// spaceAgent.list — list all agents for a Space
	messageHub.onRequest('spaceAgent.list', async (data) => {
		const params = data as { spaceId: string };
		if (!params.spaceId) throw new Error('spaceId is required');

		const agents = spaceAgentManager.listBySpaceId(params.spaceId);
		return { agents };
	});

	// spaceAgent.get — get a single agent by ID
	messageHub.onRequest('spaceAgent.get', async (data) => {
		const params = data as { id: string };
		if (!params.id) throw new Error('id is required');

		const agent = spaceAgentManager.getById(params.id);
		if (!agent) throw new Error(`Agent not found: ${params.id}`);

		return { agent };
	});

	// spaceAgent.update — update an existing agent
	messageHub.onRequest('spaceAgent.update', async (data) => {
		const params = data as {
			id: string;
			name?: string;
			description?: string | null;
			model?: string | null;
			thinkingLevel?: import('@neokai/shared').ThinkingLevel | null;
			provider?: string | null;
			customPrompt?: string | null;
		};

		if (!params.id) throw new Error('id is required');

		const { id, ...updateFields } = params;
		const result = await spaceAgentManager.update(id, {
			name: updateFields.name,
			description: updateFields.description,
			model: updateFields.model,
			thinkingLevel: updateFields.thinkingLevel,
			provider: updateFields.provider,
			customPrompt: updateFields.customPrompt,
		});

		if (!result.ok) throw new Error(result.error);

		daemonHub
			.emit('spaceAgent.updated', {
				sessionId: `space:${result.value.spaceId}`,
				spaceId: result.value.spaceId,
				agent: result.value,
			})
			.catch((err) => {
				log.warn('Failed to emit spaceAgent.updated:', err);
			});

		return { agent: result.value };
	});

	// spaceAgent.getDriftReport — list preset-tracked agents and whether each
	// has drifted from the source preset definition in code.
	messageHub.onRequest('spaceAgent.getDriftReport', async (data) => {
		const params = data as { spaceId: string };
		if (!params.spaceId) throw new Error('spaceId is required');

		// Validate space ownership for consistency with the rest of the
		// spaceAgent.* handlers — keeps unauthenticated drift queries from
		// leaking the existence of preset-tracked agents.
		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) throw new Error(`Space not found: ${params.spaceId}`);

		const report = spaceAgentManager.getAgentDriftReport(params.spaceId);
		return { report };
	});

	// spaceAgent.syncFromTemplate — reset a preset-tracked agent to the
	// current preset definition (description, tools, customPrompt) and
	// re-stamp its template_hash. Throws if the agent has no template_name
	// or the named preset no longer exists in code.
	messageHub.onRequest('spaceAgent.syncFromTemplate', async (data) => {
		const params = data as { spaceId: string; agentId: string };
		if (!params.spaceId) throw new Error('spaceId is required');
		if (!params.agentId) throw new Error('agentId is required');

		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) throw new Error(`Space not found: ${params.spaceId}`);

		// Defensive: verify the agent actually belongs to this space before
		// running the sync. SpaceAgentManager.syncFromTemplate operates on the
		// agent ID alone, so this check prevents one space from rewriting
		// another space's agent via a forged spaceId.
		const existing = spaceAgentManager.getById(params.agentId);
		if (!existing) throw new Error(`Agent not found: ${params.agentId}`);
		if (existing.spaceId !== params.spaceId) {
			throw new Error(`Agent not found: ${params.agentId}`);
		}

		const result = await spaceAgentManager.syncFromTemplate(params.agentId);
		if (!result.ok) throw new Error(result.error);

		daemonHub
			.emit('spaceAgent.updated', {
				sessionId: `space:${result.value.spaceId}`,
				spaceId: result.value.spaceId,
				agent: result.value,
			})
			.catch((err) => {
				log.warn('Failed to emit spaceAgent.updated:', err);
			});

		return { agent: result.value };
	});

	// spaceAgent.delete — delete an agent (blocked if referenced by workflows)
	messageHub.onRequest('spaceAgent.delete', async (data) => {
		const params = data as { id: string };
		if (!params.id) throw new Error('id is required');

		// Pre-fetch to capture spaceId for the event payload.
		// SpaceAgentManager.delete() also calls getById internally; the two reads
		// are synchronous SQLite operations and the pre-fetch ensures we always
		// have the spaceId for event routing even after the row is removed.
		const existing = spaceAgentManager.getById(params.id);
		if (!existing) throw new Error(`Agent not found: ${params.id}`);

		const result = spaceAgentManager.delete(params.id);
		if (!result.ok) {
			const detailsMsg = result.details?.length ? `\n${result.details.join('\n')}` : '';
			throw new Error(`${result.error}${detailsMsg}`);
		}

		// Await the event so subscribers (e.g. StateManager) see it before the
		// handler returns — consistent with how room.delete emits room.deleted.
		await daemonHub
			.emit('spaceAgent.deleted', {
				sessionId: `space:${existing.spaceId}`,
				spaceId: existing.spaceId,
				agentId: params.id,
			})
			.catch((err) => {
				log.warn('Failed to emit spaceAgent.deleted:', err);
			});

		return { success: true };
	});
}
