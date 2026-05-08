/**
 * Topic validation for external-event topics and subscription glob patterns.
 *
 * v1 topics have exactly four segments: `{source}/{scope1}/{scope2}/{resource}.{action}`.
 * For GitHub: `github/owner/repo/pull_request.review_submitted`.
 * For future non-repo extensions, scope1/scope2 are source-specific scope segments
 * such as workspace/channel.
 *
 * The subscription glob pattern uses the same shape; segments may be the
 * single-segment wildcard `*`, a dotted-segment wildcard such as
 * `pull_request.*` / `pull_request.review_*`, or a literal value.
 *
 * `validateGlobPattern()` is the single source of truth for both topic literals
 * (called when an extension publishes) and subscription patterns (called when a
 * workflow declares an `eventInterest`). It is intentionally strict — patterns
 * that pass validation must never silently fail to match a well-formed topic.
 */

export interface ValidationResult {
	valid: boolean;
	reason?: string;
}

/**
 * Validate a topic literal or subscription glob pattern.
 *
 * Constraints (v1):
 * - Non-empty.
 * - Exactly 4 slash-delimited segments.
 * - No empty segments (`a//b`).
 * - No `..` segments.
 * - No multi-segment `**` wildcard (not supported in v1).
 * - Each segment uses only `[a-zA-Z0-9_.*-]`.
 * - Segment 4 (`resource.action`) contains exactly one dot, and neither side is empty.
 *
 * Note: glob `*` is allowed only as a whole-segment wildcard or as part of a
 * dotted segment (e.g. `pull_request.*`, `pull_request.review_*`). It is
 * not treated as a regex metacharacter — segment matching is done by the trie.
 */
export function validateGlobPattern(pattern: string): ValidationResult {
	if (typeof pattern !== 'string' || pattern.trim().length === 0) {
		return { valid: false, reason: 'Topic pattern must not be empty' };
	}

	const segments = pattern.split('/');

	if (segments.length !== 4) {
		return {
			valid: false,
			reason:
				`Topic pattern must have exactly 4 segments ` +
				`(source/scope1/scope2/resource.action); got ${segments.length}. ` +
				`Example: 'github/*/*/pull_request.review_submitted'`,
		};
	}

	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		if (segment === '') {
			return {
				valid: false,
				reason: 'Topic pattern must not contain empty segments (double slashes)',
			};
		}
		if (segment === '..') {
			return { valid: false, reason: 'Topic pattern must not contain ".." segments' };
		}
		if (segment === '**') {
			return { valid: false, reason: 'Multi-segment "**" wildcard is not supported in v1' };
		}
		if (!/^[a-zA-Z0-9_.*-]+$/.test(segment)) {
			return {
				valid: false,
				reason:
					`Segment "${segment}" contains invalid characters. ` +
					`Use alphanumeric, dash, underscore, dot, or segment-local "*" wildcard.`,
			};
		}

		// Segments 0-2 (source, scope1, scope2): * is only allowed as a whole-segment
		// wildcard. Mid-segment wildcards like `own*` or `re*po` are not supported.
		if (i < 3 && segment.includes('*') && segment !== '*') {
			return {
				valid: false,
				reason:
					`Segment "${segment}" in position ${i + 1} uses an unsupported wildcard. ` +
					`* is only allowed as a whole-segment wildcard in segments 1-3.`,
			};
		}
	}

	const resourceAction = segments[3];
	const dotIndex = resourceAction.indexOf('.');
	if (dotIndex <= 0 || dotIndex === resourceAction.length - 1) {
		return {
			valid: false,
			reason:
				`Topic pattern fourth segment must be resource.action; got "${resourceAction}". ` +
				`Example: 'pull_request.review_submitted'`,
		};
	}

	// Enforce exactly one dot in the 4th segment (resource.action pair).
	// Patterns like `pull_request.review.submitted` (two dots) are invalid
	// because v1 topics use exactly one dot to separate resource from action.
	const dotCount = (resourceAction.match(/\./g) || []).length;
	if (dotCount !== 1) {
		return {
			valid: false,
			reason:
				`Topic pattern fourth segment must contain exactly one dot ` +
				`(resource.action), got ${dotCount} dots in "${resourceAction}". ` +
				`Example: 'pull_request.review_submitted'`,
		};
	}

	return { valid: true };
}

/**
 * Allow-list of source identifiers known to the daemon. Extensions register
 * their identifier here so unknown/typo'd sources fail loudly at publish time
 * rather than silently storing topics that no router will ever match.
 */
export const KNOWN_SOURCES: ReadonlySet<string> = new Set<string>(['github']);

/**
 * Validate that a topic is a literal (no wildcards) suitable for storing
 * as a published external event.
 *
 * This is stricter than `validateGlobPattern` — it rejects any `*` characters
 * since published events must be concrete topics, not subscription patterns.
 */
export function validateLiteralTopic(topic: string): ValidationResult {
	const globCheck = validateGlobPattern(topic);
	if (!globCheck.valid) {
		return globCheck;
	}
	if (topic.includes('*')) {
		return {
			valid: false,
			reason: `Published event topic must be a literal (no wildcards); got "${topic}"`,
		};
	}
	return { valid: true };
}

export function validateSource(source: string): ValidationResult {
	if (typeof source !== 'string' || source.trim().length === 0) {
		return { valid: false, reason: 'Source must be a non-empty string' };
	}
	if (!/^[a-z][a-z0-9_-]*$/.test(source)) {
		return {
			valid: false,
			reason:
				`Source "${source}" must be lowercase, start with a letter, and use only ` +
				`alphanumerics, dashes, and underscores`,
		};
	}
	if (!KNOWN_SOURCES.has(source)) {
		return {
			valid: false,
			reason: `Source "${source}" is not registered. Known sources: ${[...KNOWN_SOURCES].join(', ')}`,
		};
	}
	return { valid: true };
}
