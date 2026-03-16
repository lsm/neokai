/**
 * Bun → Node.js wrapper for CopilotClient subprocess.
 *
 * @github/copilot-sdk's getNodeExecPath() returns the string "node" (not
 * process.execPath) when process.versions.bun is truthy. When the system
 * "node" on PATH is older than v22.5.0 (which introduced node:sqlite), the
 * Copilot CLI subprocess crashes with ERR_UNKNOWN_BUILTIN_MODULE.
 *
 * Fix (macOS / Windows): when running under Bun, create a temp directory with
 * a "node" symlink pointing to process.execPath (the Bun binary) and prepend
 * it to the PATH passed to CopilotClient. Bun supports node:sqlite on these
 * platforms, so the subprocess works.
 *
 * Linux exception: Bun on Linux x64 does NOT support node:sqlite (as of
 * v1.3.x). buildCopilotEnv() skips the wrapper on Linux and relies on the
 * system node being >= v22.5.0. In CI, actions/setup-node installs Node.js
 * 24, which satisfies this requirement. For local Linux development, Node.js
 * >= 22.5 must be on PATH when running the anthropic-copilot provider.
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
 * Skipped on Linux because Bun on Linux does not support node:sqlite (see
 * module header). No-op on Node.js or when the wrapper directory cannot be
 * created.
 */
export function buildCopilotEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	// Bun on Linux x64 lacks node:sqlite — skip the wrapper and let the
	// system node (must be >= 22.5) handle the subprocess.
	if (process.platform === 'linux') return base;
	const wrapperDir = ensureBunNodeWrapper();
	if (!wrapperDir) return base;
	const existingPath = base.PATH ?? process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
	return { ...base, PATH: `${wrapperDir}:${existingPath}` };
}
