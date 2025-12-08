/**
 * Logger Unit Tests
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Logger } from '../src/lib/logger';

describe('Logger', () => {
	const originalNodeEnv = process.env.NODE_ENV;
	let consoleSpy: {
		log: ReturnType<typeof spyOn>;
		error: ReturnType<typeof spyOn>;
		warn: ReturnType<typeof spyOn>;
		info: ReturnType<typeof spyOn>;
	};

	beforeEach(() => {
		consoleSpy = {
			log: spyOn(console, 'log').mockImplementation(() => {}),
			error: spyOn(console, 'error').mockImplementation(() => {}),
			warn: spyOn(console, 'warn').mockImplementation(() => {}),
			info: spyOn(console, 'info').mockImplementation(() => {}),
		};
	});

	afterEach(() => {
		process.env.NODE_ENV = originalNodeEnv;
		consoleSpy.log.mockRestore();
		consoleSpy.error.mockRestore();
		consoleSpy.warn.mockRestore();
		consoleSpy.info.mockRestore();
	});

	describe('in development mode', () => {
		beforeEach(() => {
			process.env.NODE_ENV = 'development';
		});

		test('log should output to console', () => {
			const logger = new Logger('TestPrefix');
			logger.log('test message', { extra: 'data' });

			expect(consoleSpy.log).toHaveBeenCalledWith('[TestPrefix]', 'test message', {
				extra: 'data',
			});
		});

		test('error should output to console.error', () => {
			const logger = new Logger('TestPrefix');
			logger.error('error message', new Error('test'));

			expect(consoleSpy.error).toHaveBeenCalledTimes(1);
			const calls = consoleSpy.error.mock.calls[0];
			expect(calls[0]).toBe('[TestPrefix]');
			expect(calls[1]).toBe('error message');
		});

		test('warn should output to console.warn', () => {
			const logger = new Logger('TestPrefix');
			logger.warn('warning message');

			expect(consoleSpy.warn).toHaveBeenCalledWith('[TestPrefix]', 'warning message');
		});

		test('info should output to console.info', () => {
			const logger = new Logger('TestPrefix');
			logger.info('info message');

			expect(consoleSpy.info).toHaveBeenCalledWith('[TestPrefix]', 'info message');
		});
	});

	describe('in test mode', () => {
		beforeEach(() => {
			process.env.NODE_ENV = 'test';
		});

		test('log should be silent', () => {
			const logger = new Logger('TestPrefix');
			logger.log('test message');

			expect(consoleSpy.log).not.toHaveBeenCalled();
		});

		test('error should be silent', () => {
			const logger = new Logger('TestPrefix');
			logger.error('error message');

			expect(consoleSpy.error).not.toHaveBeenCalled();
		});

		test('warn should be silent', () => {
			const logger = new Logger('TestPrefix');
			logger.warn('warning message');

			expect(consoleSpy.warn).not.toHaveBeenCalled();
		});

		test('info should be silent', () => {
			const logger = new Logger('TestPrefix');
			logger.info('info message');

			expect(consoleSpy.info).not.toHaveBeenCalled();
		});
	});

	describe('in production mode', () => {
		beforeEach(() => {
			process.env.NODE_ENV = 'production';
		});

		test('log should be silent', () => {
			const logger = new Logger('TestPrefix');
			logger.log('test message');

			expect(consoleSpy.log).not.toHaveBeenCalled();
		});
	});
});
