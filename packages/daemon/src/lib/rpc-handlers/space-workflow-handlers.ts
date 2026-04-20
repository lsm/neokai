/**
 * Space Workflow RPC Handlers
 *
 * RPC handlers for SpaceWorkflow CRUD operations:
 * - spaceWorkflow.create    - Create a workflow in a Space
 * - spaceWorkflow.list      - List workflows in a Space
 * - spaceWorkflow.get       - Get a workflow by ID (optional spaceId: existence + ownership check)
 * - spaceWorkflow.update    - Update workflow fields (optional spaceId: existence + ownership check)
 * - spaceWorkflow.delete    - Delete a workflow (optional spaceId: existence + ownership check)
 *
 * No spaceWorkflow.setDefault — default selection is removed from the design.
 * Workflow selection uses only explicit workflowId or AI auto-select.
 *
 * Events emitted (spaceWorkflow.* namespace — matches SpaceStore subscriptions in M5):
 * - spaceWorkflow.created
 * - spaceWorkflow.updated
 * - spaceWorkflow.deleted
 */

import type { MessageHub } from '@neokai/shared';
import { generateUUID } from '@neokai/shared';
import type {
	CreateSpaceWorkflowParams,
	UpdateSpaceWorkflowParams,
	DuplicateDriftReport,
} from '@neokai/shared';
import type { DaemonHub } from '../daemon-hub';
import type { SpaceManager } from '../space/managers/space-manager';
import type { SpaceWorkflowManager } from '../space/managers/space-workflow-manager';
import type { SpaceAgentManager } from '../space/managers/space-agent-manager';
import { getBuiltInWorkflows } from '../space/workflows/built-in-workflows';
import { computeWorkflowHash } from '../space/workflows/template-hash';
import { Logger } from '../logger';

const log = new Logger('space-workflow-handlers');

export function setupSpaceWorkflowHandlers(
	messageHub: MessageHub,
	spaceManager: SpaceManager,
	workflowManager: SpaceWorkflowManager,
	daemonHub: DaemonHub,
	spaceAgentManager: SpaceAgentManager
): void {
	// ─── spaceWorkflow.create ────────────────────────────────────────────────
	messageHub.onRequest('spaceWorkflow.create', async (data) => {
		const params = data as CreateSpaceWorkflowParams;

		if (!params.spaceId) {
			throw new Error('spaceId is required');
		}
		if (!params.name || params.name.trim() === '') {
			throw new Error('name is required');
		}

		// Verify space exists
		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) {
			throw new Error(`Space not found: ${params.spaceId}`);
		}

		const workflow = workflowManager.createWorkflow(params);

		// sessionId: 'global' — spaceWorkflow.* events are global broadcast events,
		// not channel-scoped. The SpaceStore (M5) will subscribe globally and filter by spaceId.
		daemonHub
			.emit('spaceWorkflow.created', {
				sessionId: 'global',
				spaceId: params.spaceId,
				workflow,
			})
			.catch((err) => {
				log.warn('Failed to emit spaceWorkflow.created:', err);
			});

		return { workflow };
	});

	// ─── spaceWorkflow.list ──────────────────────────────────────────────────
	messageHub.onRequest('spaceWorkflow.list', async (data) => {
		const params = data as { spaceId: string };

		if (!params.spaceId) {
			throw new Error('spaceId is required');
		}

		// Verify space exists
		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) {
			throw new Error(`Space not found: ${params.spaceId}`);
		}

		const workflows = workflowManager.listWorkflows(params.spaceId);
		return { workflows };
	});

	// ─── spaceWorkflow.listBuiltInTemplates ──────────────────────────────────
	messageHub.onRequest('spaceWorkflow.listBuiltInTemplates', async (data) => {
		const params = data as { spaceId: string };

		if (!params.spaceId) {
			throw new Error('spaceId is required');
		}

		// Keep validation aligned with other spaceWorkflow.* handlers.
		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) {
			throw new Error(`Space not found: ${params.spaceId}`);
		}

		// Return canonical built-ins from the same source used by seeding.
		// Clone shallowly to avoid accidental mutation of shared constants.
		const workflows = getBuiltInWorkflows().map((workflow) => ({
			...workflow,
			nodes: workflow.nodes.map((node) => ({
				...node,
				agents: node.agents.map((agent) => ({ ...agent })),
			})),
			channels: workflow.channels ? [...workflow.channels] : undefined,
			gates: workflow.gates ? [...workflow.gates] : undefined,
			tags: [...workflow.tags],
		}));
		return { workflows };
	});

	// ─── spaceWorkflow.get ───────────────────────────────────────────────────
	messageHub.onRequest('spaceWorkflow.get', async (data) => {
		const params = data as { id: string; spaceId?: string };

		if (!params.id) {
			throw new Error('id is required');
		}

		// When spaceId is provided: verify the space exists before fetching the workflow.
		// This matches the space-task-handlers.ts pattern and surfaces "Space not found"
		// correctly instead of silently returning an orphaned workflow.
		if (params.spaceId) {
			const space = await spaceManager.getSpace(params.spaceId);
			if (!space) {
				throw new Error(`Space not found: ${params.spaceId}`);
			}
		}

		const workflow = workflowManager.getWorkflow(params.id);
		if (!workflow) {
			throw new Error(`Workflow not found: ${params.id}`);
		}

		// Ownership check — reject if caller's spaceId doesn't match the workflow's owner
		if (params.spaceId && workflow.spaceId !== params.spaceId) {
			throw new Error(`Workflow not found: ${params.id}`);
		}

		return { workflow };
	});

	// ─── spaceWorkflow.update ────────────────────────────────────────────────
	messageHub.onRequest('spaceWorkflow.update', async (data) => {
		const params = data as { id: string; spaceId?: string } & UpdateSpaceWorkflowParams;

		if (!params.id) {
			throw new Error('id is required');
		}

		// When spaceId is provided: verify space exists and ownership before mutating.
		// The ownership check requires fetching the workflow here; updateWorkflow will
		// re-fetch internally (synchronous SQLite — acceptable for this pattern).
		if (params.spaceId) {
			const space = await spaceManager.getSpace(params.spaceId);
			if (!space) {
				throw new Error(`Space not found: ${params.spaceId}`);
			}
			const existing = workflowManager.getWorkflow(params.id);
			if (!existing) {
				throw new Error(`Workflow not found: ${params.id}`);
			}
			if (existing.spaceId !== params.spaceId) {
				throw new Error(`Workflow not found: ${params.id}`);
			}
		}

		const { id, spaceId: _spaceId, ...updateParams } = params;

		const workflow = workflowManager.updateWorkflow(id, updateParams);
		if (!workflow) {
			throw new Error(`Workflow not found: ${id}`);
		}

		daemonHub
			.emit('spaceWorkflow.updated', {
				sessionId: 'global',
				spaceId: workflow.spaceId,
				workflow,
			})
			.catch((err) => {
				log.warn('Failed to emit spaceWorkflow.updated:', err);
			});

		return { workflow };
	});

	// ─── spaceWorkflow.delete ────────────────────────────────────────────────
	messageHub.onRequest('spaceWorkflow.delete', async (data) => {
		const params = data as { id: string; spaceId?: string };

		if (!params.id) {
			throw new Error('id is required');
		}

		// When spaceId is provided: verify space exists before fetching the workflow.
		if (params.spaceId) {
			const space = await spaceManager.getSpace(params.spaceId);
			if (!space) {
				throw new Error(`Space not found: ${params.spaceId}`);
			}
		}

		// Fetch before deleting — needed for the event payload and optional ownership check
		const workflow = workflowManager.getWorkflow(params.id);
		if (!workflow) {
			throw new Error(`Workflow not found: ${params.id}`);
		}

		// Ownership check
		if (params.spaceId && workflow.spaceId !== params.spaceId) {
			throw new Error(`Workflow not found: ${params.id}`);
		}

		const deleted = workflowManager.deleteWorkflow(params.id);
		if (!deleted) {
			throw new Error(`Workflow not found: ${params.id}`);
		}

		// Await so subscribers (e.g. SpaceStore in M5) see the deletion before the handler returns,
		// consistent with how spaceAgent.delete emits spaceAgent.deleted.
		await daemonHub
			.emit('spaceWorkflow.deleted', {
				sessionId: 'global',
				spaceId: workflow.spaceId,
				workflowId: params.id,
			})
			.catch((err) => {
				log.warn('Failed to emit spaceWorkflow.deleted:', err);
			});

		return { success: true };
	});

	// ─── spaceWorkflow.detectDrift ───────────────────────────────────────────
	messageHub.onRequest('spaceWorkflow.detectDrift', async (data) => {
		const params = data as { id: string; spaceId?: string };

		if (!params.id) {
			throw new Error('id is required');
		}

		const workflow = workflowManager.getWorkflow(params.id);
		if (!workflow) {
			throw new Error(`Workflow not found: ${params.id}`);
		}

		if (params.spaceId && workflow.spaceId !== params.spaceId) {
			throw new Error(`Workflow not found: ${params.id}`);
		}

		// If no template tracking, no drift possible
		if (!workflow.templateName) {
			return {
				drifted: false,
				templateName: null,
				currentTemplateHash: null,
				workflowContentHash: null,
				storedHash: workflow.templateHash ?? null,
			};
		}

		// Find the current template by name
		const templates = getBuiltInWorkflows();
		const template = templates.find((t) => t.name === workflow.templateName);
		if (!template) {
			// Template no longer exists — can't detect drift
			return {
				drifted: false,
				templateName: workflow.templateName,
				currentTemplateHash: null,
				workflowContentHash: null,
				storedHash: workflow.templateHash ?? null,
			};
		}

		// Compute current template's hash
		const currentTemplateHash = computeWorkflowHash(template);
		const workflowContentHash = computeWorkflowHash(workflow);

		// Drift if either:
		// 1. The stored template_hash differs from the current template hash (template was updated)
		// 2. The workflow content hash differs from the stored template_hash (user edited workflow)
		const storedHash = workflow.templateHash ?? null;
		const drifted = currentTemplateHash !== storedHash || workflowContentHash !== storedHash;

		return {
			drifted,
			templateName: workflow.templateName,
			currentTemplateHash,
			workflowContentHash,
			storedHash,
		};
	});

	// ─── spaceWorkflow.syncFromTemplate ─────────────────────────────────────
	messageHub.onRequest('spaceWorkflow.syncFromTemplate', async (data) => {
		const params = data as { id: string; spaceId: string };

		if (!params.id) {
			throw new Error('id is required');
		}
		if (!params.spaceId) {
			throw new Error('spaceId is required');
		}

		// Verify space exists
		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) {
			throw new Error(`Space not found: ${params.spaceId}`);
		}

		const workflow = workflowManager.getWorkflow(params.id);
		if (!workflow) {
			throw new Error(`Workflow not found: ${params.id}`);
		}
		if (workflow.spaceId !== params.spaceId) {
			throw new Error(`Workflow not found: ${params.id}`);
		}
		if (!workflow.templateName) {
			throw new Error(
				`Workflow "${workflow.name}" is not linked to a built-in template and cannot be synced.`
			);
		}

		// Find the template
		const templates = getBuiltInWorkflows();
		const template = templates.find((t) => t.name === workflow.templateName);
		if (!template) {
			throw new Error(
				`Built-in template "${workflow.templateName}" not found. It may have been removed.`
			);
		}

		// Resolve agent role names → space agent UUIDs
		const spaceAgents = spaceAgentManager.listBySpaceId(params.spaceId);
		function resolveAgentId(roleName: string): string | undefined {
			return spaceAgents.find((a) => a.name.toLowerCase() === roleName.toLowerCase())?.id;
		}

		// Build new node list from template, assigning fresh UUIDs to node IDs
		const nodeIdMap = new Map<string, string>();
		for (const node of template.nodes) {
			nodeIdMap.set(node.id, generateUUID());
		}

		const newNodes = template.nodes.map((node) => {
			const resolvedAgents = node.agents.map((a) => {
				const resolvedId = resolveAgentId(a.agentId);
				if (!resolvedId) {
					throw new Error(
						`Cannot sync: no SpaceAgent found with name "${a.agentId}" in space "${params.spaceId}".`
					);
				}
				return { ...a, agentId: resolvedId };
			});
			return {
				id: nodeIdMap.get(node.id)!,
				name: node.name,
				agents: resolvedAgents,
				...(node.completionActions ? { completionActions: node.completionActions } : {}),
			};
		});

		const newStartNodeId = nodeIdMap.get(template.startNodeId);
		if (!newStartNodeId) {
			throw new Error(`Template "${template.name}" has invalid startNodeId.`);
		}

		const newEndNodeId = template.endNodeId ? nodeIdMap.get(template.endNodeId) : undefined;

		const newChannels = template.channels
			? template.channels.map((ch) => ({ ...ch, id: ch.id ?? generateUUID() }))
			: null;

		const newGates = template.gates ? [...template.gates] : null;

		// Compute the template hash for drift tracking
		const templateHash = computeWorkflowHash(template);

		// Overwrite the workflow
		const updated = workflowManager.updateWorkflow(params.id, {
			name: template.name,
			description: template.description ?? null,
			instructions: template.instructions ?? null,
			nodes: newNodes,
			startNodeId: newStartNodeId,
			endNodeId: newEndNodeId ?? null,
			channels: newChannels,
			gates: newGates,
			tags: [...template.tags],
			templateName: workflow.templateName,
			templateHash,
		});

		if (!updated) {
			throw new Error(`Workflow not found: ${params.id}`);
		}

		daemonHub
			.emit('spaceWorkflow.updated', {
				sessionId: 'global',
				spaceId: params.spaceId,
				workflow: updated,
			})
			.catch((err) => {
				log.warn('Failed to emit spaceWorkflow.updated:', err);
			});

		return { workflow: updated };
	});

	// ─── spaceWorkflow.detectDuplicateDrift ──────────────────────────────────
	// Returns groups of workflows within a space that share a `templateName`
	// but have diverging `templateHash` values — i.e. template drift between
	// multiple rows for the same built-in template.
	//
	// This is distinct from `spaceWorkflow.detectDrift` which reports per-row
	// drift against the canonical built-in template. `detectDuplicateDrift`
	// surfaces the case where two or more rows exist and their stored hashes
	// disagree, which is the signal for "this space has a stale duplicate
	// that should be cleaned up".
	messageHub.onRequest('spaceWorkflow.detectDuplicateDrift', async (data) => {
		const params = data as { spaceId: string };

		if (!params.spaceId) {
			throw new Error('spaceId is required');
		}

		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) {
			throw new Error(`Space not found: ${params.spaceId}`);
		}

		// Only built-in templates are eligible for drift reporting — drift on
		// a user-named template has no canonical source to resync against.
		const builtInNames = new Set(getBuiltInWorkflows().map((w) => w.name));

		const workflows = workflowManager.listWorkflows(params.spaceId);

		// Group workflows by templateName.
		const byTemplate = new Map<string, typeof workflows>();
		for (const wf of workflows) {
			if (!wf.templateName) continue;
			if (!builtInNames.has(wf.templateName)) continue;
			const bucket = byTemplate.get(wf.templateName);
			if (bucket) bucket.push(wf);
			else byTemplate.set(wf.templateName, [wf]);
		}

		const reports: DuplicateDriftReport[] = [];
		for (const [templateName, rows] of byTemplate) {
			if (rows.length < 2) continue;
			// Drift = hash values diverge across rows. Rows with identical hashes
			// aren't considered drift (even though they're still technically
			// duplicates — left for separate cleanup).
			const distinctHashes = new Set(rows.map((r) => r.templateHash ?? null));
			if (distinctHashes.size < 2) continue;
			const sortedRows = [...rows].sort((a, b) => b.createdAt - a.createdAt);
			reports.push({
				templateName,
				rows: sortedRows.map((r) => ({
					id: r.id,
					templateHash: r.templateHash ?? null,
					createdAt: r.createdAt,
				})),
			});
		}

		return { reports };
	});

	// ─── spaceWorkflow.resyncDuplicates ──────────────────────────────────────
	// Resolves a duplicate-drift group by:
	//   1. Keeping the newest (by createdAt) workflow row for the given
	//      `templateName` in the space.
	//   2. Deleting every older row in the group (cascade-removing their
	//      workflow runs — which is acceptable because this is a user-initiated
	//      cleanup, gated by a confirmation dialog in the UI).
	//   3. Overwriting the kept row with the current built-in template via
	//      the same logic as `spaceWorkflow.syncFromTemplate`.
	messageHub.onRequest('spaceWorkflow.resyncDuplicates', async (data) => {
		const params = data as { spaceId: string; templateName: string };

		if (!params.spaceId) {
			throw new Error('spaceId is required');
		}
		if (!params.templateName) {
			throw new Error('templateName is required');
		}

		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) {
			throw new Error(`Space not found: ${params.spaceId}`);
		}

		// Only built-in templates can be resynced — other templateNames have
		// no canonical source to pull from.
		const builtInTemplates = getBuiltInWorkflows();
		const template = builtInTemplates.find((t) => t.name === params.templateName);
		if (!template) {
			throw new Error(
				`Built-in template "${params.templateName}" not found. Resync is only available for built-in workflows.`
			);
		}

		// Find all workflows in the space with this templateName.
		const all = workflowManager.listWorkflows(params.spaceId);
		const group = all.filter((w) => w.templateName === params.templateName);
		if (group.length === 0) {
			throw new Error(
				`No workflows found for templateName "${params.templateName}" in space "${params.spaceId}".`
			);
		}

		// Sort newest-first. Keep the first, delete the rest.
		group.sort((a, b) => b.createdAt - a.createdAt);
		const kept = group[0];
		const toDelete = group.slice(1);

		const deletedIds: string[] = [];
		for (const wf of toDelete) {
			const ok = workflowManager.deleteWorkflow(wf.id);
			if (ok) {
				deletedIds.push(wf.id);
				await daemonHub
					.emit('spaceWorkflow.deleted', {
						sessionId: 'global',
						spaceId: params.spaceId,
						workflowId: wf.id,
					})
					.catch((err) => {
						log.warn('Failed to emit spaceWorkflow.deleted:', err);
					});
			}
		}

		// If the kept row is already a verbatim copy of the template there's
		// no content to overwrite — but we still refresh the stored hash so
		// drift detection clears immediately. The overwrite below re-derives
		// everything from the template, so this is safe.
		const spaceAgents = spaceAgentManager.listBySpaceId(params.spaceId);
		function resolveAgentId(roleName: string): string | undefined {
			return spaceAgents.find((a) => a.name.toLowerCase() === roleName.toLowerCase())?.id;
		}

		const nodeIdMap = new Map<string, string>();
		for (const node of template.nodes) {
			nodeIdMap.set(node.id, generateUUID());
		}

		const newNodes = template.nodes.map((node) => {
			const resolvedAgents = node.agents.map((a) => {
				const resolvedId = resolveAgentId(a.agentId);
				if (!resolvedId) {
					throw new Error(
						`Cannot resync: no SpaceAgent found with name "${a.agentId}" in space "${params.spaceId}".`
					);
				}
				return { ...a, agentId: resolvedId };
			});
			return {
				id: nodeIdMap.get(node.id)!,
				name: node.name,
				agents: resolvedAgents,
				...(node.completionActions ? { completionActions: node.completionActions } : {}),
			};
		});

		const newStartNodeId = nodeIdMap.get(template.startNodeId);
		if (!newStartNodeId) {
			throw new Error(`Template "${template.name}" has invalid startNodeId.`);
		}
		const newEndNodeId = template.endNodeId ? nodeIdMap.get(template.endNodeId) : undefined;
		const newChannels = template.channels
			? template.channels.map((ch) => ({ ...ch, id: ch.id ?? generateUUID() }))
			: null;
		const newGates = template.gates ? [...template.gates] : null;
		const templateHash = computeWorkflowHash(template);

		const updated = workflowManager.updateWorkflow(kept.id, {
			name: template.name,
			description: template.description ?? null,
			instructions: template.instructions ?? null,
			nodes: newNodes,
			startNodeId: newStartNodeId,
			endNodeId: newEndNodeId ?? null,
			channels: newChannels,
			gates: newGates,
			tags: [...template.tags],
			templateName: template.name,
			templateHash,
		});

		if (!updated) {
			throw new Error(`Workflow not found: ${kept.id}`);
		}

		daemonHub
			.emit('spaceWorkflow.updated', {
				sessionId: 'global',
				spaceId: params.spaceId,
				workflow: updated,
			})
			.catch((err) => {
				log.warn('Failed to emit spaceWorkflow.updated:', err);
			});

		return { workflow: updated, keptWorkflowId: kept.id, deletedIds };
	});
}
