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

import type { SpaceTask } from '@neokai/shared';
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
	/**
	 * Optional repo-scoped task filter. When provided, candidates are narrowed
	 * to tasks associated with the given repository. This is needed for accurate
	 * resolution in multi-repo spaces because `SpaceTask` does not yet carry
	 * repo metadata natively.
	 *
	 * When absent, a default heuristic filter is applied that requires the task
	 * title or description to contain the repo owner or repo name as a
	 * word-bounded token (case-insensitive).
	 */
	taskRepoFilter?: (task: SpaceTask, repoOwner: string, repoName: string) => boolean;
}

/**
 * Default repo-scoped filter used when no custom `taskRepoFilter` is provided.
 *
 * Requires the task title or description to contain the repo owner or repo
 * name as a standalone token (case-insensitive, word-bounded). This prevents
 * cross-repo misrouting where different repos have tasks with the same PR number.
 */
function defaultRepoFilter(task: SpaceTask, repoOwner: string, repoName: string): boolean {
	const text = `${task.title} ${task.description ?? ''}`;
	const ownerPattern = new RegExp(
		`(?:^|[^a-zA-Z0-9])${escapeRegExp(repoOwner)}(?:[^a-zA-Z0-9]|$)`,
		'i'
	);
	const namePattern = new RegExp(
		`(?:^|[^a-zA-Z0-9])${escapeRegExp(repoName)}(?:[^a-zA-Z0-9]|$)`,
		'i'
	);
	return ownerPattern.test(text) || namePattern.test(text);
}

/** Escape a string for safe interpolation into a RegExp. */
function escapeRegExp(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Test whether `text` contains `prString` as a standalone token.
 *
 * Uses word boundaries so `#42` does not match inside `#420` or `abc#42x`.
 * `prNumber` must be a positive safe integer; non-integer values are rejected
 * to avoid regex metacharacter injection.
 */
function titleContainsPrNumber(text: string, prNumber: number): boolean {
	if (!Number.isInteger(prNumber) || prNumber <= 0 || prNumber > Number.MAX_SAFE_INTEGER) {
		return false;
	}
	const pattern = new RegExp(`(?:^|[^a-zA-Z0-9])#${prNumber}(?:[^a-zA-Z0-9]|$)`);
	return pattern.test(text);
}

/**
 * Resolves GitHub PR events to SpaceTasks when trusted metadata exists.
 *
 * Strategy:
 * 1. If the event already carries `routedTaskId` (set by a trusted source
 *    extension), return it directly.
 * 2. If the event has `prNumber`, `repoOwner`, and `repoName`, look for open
 *    tasks in the same space whose title contains the PR number as a
 *    standalone token. When `taskRepoFilter` is provided, candidates are
 *    further narrowed by repo. Multiple matches produce `ambiguous`.
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
		if (
			event.routedTaskId &&
			typeof event.routedTaskId === 'string' &&
			event.routedTaskId.trim() !== ''
		) {
			return { type: 'enriched', routedTaskId: event.routedTaskId };
		}

		// 2. Heuristic: PR number + repo match against open tasks in the space.
		if (
			event.prNumber == null ||
			event.repoOwner == null ||
			event.repoName == null ||
			typeof event.repoOwner !== 'string' ||
			typeof event.repoName !== 'string' ||
			event.repoOwner.trim() === '' ||
			event.repoName.trim() === ''
		) {
			return { type: 'ignored' };
		}

		const tasks = this.config.taskRepo.listBySpace(event.spaceId, false);
		const repoFilter = this.config.taskRepoFilter ?? defaultRepoFilter;

		const candidates = tasks.filter((t) => {
			if (t.status !== 'open' && t.status !== 'in_progress') {
				return false;
			}
			if (!titleContainsPrNumber(t.title, event.prNumber!)) {
				return false;
			}
			return repoFilter(t, event.repoOwner!, event.repoName!);
		});

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
