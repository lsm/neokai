/**
 * Space Agent RPC Handlers
 *
 * RPC handlers for Space agent CRUD operations:
 * - spaceAgent.create  - Create an agent in a Space
 * - spaceAgent.list    - List all agents in a Space
 * - spaceAgent.get     - Get a single agent by ID
 * - spaceAgent.update  - Update an agent's fields
 * - spaceAgent.delete  - Delete an agent (error if referenced by workflows)
 */

import type { MessageHub } from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { SpaceAgentManager } from '../space/managers/space-agent-manager';
import { Logger } from '../logger';

const log = new Logger('space-agent-handlers');

export function setupSpaceAgentHandlers(
	messageHub: MessageHub,
	daemonHub: DaemonHub,
	spaceAgentManager: SpaceAgentManager
): void {
	// spaceAgent.create — create a new agent within a Space
	messageHub.onRequest('spaceAgent.create', async (data) => {
		const params = data as {
			spaceId: string;
			name: string;
			role: string;
			description?: string;
			model?: string;
			provider?: string;
			toolConfig?: Record<string, unknown>;
			systemPrompt?: string;
		};

		if (!params.spaceId) throw new Error('spaceId is required');
		if (!params.name) throw new Error('name is required');
		if (!params.role) throw new Error('role is required');

		const result = await spaceAgentManager.create({
			spaceId: params.spaceId,
			name: params.name,
			role: params.role as import('@neokai/shared').BuiltinAgentRole,
			description: params.description,
			model: params.model,
			provider: params.provider,
			toolConfig: params.toolConfig,
			systemPrompt: params.systemPrompt,
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
			role?: string;
			model?: string | null;
			provider?: string | null;
			toolConfig?: Record<string, unknown> | null;
			systemPrompt?: string | null;
		};

		if (!params.id) throw new Error('id is required');

		const { id, ...updateFields } = params;
		const result = await spaceAgentManager.update(id, {
			name: updateFields.name,
			description: updateFields.description,
			role: updateFields.role as import('@neokai/shared').BuiltinAgentRole | undefined,
			model: updateFields.model,
			provider: updateFields.provider,
			toolConfig: updateFields.toolConfig,
			systemPrompt: updateFields.systemPrompt,
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

	// spaceAgent.delete — delete an agent (blocked if referenced by workflows)
	messageHub.onRequest('spaceAgent.delete', async (data) => {
		const params = data as { id: string };
		if (!params.id) throw new Error('id is required');

		// Capture spaceId before deleting
		const existing = spaceAgentManager.getById(params.id);
		if (!existing) throw new Error(`Agent not found: ${params.id}`);

		const result = spaceAgentManager.delete(params.id);
		if (!result.ok) {
			const detailsMsg = result.details?.length ? `\n${result.details.join('\n')}` : '';
			throw new Error(`${result.error}${detailsMsg}`);
		}

		daemonHub
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
