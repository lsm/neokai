/**
 * Bun → Node.js wrapper for CopilotClient subprocess.
 *
 * @github/copilot-sdk's getNodeExecPath() returns the string "node" (not
 * process.execPath) when process.versions.bun is truthy. On CI, the system
 * "node" may be Node.js v20, which predates node:sqlite (added in v22.5.0).
 * The Copilot CLI app.js uses node:sqlite, so the subprocess crashes.
 *
 * Fix: when running under Bun, create a temp directory with a "node" symlink
 * pointing to process.execPath (the Bun binary) and prepend it to the PATH
 * passed to CopilotClient. When the SDK calls spawn("node", ...) it finds the
 * symlink first, so the subprocess runs under Bun (which supports node:sqlite).
 */

import { mkdirSync, symlinkSync, readlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isRunningUnderBun } from '../../agent/sdk-cli-resolver.js';

/**
 * Ensure a temp directory exists that contains a 'node' symlink pointing to
 * the Bun binary (process.execPath).
 *
 * @returns The wrapper directory path on success, or undefined if not running
 *   under Bun or if the symlink cannot be created.
 */
export function ensureBunNodeWrapper(): string | undefined {
	if (!isRunningUnderBun()) return undefined;
	const wrapperDir = join(tmpdir(), 'neokai-bun-node-wrapper');
	const nodePath = join(wrapperDir, 'node');
	const bunPath = process.execPath;
	try {
		mkdirSync(wrapperDir, { recursive: true });
		let needsSymlink = true;
		try {
			needsSymlink = readlinkSync(nodePath) !== bunPath;
		} catch {
			// Symlink does not exist yet — needs to be created
		}
		if (needsSymlink) {
			try {
				unlinkSync(nodePath);
			} catch {
				// Ignore — may not exist
			}
			symlinkSync(bunPath, nodePath);
		}
		return wrapperDir;
	} catch {
		return undefined;
	}
}

/**
 * Build the env object for a CopilotClient so that its CLI subprocess runs
 * under Bun (not system Node.js) when the parent process is running under Bun.
 *
 * No-op on Node.js or when the bun-node-wrapper directory cannot be created.
 */
export function buildCopilotEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const wrapperDir = ensureBunNodeWrapper();
	if (!wrapperDir) return base;
	const existingPath = base.PATH ?? process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
	return { ...base, PATH: `${wrapperDir}:${existingPath}` };
}
