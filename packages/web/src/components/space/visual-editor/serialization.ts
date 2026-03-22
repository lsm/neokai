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
 *   When absent (or only partially populated), `autoLayout` fills in missing positions.
 * - `WorkflowCondition` is stored verbatim on `VisualEdge` (including `description`,
 *   `maxRetries`, `timeoutMs`). Fields that the visual editor UI does not expose are
 *   preserved through load/save so they are not silently stripped.
 * - `WorkflowTransition.id` is intentionally not stored on `VisualEdge`. The update
 *   API uses `WorkflowTransitionInput` (which omits `id`) and replaces the entire
 *   transition list, so per-transition IDs are backend-assigned on every save.
 *   If the backend API ever changes to patch individual transitions by ID, this
 *   code will need to be revisited.
 * - Blank rules (name and content both empty/whitespace) are silently filtered out
 *   before submission, matching the behaviour of `WorkflowEditor.tsx`.
 * - New steps (no `step.id`) receive a generated UUID inside `buildWorkflowFields`.
 *   This UUID is stable within a single call but differs across calls — callers must
 *   not invoke `visualStateToCreateParams` / `visualStateToUpdateParams` twice on the
 *   same state and expect the generated IDs to match.
 */

import type {
	SpaceWorkflow,
	CreateSpaceWorkflowParams,
	UpdateSpaceWorkflowParams,
	WorkflowCondition,
} from '@neokai/shared';
import { generateUUID } from '@neokai/shared';
import type { StepDraft } from '../WorkflowStepCard';
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
 * - If `workflow.layout` is present and covers all steps, positions are restored
 *   exactly from the stored layout. Steps missing from a partial layout fall back
 *   to `autoLayout` positions (autoLayout is only invoked when needed).
 * - All `WorkflowCondition` fields are preserved verbatim on the edges.
 */
export function workflowToVisualState(workflow: SpaceWorkflow): VisualEditorState {
	// Determine whether auto-layout is needed (any step missing from layout)
	const layoutMap = workflow.layout;
	const needsAutoLayout = !layoutMap || workflow.steps.some((s) => !layoutMap[s.id]);

	// Lazily compute auto-layout only when at least one step lacks a stored position
	const layoutFallback = needsAutoLayout
		? autoLayout(workflow.steps, workflow.transitions, workflow.startStepId)
		: new Map<string, Point>();

	const nodes: VisualNode[] = workflow.steps.map((s) => {
		let position: Point;
		if (layoutMap && layoutMap[s.id]) {
			position = { x: layoutMap[s.id].x, y: layoutMap[s.id].y };
		} else {
			position = layoutFallback.get(s.id) ?? { x: 0, y: 0 };
		}
		const step: StepDraft = {
			localId: generateUUID(),
			id: s.id,
			name: s.name,
			agentId: s.agentId ?? '',
			instructions: s.instructions ?? '',
		};
		return { step, position };
	});

	// Preserve the full WorkflowCondition (all fields) to avoid silent data loss
	const edges: VisualEdge[] = workflow.transitions.map((t) => ({
		fromStepKey: t.from,
		toStepKey: t.to,
		condition: t.condition ? { ...t.condition } : undefined,
	}));

	// startStepId: use the step.id directly (matches the edge keys).
	// Fall back to the first step's id if the workflow's startStepId is missing.
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
 */
interface BuiltWorkflowFields {
	steps: Array<{ id: string; name: string; agentId: string; instructions?: string }>;
	transitions: Array<{
		from: string;
		to: string;
		condition?: WorkflowCondition;
		order: number;
	}>;
	startStepId: string;
	rules: Array<{ id?: string; name: string; content: string; appliesTo?: string[] }>;
	layout: Record<string, { x: number; y: number }>;
	tags: string[];
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

	// Assign persisted IDs to all nodes
	const nodeMap = new Map<string, { node: VisualNode; persistedId: string }>();
	for (const node of state.nodes) {
		const key = node.step.id ?? node.step.localId;
		const persistedId = resolveStepId(node, generatedIds);
		nodeMap.set(key, { node, persistedId });
	}

	// Also build a lookup by localId so startStepId can reference either key style
	// (e.g. when startStepId was set to step.localId rather than step.id).
	const localIdMap = new Map<string, { node: VisualNode; persistedId: string }>();
	for (const [, entry] of nodeMap) {
		localIdMap.set(entry.node.step.localId, entry);
	}

	// Build key -> persisted ID map for transition and rule appliesTo remapping
	const keyToPersistedId = new Map<string, string>();
	for (const [key, { persistedId }] of nodeMap) {
		keyToPersistedId.set(key, persistedId);
	}
	// Also map localId -> persistedId (covers startStepId and appliesTo references)
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

	// Build transitions with computed order (left-to-right by target x-position).
	// Edges whose fromStepKey or toStepKey does not resolve to a known node are
	// silently dropped — this is the correct behaviour when a node has been deleted
	// while an edge still references it.
	const transitions: BuiltWorkflowFields['transitions'] = [];
	for (const [sourceKey, edgeGroup] of outgoingBySource) {
		const fromId = keyToPersistedId.get(sourceKey);
		if (!fromId) continue; // dangling source — drop

		// Sort by target node x-position (ascending = left-to-right)
		const sorted = [...edgeGroup].sort((a, b) => {
			const xA = positionByKey.get(a.toStepKey)?.x ?? 0;
			const xB = positionByKey.get(b.toStepKey)?.x ?? 0;
			return xA - xB;
		});

		for (let i = 0; i < sorted.length; i++) {
			const edge = sorted[i];
			const toId = keyToPersistedId.get(edge.toStepKey);
			if (!toId) continue; // dangling target — drop

			transitions.push({
				from: fromId,
				to: toId,
				// Preserve full WorkflowCondition (including backend-only fields).
				// undefined condition means unconditional ("always").
				condition: edge.condition ? { ...edge.condition } : undefined,
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

	// Resolve startStepId — prefer exact key match, then localId match, then first node
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

	// Build rules — blank rules (both name and content empty/whitespace) are filtered out
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
		// WorkflowRuleInput omits `id` — strip it from each rule
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
		// WorkflowRule requires `id` — generate one for new rules that lack a persisted id
		rules: fields.rules.map((r) => ({
			id: r.id ?? generateUUID(),
			name: r.name,
			content: r.content,
			appliesTo: r.appliesTo,
		})),
		layout: fields.layout,
		tags: fields.tags,
	};
}
