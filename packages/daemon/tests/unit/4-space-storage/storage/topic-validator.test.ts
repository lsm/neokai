/**
 * Topic Validator Unit Tests
 *
 * Covers:
 *   - validateGlobPattern: valid patterns across different segment counts, edge cases
 *   - validateLiteralTopic: literal topics accepted, wildcards rejected
 *   - validateSource: known sources, unknown sources, malformed sources
 */

import { describe, expect, test } from 'bun:test';
import {
	KNOWN_SOURCES,
	validateGlobPattern,
	validateLiteralTopic,
	validateSource,
	validateSubscriptionPattern,
} from '../../../../src/lib/external-events/topic-validator';

describe('validateGlobPattern', () => {
	test('accepts 5-segment GitHub topic', () => {
		const r = validateGlobPattern('github/lsm/neokai/pull_request/5.review_submitted');
		expect(r.valid).toBe(true);
	});

	test('accepts 3-segment Slack-like topic', () => {
		const r = validateGlobPattern('slack/workspace/channel/message_created');
		expect(r.valid).toBe(true);
	});

	test('accepts segment wildcards', () => {
		const r = validateGlobPattern('github/*/*/pull_request/5.review_submitted');
		expect(r.valid).toBe(true);
	});

	test('accepts dotted-segment wildcard', () => {
		const r = validateGlobPattern('github/*/*/pull_request/5.*');
		expect(r.valid).toBe(true);
	});

	test('accepts dotted-segment partial wildcard', () => {
		const r = validateGlobPattern('github/*/*/pull_request/5.review_*');
		expect(r.valid).toBe(true);
	});

	test('rejects empty string', () => {
		const r = validateGlobPattern('');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/must not be empty/);
	});

	test('rejects single segment (no scope)', () => {
		const r = validateGlobPattern('github');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/at least 2 segments/);
	});

	test('rejects empty segment (double slash)', () => {
		const r = validateGlobPattern('github//repo/pull_request/5.opened');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/empty segments/);
	});

	test('rejects ".." segment', () => {
		const r = validateGlobPattern('github/../repo/pull_request/5.opened');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/\.\./);
	});

	test('rejects multi-segment "**" wildcard', () => {
		const r = validateGlobPattern('github/**/repo/pull_request/5.opened');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/\*\*/);
	});

	test('rejects invalid characters', () => {
		const r = validateGlobPattern('github/lsm/neokai/pull_request/5$opened');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/invalid characters/);
	});
});

describe('validateLiteralTopic', () => {
	test('accepts literal 5-segment GitHub topic', () => {
		const r = validateLiteralTopic('github/lsm/neokai/pull_request/5.review_submitted');
		expect(r.valid).toBe(true);
	});

	test('accepts literal 4-segment GitHub topic (legacy format)', () => {
		const r = validateLiteralTopic('github/lsm/neokai/pull_request.review_submitted');
		expect(r.valid).toBe(true);
	});

	test('accepts literal 3-segment non-GitHub topic', () => {
		const r = validateLiteralTopic('slack/workspace/channel/message_created');
		expect(r.valid).toBe(true);
	});

	test('rejects GitHub topic with wrong segment count', () => {
		const r = validateLiteralTopic('github/owner/repo');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/4 or 5 segments/);
	});

	test('rejects GitHub 5-segment topic without entityId.action delimiter', () => {
		const r = validateLiteralTopic('github/lsm/neokai/pull_request/review_submitted');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/fifth segment must be entityId\.action/);
	});

	test('rejects GitHub 5-segment topic with empty entityId', () => {
		const r = validateLiteralTopic('github/lsm/neokai/pull_request/.review_submitted');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/fifth segment must be entityId\.action/);
	});

	test('rejects GitHub 5-segment topic with empty action', () => {
		const r = validateLiteralTopic('github/lsm/neokai/pull_request/5.');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/fifth segment must be entityId\.action/);
	});

	test('rejects GitHub 5-segment topic with multiple dots in final segment', () => {
		const r = validateLiteralTopic('github/lsm/neokai/pull_request/5.review.submitted');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/exactly one dot/);
	});

	test('rejects GitHub 4-segment topic without resource.action delimiter', () => {
		const r = validateLiteralTopic('github/lsm/neokai/pull_request_review_submitted');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/fourth segment must be resource\.action/);
	});

	test('rejects segment wildcard', () => {
		const r = validateLiteralTopic('github/*/*/pull_request/5.opened');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/no wildcards/);
	});

	test('rejects dotted-segment wildcard', () => {
		const r = validateLiteralTopic('github/lsm/neokai/pull_request/5.*');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/no wildcards/);
	});

	test('rejects single segment', () => {
		const r = validateLiteralTopic('github');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/at least 2 segments/);
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

	test('rejects valid but unregistered source', () => {
		const r = validateSource('my_source-2');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/not registered/);
	});
});

describe('validateSubscriptionPattern', () => {
	test('accepts valid 5-segment GitHub pattern with wildcards', () => {
		const r = validateSubscriptionPattern('github/*/*/pull_request/*.*');
		expect(r.valid).toBe(true);
	});

	test('accepts valid 4-segment GitHub pattern with wildcards (legacy format)', () => {
		const r = validateSubscriptionPattern('github/*/*/pull_request.*');
		expect(r.valid).toBe(true);
	});

	test('accepts GitHub pattern with specific owner/repo (5-segment)', () => {
		const r = validateSubscriptionPattern('github/lsm/neokai/pull_request/5.*');
		expect(r.valid).toBe(true);
	});

	test('accepts GitHub pattern with specific owner/repo (4-segment legacy)', () => {
		const r = validateSubscriptionPattern('github/lsm/neokai/pull_request.review_submitted');
		expect(r.valid).toBe(true);
	});

	test('accepts GitHub pattern with wildcard final segment', () => {
		const r = validateSubscriptionPattern('github/lsm/neokai/pull_request/*');
		expect(r.valid).toBe(true);
	});

	test('accepts GitHub pattern with wildcard prefix in final segment', () => {
		const r = validateSubscriptionPattern('github/lsm/neokai/pull_request/*.review_*');
		expect(r.valid).toBe(true);
	});

	test('accepts GitHub pattern with wildcard entity ID', () => {
		const r = validateSubscriptionPattern('github/lsm/neokai/pull_request/*.review_submitted');
		expect(r.valid).toBe(true);
	});

	test('accepts non-GitHub 3-segment pattern', () => {
		const r = validateSubscriptionPattern('slack/workspace/channel/*');
		expect(r.valid).toBe(true);
	});

	test('normalizes source to lowercase before validation', () => {
		const r = validateSubscriptionPattern('GitHub/lsm/neokai/pull_request.review_submitted');
		expect(r.valid).toBe(true);
	});

	test('rejects GitHub pattern with wrong segment count', () => {
		const r = validateSubscriptionPattern('github/owner/repo');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/4 or 5 segments/);
	});

	test('rejects GitHub pattern with too many segments', () => {
		const r = validateSubscriptionPattern('github/owner/repo/pull_request/5/review_submitted');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/4 or 5 segments/);
	});

	test('rejects GitHub pattern with malformed final segment (no dot)', () => {
		const r = validateSubscriptionPattern('github/*/*/pull_request/review_submitted');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/exactly one dot/);
	});

	test('rejects GitHub pattern with malformed final segment (multiple dots)', () => {
		const r = validateSubscriptionPattern('github/*/*/pull_request/5.review.submitted');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/exactly one dot/);
	});

	test('rejects GitHub pattern with malformed final segment (trailing dot)', () => {
		const r = validateSubscriptionPattern('github/*/*/pull_request/5.');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/non-empty sides/);
	});

	test('rejects GitHub pattern with malformed final segment (leading dot)', () => {
		const r = validateSubscriptionPattern('github/*/*/pull_request/.review_submitted');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/non-empty sides/);
	});

	test('rejects invalid pattern via validateGlobPattern', () => {
		const r = validateSubscriptionPattern('github//repo/pull_request/5.*');
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/empty segments/);
	});
});

describe('KNOWN_SOURCES', () => {
	test('contains github', () => {
		expect(KNOWN_SOURCES.has('github')).toBe(true);
	});
});
