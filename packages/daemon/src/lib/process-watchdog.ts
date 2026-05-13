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
export type RootPidProvider = () => Iterable<number>;

const SUSPICIOUS_THRESHOLDS = [
	{ pattern: /\bbun\s+test\b/, thresholdMs: 15 * 60 * 1000 },
	{ pattern: /\bmake\s+dev\b/, thresholdMs: 24 * 60 * 60 * 1000 },
] as const;

export const PROCESS_WATCHDOG_INTERVAL_MS = 5 * 60 * 1000;

export async function listProcesses(): Promise<ProcessSnapshot[]> {
	if (process.platform === 'win32') return [];

	if (usesBsdPsElapsedFormat()) {
		const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,etime=,command='], {
			maxBuffer: 1024 * 1024,
		});
		return parseProcessList(stdout, 'duration');
	}

	const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,etimes=,command='], {
		maxBuffer: 1024 * 1024,
	});
	return parseProcessList(stdout, 'seconds');
}

function usesBsdPsElapsedFormat(): boolean {
	return (
		process.platform === 'darwin' ||
		process.platform === 'freebsd' ||
		process.platform === 'openbsd'
	);
}

export function parseProcessList(
	stdout: string,
	elapsedFormat: 'seconds' | 'duration'
): ProcessSnapshot[] {
	return stdout
		.split('\n')
		.map((line) => line.trim())
		.filter(Boolean)
		.flatMap((line): ProcessSnapshot[] => {
			const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
			if (!match) return [];
			const [, pidRaw, ppidRaw, elapsedRaw, command] = match;
			const elapsedSeconds =
				elapsedFormat === 'seconds' ? Number(elapsedRaw) : parsePsElapsedDuration(elapsedRaw);
			if (!Number.isFinite(elapsedSeconds)) return [];
			return [
				{
					pid: Number(pidRaw),
					ppid: Number(ppidRaw),
					elapsedSeconds,
					command,
				},
			];
		});
}

export function parsePsElapsedDuration(raw: string): number {
	const [dayPart, timePart] = raw.includes('-') ? raw.split('-', 2) : ['0', raw];
	const parts = timePart.split(':').map((part) => Number(part));
	if (parts.some((part) => !Number.isFinite(part))) return Number.NaN;
	const days = Number(dayPart);
	if (!Number.isFinite(days)) return Number.NaN;

	if (parts.length === 2) {
		const [minutes, seconds] = parts;
		return days * 86400 + minutes * 60 + seconds;
	}
	if (parts.length === 3) {
		const [hours, minutes, seconds] = parts;
		return days * 86400 + hours * 3600 + minutes * 60 + seconds;
	}
	return Number.NaN;
}

export async function cleanupSuspiciousProcesses(options?: {
	listProcesses?: ProcessLister;
	killProcess?: ProcessKiller;
	getRootPids?: RootPidProvider;
}): Promise<number> {
	const lister = options?.listProcesses ?? listProcesses;
	const killer = options?.killProcess ?? ((pid, signal) => process.kill(pid, signal));
	const rootPids = new Set(options?.getRootPids ? [...options.getRootPids()] : []);
	if (rootPids.size === 0) return 0;

	const snapshots = await lister();
	const ownedPids = collectDescendantPids(snapshots, rootPids);
	let killed = 0;

	for (const snapshot of snapshots) {
		if (!ownedPids.has(snapshot.pid)) continue;
		const runtimeMs = snapshot.elapsedSeconds * 1000;
		const threshold = SUSPICIOUS_THRESHOLDS.find(
			({ pattern, thresholdMs }) => pattern.test(snapshot.command) && runtimeMs > thresholdMs
		);
		if (!threshold) continue;

		try {
			killer(snapshot.pid, 'SIGTERM');
			killed++;
			logger.warn(
				`Killing suspicious daemon-owned long-running process pid=${snapshot.pid} ppid=${snapshot.ppid} ` +
					`runtimeMs=${runtimeMs} thresholdMs=${threshold.thresholdMs} command=${snapshot.command}`
			);
		} catch (error) {
			logger.warn(
				`Failed to kill suspicious daemon-owned process pid=${snapshot.pid}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	return killed;
}

export function collectDescendantPids(
	snapshots: ProcessSnapshot[],
	rootPids: ReadonlySet<number>
): Set<number> {
	const childrenByParent = new Map<number, number[]>();
	for (const snapshot of snapshots) {
		const children = childrenByParent.get(snapshot.ppid) ?? [];
		children.push(snapshot.pid);
		childrenByParent.set(snapshot.ppid, children);
	}

	const owned = new Set<number>();
	const queue = [...rootPids];
	while (queue.length > 0) {
		const pid = queue.shift()!;
		if (owned.has(pid)) continue;
		owned.add(pid);
		queue.push(...(childrenByParent.get(pid) ?? []));
	}
	return owned;
}

export class ProcessWatchdog {
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly intervalMs = PROCESS_WATCHDOG_INTERVAL_MS,
		private readonly cleanup: () => Promise<number> = cleanupSuspiciousProcesses
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
