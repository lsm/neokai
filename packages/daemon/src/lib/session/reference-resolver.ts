/**
 * Reference Resolver
 *
 * Provides static extraction and async resolution of @ references embedded
 * in user message text. Used by MessagePersistence to attach resolved entity
 * data to persisted messages as ReferenceMetadata.
 */

import type { ReferenceMention, ReferenceMetadata, ResolvedReference } from '@neokai/shared';
import { REFERENCE_PATTERN } from '@neokai/shared';
import type {
	TaskRepoForReference,
	GoalRepoForReference,
} from '../rpc-handlers/reference-handlers';
import { resolveFile, resolveFolder } from '../rpc-handlers/reference-handlers';
import { Logger } from '../logger';

const log = new Logger('ReferenceResolver');

// ============================================================================
// Public interfaces
// ============================================================================

export interface ResolutionContext {
	workspacePath: string;
	roomId: string | null;
}

export interface PreprocessedMessage {
	/** Original text, unchanged */
	text: string;
	/** Resolved reference data, keyed by @ref{type:id} token */
	referenceMetadata: ReferenceMetadata;
}

export interface ReferenceResolverDeps {
	taskRepo: TaskRepoForReference;
	goalRepo: GoalRepoForReference;
}

// ============================================================================
// ReferenceResolver class
// ============================================================================

export class ReferenceResolver {
	constructor(private deps: ReferenceResolverDeps) {}

	/**
	 * Extract all @ref{type:id} tokens from a text string.
	 *
	 * NOTE: REFERENCE_PATTERN uses the 'g' flag and is stateful. lastIndex is
	 * always reset to 0 before use to prevent stale state from prior calls.
	 */
	static extractReferences(text: string): ReferenceMention[] {
		REFERENCE_PATTERN.lastIndex = 0;
		const mentions: ReferenceMention[] = [];
		let match: RegExpExecArray | null;

		while ((match = REFERENCE_PATTERN.exec(text)) !== null) {
			const type = match[1] as ReferenceMention['type'];
			const id = match[2];

			// Only accept known reference types
			if (type !== 'task' && type !== 'goal' && type !== 'file' && type !== 'folder') {
				continue;
			}

			mentions.push({ type, id, displayText: id });
		}

		return mentions;
	}

	/**
	 * Resolve a single reference mention to its entity data.
	 * Returns null when the reference cannot be found or the type is unknown.
	 */
	async resolveReference(
		mention: ReferenceMention,
		context: ResolutionContext
	): Promise<ResolvedReference | null> {
		try {
			switch (mention.type) {
				case 'task':
					return this.resolveTask(mention.id, context.roomId);

				case 'goal':
					return this.resolveGoal(mention.id, context.roomId);

				case 'file':
					return resolveFile(mention.id, context.workspacePath);

				case 'folder':
					return resolveFolder(mention.id, context.workspacePath);

				default: {
					log.warn(`Unknown reference type: ${mention.type as string}`);
					return null;
				}
			}
		} catch (err) {
			log.warn(`Failed to resolve reference ${mention.type}:${mention.id}:`, err);
			return null;
		}
	}

	/**
	 * Resolve all mentions in parallel.
	 *
	 * Returns a map keyed by the raw @ref{type:id} token string.
	 * Null (unresolved) results are excluded from the returned map.
	 */
	async resolveAllReferences(
		mentions: ReferenceMention[],
		context: ResolutionContext
	): Promise<Record<string, ResolvedReference>> {
		const tokens = mentions.map((m) => `@ref{${m.type}:${m.id}}`);

		const results = await Promise.all(
			mentions.map((mention) => this.resolveReference(mention, context))
		);

		const metadata: Record<string, ResolvedReference> = {};
		for (let i = 0; i < results.length; i++) {
			const resolved = results[i];
			if (resolved !== null) {
				metadata[tokens[i]] = resolved;
			}
		}

		return metadata;
	}

	// ============================================================================
	// Private per-type resolution helpers
	// ============================================================================

	private resolveTask(id: string, roomId: string | null): ResolvedReference | null {
		if (!roomId) {
			return null;
		}

		let task = this.deps.taskRepo.getTask(id);
		if (!task) {
			task = this.deps.taskRepo.getTaskByShortId(roomId, id);
		}

		if (!task) {
			return null;
		}

		// Confirm the task belongs to the session's room (prevent cross-room access via UUID)
		if (task.roomId !== roomId) {
			return null;
		}

		return { type: 'task', id, data: task };
	}

	private resolveGoal(id: string, roomId: string | null): ResolvedReference | null {
		if (!roomId) {
			return null;
		}

		let goal = this.deps.goalRepo.getGoal(id);
		if (!goal) {
			goal = this.deps.goalRepo.getGoalByShortId(roomId, id);
		}

		if (!goal) {
			return null;
		}

		// Confirm the goal belongs to the session's room
		if (goal.roomId !== roomId) {
			return null;
		}

		return { type: 'goal', id, data: goal };
	}
}
