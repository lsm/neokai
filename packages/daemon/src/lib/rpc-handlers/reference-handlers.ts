/**
 * Reference RPC Handlers
 *
 * RPC handlers for the @ reference system:
 * - reference.resolve — Resolve a single reference to its full entity data
 */

import type {
	MessageHub,
	ReferenceType,
	ResolvedReference,
	NeoTask,
	RoomGoal,
} from '@neokai/shared';
import type { SessionManager } from '../session-manager';
import { FileManager } from '../file-manager';
import { Logger } from '../logger';
import { join, normalize, relative } from 'node:path';

const log = new Logger('reference-handlers');

/**
 * Maximum number of bytes to include in file content payloads.
 * Files larger than this will be truncated to prevent oversized responses.
 */
const MAX_FILE_CONTENT_BYTES = 50_000;

/**
 * Number of bytes to sample when detecting binary files.
 * Checking the first 8 KB is sufficient for reliable binary detection.
 */
const BINARY_DETECTION_SAMPLE_BYTES = 8_192;

// ============================================================================
// Repository interfaces (minimal — only what this handler needs)
// ============================================================================

export interface TaskRepoForReference {
	getTask(id: string): NeoTask | null;
	getTaskByShortId(roomId: string, shortId: string): NeoTask | null;
}

export interface GoalRepoForReference {
	getGoal(id: string): RoomGoal | null;
	getGoalByShortId(roomId: string, shortId: string): RoomGoal | null;
}

// ============================================================================
// Handler dependencies
// ============================================================================

export interface ReferenceHandlerDeps {
	/** Session manager — used to look up session workspace path and room context */
	sessionManager: SessionManager;
	/** Task repository for looking up room tasks */
	taskRepo: TaskRepoForReference;
	/** Goal repository (not scoped to room — uses global DB access) */
	goalRepo: GoalRepoForReference;
	/** Workspace root path — used as fallback when no session is provided */
	workspaceRoot: string;
}

// ============================================================================
// Main setup function
// ============================================================================

export function setupReferenceHandlers(messageHub: MessageHub, deps: ReferenceHandlerDeps): void {
	// ------------------------------------------------------------------
	// reference.resolve
	// ------------------------------------------------------------------
	messageHub.onRequest(
		'reference.resolve',
		async (
			data
		): Promise<{
			resolved: ResolvedReference | null;
		}> => {
			const params = data as {
				sessionId: string;
				type: ReferenceType;
				id: string;
			};

			if (!params.sessionId) {
				throw new Error('sessionId is required');
			}
			if (!params.type) {
				throw new Error('type is required');
			}
			if (!params.id) {
				throw new Error('id is required');
			}

			// Determine session context (workspace path + optional room ID)
			const { workspacePath, roomId } = await resolveSessionContext(params.sessionId, deps);

			try {
				switch (params.type) {
					case 'task':
						return { resolved: await resolveTask(params.id, roomId, deps) };

					case 'goal':
						return { resolved: resolveGoal(params.id, roomId, deps) };

					case 'file':
						return { resolved: await resolveFile(params.id, workspacePath) };

					case 'folder':
						return { resolved: await resolveFolder(params.id, workspacePath) };

					default: {
						// Exhaustiveness guard — unknown types return null rather than throwing
						log.warn(`Unknown reference type: ${params.type as string}`);
						return { resolved: null };
					}
				}
			} catch (err) {
				// Log unexpected errors but surface null so callers handle gracefully
				log.warn(`Failed to resolve reference ${params.type}:${params.id}:`, err);
				return { resolved: null };
			}
		}
	);
}

// ============================================================================
// Session context helper
// ============================================================================

/**
 * Resolve the workspace path and optional room ID for a given session ID.
 *
 * Falls back to the configured workspace root when the session cannot be loaded,
 * so file/folder resolution still works in standalone (non-room) contexts.
 */
async function resolveSessionContext(
	sessionId: string,
	deps: ReferenceHandlerDeps
): Promise<{ workspacePath: string; roomId: string | null }> {
	const agentSession = await deps.sessionManager.getSessionAsync(sessionId);
	if (!agentSession) {
		return { workspacePath: deps.workspaceRoot, roomId: null };
	}

	const sessionData = agentSession.getSessionData();
	return {
		workspacePath: sessionData.workspacePath ?? deps.workspaceRoot,
		roomId: sessionData.context?.roomId ?? null,
	};
}

// ============================================================================
// Per-type resolution helpers
// ============================================================================

async function resolveTask(
	id: string,
	roomId: string | null,
	deps: ReferenceHandlerDeps
): Promise<ResolvedReference | null> {
	if (!roomId) {
		return null;
	}

	// Support both UUID and short IDs (e.g. "t-42")
	let task = deps.taskRepo.getTask(id);
	if (!task) {
		task = deps.taskRepo.getTaskByShortId(roomId, id);
	}

	if (!task) {
		return null;
	}

	// Confirm the task belongs to the session's room (prevent cross-room access via UUID)
	if (task.roomId !== roomId) {
		return null;
	}

	return {
		type: 'task',
		id,
		data: task,
	};
}

function resolveGoal(
	id: string,
	roomId: string | null,
	deps: ReferenceHandlerDeps
): ResolvedReference | null {
	if (!roomId) {
		return null;
	}

	// Support both UUID and short IDs (e.g. "g-7")
	let goal = deps.goalRepo.getGoal(id);
	if (!goal) {
		goal = deps.goalRepo.getGoalByShortId(roomId, id);
	}

	if (!goal) {
		return null;
	}

	// Confirm the goal belongs to the session's room
	if (goal.roomId !== roomId) {
		return null;
	}

	return {
		type: 'goal',
		id,
		data: goal,
	};
}

export async function resolveFile(
	id: string,
	workspacePath: string
): Promise<ResolvedReference | null> {
	const fileManager = new FileManager(workspacePath);

	// Validate path (throws on traversal — we catch below to return null)
	let absolutePath: string;
	try {
		// Replicate FileManager path validation without reading the file yet
		const normalized = normalize(workspacePath);
		const resolved = normalize(join(workspacePath, id));
		const rel = relative(normalized, resolved);
		if (rel.startsWith('..') || rel === '..') {
			return null;
		}
		absolutePath = resolved;
	} catch {
		return null;
	}

	// Check for binary content before attempting text decode
	let isBinary = false;
	let fileSize = 0;
	let fileMtime = '';
	try {
		const { stat } = await import('node:fs/promises');
		const stats = await stat(absolutePath);
		fileSize = stats.size;
		fileMtime = stats.mtime.toISOString();

		// Sample the first BINARY_DETECTION_SAMPLE_BYTES bytes and check for null bytes,
		// which are the most reliable indicator of binary content.
		const sampleSize = Math.min(fileSize, BINARY_DETECTION_SAMPLE_BYTES);
		if (sampleSize > 0) {
			const buf = Buffer.allocUnsafe(sampleSize);
			const { open } = await import('node:fs/promises');
			const fd = await open(absolutePath, 'r');
			try {
				await fd.read(buf, 0, sampleSize, 0);
			} finally {
				await fd.close();
			}
			isBinary = buf.includes(0x00);
		}
	} catch {
		// File not found or unreadable
		return null;
	}

	if (isBinary) {
		// Return metadata only — content would be garbled and oversized
		return {
			type: 'file',
			id,
			data: {
				path: id,
				content: null,
				binary: true,
				truncated: false,
				size: fileSize,
				mtime: fileMtime,
			},
		};
	}

	// Read text content via FileManager (handles path validation internally)
	let fileData: {
		path: string;
		content: string;
		encoding: string;
		size: number;
		mtime: string;
	};

	try {
		fileData = await fileManager.readFile(id, 'utf-8');
	} catch {
		return null;
	}

	const rawContent = fileData.content;
	const truncated = rawContent.length > MAX_FILE_CONTENT_BYTES;
	const content = truncated ? rawContent.slice(0, MAX_FILE_CONTENT_BYTES) : rawContent;

	return {
		type: 'file',
		id,
		data: {
			path: fileData.path,
			content,
			binary: false,
			truncated,
			size: fileData.size,
			mtime: fileData.mtime,
		},
	};
}

export async function resolveFolder(
	id: string,
	workspacePath: string
): Promise<ResolvedReference | null> {
	const fileManager = new FileManager(workspacePath);

	let entries: Array<{ name: string; path: string; type: 'file' | 'directory' }>;

	try {
		const rawEntries = await fileManager.listDirectory(id, false);
		entries = rawEntries.map((e) => ({
			name: e.name,
			path: e.path,
			type: e.type as 'file' | 'directory',
		}));
	} catch {
		// Directory not found or path traversal detected — return null
		return null;
	}

	return {
		type: 'folder',
		id,
		data: {
			path: id,
			entries,
		},
	};
}
