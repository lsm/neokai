import { slugify } from './slug';

/**
 * Generate a slug for a worktree folder name and git branch.
 *
 * Delegates to `slugify()` for core slugification rules.
 * If the task title is empty/whitespace-only or produces an empty slug,
 * falls back to `task-{taskNumber}`.
 *
 * The returned slug is used as:
 * - The worktree folder name (as-is)
 * - The git branch name (prefixed with `space/`)
 *
 * @param taskTitle - The task title to slugify
 * @param taskNumber - The numeric task ID for fallback naming
 * @param existingSlugs - Slugs already in use, for collision avoidance
 * @returns A unique, URL-safe slug
 */
export function worktreeSlug(
	taskTitle: string,
	taskNumber: number,
	existingSlugs: string[] = []
): string {
	const trimmed = taskTitle.trim();

	if (!trimmed) {
		return resolveWorktreeCollision(`task-${taskNumber}`, existingSlugs);
	}

	const slug = slugify(trimmed, existingSlugs);

	// slugify() falls back to 'unnamed-space' for empty input; treat that as a
	// signal that the title produced no usable characters.
	if (!slug || slug === 'unnamed-space') {
		return resolveWorktreeCollision(`task-${taskNumber}`, existingSlugs);
	}

	return slug;
}

/**
 * Resolve collisions for the fallback `task-{taskNumber}` slug.
 * Appends a numeric suffix (-2, -3, …) if the base is already taken.
 */
function resolveWorktreeCollision(base: string, existingSlugs: string[]): string {
	const slugSet = new Set(existingSlugs);
	if (!slugSet.has(base)) {
		return base;
	}
	let counter = 2;
	while (true) {
		const suffixed = `${base}-${counter}`;
		if (!slugSet.has(suffixed)) {
			return suffixed;
		}
		counter++;
	}
}
