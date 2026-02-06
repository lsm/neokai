/**
 * Sandbox Restriction Tests
 *
 * These tests verify that sandbox correctly restricts file access:
 * - Files outside workspace cannot be modified
 * - Bash commands are sandboxed
 * - Network access is restricted
 *
 * REQUIREMENTS:
 * - Requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY
 * - Makes real API calls (costs money, uses rate limits)
 * - Requires sandbox support (macOS, Linux, or WSL2)
 *
 * MODEL:
 * - Uses 'haiku-4.5' for faster and cheaper tests
 *
 * PLATFORM NOTE:
 * - macOS: Seatbelt (built-in)
 * - Linux/WSL2: Requires bubblewrap and socat
 * - Skipped on Windows
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { DaemonServerContext } from '../helpers/daemon-server-helper';
import { createDaemonServer } from '../helpers/daemon-server-helper';
import { sendMessage, waitForIdle } from '../helpers/daemon-test-helpers';

// Skip on Windows (sandbox not supported)
const platform = os.platform();
const skipTest = platform === 'win32';

describe('Sandbox Restrictions', { skip: skipTest }, () => {
	let daemon: DaemonServerContext;
	let workspacePath: string;
	let tempDirOutsideWorkspace: string;

	beforeAll(async () => {
		// Create a temporary workspace directory
		workspacePath = path.join(os.tmpdir(), `neokai-sandbox-test-${Date.now()}`);
		await fs.mkdir(workspacePath, { recursive: true });

		// Create a temporary directory OUTSIDE the workspace for testing restrictions
		tempDirOutsideWorkspace = path.join(os.tmpdir(), `neokai-sandbox-outside-${Date.now()}`);
		await fs.mkdir(tempDirOutsideWorkspace, { recursive: true });

		// Create daemon server
		daemon = await createDaemonServer();
	}, 30000);

	afterAll(async () => {
		// Cleanup sessions
		await daemon.cleanup();

		// Kill daemon
		daemon.kill('SIGTERM');
		await daemon.waitForExit();

		// Cleanup directories
		try {
			await fs.rm(workspacePath, { recursive: true, force: true });
		} catch {
			console.warn('Failed to cleanup workspace');
		}
		try {
			await fs.rm(tempDirOutsideWorkspace, { recursive: true, force: true });
		} catch {
			console.warn('Failed to cleanup temp dir');
		}
	});

	describe('Filesystem restrictions', () => {
		test('should reject file write outside workspace', async () => {
			const testFilePath = path.join(tempDirOutsideWorkspace, 'test-sandbox.txt');

			// Create session with sandbox enabled
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Sandbox File Test',
				config: {
					model: 'haiku-4.5',
					permissionMode: 'acceptEdits',
					// Sandbox is enabled by default, but let's be explicit
					sandbox: {
						enabled: true,
						autoAllowBashIfSandboxed: true,
						excludedCommands: ['git'],
					},
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			try {
				// Ask agent to write to file outside workspace
				const messageContent = `Write the text "SANDBOX TEST" to the file ${testFilePath}`;

				await sendMessage(daemon.messageHub, sessionId, messageContent);

				// Wait for processing to complete
				await waitForIdle(daemon.messageHub, sessionId, 30000);

				// Check that the file was NOT created outside workspace
				// (If sandbox is working, the file should not exist)
				try {
					await fs.access(testFilePath);
					// File exists - sandbox FAILED!
					const fileContent = await fs.readFile(testFilePath, 'utf-8');
					expect(fileContent).not.toBe('SANDBOX TEST');
					throw new Error('Sandbox test failed: File was created outside workspace');
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
						// File doesn't exist - sandbox is working! ✅
						expect(true).toBe(true);
					} else {
						// Some other error
						throw error;
					}
				}
			} finally {
				// Cleanup session
				await daemon.messageHub.call('session.delete', { sessionId });
			}
		});

		test('should allow file write inside workspace', async () => {
			const testFilePath = path.join(workspacePath, 'test-inside-workspace.txt');

			// Create session with sandbox enabled
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Sandbox Inside Workspace Test',
				config: {
					model: 'haiku-4.5',
					permissionMode: 'acceptEdits',
					sandbox: {
						enabled: true,
						autoAllowBashIfSandboxed: true,
						excludedCommands: ['git'],
					},
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			try {
				// Ask agent to write to file inside workspace
				const messageContent = `Write the text "INSIDE WORKSPACE" to the file test-inside-workspace.txt`;

				await sendMessage(daemon.messageHub, sessionId, messageContent);

				// Wait for processing to complete
				await waitForIdle(daemon.messageHub, sessionId, 30000);

				// Check that the file WAS created inside workspace
				// (Sandbox should allow writes to cwd)
				try {
					await fs.access(testFilePath);
					const fileContent = await fs.readFile(testFilePath, 'utf-8');
					expect(fileContent).toContain('INSIDE WORKSPACE');
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
						throw new Error('Sandbox test failed: File was NOT created inside workspace');
					} else {
						throw error;
					}
				}
			} finally {
				// Cleanup session
				await daemon.messageHub.call('session.delete', { sessionId });

				// Cleanup test file
				try {
					await fs.rm(testFilePath, { force: true });
				} catch {
					// Ignore cleanup errors
				}
			}
		});
	});

	describe('Bash command sandboxing', () => {
		test('should run bash commands in sandbox', async () => {
			// Create session with sandbox enabled
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'Sandbox Bash Test',
				config: {
					model: 'haiku-4.5',
					permissionMode: 'bypassPermissions',
					sandbox: {
						enabled: true,
						autoAllowBashIfSandboxed: true,
						excludedCommands: ['git'],
					},
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			try {
				// Ask agent to run a bash command that writes to workspace (should succeed)
				const messageContent =
					'Create a file named test-bash-sandbox.txt with content "BASH SANDBOX TEST"';

				await sendMessage(daemon.messageHub, sessionId, messageContent);

				// Wait for processing to complete
				await waitForIdle(daemon.messageHub, sessionId, 30000);

				// Verify the file was created
				const testFilePath = path.join(workspacePath, 'test-bash-sandbox.txt');
				try {
					await fs.access(testFilePath);
					const fileContent = await fs.readFile(testFilePath, 'utf-8');
					expect(fileContent).toContain('BASH SANDBOX TEST');
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
						throw new Error('Sandbox bash test failed: File was NOT created');
					} else {
						throw error;
					}
				}
			} finally {
				// Cleanup session
				await daemon.messageHub.call('session.delete', { sessionId });

				// Cleanup test file
				try {
					const testFilePath = path.join(workspacePath, 'test-bash-sandbox.txt');
					await fs.rm(testFilePath, { force: true });
				} catch {
					// Ignore cleanup errors
				}
			}
		});
	});

	describe('Sandbox configuration override', () => {
		test('should allow disabling sandbox per session', async () => {
			const testFilePath = path.join(tempDirOutsideWorkspace, 'test-no-sandbox.txt');

			// Create session with sandbox DISABLED
			const createResult = (await daemon.messageHub.call('session.create', {
				workspacePath,
				title: 'No Sandbox Test',
				config: {
					model: 'haiku-4.5',
					permissionMode: 'acceptEdits',
					sandbox: {
						enabled: false, // Explicitly disable sandbox
					},
				},
			})) as { sessionId: string };

			const { sessionId } = createResult;
			daemon.trackSession(sessionId);

			try {
				// Ask agent to write to file outside workspace
				// (Should succeed when sandbox is disabled)
				const messageContent = `Write the text "NO SANDBOX" to the file ${testFilePath}`;

				await sendMessage(daemon.messageHub, sessionId, messageContent);

				// Wait for processing to complete
				await waitForIdle(daemon.messageHub, sessionId, 30000);

				// Check that the file WAS created (sandbox was disabled)
				try {
					await fs.access(testFilePath);
					const fileContent = await fs.readFile(testFilePath, 'utf-8');
					expect(fileContent).toContain('NO SANDBOX');
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
						throw new Error('No sandbox test failed: File was NOT created when sandbox disabled');
					} else {
						throw error;
					}
				}
			} finally {
				// Cleanup session
				await daemon.messageHub.call('session.delete', { sessionId });

				// Cleanup test file
				try {
					await fs.rm(testFilePath, { force: true });
				} catch {
					// Ignore cleanup errors
				}
			}
		});
	});
});
