import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Logger } from './logger';

const execFileAsync = promisify(execFile);
const logger = new Logger('ProcessWatchdog');

export interface ProcessSnapshot {
	pid: number;
	ppid: number;
	elapsedSeconds: number;
	command: string;
}

export type ProcessLister = () => Promise<ProcessSnapshot[]>;
export type ProcessKiller = (pid: number, signal: NodeJS.Signals) => void;

const SUSPICIOUS_THRESHOLDS = [
	{ pattern: /\bbun\s+test\b/, thresholdMs: 15 * 60 * 1000 },
	{ pattern: /\bmake\s+dev\b/, thresholdMs: 24 * 60 * 60 * 1000 },
] as const;

export const PROCESS_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;

export async function listProcesses(): Promise<ProcessSnapshot[]> {
	if (process.platform === 'win32') return [];

	const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,etimes=,command='], {
		maxBuffer: 1024 * 1024,
	});

	return stdout
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.flatMap((line): ProcessSnapshot[] => {
			const match = line.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
			if (!match) return [];
			const [, pidRaw, ppidRaw, elapsedRaw, command] = match;
			return [
				{
					pid: Number(pidRaw),
					ppid: Number(ppidRaw),
					elapsedSeconds: Number(elapsedRaw),
					command,
				},
			];
		});
}

export async function cleanupSuspiciousProcesses(options?: {
	listProcesses?: ProcessLister;
	killProcess?: ProcessKiller;
}): Promise<number> {
	const lister = options?.listProcesses ?? listProcesses;
	const killer = options?.killProcess ?? ((pid, signal) => process.kill(pid, signal));
	const snapshots = await lister();
	let killed = 0;

	for (const snapshot of snapshots) {
		const runtimeMs = snapshot.elapsedSeconds * 1000;
		const threshold = SUSPICIOUS_THRESHOLDS.find(
			({ pattern, thresholdMs }) => pattern.test(snapshot.command) && runtimeMs > thresholdMs
		);
		if (!threshold) continue;

		try {
			killer(snapshot.pid, 'SIGTERM');
			killed++;
			logger.warn(
				`Killing suspicious long-running process pid=${snapshot.pid} ppid=${snapshot.ppid} ` +
					`runtimeMs=${runtimeMs} thresholdMs=${threshold.thresholdMs} command=${snapshot.command}`
			);
		} catch (error) {
			logger.warn(
				`Failed to kill suspicious process pid=${snapshot.pid}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	return killed;
}

export class ProcessWatchdog {
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly intervalMs = PROCESS_WATCHDOG_INTERVAL_MS,
		private readonly cleanup = cleanupSuspiciousProcesses
	) {}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			this.cleanup().catch((error) => {
				logger.warn(
					`Process watchdog cleanup failed: ${error instanceof Error ? error.message : String(error)}`
				);
			});
		}, this.intervalMs);
		this.timer.unref?.();
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}
}
