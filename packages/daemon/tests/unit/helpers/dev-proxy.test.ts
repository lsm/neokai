/**
 * Unit tests for Dev Proxy helper module
 *
 * Note: Most tests skip when devproxy is not installed since
 * the helper requires the actual devproxy binary to run.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test';
import path from 'path';
import fs from 'fs';
import {
	createDevProxyController,
	startGlobalDevProxy,
	stopGlobalDevProxy,
	getGlobalDevProxy,
	type DevProxyOptions,
} from '../../helpers/dev-proxy';

// Check if devproxy is available
async function isDevProxyInstalled(): Promise<boolean> {
	try {
		const proc = Bun.spawn(['which', 'devproxy'], { stdout: 'pipe' });
		const exitCode = await proc.exited;
		return exitCode === 0;
	} catch {
		return false;
	}
}

const DEV_PROXY_INSTALLED = await isDevProxyInstalled();

describe('Dev Proxy Helper', () => {
	describe('createDevProxyController', () => {
		it('should create controller with default options', () => {
			const controller = createDevProxyController();
			expect(controller).toBeDefined();
			expect(controller.port).toBe(8000);
			expect(controller.proxyUrl).toBe('http://127.0.0.1:8000');
			expect(controller.isRunning()).toBe(false);
			expect(controller.pid).toBeUndefined();
		});

		it('should create controller with custom port', () => {
			const controller = createDevProxyController({ port: 9000 });
			expect(controller.port).toBe(9000);
			expect(controller.proxyUrl).toBe('http://127.0.0.1:9000');
		});

		it('should throw when loading non-existent mock file', () => {
			const controller = createDevProxyController();
			expect(() => controller.loadMockFile('/non/existent/file.json')).toThrow(
				'Mock file not found'
			);
		});

		it('should not be running initially', () => {
			const controller = createDevProxyController();
			expect(controller.isRunning()).toBe(false);
		});
	});

	describe('start/stop lifecycle', () => {
		// Skip these tests if devproxy is not installed
		const itif = DEV_PROXY_INSTALLED ? it : it.skip;

		itif(
			'should start and stop proxy',
			async () => {
				const controller = createDevProxyController({
					port: 8100 + Math.floor(Math.random() * 100),
					logLevel: 'error', // Reduce log noise in tests
				});

				try {
					await controller.start();
					expect(controller.isRunning()).toBe(true);
					// Detached devproxy process doesn't expose a stable PID in this helper.
					expect(controller.pid).toBeUndefined();

					// Verify ANTHROPIC_BASE_URL is redirected to the local proxy
					expect(process.env.ANTHROPIC_BASE_URL).toBe(controller.proxyUrl);
				} finally {
					await controller.stop();
					expect(controller.isRunning()).toBe(false);
				}
			},
			{ timeout: 15000 }
		);

		itif(
			'should restore environment variables after stop',
			async () => {
				// Save original values
				const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;

				const controller = createDevProxyController({
					port: 8200 + Math.floor(Math.random() * 100),
					logLevel: 'error',
				});

				try {
					await controller.start();
					expect(process.env.ANTHROPIC_BASE_URL).toBe(controller.proxyUrl);

					controller.restoreEnv();

					// Should restore to original values
					expect(process.env.ANTHROPIC_BASE_URL).toBe(originalAnthropicBaseUrl);
				} finally {
					await controller.stop();
				}
			},
			{ timeout: 15000 }
		);

		itif(
			'should throw error when starting twice',
			async () => {
				const controller = createDevProxyController({
					port: 8300 + Math.floor(Math.random() * 100),
					logLevel: 'error',
				});

				try {
					await controller.start();
					await expect(controller.start()).rejects.toThrow('already running');
				} finally {
					await controller.stop();
				}
			},
			{ timeout: 15000 }
		);

		itif(
			'should handle stop when not started',
			async () => {
				const controller = createDevProxyController();
				// Should not throw
				await controller.stop();
			},
			{ timeout: 5000 }
		);

		itif(
			'should wait for proxy to be ready',
			async () => {
				const controller = createDevProxyController({
					port: 8400 + Math.floor(Math.random() * 100),
					logLevel: 'error',
				});

				try {
					await controller.start();
					await expect(controller.waitForReady(5000)).resolves.toBeUndefined();
				} finally {
					await controller.stop();
				}
			},
			{ timeout: 15000 }
		);
	});

	describe('Global Dev Proxy', () => {
		const itif = DEV_PROXY_INSTALLED ? it : it.skip;

		afterEach(async () => {
			await stopGlobalDevProxy();
		});

		itif(
			'should start and stop global proxy',
			async () => {
				const controller = await startGlobalDevProxy({
					port: 8500 + Math.floor(Math.random() * 100),
					logLevel: 'error',
				});

				expect(controller).toBeDefined();
				expect(controller.isRunning()).toBe(true);
				expect(getGlobalDevProxy()).toBe(controller);

				await stopGlobalDevProxy();
				expect(getGlobalDevProxy()).toBeNull();
			},
			{ timeout: 15000 }
		);

		itif(
			'should return same controller on multiple start calls',
			async () => {
				const controller1 = await startGlobalDevProxy({
					port: 8600 + Math.floor(Math.random() * 100),
					logLevel: 'error',
				});
				const controller2 = await startGlobalDevProxy();

				expect(controller1).toBe(controller2);
			},
			{ timeout: 15000 }
		);
	});

	describe('loadMockFile', () => {
		it('should throw for non-existent mock file', () => {
			const controller = createDevProxyController();
			expect(() => controller.loadMockFile('/path/to/nonexistent.json')).toThrow(
				'Mock file not found'
			);
		});
	});

	describe('when devproxy is not installed', () => {
		it('should throw error on start if not installed', async () => {
			// This test only runs if devproxy IS installed, to verify the error message
			// Skip if not installed since the test would pass trivially
			if (DEV_PROXY_INSTALLED) {
				// We can't easily test this case when devproxy IS installed
				// So skip it
				return;
			}

			const controller = createDevProxyController();
			await expect(controller.start()).rejects.toThrow('devproxy is not installed');
		});
	});
});
