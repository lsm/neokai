/**
 * Topic validation for external-event topics and subscription glob patterns.
 *
 * Topic shape is source-specific. GitHub uses
 * `github/owner/repo/resource/entityId.action` (5 segments); other sources may
 * use different depths. Each source extension defines and enforces its own
 * schema.
 *
 * `validateGlobPattern()` enforces only the universal structural constraints
 * shared by all sources: non-empty, no empty segments, no `..`, no `**`,
 * valid characters per segment. Source-specific depth and structure checks
 * belong in the extension.
 *
 * The subscription glob pattern uses the same shape; segments may be the
 * single-segment wildcard `*`, a dotted-segment wildcard such as
 * `5.*` / `5.review_*`, or a literal value.
 *
 * `validateGlobPattern()` is the single source of truth for both topic literals
 * (called when an extension publishes) and subscription patterns (called when a
 * workflow declares an `eventInterest`). It is intentionally strict about
 * structural safety — patterns that pass validation must never silently fail to
 * match a well-formed topic.
 */

export interface ValidationResult {
	valid: boolean;
	reason?: string;
}

/**
 * Validate a topic literal or subscription glob pattern.
 *
 * Universal constraints:
 * - Non-empty.
 * - At least 2 slash-delimited segments (source + one scope segment).
 * - No empty segments (`a//b`).
 * - No `..` segments.
 * - No multi-segment `**` wildcard (not supported).
 * - Each segment uses only `[a-zA-Z0-9_.*-]`.
 *
 * Source-specific constraints (segment count, dotted resource.action format,
 * wildcard position restrictions) are enforced by each extension.
 */
export function validateGlobPattern(pattern: string): ValidationResult {
	if (typeof pattern !== 'string' || pattern.trim().length === 0) {
		return { valid: false, reason: 'Topic pattern must not be empty' };
	}

	const segments = pattern.split('/');

	if (segments.length < 2) {
		return {
			valid: false,
			reason:
				`Topic pattern must have at least 2 segments (source/scope); got ${segments.length}. ` +
				`Example: 'github/lsm/neokai/pull_request/5.review_submitted'`,
		};
	}

	for (const segment of segments) {
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
			return { valid: false, reason: 'Multi-segment "**" wildcard is not supported' };
		}
		if (!/^[a-zA-Z0-9_.*-]+$/.test(segment)) {
			return {
				valid: false,
				reason:
					`Segment "${segment}" contains invalid characters. ` +
					`Use alphanumeric, dash, underscore, dot, or segment-local "*" wildcard.`,
			};
		}
	}

	return { valid: true };
}

/**
 * Allow-list of source identifiers known to the daemon. Extensions register
 * their identifier here so unknown/typo'd sources fail loudly at publish time
 * rather than silently storing topics that no subscriber will ever match.
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

	// Source-specific validation for registered sources
	const source = topic.split('/')[0];
	if (source === 'github') {
		return validateGitHubLiteralTopic(topic);
	}

	return { valid: true };
}

/**
 * Validate a subscription pattern for workflow eventInterests.
 * Enforces source-specific pattern structure in addition to general
 * glob pattern validation.
 */
export function validateSubscriptionPattern(pattern: string): ValidationResult {
	const globCheck = validateGlobPattern(pattern);
	if (!globCheck.valid) {
		return globCheck;
	}

	// Source-specific validation for registered sources
	const source = pattern.split('/')[0];
	if (source === 'github') {
		return validateGitHubSubscriptionPattern(pattern);
	}

	return { valid: true };
}

/**
 * Validate GitHub literal topic structure.
 * GitHub topics must be 5 segments: {source}/{owner}/{repo}/{resource}/{entityId.action}
 */
function validateGitHubLiteralTopic(topic: string): ValidationResult {
	const segments = topic.split('/');

	if (segments.length !== 5) {
		return {
			valid: false,
			reason:
				`GitHub topic must have exactly 5 segments ` +
				`(source/owner/repo/resource/entityId.action); got ${segments.length}. ` +
				`Example: 'github/lsm/neokai/pull_request/5.review_submitted'`,
		};
	}

	const entityIdAction = segments[4];
	const dotIndex = entityIdAction.indexOf('.');
	if (dotIndex <= 0 || dotIndex === entityIdAction.length - 1) {
		return {
			valid: false,
			reason:
				`GitHub topic fifth segment must be entityId.action; got "${entityIdAction}". ` +
				`Example: '5.review_submitted'`,
		};
	}

	// Enforce exactly one dot in the 5th segment (entityId.action pair).
	const dotCount = (entityIdAction.match(/\./g) || []).length;
	if (dotCount !== 1) {
		return {
			valid: false,
			reason:
				`GitHub topic fifth segment must contain exactly one dot ` +
				`(entityId.action), got ${dotCount} dots in "${entityIdAction}". ` +
				`Example: '5.review_submitted'`,
		};
	}

	return { valid: true };
}

/**
 * Validate GitHub subscription pattern structure.
 * GitHub patterns must have exactly 5 segments to match real GitHub topics.
 */
function validateGitHubSubscriptionPattern(pattern: string): ValidationResult {
	const segments = pattern.split('/');

	if (segments.length !== 5) {
		return {
			valid: false,
			reason:
				`GitHub subscription pattern must have exactly 5 segments ` +
				`(source/owner/repo/resource/entityId.action); got ${segments.length}. ` +
				`Example: 'github/*/*/pull_request/*.*' or 'github/lsm/neokai/pull_request/5.*'`,
		};
	}

	// Final segment pattern must be compatible with entityId.action format:
	// - `*` (matches whole segment)
	// - `*.*` (matches any entity.action)
	// - `*.action` or `entity.*` (matches specific entity or action)
	// - `*.prefix_*` (matches actions with prefix)
	// Basically: either `*` or contains exactly one dot with non-empty sides
	const finalSegment = segments[4];
	if (finalSegment !== '*') {
		const dotCount = (finalSegment.match(/\./g) || []).length;
		if (dotCount !== 1) {
			return {
				valid: false,
				reason:
					`GitHub subscription pattern final segment must contain exactly one dot ` +
					`to match entityId.action; got ${dotCount} dots in "${finalSegment}". ` +
					`Examples: '*.*', '*.review_submitted', '5.*', '5.review_*'`,
			};
		}

		const dotIndex = finalSegment.indexOf('.');
		if (dotIndex <= 0 || dotIndex === finalSegment.length - 1) {
			return {
				valid: false,
				reason:
					`GitHub subscription pattern final segment must have non-empty sides ` +
					`around the dot (entityId.action); got "${finalSegment}". ` +
					`Examples: '*.*', '*.review_submitted', '5.*', '5.review_*'`,
			};
		}
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
