/**
 * Workflow Selector
 *
 * Pure, deterministic function for selecting a SpaceWorkflow given a context.
 * Has no runtime dependencies — takes only data inputs so it can be tested
 * in isolation without any DB or manager instances.
 *
 * Priority chain (first match wins):
 *   1. Explicit workflowId provided → use it
 *   2. Tag-based: match keywords from title/description against workflow tags
 *   3. MVP keyword matching: substring match title/description against workflow descriptions
 *   4. Fall back to null (create standalone task)
 *
 * Note: The "space has default workflow" step was removed in Task 3.2 —
 * the Space system has no isDefault concept. Workflow selection is explicit
 * workflowId OR AI auto-select via this function.
 */

import type { SpaceWorkflow } from '@neokai/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowSelectionContext {
	/** The space this selection is scoped to. */
	spaceId: string;
	/** Human-readable title of the work being requested. */
	title: string;
	/** Longer description of the work being requested. May be empty. */
	description: string;
	/**
	 * Available workflows to select from.
	 * Must all belong to the given spaceId — callers are responsible for pre-filtering.
	 */
	availableWorkflows: SpaceWorkflow[];
	/**
	 * Optional explicit workflow ID. When provided, the function uses this workflow
	 * if it exists in availableWorkflows, bypassing all other heuristics.
	 */
	workflowId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise text for comparison: lowercase, collapse whitespace.
 */
function normalise(text: string): string {
	return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Extract candidate keywords from a title + description string.
 * Returns individual words longer than 2 chars (stops words like 'a', 'an', 'to').
 */
function extractKeywords(title: string, description: string): string[] {
	const combined = normalise(`${title} ${description}`);
	return combined
		.split(/\W+/)
		.filter((w) => w.length > 2)
		.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Core selection logic
// ---------------------------------------------------------------------------

/**
 * Select a workflow from the available set given the context.
 *
 * Returns null when no workflow matches — callers should create a standalone
 * SpaceTask in that case.
 *
 * The function is pure and deterministic: given the same inputs it always
 * returns the same output.
 */
export function selectWorkflow(context: WorkflowSelectionContext): SpaceWorkflow | null {
	const { availableWorkflows, workflowId, title, description } = context;

	if (availableWorkflows.length === 0) return null;

	// -------------------------------------------------------------------------
	// Step 1: Explicit workflowId provided
	// -------------------------------------------------------------------------
	if (workflowId) {
		const explicit = availableWorkflows.find((w) => w.id === workflowId);
		if (explicit) return explicit;
		// Explicit ID was given but not found in the available set — return null
		// rather than silently falling through to heuristics.
		return null;
	}

	// -------------------------------------------------------------------------
	// Step 2: Tag-based matching
	// Rank workflows by how many of the input keywords appear in their tag list.
	// -------------------------------------------------------------------------
	const keywords = extractKeywords(title, description);

	if (keywords.length > 0) {
		let bestTagMatch: SpaceWorkflow | null = null;
		let bestTagScore = 0;

		for (const workflow of availableWorkflows) {
			if (!workflow.tags || workflow.tags.length === 0) continue;

			const normalisedTags = workflow.tags.map(normalise);
			let score = 0;
			for (const kw of keywords) {
				if (normalisedTags.some((tag) => tag.includes(kw) || kw.includes(tag))) {
					score++;
				}
			}

			if (score > bestTagScore) {
				bestTagScore = score;
				bestTagMatch = workflow;
			}
		}

		if (bestTagMatch) return bestTagMatch;
	}

	// -------------------------------------------------------------------------
	// Step 3: MVP keyword matching — substring match title/description against
	// workflow descriptions.
	// -------------------------------------------------------------------------
	const normalisedInput = normalise(`${title} ${description}`);

	let bestDescMatch: SpaceWorkflow | null = null;
	let bestDescScore = 0;

	for (const workflow of availableWorkflows) {
		const workflowDesc = normalise(workflow.description ?? '');
		if (!workflowDesc) continue;

		// Score: count how many words from the workflow description appear in the input
		const descWords = workflowDesc.split(/\W+/).filter((w) => w.length > 2);
		let score = 0;
		for (const word of descWords) {
			if (normalisedInput.includes(word)) score++;
		}

		if (score > bestDescScore) {
			bestDescScore = score;
			bestDescMatch = workflow;
		}
	}

	if (bestDescMatch) return bestDescMatch;

	// -------------------------------------------------------------------------
	// Step 4: Fall back to null — caller creates a standalone task
	// -------------------------------------------------------------------------
	return null;
}
