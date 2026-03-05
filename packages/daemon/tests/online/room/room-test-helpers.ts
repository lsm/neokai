/**
 * Shared helpers for room online tests.
 */

import { execSync } from 'child_process';
import { mkdirSync, writeFileSync, chmodSync } from 'fs';
import path from 'path';
import type { DaemonServerContext } from '../../helpers/daemon-server';
import type { NeoTask, RoomGoal } from '@neokai/shared';

/**
 * Set up a full git environment in the workspace for room online tests.
 *
 * Creates:
 * 1. A git repo with an initial commit (with user identity for CI)
 * 2. A bare remote repo so `git push` works
 * 3. A stateful mock `gh` CLI that handles pr create/list/view/review/comment/merge
 * 4. Prepends mock bin to PATH
 *
 * The mock `gh` is stateful: `gh pr review` sets a flag file, and
 * `gh pr view ... reviews` checks it. This enforces that reviewer
 * sub-agents must post reviews before `submit_for_review` passes the
 * lifecycle gate.
 */
export function setupGitEnvironment(workspace: string): void {
	// 1. Init as git repo with a proper initial commit
	execSync(
		'git init && git -c user.name=test -c user.email=test@test.com commit --allow-empty -m "init"',
		{ cwd: workspace, stdio: 'pipe' }
	);

	// 2. Create a bare remote repo so `git push` works
	const bareRemote = path.join(workspace, '..', `bare-remote-${Date.now()}`);
	mkdirSync(bareRemote, { recursive: true });
	execSync('git init --bare', { cwd: bareRemote, stdio: 'pipe' });
	execSync(`git remote add origin "${bareRemote}"`, { cwd: workspace, stdio: 'pipe' });
	execSync('git push -u origin HEAD', { cwd: workspace, stdio: 'pipe' });

	// 3. Create state directory for mock gh
	const stateDir = path.join(workspace, '.mock-state');
	mkdirSync(stateDir, { recursive: true });

	// 4. Create mock `gh` script
	const mockBin = path.join(workspace, '.mock-bin');
	mkdirSync(mockBin, { recursive: true });

	const ghScript = `#!/bin/bash
# Stateful mock gh CLI for room online tests
STATE_DIR="${stateDir}"

case "$1" in
  pr)
    case "$2" in
      create)
        echo "https://github.com/test/repo/pull/1"
        exit 0
        ;;
      list)
        echo '[{"number":1,"url":"https://github.com/test/repo/pull/1","headRefName":"test-branch"}]'
        exit 0
        ;;
      view)
        if echo "$*" | grep -q "headRefOid"; then
          git rev-parse HEAD 2>/dev/null || echo "abc1234"
          exit 0
        elif echo "$*" | grep -q "reviews"; then
          if [ -f "$STATE_DIR/.reviews-posted" ]; then
            echo '1'
          else
            echo '0'
          fi
          exit 0
        else
          echo '{"number":1,"url":"https://github.com/test/repo/pull/1","state":"OPEN"}'
          exit 0
        fi
        ;;
      review)
        touch "$STATE_DIR/.reviews-posted"
        echo '{"state":"APPROVED"}'
        exit 0
        ;;
      comment)
        echo "https://github.com/test/repo/pull/1#issuecomment-1"
        exit 0
        ;;
      merge)
        echo "Pull request #1 merged"
        exit 0
        ;;
      *)
        exit 0
        ;;
    esac
    ;;
  api)
    echo '{"id":1}'
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`;
	writeFileSync(path.join(mockBin, 'gh'), ghScript);
	chmodSync(path.join(mockBin, 'gh'), 0o755);

	// 5. Prepend mock bin to PATH so agents find mock `gh` first
	process.env.PATH = `${mockBin}:${process.env.PATH}`;
}

export async function waitForTask(
	daemon: DaemonServerContext,
	roomId: string,
	filter: { taskType?: string; status?: string | string[] },
	timeout = 120_000
): Promise<NeoTask> {
	const start = Date.now();
	const statusArray = filter.status
		? Array.isArray(filter.status)
			? filter.status
			: [filter.status]
		: undefined;

	while (Date.now() - start < timeout) {
		const result = (await daemon.messageHub.request('task.list', { roomId })) as {
			tasks: NeoTask[];
		};
		const match = result.tasks.find(
			(t) =>
				(!filter.taskType || t.taskType === filter.taskType) &&
				(!statusArray || statusArray.includes(t.status))
		);
		if (match) return match;
		await new Promise((r) => setTimeout(r, 1000));
	}
	// Include current task states in error for debugging
	const finalResult = (await daemon.messageHub.request('task.list', { roomId })) as {
		tasks: NeoTask[];
	};
	const taskSummary = finalResult.tasks
		.map((t) => `  ${t.taskType}:${t.status} (${t.title})`)
		.join('\n');
	throw new Error(
		`Timeout (${timeout}ms) waiting for task matching ${JSON.stringify(filter)} in room ${roomId}\nCurrent tasks:\n${taskSummary}`
	);
}

/**
 * Wait for a task matching the filter that is NOT in the excludeIds set.
 * Used to find newly created tasks after external failure.
 */
export async function waitForNewTask(
	daemon: DaemonServerContext,
	roomId: string,
	filter: { taskType?: string; status?: string | string[] },
	excludeIds: Set<string>,
	timeout = 120_000
): Promise<NeoTask> {
	const start = Date.now();
	const statusArray = filter.status
		? Array.isArray(filter.status)
			? filter.status
			: [filter.status]
		: undefined;

	while (Date.now() - start < timeout) {
		const result = (await daemon.messageHub.request('task.list', { roomId })) as {
			tasks: NeoTask[];
		};
		const match = result.tasks.find(
			(t) =>
				!excludeIds.has(t.id) &&
				(!filter.taskType || t.taskType === filter.taskType) &&
				(!statusArray || statusArray.includes(t.status))
		);
		if (match) return match;
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(
		`Timeout (${timeout}ms) waiting for new task matching ${JSON.stringify(filter)} (excluding ${excludeIds.size} IDs)`
	);
}

export async function waitForTaskCount(
	daemon: DaemonServerContext,
	roomId: string,
	filter: { taskType?: string; status?: string | string[] },
	minCount: number,
	timeout = 120_000
): Promise<NeoTask[]> {
	const start = Date.now();
	const statusArray = filter.status
		? Array.isArray(filter.status)
			? filter.status
			: [filter.status]
		: undefined;

	while (Date.now() - start < timeout) {
		const result = (await daemon.messageHub.request('task.list', { roomId })) as {
			tasks: NeoTask[];
		};
		const matches = result.tasks.filter(
			(t) =>
				(!filter.taskType || t.taskType === filter.taskType) &&
				(!statusArray || statusArray.includes(t.status))
		);
		if (matches.length >= minCount) return matches;
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(
		`Timeout (${timeout}ms) waiting for ${minCount}+ tasks matching ${JSON.stringify(filter)}`
	);
}

export async function waitForGroupState(
	daemon: DaemonServerContext,
	roomId: string,
	taskId: string,
	targetStates: string[],
	timeout = 120_000
): Promise<{ id: string; state: string; feedbackIteration: number }> {
	const start = Date.now();

	while (Date.now() - start < timeout) {
		const result = (await daemon.messageHub.request('task.getGroup', { roomId, taskId })) as {
			group: { id: string; state: string; feedbackIteration: number } | null;
		};
		if (result.group && targetStates.includes(result.group.state)) {
			return result.group;
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(
		`Timeout (${timeout}ms) waiting for group state ${targetStates.join('|')} on task ${taskId}`
	);
}

export async function createRoom(daemon: DaemonServerContext, name: string): Promise<string> {
	const result = (await daemon.messageHub.request('room.create', {
		name: `${name} ${Date.now()}`,
	})) as { room: { id: string } };
	return result.room.id;
}

export async function createGoal(
	daemon: DaemonServerContext,
	roomId: string,
	title: string,
	description: string
): Promise<RoomGoal> {
	const result = (await daemon.messageHub.request('goal.create', {
		roomId,
		title,
		description,
	})) as { goal: RoomGoal };
	return result.goal;
}

export async function getGoal(
	daemon: DaemonServerContext,
	roomId: string,
	goalId: string
): Promise<RoomGoal> {
	return ((await daemon.messageHub.request('goal.get', { roomId, goalId })) as { goal: RoomGoal })
		.goal;
}

export async function listTasks(daemon: DaemonServerContext, roomId: string): Promise<NeoTask[]> {
	return ((await daemon.messageHub.request('task.list', { roomId })) as { tasks: NeoTask[] }).tasks;
}
