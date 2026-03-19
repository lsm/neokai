// @ts-nocheck
/**
 * Tests for Space URL routing
 *
 * Covers:
 * - Path extraction (getSpaceIdFromPath, getSpaceSessionIdFromPath, getSpaceTaskIdFromPath)
 * - Path creation (createSpacePath, createSpaceSessionPath, createSpaceTaskPath)
 * - Navigation functions (navigateToSpace, navigateToSpaceSession, navigateToSpaceTask)
 * - initializeRouter deep-linking for space URLs
 * - handlePopState for space URL transitions
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
	getSpaceIdFromPath,
	getSpaceSessionIdFromPath,
	getSpaceTaskIdFromPath,
	createSpacePath,
	createSpaceSessionPath,
	createSpaceTaskPath,
	navigateToSpace,
	navigateToSpaceSession,
	navigateToSpaceTask,
	navigateToSpaces,
	initializeRouter,
	cleanupRouter,
} from '../router';
import {
	currentSpaceIdSignal,
	currentSpaceSessionIdSignal,
	currentSpaceTaskIdSignal,
	currentSessionIdSignal,
	currentRoomIdSignal,
	navSectionSignal,
} from '../signals';

const SPACE_ID = '550e8400-e29b-41d4-a716-446655440000';
const SESSION_ID = '660e8400-e29b-41d4-a716-446655440001';
const TASK_ID = '770e8400-e29b-41d4-a716-446655440002';

let originalHistory: unknown;
let originalLocation: unknown;
let mockHistory: { pushState: ReturnType<typeof vi.fn>; replaceState: ReturnType<typeof vi.fn> };
let mockLocation: { pathname: string };

beforeEach(() => {
	originalHistory = window.history;
	originalLocation = window.location;

	mockHistory = { pushState: vi.fn(), replaceState: vi.fn() };
	mockLocation = { pathname: '/' };

	Object.defineProperty(window, 'history', {
		value: mockHistory,
		writable: true,
		configurable: true,
	});
	Object.defineProperty(window, 'location', {
		value: mockLocation,
		writable: true,
		configurable: true,
	});

	currentSessionIdSignal.value = null;
	currentRoomIdSignal.value = null;
	currentSpaceIdSignal.value = null;
	currentSpaceSessionIdSignal.value = null;
	currentSpaceTaskIdSignal.value = null;

	vi.clearAllMocks();
	cleanupRouter();
});

afterEach(() => {
	Object.defineProperty(window, 'history', {
		value: originalHistory,
		writable: true,
		configurable: true,
	});
	Object.defineProperty(window, 'location', {
		value: originalLocation,
		writable: true,
		configurable: true,
	});

	cleanupRouter();

	currentSessionIdSignal.value = null;
	currentRoomIdSignal.value = null;
	currentSpaceIdSignal.value = null;
	currentSpaceSessionIdSignal.value = null;
	currentSpaceTaskIdSignal.value = null;
});

// ---------------------------------------------------------------------------
// Path extraction helpers
// ---------------------------------------------------------------------------

describe('getSpaceIdFromPath', () => {
	it('extracts space ID from plain space path', () => {
		expect(getSpaceIdFromPath(`/space/${SPACE_ID}`)).toBe(SPACE_ID);
	});

	it('extracts space ID from space/session path', () => {
		expect(getSpaceIdFromPath(`/space/${SPACE_ID}/session/${SESSION_ID}`)).toBe(SPACE_ID);
	});

	it('extracts space ID from space/task path', () => {
		expect(getSpaceIdFromPath(`/space/${SPACE_ID}/task/${TASK_ID}`)).toBe(SPACE_ID);
	});

	it('returns null for room path', () => {
		expect(getSpaceIdFromPath(`/room/${SPACE_ID}`)).toBeNull();
	});

	it('returns null for session path', () => {
		expect(getSpaceIdFromPath(`/session/${SPACE_ID}`)).toBeNull();
	});

	it('returns null for home path', () => {
		expect(getSpaceIdFromPath('/')).toBeNull();
	});
});

describe('getSpaceSessionIdFromPath', () => {
	it('extracts space and session IDs from space/session path', () => {
		const result = getSpaceSessionIdFromPath(`/space/${SPACE_ID}/session/${SESSION_ID}`);
		expect(result).toEqual({ spaceId: SPACE_ID, sessionId: SESSION_ID });
	});

	it('returns null for plain space path', () => {
		expect(getSpaceSessionIdFromPath(`/space/${SPACE_ID}`)).toBeNull();
	});

	it('returns null for space/task path', () => {
		expect(getSpaceSessionIdFromPath(`/space/${SPACE_ID}/task/${TASK_ID}`)).toBeNull();
	});

	it('returns null for unrelated paths', () => {
		expect(getSpaceSessionIdFromPath('/')).toBeNull();
		expect(getSpaceSessionIdFromPath(`/room/${SPACE_ID}/session/${SESSION_ID}`)).toBeNull();
	});
});

describe('getSpaceTaskIdFromPath', () => {
	it('extracts space and task IDs from space/task path', () => {
		const result = getSpaceTaskIdFromPath(`/space/${SPACE_ID}/task/${TASK_ID}`);
		expect(result).toEqual({ spaceId: SPACE_ID, taskId: TASK_ID });
	});

	it('returns null for plain space path', () => {
		expect(getSpaceTaskIdFromPath(`/space/${SPACE_ID}`)).toBeNull();
	});

	it('returns null for space/session path', () => {
		expect(getSpaceTaskIdFromPath(`/space/${SPACE_ID}/session/${SESSION_ID}`)).toBeNull();
	});

	it('returns null for unrelated paths', () => {
		expect(getSpaceTaskIdFromPath('/')).toBeNull();
		expect(getSpaceTaskIdFromPath(`/room/${SPACE_ID}/task/${TASK_ID}`)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Path creators
// ---------------------------------------------------------------------------

describe('createSpacePath', () => {
	it('creates correct path', () => {
		expect(createSpacePath(SPACE_ID)).toBe(`/space/${SPACE_ID}`);
	});
});

describe('createSpaceSessionPath', () => {
	it('creates correct path', () => {
		expect(createSpaceSessionPath(SPACE_ID, SESSION_ID)).toBe(
			`/space/${SPACE_ID}/session/${SESSION_ID}`
		);
	});
});

describe('createSpaceTaskPath', () => {
	it('creates correct path', () => {
		expect(createSpaceTaskPath(SPACE_ID, TASK_ID)).toBe(`/space/${SPACE_ID}/task/${TASK_ID}`);
	});
});

// ---------------------------------------------------------------------------
// Navigation functions
// ---------------------------------------------------------------------------

describe('navigateToSpace', () => {
	it('pushes correct URL and sets space signals', () => {
		navigateToSpace(SPACE_ID);

		expect(mockHistory.pushState).toHaveBeenCalledWith(
			{ spaceId: SPACE_ID, path: `/space/${SPACE_ID}` },
			'',
			`/space/${SPACE_ID}`
		);
		expect(currentSpaceIdSignal.value).toBe(SPACE_ID);
		expect(currentSpaceSessionIdSignal.value).toBeNull();
		expect(currentSpaceTaskIdSignal.value).toBeNull();
		expect(currentRoomIdSignal.value).toBeNull();
		expect(currentSessionIdSignal.value).toBeNull();
		expect(navSectionSignal.value).toBe('spaces');
	});

	it('uses replaceState when replace=true', () => {
		navigateToSpace(SPACE_ID, true);
		expect(mockHistory.replaceState).toHaveBeenCalled();
		expect(mockHistory.pushState).not.toHaveBeenCalled();
	});

	it('skips history push when already on the same path', () => {
		mockLocation.pathname = `/space/${SPACE_ID}`;
		navigateToSpace(SPACE_ID);
		expect(mockHistory.pushState).not.toHaveBeenCalled();
		expect(currentSpaceIdSignal.value).toBe(SPACE_ID);
	});

	it('prevents recursive navigation', () => {
		navigateToSpace(SPACE_ID);
		const callCount = mockHistory.pushState.mock.calls.length;
		navigateToSpace(SESSION_ID); // second call while isNavigating is true
		expect(mockHistory.pushState.mock.calls.length).toBe(callCount);
	});
});

describe('navigateToSpaceSession', () => {
	it('pushes correct URL and sets space + session signals', () => {
		navigateToSpaceSession(SPACE_ID, SESSION_ID);

		expect(mockHistory.pushState).toHaveBeenCalledWith(
			{
				spaceId: SPACE_ID,
				sessionId: SESSION_ID,
				path: `/space/${SPACE_ID}/session/${SESSION_ID}`,
			},
			'',
			`/space/${SPACE_ID}/session/${SESSION_ID}`
		);
		expect(currentSpaceIdSignal.value).toBe(SPACE_ID);
		expect(currentSpaceSessionIdSignal.value).toBe(SESSION_ID);
		expect(currentSpaceTaskIdSignal.value).toBeNull();
		expect(navSectionSignal.value).toBe('spaces');
	});

	it('uses replaceState when replace=true', () => {
		navigateToSpaceSession(SPACE_ID, SESSION_ID, true);
		expect(mockHistory.replaceState).toHaveBeenCalled();
	});
});

describe('navigateToSpaceTask', () => {
	it('pushes correct URL and sets space + task signals', () => {
		navigateToSpaceTask(SPACE_ID, TASK_ID);

		expect(mockHistory.pushState).toHaveBeenCalledWith(
			{ spaceId: SPACE_ID, taskId: TASK_ID, path: `/space/${SPACE_ID}/task/${TASK_ID}` },
			'',
			`/space/${SPACE_ID}/task/${TASK_ID}`
		);
		expect(currentSpaceIdSignal.value).toBe(SPACE_ID);
		expect(currentSpaceTaskIdSignal.value).toBe(TASK_ID);
		expect(currentSpaceSessionIdSignal.value).toBeNull();
		expect(navSectionSignal.value).toBe('spaces');
	});

	it('uses replaceState when replace=true', () => {
		navigateToSpaceTask(SPACE_ID, TASK_ID, true);
		expect(mockHistory.replaceState).toHaveBeenCalled();
	});
});

describe('navigateToSpaces', () => {
	it('sets navSection to spaces and navigates home', () => {
		mockLocation.pathname = `/space/${SPACE_ID}`;
		currentSpaceIdSignal.value = SPACE_ID;

		navigateToSpaces();

		expect(navSectionSignal.value).toBe('spaces');
	});
});

// ---------------------------------------------------------------------------
// initializeRouter — deep-linking for space URLs
// ---------------------------------------------------------------------------

describe('initializeRouter with space routes', () => {
	it('sets currentSpaceIdSignal from plain space URL', () => {
		mockLocation.pathname = `/space/${SPACE_ID}`;
		initializeRouter();

		expect(currentSpaceIdSignal.value).toBe(SPACE_ID);
		expect(currentSpaceSessionIdSignal.value).toBeNull();
		expect(currentSpaceTaskIdSignal.value).toBeNull();
		expect(currentRoomIdSignal.value).toBeNull();
		expect(navSectionSignal.value).toBe('spaces');
	});

	it('sets space + session signals from space/session URL', () => {
		mockLocation.pathname = `/space/${SPACE_ID}/session/${SESSION_ID}`;
		initializeRouter();

		expect(currentSpaceIdSignal.value).toBe(SPACE_ID);
		expect(currentSpaceSessionIdSignal.value).toBe(SESSION_ID);
		expect(currentSpaceTaskIdSignal.value).toBeNull();
		expect(navSectionSignal.value).toBe('spaces');
	});

	it('sets space + task signals from space/task URL', () => {
		mockLocation.pathname = `/space/${SPACE_ID}/task/${TASK_ID}`;
		initializeRouter();

		expect(currentSpaceIdSignal.value).toBe(SPACE_ID);
		expect(currentSpaceTaskIdSignal.value).toBe(TASK_ID);
		expect(currentSpaceSessionIdSignal.value).toBeNull();
		expect(navSectionSignal.value).toBe('spaces');
	});

	it('space task URL takes priority over room task with same structure', () => {
		mockLocation.pathname = `/space/${SPACE_ID}/task/${TASK_ID}`;
		initializeRouter();

		expect(currentSpaceIdSignal.value).toBe(SPACE_ID);
		expect(currentRoomIdSignal.value).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// popstate for space URLs
// ---------------------------------------------------------------------------

describe('Popstate handling for space routes', () => {
	it('updates space signals when popstate navigates to a plain space path', () => {
		mockLocation.pathname = '/';
		initializeRouter();

		mockLocation.pathname = `/space/${SPACE_ID}`;
		window.dispatchEvent(new PopStateEvent('popstate', {}));

		expect(currentSpaceIdSignal.value).toBe(SPACE_ID);
		expect(currentRoomIdSignal.value).toBeNull();
		expect(navSectionSignal.value).toBe('spaces');
	});

	it('updates space + session signals when popstate navigates to space/session path', () => {
		mockLocation.pathname = '/';
		initializeRouter();

		mockLocation.pathname = `/space/${SPACE_ID}/session/${SESSION_ID}`;
		window.dispatchEvent(new PopStateEvent('popstate', {}));

		expect(currentSpaceIdSignal.value).toBe(SPACE_ID);
		expect(currentSpaceSessionIdSignal.value).toBe(SESSION_ID);
		expect(currentSpaceTaskIdSignal.value).toBeNull();
		expect(navSectionSignal.value).toBe('spaces');
	});

	it('updates space + task signals when popstate navigates to space/task path', () => {
		mockLocation.pathname = '/';
		initializeRouter();

		mockLocation.pathname = `/space/${SPACE_ID}/task/${TASK_ID}`;
		window.dispatchEvent(new PopStateEvent('popstate', {}));

		expect(currentSpaceIdSignal.value).toBe(SPACE_ID);
		expect(currentSpaceTaskIdSignal.value).toBe(TASK_ID);
		expect(currentSpaceSessionIdSignal.value).toBeNull();
		expect(navSectionSignal.value).toBe('spaces');
	});

	it('clears space signals when popstate navigates away from space to home', () => {
		mockLocation.pathname = `/space/${SPACE_ID}`;
		initializeRouter();
		currentSpaceIdSignal.value = SPACE_ID;

		mockLocation.pathname = '/';
		window.dispatchEvent(new PopStateEvent('popstate', {}));

		expect(currentSpaceIdSignal.value).toBeNull();
		expect(navSectionSignal.value).toBe('home');
	});

	it('switches from room to space correctly on popstate', () => {
		mockLocation.pathname = `/room/${SPACE_ID}`;
		initializeRouter();

		mockLocation.pathname = `/space/${SPACE_ID}`;
		window.dispatchEvent(new PopStateEvent('popstate', {}));

		expect(currentSpaceIdSignal.value).toBe(SPACE_ID);
		expect(currentRoomIdSignal.value).toBeNull();
		expect(navSectionSignal.value).toBe('spaces');
	});
});
