/**
 * ExternalEventTaskResolver — resolves external events to SpaceTask ids.
 *
 * Source-agnostic interface with a GitHub-specific initial implementation.
 * The resolver only uses trusted metadata (e.g. a first-party task id provided
 * by the source extension) or stable lookup tables. It must NOT query
 * workflow/task/gate tables directly — source extensions must not reach into
 * core runtime tables.
 *
 * Resolution results are explicit:
 *   - `enriched`     : a single unambiguous task id was found.
 *   - `ambiguous`    : multiple candidate tasks match; human/router must decide.
 *   - `unknown`      : no candidate task matches.
 *   - `ignored`      : the event does not require task resolution (e.g. no PR number).
 */

import type { SpaceTaskRepository } from '../../storage/repositories/space-task-repository';
import type { ExternalEvent } from './types';

export interface EnrichedResolution {
	type: 'enriched';
	routedTaskId: string;
}

export interface AmbiguousResolution {
	type: 'ambiguous';
	candidateTaskIds: string[];
}

export interface UnknownResolution {
	type: 'unknown';
}

export interface IgnoredResolution {
	type: 'ignored';
}

export type TaskResolution =
	| EnrichedResolution
	| AmbiguousResolution
	| UnknownResolution
	| IgnoredResolution;

export interface ExternalEventTaskResolver {
	resolve(event: ExternalEvent): Promise<TaskResolution>;
}

// ---------------------------------------------------------------------------
// GitHub PR -> SpaceTask resolver (initial implementation)
// ---------------------------------------------------------------------------

export interface GitHubTaskResolverConfig {
	taskRepo: SpaceTaskRepository;
}

/**
 * Resolves GitHub PR events to SpaceTasks when trusted metadata exists.
 *
 * Strategy:
 * 1. If the event already carries `routedTaskId` (set by a trusted source
 *    extension), return it directly.
 * 2. If the event has `prNumber`, `repoOwner`, and `repoName`, look for open
 *    tasks in the same space whose title contains the PR number. This is a
 *    heuristic — multiple matches produce `ambiguous`.
 * 3. Otherwise return `ignored` (no PR number means no routing attempt).
 *
 * This resolver never queries workflow/task/gate tables directly. It only
 * uses the `SpaceTaskRepository` public API.
 */
export class GitHubExternalEventTaskResolver implements ExternalEventTaskResolver {
	constructor(private readonly config: GitHubTaskResolverConfig) {}

	async resolve(event: ExternalEvent): Promise<TaskResolution> {
		if (event.source !== 'github') {
			return { type: 'ignored' };
		}

		// 1. Trusted first-party metadata.
		if (event.routedTaskId) {
			return { type: 'enriched', routedTaskId: event.routedTaskId };
		}

		// 2. Heuristic: PR number + repo match against open tasks in the space.
		if (event.prNumber == null || event.repoOwner == null || event.repoName == null) {
			return { type: 'ignored' };
		}

		const tasks = this.config.taskRepo.listBySpace(event.spaceId, false);
		const prString = `#${event.prNumber}`;

		const candidates = tasks.filter(
			(t) =>
				t.status !== 'archived' &&
				t.status !== 'done' &&
				t.status !== 'cancelled' &&
				t.title.toLowerCase().includes(prString.toLowerCase())
		);

		if (candidates.length === 0) {
			return { type: 'unknown' };
		}

		if (candidates.length === 1) {
			return { type: 'enriched', routedTaskId: candidates[0]!.id };
		}

		return {
			type: 'ambiguous',
			candidateTaskIds: candidates.map((t) => t.id),
		};
	}
}
