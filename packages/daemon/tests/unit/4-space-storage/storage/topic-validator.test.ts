/**
 * Topic Validator Unit Tests
 *
 * Covers:
 *   - validateGlobPattern: valid patterns, invalid patterns, edge cases
 *   - validateSource: known sources, unknown sources, malformed sources
 */

import { describe, test, expect } from 'bun:test';
import {
	validateGlobPattern,
	validateLiteralTopic,
	validateSource,
	KNOWN_SOURCES,
} from '../../../../src/lib/external-events/topic-validator';

describe('validateGlobPattern', () => {
	test('accepts literal topic', () => {
		const r = validateGlobPattern('github/lsm/neokai/pull_request.review_submitted');
		expect(r.valid).toBe(true);
	});

	test('accepts segment wildcard', () => {
		const r = validateGlobPattern('github/*/*/pull_request.opened');
		expect(r.valid).toBe(true);
	});

	test('accepts dotted-segment wildcard', () => {
		const r = validateGlobPattern('github/*/*/pull_request.*');
		expect(r.valid).toBe(true);
	});

	test('accepts dotted-segment partial wildcard', () => {
		const r = validateGlobPattern('github/*/*/pull_request.review_*');
		expect(r.valid).toBe(true);
	});

	test('rejects empty string', () => {
		const r = validateGlobPattern('');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/must not be empty/);
	});

	test('rejects wrong segment count (too few)', () => {
		const r = validateGlobPattern('github/owner/repo');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/exactly 4 segments/);
	});

	test('rejects wrong segment count (too many)', () => {
		const r = validateGlobPattern('github/owner/repo/extra/pull_request.opened');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/exactly 4 segments/);
	});

	test('rejects empty segment (double slash)', () => {
		const r = validateGlobPattern('github//repo/pull_request.opened');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/empty segments/);
	});

	test('rejects ".." segment', () => {
		const r = validateGlobPattern('github/../repo/pull_request.opened');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/\.\./);
	});

	test('rejects multi-segment "**" wildcard', () => {
		const r = validateGlobPattern('github/**/repo/pull_request.opened');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/\*\*/);
	});

	test('rejects invalid characters', () => {
		const r = validateGlobPattern('github/lsm/neokai/pull_request$opened');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/invalid characters/);
	});

	test('rejects resource.action without dot', () => {
		const r = validateGlobPattern('github/lsm/neokai/pull_request_opened');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/resource\.action/);
	});

	test('rejects resource.action with empty resource', () => {
		const r = validateGlobPattern('github/lsm/neokai/.opened');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/resource\.action/);
	});

	test('rejects resource.action with empty action', () => {
		const r = validateGlobPattern('github/lsm/neokai/pull_request.');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/resource\.action/);
	});

	test('rejects resource.action with more than one dot', () => {
		const r = validateGlobPattern('github/lsm/neokai/pull_request.review.submitted');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/exactly one dot/);
	});

	test('rejects mid-segment wildcard in source position', () => {
		const r = validateGlobPattern('git*/lsm/neokai/pull_request.opened');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/unsupported wildcard/);
	});

	test('rejects mid-segment wildcard in scope1 position', () => {
		const r = validateGlobPattern('github/own*/neokai/pull_request.opened');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/unsupported wildcard/);
	});

	test('rejects mid-segment wildcard in scope2 position', () => {
		const r = validateGlobPattern('github/lsm/repo*/pull_request.opened');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/unsupported wildcard/);
	});

	test('accepts whole-segment wildcard in segments 1-3', () => {
		const r = validateGlobPattern('github/*/*/pull_request.opened');
		expect(r.valid).toBe(true);
	});
});

describe('validateLiteralTopic', () => {
	test('accepts literal topic', () => {
		const r = validateLiteralTopic('github/lsm/neokai/pull_request.review_submitted');
		expect(r.valid).toBe(true);
	});

	test('rejects segment wildcard', () => {
		const r = validateLiteralTopic('github/*/*/pull_request.opened');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/no wildcards/);
	});

	test('rejects dotted-segment wildcard', () => {
		const r = validateLiteralTopic('github/lsm/neokai/pull_request.*');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/no wildcards/);
	});

	test('rejects invalid segment count', () => {
		const r = validateLiteralTopic('github/owner/repo');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/exactly 4 segments/);
	});
});

describe('validateSource', () => {
	test('accepts known source "github"', () => {
		const r = validateSource('github');
		expect(r.valid).toBe(true);
	});

	test('rejects unknown source', () => {
		const r = validateSource('slack');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/not registered/);
	});

	test('rejects empty source', () => {
		const r = validateSource('');
		expect(r.valid).toBe(false);
	});

	test('rejects source starting with digit', () => {
		const r = validateSource('1github');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/must be lowercase/);
	});

	test('rejects source with uppercase', () => {
		const r = validateSource('GitHub');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/must be lowercase/);
	});

	test('accepts source with dash and underscore', () => {
		const r = validateSource('my_source-2');
		expect(r.valid).toBe(false); // not in KNOWN_SOURCES
		expect(r.reason).toMatch(/not registered/);
	});
});

describe('KNOWN_SOURCES', () => {
	test('contains github', () => {
		expect(KNOWN_SOURCES.has('github')).toBe(true);
	});
});
