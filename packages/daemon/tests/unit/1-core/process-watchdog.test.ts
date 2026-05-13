import { describe, expect, test, mock } from 'bun:test';
import { cleanupSuspiciousProcesses } from '../../../src/lib/process-watchdog';

describe('process-watchdog', () => {
	test('kills suspicious bun test processes older than threshold', async () => {
		const killProcess = mock(() => {});

		const killed = await cleanupSuspiciousProcesses({
			listProcesses: async () => [
				{
					pid: 123,
					ppid: 1,
					elapsedSeconds: 16 * 60,
					command: 'bun test tests/unit/leaky.test.ts',
				},
			],
			killProcess,
		});

		expect(killed).toBe(1);
		expect(killProcess).toHaveBeenCalledWith(123, 'SIGTERM');
	});

	test('does not kill short-lived bun test processes', async () => {
		const killProcess = mock(() => {});

		const killed = await cleanupSuspiciousProcesses({
			listProcesses: async () => [
				{
					pid: 456,
					ppid: 1,
					elapsedSeconds: 5 * 60,
					command: 'bun test tests/unit/normal.test.ts',
				},
			],
			killProcess,
		});

		expect(killed).toBe(0);
		expect(killProcess).not.toHaveBeenCalled();
	});

	test('allows long-running make dev processes below the dev-server threshold', async () => {
		const killProcess = mock(() => {});

		const killed = await cleanupSuspiciousProcesses({
			listProcesses: async () => [
				{
					pid: 789,
					ppid: 1,
					elapsedSeconds: 2 * 60 * 60,
					command: 'make dev PORT=8484',
				},
			],
			killProcess,
		});

		expect(killed).toBe(0);
		expect(killProcess).not.toHaveBeenCalled();
	});
});
