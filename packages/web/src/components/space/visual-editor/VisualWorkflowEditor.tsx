/**
 * VisualWorkflowEditor
 *
 * Top-level orchestrator for the visual workflow editor. Composes the canvas,
 * nodes, edges, config panels and toolbar into a complete editing experience.
 *
 * Handles:
 *  - Loading an existing workflow into visual state (positions from layout field,
 *    falling back to autoLayout when absent)
 *  - Adding / removing / dragging nodes
 *  - Creating / deleting edges via port drag or keyboard
 *  - Editing step properties via NodeConfigPanel
 *  - Editing edge conditions via EdgeConfigPanel
 *  - Designating the start node
 *  - Persisting layout positions on save
 *  - Tags and WorkflowRulesEditor (collapsible)
 */

import { useState, useMemo, useCallback } from 'preact/hooks';
import type { SpaceWorkflow, WorkflowTransition, WorkflowConditionType } from '@neokai/shared';
import { spaceStore } from '../../../lib/space-store';
import { filterAgents } from '../WorkflowEditor';
import { WorkflowRulesEditor } from '../WorkflowRulesEditor';
import type { RuleDraft } from '../WorkflowRulesEditor';
import type { StepDraft } from '../WorkflowStepCard';
import type { ConditionDraft } from './GateConfig';
import type { ViewportState, Point } from './types';
import type { VisualNode, VisualEdge, VisualEditorState } from './serialization';
import {
	workflowToVisualState,
	visualStateToCreateParams,
	visualStateToUpdateParams,
} from './serialization';
import type { WorkflowNodeData } from './WorkflowCanvas';
import { WorkflowCanvas } from './WorkflowCanvas';
import { NodeConfigPanel } from './NodeConfigPanel';
import { EdgeConfigPanel } from './EdgeConfigPanel';

// ============================================================================
// Constants
// ============================================================================

const TAG_SUGGESTIONS = ['coding', 'review', 'research', 'design', 'deployment'];

// ============================================================================
// Props
// ============================================================================

export interface VisualWorkflowEditorProps {
	/** Existing workflow to edit. Undefined means create new. */
	workflow?: SpaceWorkflow;
	onSave: () => void;
	onCancel: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

function makeEmptyStep(): StepDraft {
	return { localId: crypto.randomUUID(), name: '', agentId: '', instructions: '' };
}

// ============================================================================
// Component
// ============================================================================

export function VisualWorkflowEditor({ workflow, onSave, onCancel }: VisualWorkflowEditorProps) {
	const isEditing = !!workflow;

	// ------------------------------------------------------------------
	// Initialize from existing workflow (on mount only)
	// ------------------------------------------------------------------
	const initState: VisualEditorState | null = useMemo(() => {
		if (!workflow) return null;
		return workflowToVisualState(workflow);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []); // intentionally only on mount

	// ------------------------------------------------------------------
	// State
	// ------------------------------------------------------------------

	const [name, setName] = useState(workflow?.name ?? '');
	const [description, setDescription] = useState(workflow?.description ?? '');
	const [nodes, setNodes] = useState<VisualNode[]>(() => initState?.nodes ?? []);
	const [edges, setEdges] = useState<VisualEdge[]>(() => initState?.edges ?? []);
	const [rules, setRules] = useState<RuleDraft[]>(() => initState?.rules ?? []);
	const [tags, setTags] = useState<string[]>(() => initState?.tags ?? []);
	const [startStepId, setStartStepId] = useState<string>(() => initState?.startStepId ?? '');
	const [viewportState, setViewportState] = useState<ViewportState>({
		offsetX: 0,
		offsetY: 0,
		scale: 1,
	});

	// Selection state — lifted so config panels can render from the editor
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null); // step.localId
	const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null); // "fromLocalId:toLocalId"

	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [showRules, setShowRules] = useState(false);
	const [tagInput, setTagInput] = useState('');

	const agents = filterAgents(spaceStore.agents.value);

	// ------------------------------------------------------------------
	// Key-resolution maps
	// ------------------------------------------------------------------

	/**
	 * Maps step.id or step.localId -> step.localId.
	 * Used when converting VisualEdge (keyed by step.id for existing steps) to
	 * WorkflowTransition (keyed by localId, which is what WorkflowCanvas uses).
	 */
	const stepKeyToLocalId = useMemo(() => {
		const map = new Map<string, string>();
		for (const node of nodes) {
			if (node.step.id) map.set(node.step.id, node.step.localId);
			map.set(node.step.localId, node.step.localId);
		}
		return map;
	}, [nodes]);

	/** Maps step.localId -> step key used in VisualEdge (step.id ?? step.localId). */
	const localIdToStepKey = useMemo(() => {
		const map = new Map<string, string>();
		for (const node of nodes) {
			map.set(node.step.localId, node.step.id ?? node.step.localId);
		}
		return map;
	}, [nodes]);

	// ------------------------------------------------------------------
	// Derived: WorkflowTransition[] for WorkflowCanvas
	// WorkflowCanvas / EdgeRenderer use localIds as node keys, so we re-map
	// VisualEdge's step.id-based keys to localIds here.
	// ------------------------------------------------------------------

	const transitions = useMemo<WorkflowTransition[]>(() => {
		return edges.map((e, i) => {
			const fromLocalId = stepKeyToLocalId.get(e.fromStepKey) ?? e.fromStepKey;
			const toLocalId = stepKeyToLocalId.get(e.toStepKey) ?? e.toStepKey;
			return {
				id: `${fromLocalId}:${toLocalId}`,
				from: fromLocalId,
				to: toLocalId,
				condition: e.condition ?? { type: 'always' },
				order: i,
			};
		});
	}, [edges, stepKeyToLocalId]);

	// ------------------------------------------------------------------
	// Helpers
	// ------------------------------------------------------------------

	/** True when the given node is the current start node. */
	const nodeIsStart = useCallback(
		(node: VisualNode): boolean => {
			return node.step.localId === startStepId || node.step.id === startStepId;
		},
		[startStepId]
	);

	/** Find the first incoming edge condition for a node (entry gate). */
	function getEntryCondition(node: VisualNode): ConditionDraft | null {
		const key = node.step.id ?? node.step.localId;
		const incoming = edges.find((e) => e.toStepKey === key);
		if (!incoming) return null;
		const cond = incoming.condition;
		if (!cond || cond.type === 'always') return { type: 'always' };
		return { type: cond.type, expression: cond.expression };
	}

	/** Find the first outgoing edge condition for a node (exit gate). */
	function getExitCondition(node: VisualNode): ConditionDraft | null {
		const key = node.step.id ?? node.step.localId;
		const outgoing = edges.find((e) => e.fromStepKey === key);
		if (!outgoing) return null;
		const cond = outgoing.condition;
		if (!cond || cond.type === 'always') return { type: 'always' };
		return { type: cond.type, expression: cond.expression };
	}

	// ------------------------------------------------------------------
	// Derived: WorkflowNodeData[] for WorkflowCanvas
	// ------------------------------------------------------------------

	const nodeData = useMemo<WorkflowNodeData[]>(() => {
		return nodes.map((node, i) => ({
			stepIndex: i,
			step: node.step,
			position: node.position,
			agents,
			isStartNode: nodeIsStart(node),
		}));
	}, [nodes, agents, nodeIsStart]);

	// ------------------------------------------------------------------
	// Derived: selected node / edge
	// ------------------------------------------------------------------

	const selectedNode = selectedNodeId
		? (nodes.find((n) => n.step.localId === selectedNodeId) ?? null)
		: null;

	const selectedEdgeInfo = useMemo(() => {
		if (!selectedEdgeId) return null;
		const colonIdx = selectedEdgeId.indexOf(':');
		if (colonIdx === -1) return null;
		const fromLocalId = selectedEdgeId.slice(0, colonIdx);
		const toLocalId = selectedEdgeId.slice(colonIdx + 1);
		const fromNode = nodes.find((n) => n.step.localId === fromLocalId);
		const toNode = nodes.find((n) => n.step.localId === toLocalId);
		if (!fromNode || !toNode) return null;
		const fromKey = localIdToStepKey.get(fromLocalId) ?? fromLocalId;
		const toKey = localIdToStepKey.get(toLocalId) ?? toLocalId;
		const edge = edges.find((e) => e.fromStepKey === fromKey && e.toStepKey === toKey);
		return { fromNode, toNode, edge, fromKey, toKey };
	}, [selectedEdgeId, nodes, edges, localIdToStepKey]);

	// ------------------------------------------------------------------
	// Node operations
	// ------------------------------------------------------------------

	function addStep() {
		const newLocalId = crypto.randomUUID();
		const newStep = makeEmptyStep();
		(newStep as StepDraft & { localId: string }).localId = newLocalId;

		// Stagger new nodes so they don't stack exactly
		const position: Point = { x: 120 + nodes.length * 20, y: 80 + nodes.length * 20 };
		const newNode: VisualNode = { step: newStep, position };

		setNodes((prev) => [...prev, newNode]);

		// First node automatically becomes the start node
		if (nodes.length === 0) {
			setStartStepId(newLocalId);
		}
	}

	const handleNodePositionChange = useCallback((localId: string, newPosition: Point) => {
		setNodes((prev) =>
			prev.map((n) => (n.step.localId === localId ? { ...n, position: newPosition } : n))
		);
	}, []);

	const handleNodeSelect = useCallback((localId: string | null) => {
		setSelectedNodeId(localId);
		if (localId) setSelectedEdgeId(null);
	}, []);

	const handleDeleteNode = useCallback(
		(localId: string) => {
			setNodes((prev) => {
				const nodeToDelete = prev.find((n) => n.step.localId === localId);
				if (!nodeToDelete) return prev;
				const key = nodeToDelete.step.id ?? nodeToDelete.step.localId;
				const remaining = prev.filter((n) => n.step.localId !== localId);

				// Re-assign start to first remaining node if the deleted node was start
				const wasStart =
					nodeToDelete.step.localId === startStepId || nodeToDelete.step.id === startStepId;
				if (wasStart && remaining.length > 0) {
					const next = remaining[0];
					setStartStepId(next.step.id ?? next.step.localId);
				} else if (wasStart) {
					setStartStepId('');
				}

				// Drop edges touching the deleted node
				setEdges((prevEdges) =>
					prevEdges.filter((e) => e.fromStepKey !== key && e.toStepKey !== key)
				);

				return remaining;
			});
			setSelectedNodeId(null);
		},
		[startStepId]
	);

	const handleUpdateNode = useCallback((step: StepDraft) => {
		setNodes((prev) => prev.map((n) => (n.step.localId === step.localId ? { ...n, step } : n)));
	}, []);

	const handleSetAsStart = useCallback((localId: string) => {
		setNodes((prev) => {
			const node = prev.find((n) => n.step.localId === localId);
			if (node) setStartStepId(node.step.id ?? node.step.localId);
			return prev;
		});
	}, []);

	const handleUpdateEntryCondition = useCallback((node: VisualNode, cond: ConditionDraft) => {
		const key = node.step.id ?? node.step.localId;
		let updated = false;
		setEdges((prev) =>
			prev.map((e) => {
				if (e.toStepKey !== key || updated) return e;
				updated = true;
				const newCond =
					cond.type === 'always'
						? undefined
						: { ...e.condition, type: cond.type, expression: cond.expression };
				return { ...e, condition: newCond };
			})
		);
	}, []);

	const handleUpdateExitCondition = useCallback((node: VisualNode, cond: ConditionDraft) => {
		const key = node.step.id ?? node.step.localId;
		let updated = false;
		setEdges((prev) =>
			prev.map((e) => {
				if (e.fromStepKey !== key || updated) return e;
				updated = true;
				const newCond =
					cond.type === 'always'
						? undefined
						: { ...e.condition, type: cond.type, expression: cond.expression };
				return { ...e, condition: newCond };
			})
		);
	}, []);

	// ------------------------------------------------------------------
	// Edge operations
	// ------------------------------------------------------------------

	const handleEdgeSelect = useCallback((edgeId: string | null) => {
		setSelectedEdgeId(edgeId);
		if (edgeId) setSelectedNodeId(null);
	}, []);

	const handleCreateTransition = useCallback(
		(fromLocalId: string, toLocalId: string) => {
			const fromKey = localIdToStepKey.get(fromLocalId) ?? fromLocalId;
			const toKey = localIdToStepKey.get(toLocalId) ?? toLocalId;
			setEdges((prev) => {
				if (prev.some((e) => e.fromStepKey === fromKey && e.toStepKey === toKey)) return prev;
				return [...prev, { fromStepKey: fromKey, toStepKey: toKey, condition: undefined }];
			});
		},
		[localIdToStepKey]
	);

	const handleDeleteEdge = useCallback(
		(edgeId: string) => {
			const colonIdx = edgeId.indexOf(':');
			if (colonIdx === -1) return;
			const fromLocalId = edgeId.slice(0, colonIdx);
			const toLocalId = edgeId.slice(colonIdx + 1);
			const fromKey = localIdToStepKey.get(fromLocalId) ?? fromLocalId;
			const toKey = localIdToStepKey.get(toLocalId) ?? toLocalId;
			setEdges((prev) => prev.filter((e) => !(e.fromStepKey === fromKey && e.toStepKey === toKey)));
			setSelectedEdgeId(null);
		},
		[localIdToStepKey]
	);

	const handleUpdateEdgeCondition = useCallback(
		(edgeId: string, conditionType: WorkflowConditionType, expression?: string) => {
			const colonIdx = edgeId.indexOf(':');
			if (colonIdx === -1) return;
			const fromLocalId = edgeId.slice(0, colonIdx);
			const toLocalId = edgeId.slice(colonIdx + 1);
			const fromKey = localIdToStepKey.get(fromLocalId) ?? fromLocalId;
			const toKey = localIdToStepKey.get(toLocalId) ?? toLocalId;
			setEdges((prev) =>
				prev.map((e) => {
					if (e.fromStepKey !== fromKey || e.toStepKey !== toKey) return e;
					const newCond =
						conditionType === 'always'
							? undefined
							: { ...e.condition, type: conditionType, expression };
					return { ...e, condition: newCond };
				})
			);
		},
		[localIdToStepKey]
	);

	// ------------------------------------------------------------------
	// Tags
	// ------------------------------------------------------------------

	function addTag(value: string) {
		const trimmed = value.trim().toLowerCase();
		if (trimmed && !tags.includes(trimmed)) {
			setTags((prev) => [...prev, trimmed]);
		}
	}

	function removeTag(tag: string) {
		setTags((prev) => prev.filter((t) => t !== tag));
	}

	function handleTagInputKeyDown(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ',') {
			e.preventDefault();
			addTag(tagInput);
			setTagInput('');
		} else if (e.key === 'Backspace' && !tagInput && tags.length > 0) {
			removeTag(tags[tags.length - 1]);
		}
	}

	// ------------------------------------------------------------------
	// Save
	// ------------------------------------------------------------------

	async function handleSave() {
		if (!name.trim()) {
			setError('Workflow name is required.');
			return;
		}

		const visualState: VisualEditorState = { nodes, edges, startStepId, rules, tags };

		setSaving(true);
		setError(null);

		try {
			if (isEditing && workflow) {
				const params = visualStateToUpdateParams(visualState, {
					name: name.trim(),
					description: description.trim() || null,
				});
				await spaceStore.updateWorkflow(workflow.id, params);
			} else {
				// visualStateToCreateParams generates full CreateSpaceWorkflowParams (including spaceId).
				// spaceStore.createWorkflow adds spaceId internally, so strip it.
				const fullParams = visualStateToCreateParams(
					visualState,
					'', // placeholder — spaceStore injects the real value
					name.trim(),
					description.trim() || undefined
				);
				const { spaceId: _spaceId, ...createParams } = fullParams;
				await spaceStore.createWorkflow(createParams);
			}
			onSave();
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to save workflow.');
		} finally {
			setSaving(false);
		}
	}

	// ------------------------------------------------------------------
	// Render
	// ------------------------------------------------------------------

	return (
		<div data-testid="visual-workflow-editor" class="flex flex-col h-full overflow-hidden">
			{/* ---- Header ---- */}
			<div class="flex items-center gap-3 px-6 py-4 border-b border-dark-700 flex-shrink-0">
				<button
					onClick={onCancel}
					class="text-gray-500 hover:text-gray-300 transition-colors"
					title="Back"
					data-testid="back-button"
				>
					<svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width={2}
							d="M15 19l-7-7 7-7"
						/>
					</svg>
				</button>
				<h1 class="text-sm font-semibold text-gray-100">
					{isEditing ? 'Edit Workflow' : 'New Workflow'}
				</h1>

				{/* Inline name / description inputs */}
				<div class="flex-1 flex items-center gap-3 min-w-0">
					<input
						type="text"
						value={name}
						onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
						placeholder="Workflow name…"
						data-testid="workflow-name-input"
						class="flex-1 min-w-0 text-sm bg-dark-800 border border-dark-600 rounded px-2 py-1 text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-600"
					/>
					<input
						type="text"
						value={description}
						onInput={(e) => setDescription((e.currentTarget as HTMLInputElement).value)}
						placeholder="Description (optional)"
						data-testid="workflow-description-input"
						class="flex-1 min-w-0 text-sm bg-dark-800 border border-dark-600 rounded px-2 py-1 text-gray-500 focus:outline-none focus:border-blue-500 placeholder-gray-600"
					/>
				</div>

				<button
					onClick={onCancel}
					class="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 transition-colors"
					data-testid="cancel-button"
				>
					Cancel
				</button>
				<button
					onClick={handleSave}
					disabled={saving}
					data-testid="save-button"
					class="px-3 py-1.5 text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded transition-colors"
				>
					{saving ? 'Saving…' : isEditing ? 'Save Changes' : 'Create Workflow'}
				</button>
			</div>

			{/* ---- Error banner ---- */}
			{error && (
				<div class="px-6 py-2 bg-red-900/20 border-b border-red-800/40 flex-shrink-0">
					<p class="text-xs text-red-300">{error}</p>
				</div>
			)}

			{/* ---- Canvas area ---- */}
			<div class="flex-1 relative overflow-hidden bg-dark-950">
				{/* Add Step toolbar button */}
				<div class="absolute top-3 left-3 z-10" style={{ pointerEvents: 'auto' }}>
					<button
						onClick={addStep}
						data-testid="add-step-button"
						class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-dark-800 border border-dark-600 rounded text-gray-300 hover:text-white hover:bg-dark-700 hover:border-dark-500 transition-colors shadow"
					>
						<svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M12 4v16m8-8H4"
							/>
						</svg>
						Add Step
					</button>
				</div>

				{/* Empty state overlay */}
				{nodes.length === 0 && (
					<div class="absolute inset-0 flex items-center justify-center pointer-events-none">
						<div class="text-center">
							<p class="text-sm text-gray-600">No steps yet.</p>
							<p class="text-xs text-gray-700 mt-1">Click "Add Step" to start building.</p>
						</div>
					</div>
				)}

				<WorkflowCanvas
					nodes={nodeData}
					viewportState={viewportState}
					onViewportChange={setViewportState}
					transitions={transitions}
					onNodeSelect={handleNodeSelect}
					onDeleteNode={handleDeleteNode}
					onNodePositionChange={handleNodePositionChange}
					onCreateTransition={handleCreateTransition}
					onEdgeSelect={handleEdgeSelect}
					onDeleteEdge={handleDeleteEdge}
				/>

				{/* NodeConfigPanel — anchored to the right of the canvas */}
				{selectedNode && (
					<NodeConfigPanel
						step={selectedNode.step}
						agents={agents}
						entryCondition={getEntryCondition(selectedNode)}
						exitCondition={getExitCondition(selectedNode)}
						isStartNode={nodeIsStart(selectedNode)}
						isFirstStep={
							!edges.some(
								(e) => e.toStepKey === (selectedNode.step.id ?? selectedNode.step.localId)
							)
						}
						isLastStep={
							!edges.some(
								(e) => e.fromStepKey === (selectedNode.step.id ?? selectedNode.step.localId)
							)
						}
						onUpdate={handleUpdateNode}
						onUpdateEntryCondition={(c) => handleUpdateEntryCondition(selectedNode, c)}
						onUpdateExitCondition={(c) => handleUpdateExitCondition(selectedNode, c)}
						onSetAsStart={handleSetAsStart}
						onClose={() => setSelectedNodeId(null)}
						onDelete={handleDeleteNode}
					/>
				)}

				{/* EdgeConfigPanel — floating panel in the bottom-left of the canvas */}
				{selectedEdgeInfo && (
					<div class="absolute bottom-16 left-3 w-72 z-20" style={{ pointerEvents: 'auto' }}>
						<EdgeConfigPanel
							transition={{
								id: selectedEdgeId!,
								fromStepName: selectedEdgeInfo.fromNode.step.name || 'Unnamed',
								toStepName: selectedEdgeInfo.toNode.step.name || 'Unnamed',
								condition: selectedEdgeInfo.edge?.condition ?? { type: 'always' },
							}}
							onUpdateCondition={handleUpdateEdgeCondition}
							onDelete={handleDeleteEdge}
							onClose={() => setSelectedEdgeId(null)}
						/>
					</div>
				)}
			</div>

			{/* ---- Tags and Rules (collapsible) ---- */}
			<div class="flex-shrink-0 border-t border-dark-700 max-h-64 overflow-y-auto">
				{/* Tags row */}
				<div class="px-4 py-3 border-b border-dark-800">
					<div class="flex items-center gap-2 mb-2">
						<span class="text-xs font-semibold text-gray-500 uppercase tracking-wider">Tags</span>
						<div class="flex flex-wrap gap-1">
							{tags.map((tag) => (
								<span
									key={tag}
									class="flex items-center gap-1 text-xs bg-dark-700 border border-dark-600 text-gray-300 rounded px-1.5 py-0.5"
								>
									{tag}
									<button
										type="button"
										onClick={() => removeTag(tag)}
										class="text-gray-500 hover:text-red-400 transition-colors"
										aria-label={`Remove tag ${tag}`}
									>
										×
									</button>
								</span>
							))}
							<input
								type="text"
								value={tagInput}
								placeholder={tags.length === 0 ? 'Add tags…' : ''}
								onInput={(e) => setTagInput((e.currentTarget as HTMLInputElement).value)}
								onKeyDown={handleTagInputKeyDown}
								onBlur={() => {
									if (tagInput.trim()) {
										tagInput.split(',').forEach((t) => addTag(t));
										setTagInput('');
									}
								}}
								class="text-xs bg-transparent text-gray-300 outline-none placeholder-gray-700 min-w-[6rem]"
							/>
						</div>
						{/* Tag suggestions */}
						<div class="flex gap-1 ml-auto">
							{TAG_SUGGESTIONS.filter((s) => !tags.includes(s)).map((s) => (
								<button
									key={s}
									type="button"
									onClick={() => addTag(s)}
									class="text-xs text-gray-600 hover:text-gray-300 border border-dark-700 hover:border-dark-500 rounded px-1.5 py-0.5 transition-colors"
								>
									+{s}
								</button>
							))}
						</div>
					</div>
				</div>

				{/* Rules — collapsible */}
				<div class="px-4 py-2">
					<button
						onClick={() => setShowRules((v) => !v)}
						class="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
						data-testid="toggle-rules-button"
					>
						<svg
							class={`w-3 h-3 transition-transform ${showRules ? 'rotate-90' : ''}`}
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width={2}
								d="M9 5l7 7-7 7"
							/>
						</svg>
						<span class="font-semibold uppercase tracking-wider">
							Rules {rules.length > 0 ? `(${rules.length})` : ''}
						</span>
					</button>

					{showRules && (
						<div class="mt-3">
							<WorkflowRulesEditor
								rules={rules}
								steps={nodes.map((n, i) => ({
									id: n.step.id ?? n.step.localId,
									name: n.step.name || `Step ${i + 1}`,
									agentId: n.step.agentId,
									instructions: n.step.instructions,
								}))}
								onChange={setRules}
							/>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
