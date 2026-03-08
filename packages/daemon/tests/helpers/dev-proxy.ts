/**
 * Dev Proxy Test Helper
 *
 * Manages Dev Proxy lifecycle for integration tests that need to mock
 * HTTP requests to external APIs (like Anthropic API).
 *
 * ## Usage
 *
 * ```ts
 * import { createDevProxyController, type DevProxyController } from './dev-proxy';
 *
 * describe('My API tests', () => {
 *   let proxy: DevProxyController;
 *
 *   beforeEach(async () => {
 *     proxy = createDevProxyController();
 *     await proxy.start();
 *   });
 *
 *   afterEach(async () => {
 *     await proxy.stop();
 *   });
 *
 *   it('should mock API response', async () => {
 *     // Set environment for tests
 *     process.env.HTTPS_PROXY = proxy.proxyUrl;
 *     process.env.HTTP_PROXY = proxy.proxyUrl;
 *     process.env.NODE_USE_ENV_PROXY = '1';
 *     // ... test code
 *   });
 * });
 * ```
 *
 * ## Environment Variables
 *
 * The helper automatically sets these env vars on start:
 * - HTTPS_PROXY: The proxy URL for HTTPS requests
 * - HTTP_PROXY: The proxy URL for HTTP requests
 * - NODE_USE_ENV_PROXY: Enables Node.js to use proxy env vars
 * - NODE_EXTRA_CA_CERTS: Path to Dev Proxy's CA certificate
 *
 * ## Prerequisites
 *
 * Dev Proxy must be installed. See:
 * https://learn.microsoft.com/en-us/microsoft-cloud/dev/dev-proxy/get-started/set-up
 */

import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import { setTimeout as sleep } from 'timers/promises';

/**
 * Configuration options for Dev Proxy controller
 */
export interface DevProxyOptions {
	/**
	 * Port to run Dev Proxy on
	 * Default: 8000
	 */
	port?: number;

	/**
	 * Path to devproxyrc.json configuration file
	 * Default: <repo-root>/.devproxy/devproxyrc.json
	 */
	configPath?: string;

	/**
	 * Path to mocks.json file
	 * Default: <repo-root>/.devproxy/mocks.json
	 */
	mocksPath?: string;

	/**
	 * Timeout in ms to wait for proxy to start
	 * Default: 10000
	 */
	startTimeout?: number;

	/**
	 * Whether to automatically set environment variables on start
	 * Default: true
	 */
	setEnvVars?: boolean;

	/**
	 * Log level for Dev Proxy
	 * Default: 'warning' (reduced output during tests)
	 */
	logLevel?: 'debug' | 'information' | 'warning' | 'error' | 'trace';
}

/**
 * Controller interface for managing Dev Proxy lifecycle
 */
export interface DevProxyController {
	/**
	 * Start Dev Proxy process
	 * @throws Error if proxy fails to start within timeout
	 */
	start(): Promise<void>;

	/**
	 * Stop Dev Proxy process gracefully
	 */
	stop(): Promise<void>;

	/**
	 * Check if Dev Proxy is currently running
	 */
	isRunning(): boolean;

	/**
	 * Wait for proxy to be ready (health check)
	 * @param timeout - Timeout in ms
	 */
	waitForReady(timeout?: number): Promise<void>;

	/**
	 * Load a different mock file by updating devproxyrc.json
	 * @param mockFilePath - Path to the new mock file (relative to .devproxy dir or absolute)
	 */
	loadMockFile(mockFilePath: string): void;

	/**
	 * Get the proxy URL (e.g., http://127.0.0.1:8000)
	 */
	readonly proxyUrl: string;

	/**
	 * Get the proxy port
	 */
	readonly port: number;

	/**
	 * Get the process PID (if running)
	 */
	readonly pid: number | undefined;

	/**
	 * Restore original environment variables that were modified
	 */
	restoreEnv(): void;
}

/**
 * Find the repository root directory by looking for package.json with workspaces
 */
function findRepoRoot(startDir: string): string | null {
	let dir = startDir;
	while (dir !== path.dirname(dir)) {
		const pkgPath = path.join(dir, 'package.json');
		if (fs.existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
				if (pkg.workspaces) {
					return dir;
				}
			} catch {
				// Continue searching
			}
		}
		dir = path.dirname(dir);
	}
	return null;
}

/**
 * Get the path to Dev Proxy's root CA certificate
 */
function getCaCertPath(): string {
	// Dev Proxy stores CA cert in ~/.proxy/rootCA.pem on macOS/Linux
	const homeDir = process.env.HOME || process.env.USERPROFILE || '';
	return path.join(homeDir, '.proxy', 'rootCA.pem');
}

/**
 * Check if devproxy is running on the expected port
 * This is more reliable than checking if the binary is in PATH,
 * especially in CI where the proxy may have been started in a different step
 */
async function isDevProxyInstalled(port: number = 8000): Promise<boolean> {
	return new Promise((resolve) => {
		const http = require('http');
		const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
			res.resume();
			resolve(true);
		});
		req.on('error', () => resolve(false));
		req.setTimeout(1000, () => {
			req.destroy();
			resolve(false);
		});
	});
}

/**
 * Create a Dev Proxy controller instance
 */
export function createDevProxyController(options: DevProxyOptions = {}): DevProxyController {
	const {
		port = 8000,
		configPath: userConfigPath,
		mocksPath: userMocksPath,
		startTimeout = 10000,
		setEnvVars = true,
		logLevel = 'warning',
	} = options;

	// Resolve paths
	const repoRoot = findRepoRoot(__dirname);
	if (!repoRoot) {
		throw new Error('Could not find repository root directory');
	}

	const devProxyDir = path.join(repoRoot, '.devproxy');
	const configPath = userConfigPath || path.join(devProxyDir, 'devproxyrc.json');
	const mocksPath = userMocksPath || path.join(devProxyDir, 'mocks.json');
	const logPath = path.join(devProxyDir, 'devproxy.log');

	// Ensure .devproxy directory exists (may not exist in git worktrees)
	if (!fs.existsSync(devProxyDir)) {
		fs.mkdirSync(devProxyDir, { recursive: true });
	}

	// Create default devproxyrc.json if it doesn't exist
	const defaultConfigPath = path.join(devProxyDir, 'devproxyrc.json');
	if (!fs.existsSync(defaultConfigPath)) {
		fs.writeFileSync(
			defaultConfigPath,
			JSON.stringify(
				{
					$schema:
						'https://raw.githubusercontent.com/dotnet/dev-proxy/main/schemas/v2.2.0/rc.schema.json',
					plugins: [
						{
							name: 'MockResponsePlugin',
							enabled: true,
							pluginPath: 'Microsoft.DevProxy.Plugins.Mocks.MockResponsePlugin',
							configSection: 'mockResponsePlugin',
							urlsToWatch: ['https://api.anthropic.com/*'],
						},
					],
					mockResponsePlugin: {
						mocksFile: 'mocks.json',
					},
				},
				null,
				2
			)
		);
	}

	// Create default mocks.json if it doesn't exist
	const defaultMocksPath = path.join(devProxyDir, 'mocks.json');
	if (!fs.existsSync(defaultMocksPath)) {
		fs.writeFileSync(
			defaultMocksPath,
			JSON.stringify(
				{
					$schema:
						'https://raw.githubusercontent.com/dotnet/dev-proxy/main/schemas/v2.1.0/mockresponseplugin.mocksfile.schema.json',
					mocks: [
						{
							request: {
								url: 'https://api.anthropic.com/v1/messages',
								method: 'POST',
							},
							response: {
								statusCode: 200,
								headers: [
									{ name: 'content-type', value: 'application/json' },
									{
										name: 'anthropic-ratelimit-requests-limit',
										value: '50',
									},
									{
										name: 'anthropic-ratelimit-requests-remaining',
										value: '49',
									},
								],
								body: {
									id: 'msg_mock123',
									type: 'message',
									role: 'assistant',
									content: [
										{
											type: 'text',
											text: '[MOCKED BY DEV PROXY] Hello! This is a mocked response from Dev Proxy for testing purposes.',
										},
									],
									model: 'claude-sonnet-4-20250514',
									stop_reason: 'end_turn',
									stop_sequence: null,
									usage: {
										input_tokens: 12,
										output_tokens: 48,
										cache_creation_input_tokens: 0,
										cache_read_input_tokens: 0,
										service_tier: 'standard',
									},
								},
							},
						},
					],
				},
				null,
				2
			)
		);
	}

	// State
	let process: ChildProcess | null = null;
	let originalEnv: Record<string, string | undefined> = {};

	// Helper to check if proxy is responding
	const checkProxyReady = async (): Promise<boolean> => {
		// Try to connect to the proxy port using a TCP connection check
		// This is more reliable than fetch() for HTTPS proxies
		return new Promise((resolve) => {
			const net = require('net');
			const socket = new net.Socket();

			socket.setTimeout(1000);

			socket.on('connect', () => {
				socket.destroy();
				resolve(true);
			});

			socket.on('timeout', () => {
				socket.destroy();
				resolve(false);
			});

			socket.on('error', () => {
				socket.destroy();
				resolve(false);
			});

			socket.connect(port, '127.0.0.1');
		});
	};

	// Store original env var
	const saveEnvVar = (key: string) => {
		if (!(key in originalEnv)) {
			originalEnv[key] = process?.env?.[key] ?? globalThis.process.env[key];
		}
	};

	// Set environment variables for proxy
	const setProxyEnvVars = () => {
		const proxyUrl = `http://127.0.0.1:${port}`;
		const caCertPath = getCaCertPath();

		saveEnvVar('HTTPS_PROXY');
		saveEnvVar('HTTP_PROXY');
		saveEnvVar('NODE_USE_ENV_PROXY');
		saveEnvVar('NODE_EXTRA_CA_CERTS');
		saveEnvVar('NO_PROXY');

		globalThis.process.env.HTTPS_PROXY = proxyUrl;
		globalThis.process.env.HTTP_PROXY = proxyUrl;
		globalThis.process.env.NODE_USE_ENV_PROXY = '1';

		// Set CA cert path if it exists
		if (fs.existsSync(caCertPath)) {
			globalThis.process.env.NODE_EXTRA_CA_CERTS = caCertPath;
		}

		// Don't proxy localhost
		globalThis.process.env.NO_PROXY = 'localhost,127.0.0.1';
	};

	const controller: DevProxyController = {
		get proxyUrl() {
			return `http://127.0.0.1:${port}`;
		},

		get port() {
			return port;
		},

		get pid() {
			return process?.pid;
		},

		async start() {
			if (process) {
				throw new Error('Dev Proxy is already running');
			}

			// Check if devproxy is running on the expected port
			if (!(await isDevProxyInstalled(port))) {
				throw new Error('devproxy is not running. Please start devproxy on port ' + port);
			}

			// Ensure log directory exists
			const logDir = path.dirname(logPath);
			if (!fs.existsSync(logDir)) {
				fs.mkdirSync(logDir, { recursive: true });
			}

			// Start Dev Proxy
			return new Promise((resolve, reject) => {
				const timeout = setTimeout(() => {
					if (process) {
						process.kill('SIGTERM');
						process = null;
					}
					reject(new Error(`Dev Proxy failed to start within ${startTimeout}ms`));
				}, startTimeout);

				// Open log file for writing
				const logFile = fs.openSync(logPath, 'w');

				// Spawn devproxy process
				process = spawn('devproxy', ['--port', String(port), '--log-level', logLevel], {
					cwd: devProxyDir,
					stdio: ['ignore', logFile, logFile],
					detached: false,
				});

				process.on('error', (err) => {
					clearTimeout(timeout);
					process = null;
					reject(new Error(`Failed to start Dev Proxy: ${err.message}`));
				});

				process.on('exit', (code, signal) => {
					if (code !== 0 && code !== null) {
						// Only reject if we haven't already resolved
						clearTimeout(timeout);
						if (process) {
							process = null;
							reject(new Error(`Dev Proxy exited with code ${code}`));
						}
					}
				});

				// Poll for proxy readiness
				const checkReady = async () => {
					try {
						const ready = await checkProxyReady();
						if (ready) {
							clearTimeout(timeout);
							if (setEnvVars) {
								setProxyEnvVars();
							}
							resolve();
						} else {
							setTimeout(checkReady, 100);
						}
					} catch {
						setTimeout(checkReady, 100);
					}
				};

				// Give process a moment to start before checking
				setTimeout(checkReady, 500);
			});
		},

		async stop() {
			if (!process) {
				return;
			}

			return new Promise((resolve) => {
				const proc = process;
				process = null;

				if (!proc) {
					resolve();
					return;
				}

				// Set up exit handler
				const exitHandler = () => {
					resolve();
				};
				proc.on('exit', exitHandler);

				// Send SIGTERM for graceful shutdown
				proc.kill('SIGTERM');

				// Force kill after 5 seconds
				setTimeout(() => {
					if (proc.pid) {
						try {
							process?.kill('SIGKILL');
						} catch {
							// Process already dead
						}
					}
					resolve();
				}, 5000);
			});
		},

		isRunning() {
			return process !== null && process.pid !== undefined;
		},

		async waitForReady(timeout = 5000) {
			const startTime = Date.now();
			while (Date.now() - startTime < timeout) {
				if (await checkProxyReady()) {
					return;
				}
				await sleep(100);
			}
			throw new Error(`Dev Proxy not ready within ${timeout}ms`);
		},

		loadMockFile(mockFilePath: string) {
			// Resolve relative paths to absolute
			const absoluteMockPath = path.isAbsolute(mockFilePath)
				? mockFilePath
				: path.join(devProxyDir, mockFilePath);

			if (!fs.existsSync(absoluteMockPath)) {
				throw new Error(`Mock file not found: ${absoluteMockPath}`);
			}

			// Read and update devproxyrc.json
			const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

			// Update the mocks file path (relative to .devproxy dir)
			const relativeMockPath = path.relative(devProxyDir, absoluteMockPath);
			config.mockResponsePlugin = config.mockResponsePlugin || {};
			config.mockResponsePlugin.mocksFile = relativeMockPath;

			fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

			// Note: Dev Proxy needs to be restarted for changes to take effect
			// This is a known limitation
		},

		restoreEnv() {
			for (const [key, value] of Object.entries(originalEnv)) {
				if (value === undefined) {
					delete globalThis.process.env[key];
				} else {
					globalThis.process.env[key] = value;
				}
			}
			originalEnv = {};
		},
	};

	return controller;
}

/**
 * Global Dev Proxy controller for shared use across tests
 *
 * Use this when you want a single proxy instance for all tests.
 * Call startGlobalDevProxy() in beforeAll and stopGlobalDevProxy() in afterAll.
 */
let globalController: DevProxyController | null = null;

/**
 * Start a global Dev Proxy instance
 *
 * This is useful for test suites that share a single proxy instance.
 */
export async function startGlobalDevProxy(options?: DevProxyOptions): Promise<DevProxyController> {
	if (globalController) {
		return globalController;
	}
	globalController = createDevProxyController(options);
	await globalController.start();
	return globalController;
}

/**
 * Stop the global Dev Proxy instance
 */
export async function stopGlobalDevProxy(): Promise<void> {
	if (globalController) {
		await globalController.stop();
		globalController.restoreEnv();
		globalController = null;
	}
}

/**
 * Get the global Dev Proxy controller (if started)
 */
export function getGlobalDevProxy(): DevProxyController | null {
	return globalController;
}
