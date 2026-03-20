/**
 * Serialization helpers for converting between the visual editor's internal
 * state and the SpaceWorkflow / CreateSpaceWorkflowParams / UpdateSpaceWorkflowParams
 * data model used by the backend.
 *
 * Key design decisions:
 * - `startStepId` is passed through from the editor state (explicitly set by the
 *   user via "Set as Start"), never auto-detected from graph topology.
 * - Transition `order` is computed from the left-to-right x-position of the
 *   target node among all outgoing edges of a given source node.
 * - When `workflow.layout` is present, stored positions are restored exactly.
 *   When absent, `autoLayout` is called to compute initial positions.
 */

import type {
	SpaceWorkflow,
	CreateSpaceWorkflowParams,
	UpdateSpaceWorkflowParams,
	WorkflowConditionType,
} from '@neokai/shared';
import type { StepDraft, ConditionDraft } from '../WorkflowStepCard';
import type { RuleDraft } from '../WorkflowRulesEditor';
import { rulesToDrafts } from '../WorkflowRulesEditor';
import type { Point } from './types';
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
	step: StepDraft;
	position: Point;
}

/**
 * A directed edge between two nodes in the visual editor.
 * `fromStepKey` and `toStepKey` are the stable step identifiers used
 * for serialization: `step.id` when the step already exists in the backend,
 * or `step.localId` for brand-new steps.
 */
export interface VisualEdge {
	fromStepKey: string;
	toStepKey: string;
	condition: ConditionDraft;
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
	startStepId: string;
	rules: RuleDraft[];
	tags: string[];
}

// ============================================================================
// workflowToVisualState
// ============================================================================

/**
 * Convert a SpaceWorkflow to a VisualEditorState.
 *
 * - If `workflow.layout` is present, node positions are restored from it.
 * - If `workflow.layout` is absent (or missing entries), `autoLayout` fills in positions.
 */
export function workflowToVisualState(workflow: SpaceWorkflow): VisualEditorState {
	// Compute auto-layout positions as fallback
	const layoutFallback = autoLayout(workflow.steps, workflow.transitions, workflow.startStepId);

	const nodes: VisualNode[] = workflow.steps.map((s) => {
		let position: Point;
		if (workflow.layout && workflow.layout[s.id]) {
			position = { x: workflow.layout[s.id].x, y: workflow.layout[s.id].y };
		} else {
			position = layoutFallback.get(s.id) ?? { x: 0, y: 0 };
		}
		const step: StepDraft = {
			localId: crypto.randomUUID(),
			id: s.id,
			name: s.name,
			agentId: s.agentId,
			instructions: s.instructions ?? '',
		};
		return { step, position };
	});

	const edges: VisualEdge[] = workflow.transitions.map((t) => ({
		fromStepKey: t.from,
		toStepKey: t.to,
		condition: t.condition
			? { type: t.condition.type, expression: t.condition.expression }
			: { type: 'always' },
	}));

	// startStepId: use the step.id directly (matches the edge keys)
	// If the startStepId refers to a step that doesn't exist, fall back to the
	// first step's key.
	const startKey =
		workflow.steps.find((s) => s.id === workflow.startStepId)?.id ?? workflow.steps[0]?.id ?? '';

	return {
		nodes,
		edges,
		startStepId: startKey,
		rules: rulesToDrafts(workflow.rules ?? []),
		tags: workflow.tags ?? [],
	};
}

// ============================================================================
// visualStateToWorkflowParams
// ============================================================================

/**
 * Shared structure returned by both create and update serialisation.
 * This is the same shape, just with different required/optional fields
 * depending on which API is being called.
 */
interface BuiltWorkflowFields {
	steps: Array<{ id: string; name: string; agentId: string; instructions?: string }>;
	transitions: Array<{
		from: string;
		to: string;
		condition?: { type: WorkflowConditionType; expression?: string };
		order: number;
	}>;
	startStepId: string;
	rules: Array<{ id?: string; name: string; content: string; appliesTo?: string[] }>;
	layout: Record<string, { x: number; y: number }>;
	tags: string[];
}

/**
 * Resolve the stable persisted step ID for a given step key.
 * If the node has a persisted `step.id`, that is used directly.
 * Otherwise a new UUID is generated (for brand-new steps).
 */
function resolveStepId(node: VisualNode, generatedIds: Map<string, string>): string {
	const key = node.step.id ?? node.step.localId;
	if (node.step.id) return node.step.id;
	if (!generatedIds.has(key)) {
		generatedIds.set(key, crypto.randomUUID());
	}
	return generatedIds.get(key)!;
}

/**
 * Build the serialized workflow fields from a VisualEditorState.
 * Shared between create and update serialisation.
 */
function buildWorkflowFields(state: VisualEditorState): {
	fields: BuiltWorkflowFields;
	keyToPersistedId: Map<string, string>;
} {
	const generatedIds = new Map<string, string>();

	// Assign persisted IDs to all nodes
	const nodeMap = new Map<string, { node: VisualNode; persistedId: string }>();
	for (const node of state.nodes) {
		const key = node.step.id ?? node.step.localId;
		const persistedId = resolveStepId(node, generatedIds);
		nodeMap.set(key, { node, persistedId });
	}

	// Also build a lookup by localId so startStepId can reference either key style
	const localIdMap = new Map<string, { node: VisualNode; persistedId: string }>();
	for (const [, entry] of nodeMap) {
		localIdMap.set(entry.node.step.localId, entry);
	}

	// Build key -> persisted ID map for rules' appliesTo remapping
	const keyToPersistedId = new Map<string, string>();
	for (const [key, { persistedId }] of nodeMap) {
		keyToPersistedId.set(key, persistedId);
	}
	// Also map localId -> persistedId
	for (const [, entry] of nodeMap) {
		keyToPersistedId.set(entry.node.step.localId, entry.persistedId);
	}

	// Build steps
	const steps = state.nodes.map((node, i) => {
		const key = node.step.id ?? node.step.localId;
		const persistedId = nodeMap.get(key)!.persistedId;
		return {
			id: persistedId,
			name: node.step.name || `Step ${i + 1}`,
			agentId: node.step.agentId,
			instructions: node.step.instructions || undefined,
		};
	});

	// Build a position lookup for target nodes (used to compute transition order)
	const positionByKey = new Map<string, Point>();
	for (const node of state.nodes) {
		const key = node.step.id ?? node.step.localId;
		positionByKey.set(key, node.position);
	}

	// Group outgoing edges by source key to compute order
	const outgoingBySource = new Map<string, VisualEdge[]>();
	for (const edge of state.edges) {
		const list = outgoingBySource.get(edge.fromStepKey) ?? [];
		list.push(edge);
		outgoingBySource.set(edge.fromStepKey, list);
	}

	// Build transitions with computed order (left-to-right by target x-position)
	const transitions: BuiltWorkflowFields['transitions'] = [];
	for (const [sourceKey, edgeGroup] of outgoingBySource) {
		const fromId = keyToPersistedId.get(sourceKey);
		if (!fromId) continue;

		// Sort by target node x-position (ascending = left-to-right)
		const sorted = [...edgeGroup].sort((a, b) => {
			const xA = positionByKey.get(a.toStepKey)?.x ?? 0;
			const xB = positionByKey.get(b.toStepKey)?.x ?? 0;
			return xA - xB;
		});

		for (let i = 0; i < sorted.length; i++) {
			const edge = sorted[i];
			const toId = keyToPersistedId.get(edge.toStepKey);
			if (!toId) continue;

			transitions.push({
				from: fromId,
				to: toId,
				condition:
					edge.condition.type === 'always'
						? undefined
						: { type: edge.condition.type, expression: edge.condition.expression },
				order: i,
			});
		}
	}

	// Build layout
	const layout: Record<string, { x: number; y: number }> = {};
	for (const node of state.nodes) {
		const key = node.step.id ?? node.step.localId;
		const persistedId = nodeMap.get(key)!.persistedId;
		layout[persistedId] = { x: node.position.x, y: node.position.y };
	}

	// Resolve startStepId
	const startEntry =
		nodeMap.get(state.startStepId) ??
		localIdMap.get(state.startStepId) ??
		(state.nodes.length > 0
			? {
					persistedId: nodeMap.get(state.nodes[0].step.id ?? state.nodes[0].step.localId)!
						.persistedId,
				}
			: null);
	const startStepId = startEntry?.persistedId ?? '';

	// Build rules
	const rules = state.rules
		.filter((r) => r.name.trim() || r.content.trim())
		.map((r) => ({
			id: r.id,
			name: r.name.trim() || 'Untitled Rule',
			content: r.content,
			appliesTo: r.appliesTo.map((id) => keyToPersistedId.get(id) ?? id),
		}));

	return {
		fields: { steps, transitions, startStepId, rules, layout, tags: state.tags },
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
		steps: fields.steps,
		transitions: fields.transitions,
		startStepId: fields.startStepId || undefined,
		rules: fields.rules.map(({ id: _id, ...rest }) => rest),
		layout: fields.layout,
		tags: fields.tags,
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
		steps: fields.steps,
		transitions: fields.transitions,
		startStepId: fields.startStepId || null,
		rules: fields.rules.map((r) => ({
			id: r.id ?? crypto.randomUUID(),
			name: r.name,
			content: r.content,
			appliesTo: r.appliesTo,
		})),
		layout: fields.layout,
		tags: fields.tags,
	};
}
