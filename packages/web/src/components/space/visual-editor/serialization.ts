/**
 * Serialization helpers for converting between the visual editor's internal
 * state and the SpaceWorkflow / CreateSpaceWorkflowParams / UpdateSpaceWorkflowParams
 * data model used by the backend.
 *
 * Key design decisions:
 * - `startNodeId` is passed through from the editor state (explicitly set by the
 *   user via "Set as Start"), never auto-detected from graph topology.
 * - Edge `order` is computed from the left-to-right x-position of the
 *   target node among all outgoing edges of a given source node.
 * - When `workflow.layout` is present, stored positions are restored exactly.
 *   When absent (or only partially populated), `autoLayout` fills in missing positions.
 * - `WorkflowCondition` is stored verbatim on `VisualEdge` (including `description`,
 *   `maxRetries`, `timeoutMs`). Fields that the visual editor UI does not expose are
 *   preserved through load/save so they are not silently stripped.
 * - `VisualEdge` represents a canvas-only directed edge for the visual editor.
 *   Transitions have been removed from the backend; edges are visual-only.
 * - Blank rules (name and content both empty/whitespace) are silently filtered out
 *   before submission, matching the behaviour of `WorkflowEditor.tsx`.
 * - New steps (no `step.id`) receive a generated UUID inside `buildWorkflowFields`.
 *   This UUID is stable within a single call but differs across calls — callers must
 *   not invoke `visualStateToCreateParams` / `visualStateToUpdateParams` twice on the
 *   same state and expect the generated IDs to match.
 */

import { generateUUID, TASK_AGENT_NODE_ID } from '@neokai/shared';
import type {
	SpaceWorkflow,
	CreateSpaceWorkflowParams,
	UpdateSpaceWorkflowParams,
	WorkflowNodeAgent,
	WorkflowChannel,
	Gate,
} from '@neokai/shared';
import type { NodeDraft } from '../WorkflowNodeCard';
import type { RuleDraft } from '../WorkflowRulesEditor';
import { rulesToDrafts } from '../WorkflowRulesEditor';
import type { Point, WorkflowCondition } from './types';
import { autoLayout } from './layout';

// ============================================================================
// Visual Editor State types
// ============================================================================

/**
 * A single workflow node in the visual editor.
 * `step.id` is the stable persisted step ID (present for existing steps).
 * `step.localId` is used for React keying.
 */
export interface VisualNode {
	step: NodeDraft;
	position: Point;
}

/**
 * A directed edge between two nodes in the visual editor.
 *
 * `fromStepKey` and `toStepKey` are the stable step identifiers used
 * for serialization: `step.id` when the step already exists in the backend,
 * or `step.localId` for brand-new steps.
 *
 * `condition` stores the full `WorkflowCondition` from the backend (including
 * `description`, `maxRetries`, `timeoutMs`), or undefined for unconditional
 * (always-fire) transitions. This avoids silent data loss when the UI edits a
 * transition that already has backend-only fields set.
 */
export interface VisualEdge {
	fromStepKey: string;
	toStepKey: string;
	/** Full backend condition — undefined means unconditional ("always"). */
	condition: WorkflowCondition | undefined;
}

/**
 * Complete state of the visual workflow editor.
 */
export interface VisualEditorState {
	nodes: VisualNode[];
	edges: VisualEdge[];
	/**
	 * The step key (step.id for existing, step.localId for new) of the
	 * start node. Managed explicitly by the user.
	 */
	startNodeId: string;
	rules: RuleDraft[];
	tags: string[];
	/** Directed messaging channels at the workflow level. */
	channels: WorkflowChannel[];
	/** First-class workflow gates referenced by channel.gateId. */
	gates: Gate[];
}

// ============================================================================
// workflowToVisualState
// ============================================================================

/**
 * Convert a SpaceWorkflow to a VisualEditorState.
 *
 * - If `workflow.layout` is present and covers all steps, positions are restored
 *   exactly from the stored layout. Steps missing from a partial layout fall back
 *   to `autoLayout` positions (autoLayout is only invoked when needed).
 * - All `WorkflowCondition` fields are preserved verbatim on the edges.
 * - The Task Agent virtual node is kept in editor state for compatibility, but
 *   is rendered outside the transformed canvas and excluded from layout bounds.
 */
export function workflowToVisualState(workflow: SpaceWorkflow): VisualEditorState {
	// Determine whether auto-layout is needed (any step missing from layout)
	const layoutMap = workflow.layout;
	const needsAutoLayout = !layoutMap || workflow.nodes.some((s) => !layoutMap[s.id]);

	// Lazily compute auto-layout only when at least one step lacks a stored position
	const layoutFallback = needsAutoLayout
		? autoLayout(workflow.nodes, [], workflow.startNodeId, workflow.channels ?? [])
		: new Map<string, Point>();

	const nodes: VisualNode[] = workflow.nodes.map((s) => {
		let position: Point;
		if (layoutMap && layoutMap[s.id]) {
			position = { x: layoutMap[s.id].x, y: layoutMap[s.id].y };
		} else {
			position = layoutFallback.get(s.id) ?? { x: 0, y: 0 };
		}
		const step: NodeDraft = {
			localId: generateUUID(),
			id: s.id,
			name: s.name,
			agentId: s.agentId ?? '',
			model: s.model ?? undefined,
			systemPrompt: s.systemPrompt ?? undefined,
			agents: s.agents,
			instructions: s.instructions ?? '',
		};
		return { step, position };
	});

	// Always inject the Task Agent virtual node at the top-center of the canvas.
	// Its position is computed relative to the layout so it sits above all other nodes.
	const taskAgentNode: VisualNode = {
		step: {
			localId: TASK_AGENT_NODE_ID,
			id: TASK_AGENT_NODE_ID,
			name: 'Task Agent',
			agentId: '',
			instructions: '',
		},
		position: { x: 0, y: 0 },
	};

	// Transitions have been removed from SpaceWorkflow; edges start empty.
	const edges: VisualEdge[] = [];

	// startNodeId: use the step.id directly (matches the edge keys).
	// Fall back to the first step's id if the workflow's startNodeId is missing.
	const startKey =
		workflow.nodes.find((s) => s.id === workflow.startNodeId)?.id ?? workflow.nodes[0]?.id ?? '';

	return {
		// Task Agent node is always first — pinned to the top of the canvas.
		nodes: [taskAgentNode, ...nodes],
		edges,
		startNodeId: startKey,
		rules: rulesToDrafts(workflow.rules ?? []),
		tags: workflow.tags ?? [],
		channels: workflow.channels ?? [],
		gates: workflow.gates ?? [],
	};
}

// ============================================================================
// visualStateToWorkflowParams
// ============================================================================

/**
 * Shared structure returned by both create and update serialisation.
 */
interface BuiltWorkflowFields {
	nodes: Array<{
		id: string;
		name: string;
		agentId?: string;
		model?: string;
		systemPrompt?: string;
		agents?: WorkflowNodeAgent[];
		instructions?: string;
	}>;
	startNodeId: string;
	rules: Array<{ id?: string; name: string; content: string; appliesTo?: string[] }>;
	layout: Record<string, { x: number; y: number }>;
	tags: string[];
	channels?: WorkflowChannel[];
	gates?: Gate[];
}

/**
 * Resolve the stable persisted step ID for a given node.
 * If the node has a persisted `step.id`, that is used directly.
 * Otherwise a new UUID is generated once and cached in `generatedIds`.
 */
function resolveStepId(node: VisualNode, generatedIds: Map<string, string>): string {
	if (node.step.id) return node.step.id;
	const key = node.step.localId;
	if (!generatedIds.has(key)) {
		generatedIds.set(key, generateUUID());
	}
	return generatedIds.get(key)!;
}

/**
 * Build the serialized workflow fields from a VisualEditorState.
 * Shared between create and update serialisation.
 *
 * Blank rules (both name and content empty/whitespace) are silently filtered out
 * before submission, matching the behaviour of `WorkflowEditor.tsx`. Callers
 * should be aware that `fields.rules.length` may be less than `state.rules.length`.
 */
function buildWorkflowFields(state: VisualEditorState): {
	fields: BuiltWorkflowFields;
	keyToPersistedId: Map<string, string>;
} {
	const generatedIds = new Map<string, string>();

	// Strip the Task Agent virtual node — it is never persisted to the backend.
	// Edges referencing TASK_AGENT_NODE_ID are also dropped (dangling edge logic below).
	const persistableNodes = state.nodes.filter(
		(n) => n.step.id !== TASK_AGENT_NODE_ID && n.step.localId !== TASK_AGENT_NODE_ID
	);

	// Assign persisted IDs to all nodes
	const nodeMap = new Map<string, { node: VisualNode; persistedId: string }>();
	for (const node of persistableNodes) {
		const key = node.step.id ?? node.step.localId;
		const persistedId = resolveStepId(node, generatedIds);
		nodeMap.set(key, { node, persistedId });
	}

	// Also build a lookup by localId so startNodeId can reference either key style
	// (e.g. when startNodeId was set to step.localId rather than step.id).
	const localIdMap = new Map<string, { node: VisualNode; persistedId: string }>();
	for (const [, entry] of nodeMap) {
		localIdMap.set(entry.node.step.localId, entry);
	}

	// Build key -> persisted ID map for channel and rule appliesTo remapping
	const keyToPersistedId = new Map<string, string>();
	for (const [key, { persistedId }] of nodeMap) {
		keyToPersistedId.set(key, persistedId);
	}
	// Also map localId -> persistedId (covers startNodeId and appliesTo references)
	for (const [, entry] of nodeMap) {
		keyToPersistedId.set(entry.node.step.localId, entry.persistedId);
	}

	// Build steps (Task Agent virtual node already excluded in persistableNodes)
	const nodes = persistableNodes.map((node, i) => {
		const key = node.step.id ?? node.step.localId;
		const persistedId = nodeMap.get(key)!.persistedId;
		const hasMultiAgent = Array.isArray(node.step.agents) && node.step.agents.length > 0;
		return {
			id: persistedId,
			name: node.step.name || `Step ${i + 1}`,
			// When agents array is provided and non-empty, omit agentId (agents takes precedence).
			// Otherwise use the single agentId (may be empty string, serialized as undefined).
			agentId: hasMultiAgent ? undefined : node.step.agentId || undefined,
			model: hasMultiAgent ? undefined : node.step.model || undefined,
			systemPrompt: hasMultiAgent ? undefined : node.step.systemPrompt || undefined,
			agents: hasMultiAgent ? node.step.agents : undefined,
			instructions: node.step.instructions || undefined,
		};
	});

	// Build layout (Task Agent virtual node excluded — not persisted)
	const layout: Record<string, { x: number; y: number }> = {};
	for (const node of persistableNodes) {
		const key = node.step.id ?? node.step.localId;
		const persistedId = nodeMap.get(key)!.persistedId;
		layout[persistedId] = { x: node.position.x, y: node.position.y };
	}

	// Resolve startNodeId — prefer exact key match, then localId match, then first persistable node
	const startEntry =
		nodeMap.get(state.startNodeId) ??
		localIdMap.get(state.startNodeId) ??
		(persistableNodes.length > 0
			? {
					persistedId: nodeMap.get(persistableNodes[0].step.id ?? persistableNodes[0].step.localId)!
						.persistedId,
				}
			: null);
	const startNodeId = startEntry?.persistedId ?? '';

	// Build rules — blank rules (both name and content empty/whitespace) are filtered out
	const rules = state.rules
		.filter((r) => r.name.trim() || r.content.trim())
		.map((r) => ({
			id: r.id,
			name: r.name.trim() || 'Untitled Rule',
			content: r.content,
			appliesTo: r.appliesTo.map((id) => keyToPersistedId.get(id) ?? id),
		}));

	const referencedGateIds = new Set(
		state.channels.map((channel) => channel.gateId).filter((gateId): gateId is string => !!gateId)
	);
	const gates = state.gates.filter((gate) => referencedGateIds.has(gate.id));

	return {
		fields: {
			nodes,
			startNodeId,
			rules,
			layout,
			tags: state.tags,
			channels: state.channels,
			gates,
		},
		keyToPersistedId,
	};
}

/**
 * Convert a VisualEditorState to CreateSpaceWorkflowParams.
 *
 * @param state - Current visual editor state
 * @param spaceId - The space to create the workflow in
 * @param name - Workflow name
 * @param description - Optional workflow description
 */
export function visualStateToCreateParams(
	state: VisualEditorState,
	spaceId: string,
	name: string,
	description?: string
): CreateSpaceWorkflowParams {
	const { fields } = buildWorkflowFields(state);

	return {
		spaceId,
		name,
		description,
		nodes: fields.nodes,
		startNodeId: fields.startNodeId || undefined,
		// WorkflowRuleInput omits `id` — strip it from each rule
		rules: fields.rules.map(({ id: _id, ...rest }) => rest),
		layout: fields.layout,
		tags: fields.tags,
		channels: fields.channels && fields.channels.length > 0 ? fields.channels : undefined,
		gates: fields.gates && fields.gates.length > 0 ? fields.gates : undefined,
	};
}

/**
 * Convert a VisualEditorState to UpdateSpaceWorkflowParams.
 *
 * @param state - Current visual editor state
 * @param overrides - Optional field overrides (name, description)
 */
export function visualStateToUpdateParams(
	state: VisualEditorState,
	overrides?: { name?: string; description?: string | null }
): UpdateSpaceWorkflowParams {
	const { fields } = buildWorkflowFields(state);

	return {
		...overrides,
		nodes: fields.nodes,
		startNodeId: fields.startNodeId || null,
		// WorkflowRule requires `id` — generate one for new rules that lack a persisted id
		rules: fields.rules.map((r) => ({
			id: r.id ?? generateUUID(),
			name: r.name,
			content: r.content,
			appliesTo: r.appliesTo,
		})),
		layout: fields.layout,
		tags: fields.tags,
		channels: fields.channels && fields.channels.length > 0 ? fields.channels : null,
		gates: fields.gates && fields.gates.length > 0 ? fields.gates : null,
	};
}
