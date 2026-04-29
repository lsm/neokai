import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	cleanupRouter,
	createSessionPath,
	createSpaceAgentPath,
	createSpaceConfigurePath,
	createSpacePath,
	createSpaceSessionPath,
	createSpaceSessionsPath,
	createSpaceTaskPath,
	createSpaceTasksPath,
	getSessionIdFromPath,
	getSpaceAgentFromPath,
	getSpaceConfigureTabFromPath,
	getSpaceIdFromPath,
	getSpaceSessionIdFromPath,
	getSpaceTaskIdFromPath,
	getSpaceTaskViewFromPath,
	initializeRouter,
	navigateToHome,
	navigateToInbox,
	navigateToSession,
	navigateToSpace,
	navigateToSpaceAgent,
	navigateToSpaceConfigure,
	navigateToSpaceSession,
	navigateToSpaceTask,
	navigateToSpaceTasks,
	navigateToSpacesPage,
	navigateToSettings,
} from '../router';
import {
	currentSessionIdSignal,
	currentSpaceConfigureTabSignal,
	currentSpaceIdSignal,
	currentSpaceSessionIdSignal,
	currentSpaceTaskIdSignal,
	currentSpaceTasksFilterTabSignal,
	currentSpaceTaskViewTabSignal,
	currentSpaceViewModeSignal,
	navSectionSignal,
} from '../signals';

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';
const SPACE_ID = 'demo-space';
const TASK_ID = 't-42';

function resetSignals() {
	currentSessionIdSignal.value = null;
	currentSpaceIdSignal.value = null;
	currentSpaceSessionIdSignal.value = null;
	currentSpaceTaskIdSignal.value = null;
	currentSpaceViewModeSignal.value = 'overview';
	currentSpaceConfigureTabSignal.value = 'agents';
	currentSpaceTasksFilterTabSignal.value = 'active';
	currentSpaceTaskViewTabSignal.value = 'thread';
	navSectionSignal.value = 'spaces';
}

function finishNavigation() {
	vi.runAllTimers();
}

function setPath(path: string) {
	Object.defineProperty(window, 'location', {
		value: { pathname: path },
		configurable: true,
	});
}

describe('router', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		cleanupRouter();
		resetSignals();
		setPath('/');
		vi.spyOn(window.history, 'pushState');
		vi.spyOn(window.history, 'replaceState');
	});

	afterEach(() => {
		cleanupRouter();
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSignals();
	});

	it('creates and extracts session and space paths', () => {
		expect(createSessionPath(SESSION_ID)).toBe(`/session/${SESSION_ID}`);
		expect(getSessionIdFromPath(`/session/${SESSION_ID}`)).toBe(SESSION_ID);
		expect(createSpacePath(SPACE_ID)).toBe(`/space/${SPACE_ID}`);
		expect(createSpaceConfigurePath(SPACE_ID, 'settings')).toBe(
			`/space/${SPACE_ID}/configure/settings`
		);
		expect(createSpaceTasksPath(SPACE_ID, 'action')).toBe(`/space/${SPACE_ID}/tasks/action`);
		expect(createSpaceSessionsPath(SPACE_ID)).toBe(`/space/${SPACE_ID}/sessions`);
		expect(createSpaceAgentPath(SPACE_ID)).toBe(`/space/${SPACE_ID}/agent`);
		expect(createSpaceSessionPath(SPACE_ID, SESSION_ID)).toBe(
			`/space/${SPACE_ID}/session/${SESSION_ID}`
		);
		expect(createSpaceTaskPath(SPACE_ID, TASK_ID, 'artifacts')).toBe(
			`/space/${SPACE_ID}/task/${TASK_ID}/artifacts`
		);
	});

	it('does not treat legacy room URLs as space routes', () => {
		const legacyPath = '/ro' + 'om/abc-123';
		expect(getSpaceIdFromPath(legacyPath)).toBeNull();
		expect(getSpaceAgentFromPath(`${legacyPath}/agent`)).toBeNull();
		expect(getSpaceTaskIdFromPath(`${legacyPath}/task/t-42`)).toBeNull();
	});

	it('initializes / as the Spaces section', () => {
		setPath('/');

		expect(initializeRouter()).toBeNull();

		expect(navSectionSignal.value).toBe('spaces');
		expect(currentSessionIdSignal.value).toBeNull();
		expect(currentSpaceIdSignal.value).toBeNull();
	});

	it('initializes space task view routes', () => {
		setPath(`/space/${SPACE_ID}/task/${TASK_ID}/canvas`);

		initializeRouter();

		expect(currentSpaceIdSignal.value).toBe(SPACE_ID);
		expect(currentSpaceTaskIdSignal.value).toBe(TASK_ID);
		expect(currentSpaceTaskViewTabSignal.value).toBe('canvas');
		expect(navSectionSignal.value).toBe('spaces');
		expect(getSpaceTaskViewFromPath(`/space/${SPACE_ID}/task/${TASK_ID}/canvas`)).toEqual({
			spaceId: SPACE_ID,
			taskId: TASK_ID,
			view: 'canvas',
		});
	});

	it('initializes space configure and task list tabs', () => {
		setPath(`/space/${SPACE_ID}/configure/workflows`);
		initializeRouter();

		expect(getSpaceConfigureTabFromPath(`/space/${SPACE_ID}/configure/workflows`)).toEqual({
			spaceId: SPACE_ID,
			tab: 'workflows',
		});
		expect(currentSpaceIdSignal.value).toBe(SPACE_ID);
		expect(currentSpaceViewModeSignal.value).toBe('configure');
		expect(currentSpaceConfigureTabSignal.value).toBe('workflows');

		cleanupRouter();
		setPath(`/space/${SPACE_ID}/tasks/completed`);
		initializeRouter();

		expect(currentSpaceViewModeSignal.value).toBe('tasks');
		expect(currentSpaceTasksFilterTabSignal.value).toBe('completed');
	});

	it('navigates session, settings, inbox, and home routes', () => {
		navigateToSession(SESSION_ID);
		expect(window.history.pushState).toHaveBeenLastCalledWith(
			{ sessionId: SESSION_ID, path: `/session/${SESSION_ID}` },
			'',
			`/session/${SESSION_ID}`
		);
		expect(currentSessionIdSignal.value).toBe(SESSION_ID);
		expect(navSectionSignal.value).toBe('chats');
		finishNavigation();

		navigateToSettings();
		expect(navSectionSignal.value).toBe('settings');
		expect(currentSessionIdSignal.value).toBeNull();
		finishNavigation();

		navigateToInbox();
		expect(navSectionSignal.value).toBe('inbox');
		finishNavigation();

		navigateToHome();
		expect(navSectionSignal.value).toBe('spaces');
		expect(window.history.pushState).toHaveBeenLastCalledWith({ path: '/spaces' }, '', '/spaces');
	});

	it('navigates space routes and clears regular session selection', () => {
		currentSessionIdSignal.value = SESSION_ID;

		navigateToSpace(SPACE_ID);
		expect(currentSessionIdSignal.value).toBeNull();
		expect(currentSpaceIdSignal.value).toBe(SPACE_ID);
		expect(currentSpaceViewModeSignal.value).toBe('overview');
		expect(navSectionSignal.value).toBe('spaces');
		finishNavigation();

		navigateToSpaceTasks(SPACE_ID, 'action');
		expect(currentSpaceViewModeSignal.value).toBe('tasks');
		expect(currentSpaceTasksFilterTabSignal.value).toBe('action');
		finishNavigation();

		navigateToSpaceConfigure(SPACE_ID, 'settings');
		expect(currentSpaceViewModeSignal.value).toBe('configure');
		expect(currentSpaceConfigureTabSignal.value).toBe('settings');
		finishNavigation();

		navigateToSpaceTask(SPACE_ID, TASK_ID, 'artifacts');
		expect(currentSpaceTaskIdSignal.value).toBe(TASK_ID);
		expect(currentSpaceTaskViewTabSignal.value).toBe('artifacts');
		finishNavigation();

		navigateToSpaceSession(SPACE_ID, SESSION_ID);
		expect(currentSpaceSessionIdSignal.value).toBe(SESSION_ID);
		expect(currentSpaceTaskIdSignal.value).toBeNull();
		finishNavigation();

		navigateToSpaceAgent(SPACE_ID);
		expect(currentSpaceSessionIdSignal.value).toBe(`space:chat:${SPACE_ID}`);
		finishNavigation();

		navigateToSpacesPage();
		expect(currentSpaceIdSignal.value).toBeNull();
		expect(navSectionSignal.value).toBe('spaces');
	});
});
