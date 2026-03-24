/**
 * DAG auto-layout algorithm for the workflow visual editor.
 *
 * Performs a layered layout (Sugiyama-style, simplified):
 * 1. Topological sort starting from startNodeId following transitions
 * 2. Layer assignment: each node's layer = max(predecessor layers) + 1
 * 3. Horizontal spacing within each layer with centering
 * 4. Orphaned nodes (unreachable from start) are appended below the main graph
 */

import type { WorkflowNode, WorkflowTransition } from '@neokai/shared';

/** A 2D point in canvas coordinates */
export interface Point {
	x: number;
	y: number;
}

/** Horizontal gap between nodes in the same layer */
const H_GAP = 250;
/** Vertical gap between layers */
const V_GAP = 150;
/** Starting y offset for the first layer */
const START_Y = 50;
/** Starting x offset for centering calculations */
const START_X = 50;

/**
 * Compute auto-layout positions for all steps in a workflow.
 *
 * @param steps - All workflow steps (nodes)
 * @param transitions - All workflow transitions (directed edges)
 * @param startNodeId - The entry-point step ID
 * @returns A map from step ID to canvas Point {x, y}
 */
export function autoLayout(
	nodes: WorkflowNode[],
	transitions: WorkflowTransition[],
	startNodeId: string
): Map<string, Point> {
	if (nodes.length === 0) {
		return new Map();
	}

	const stepIds = new Set(nodes.map((s) => s.id));

	// Build adjacency: successors and predecessors
	const successors = new Map<string, string[]>();
	const predecessors = new Map<string, string[]>();
	for (const s of nodes) {
		successors.set(s.id, []);
		predecessors.set(s.id, []);
	}
	for (const t of transitions) {
		if (!stepIds.has(t.from) || !stepIds.has(t.to)) continue;
		successors.get(t.from)!.push(t.to);
		predecessors.get(t.to)!.push(t.from);
	}

	// ------------------------------------------------------------------
	// Phase 1: BFS/topological reachability from startNodeId
	// We use Kahn's algorithm on the reachable subgraph to assign layers.
	// Cycle edges are broken by tracking visited nodes.
	// ------------------------------------------------------------------
	const reachable = new Set<string>();
	const bfsQueue: string[] = [];

	if (stepIds.has(startNodeId)) {
		bfsQueue.push(startNodeId);
		reachable.add(startNodeId);
	}

	while (bfsQueue.length > 0) {
		const current = bfsQueue.shift()!;
		for (const next of successors.get(current) ?? []) {
			if (!reachable.has(next)) {
				reachable.add(next);
				bfsQueue.push(next);
			}
		}
	}

	// ------------------------------------------------------------------
	// Phase 2: Layer assignment via longest-path (critical-path) layering.
	// For each reachable node, layer = max(predecessor layers) + 1.
	// We process in topological order using Kahn's algorithm; cycle edges
	// are skipped (the target keeps its already-computed layer).
	// ------------------------------------------------------------------
	const layer = new Map<string, number>();
	const inDegree = new Map<string, number>();

	// Only consider edges within the reachable set
	for (const id of reachable) {
		let deg = 0;
		for (const pred of predecessors.get(id) ?? []) {
			if (reachable.has(pred)) deg++;
		}
		inDegree.set(id, deg);
	}

	// Kahn's queue — start with nodes that have no reachable predecessors
	const topoQueue: string[] = [];
	for (const id of reachable) {
		if (inDegree.get(id) === 0) {
			topoQueue.push(id);
			layer.set(id, 0);
		}
	}

	while (topoQueue.length > 0) {
		const current = topoQueue.shift()!;
		const currentLayer = layer.get(current) ?? 0;
		for (const next of successors.get(current) ?? []) {
			if (!reachable.has(next)) continue;
			const nextLayer = Math.max(layer.get(next) ?? 0, currentLayer + 1);
			layer.set(next, nextLayer);
			const remaining = (inDegree.get(next) ?? 1) - 1;
			inDegree.set(next, remaining);
			if (remaining === 0) {
				topoQueue.push(next);
			}
		}
	}

	// Nodes still in the reachable set but not yet processed (cycle members)
	// assign them after the last assigned layer.
	const maxAssignedLayer = layer.size > 0 ? Math.max(...layer.values()) : -1;
	let cycleLayer = maxAssignedLayer + 1;
	for (const id of reachable) {
		if (!layer.has(id)) {
			layer.set(id, cycleLayer++);
		}
	}

	// ------------------------------------------------------------------
	// Phase 3: Group nodes by layer
	// ------------------------------------------------------------------
	const layerGroups = new Map<number, string[]>();
	for (const [id, l] of layer.entries()) {
		if (!layerGroups.has(l)) layerGroups.set(l, []);
		layerGroups.get(l)!.push(id);
	}

	// Sort within each layer by step order in the original array for stability
	const stepOrder = new Map<string, number>(nodes.map((s, i) => [s.id, i]));
	for (const group of layerGroups.values()) {
		group.sort((a, b) => (stepOrder.get(a) ?? 0) - (stepOrder.get(b) ?? 0));
	}

	// ------------------------------------------------------------------
	// Phase 4: Collect orphaned nodes (unreachable from start)
	// ------------------------------------------------------------------
	const orphans = nodes.filter((s) => !reachable.has(s.id)).map((s) => s.id);
	orphans.sort((a, b) => (stepOrder.get(a) ?? 0) - (stepOrder.get(b) ?? 0));

	// Determine the widest layer for centering
	const maxLayerWidth = Math.max(
		...[...layerGroups.values()].map((g) => g.length),
		orphans.length,
		1
	);

	// ------------------------------------------------------------------
	// Phase 5: Assign x/y coordinates
	// ------------------------------------------------------------------
	const positions = new Map<string, Point>();

	const sortedLayers = [...layerGroups.keys()].sort((a, b) => a - b);

	for (const l of sortedLayers) {
		const group = layerGroups.get(l)!;
		const y = START_Y + l * V_GAP;
		const totalWidth = (group.length - 1) * H_GAP;
		const maxWidth = (maxLayerWidth - 1) * H_GAP;
		const xStart = START_X + (maxWidth - totalWidth) / 2;
		for (let i = 0; i < group.length; i++) {
			positions.set(group[i], { x: xStart + i * H_GAP, y });
		}
	}

	// Place orphans below all reachable layers
	if (orphans.length > 0) {
		const orphanLayer = sortedLayers.length;
		const y = START_Y + orphanLayer * V_GAP;
		const totalWidth = (orphans.length - 1) * H_GAP;
		const maxWidth = (maxLayerWidth - 1) * H_GAP;
		const xStart = START_X + (maxWidth - totalWidth) / 2;
		for (let i = 0; i < orphans.length; i++) {
			positions.set(orphans[i], { x: xStart + i * H_GAP, y });
		}
	}

	return positions;
}
