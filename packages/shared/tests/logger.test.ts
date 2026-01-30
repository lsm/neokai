import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { Logger, createLogger, configureLogger, getLoggerConfig, LogLevel } from '../src/logger.ts';

describe('Logger', () => {
	let originalEnv: Record<string, string | undefined>;

	beforeEach(() => {
		// Save original environment
		originalEnv = { ...process.env };

		// Reset logger config to defaults
		configureLogger({
			level: LogLevel.INFO,
			filter: ['*'],
			excludeFilter: [],
			timestamps: false,
		});
	});

	afterEach(() => {
		// Restore environment
		process.env = originalEnv;

		// Reset logger config
		configureLogger({
			level: LogLevel.INFO,
			filter: ['*'],
			excludeFilter: [],
			timestamps: false,
		});
	});

	describe('configureLogger', () => {
		test('should update global logger configuration', () => {
			const config = getLoggerConfig();
			expect(config.level).toBe(LogLevel.INFO);
			expect(config.filter).toEqual(['*']);
			expect(config.excludeFilter).toEqual([]);
			expect(config.timestamps).toBe(false);

			configureLogger({
				level: LogLevel.DEBUG,
				timestamps: true,
			});

			const newConfig = getLoggerConfig();
			expect(newConfig.level).toBe(LogLevel.DEBUG);
			expect(newConfig.timestamps).toBe(true);
			// filter and excludeFilter should remain
			expect(newConfig.filter).toEqual(['*']);
			expect(newConfig.excludeFilter).toEqual([]);
		});

		test('should merge partial config with existing config', () => {
			configureLogger({
				level: LogLevel.WARN,
				filter: ['test:*'],
				excludeFilter: ['test:internal'],
			});

			const config = getLoggerConfig();
			expect(config.level).toBe(LogLevel.WARN);
			expect(config.filter).toEqual(['test:*']);
			expect(config.excludeFilter).toEqual(['test:internal']);
			expect(config.timestamps).toBe(false);
		});

		test('should update filter patterns', () => {
			configureLogger({
				filter: ['app:*', 'lib:*'],
				excludeFilter: ['app:verbose'],
			});

			const config = getLoggerConfig();
			expect(config.filter).toEqual(['app:*', 'lib:*']);
			expect(config.excludeFilter).toEqual(['app:verbose']);
		});
	});

	describe('getLoggerConfig', () => {
		test('should return a copy of the config', () => {
			const config1 = getLoggerConfig();
			config1.level = LogLevel.SILENT;

			const config2 = getLoggerConfig();
			expect(config2.level).not.toBe(LogLevel.SILENT);
		});

		test('should return current configuration', () => {
			configureLogger({
				level: LogLevel.TRACE,
				filter: ['foo:*'],
				excludeFilter: ['foo:bar'],
				timestamps: true,
			});

			const config = getLoggerConfig();
			expect(config.level).toBe(LogLevel.TRACE);
			expect(config.filter).toEqual(['foo:*']);
			expect(config.excludeFilter).toEqual(['foo:bar']);
			expect(config.timestamps).toBe(true);
		});
	});

	describe('createLogger', () => {
		test('should create logger with namespace', () => {
			const logger = createLogger('test:namespace');
			expect(logger.getNamespace()).toBe('test:namespace');
		});

		test('should create default logger without namespace', () => {
			const logger = new Logger();
			expect(logger.getNamespace()).toBe('kai');
		});

		test('should create logger with empty namespace', () => {
			const logger = new Logger('');
			expect(logger.getNamespace()).toBe('');
		});
	});

	describe('log levels', () => {
		test('should respect SILENT level', () => {
			configureLogger({ level: LogLevel.SILENT });

			const logger = createLogger('test');
			const infoSpy = spyOn(console, 'info');

			logger.info('should not log');
			logger.error('should not log');
			logger.warn('should not log');
			logger.debug('should not log');
			logger.trace('should not log');
			logger.log('should not log');

			expect(infoSpy).not.toHaveBeenCalled();
			infoSpy.mockRestore();
		});

		test('should respect ERROR level', () => {
			configureLogger({ level: LogLevel.ERROR });

			const logger = createLogger('test');
			const errorSpy = spyOn(console, 'error');
			const warnSpy = spyOn(console, 'warn');

			logger.error('error message');
			logger.warn('warn message');
			logger.info('info message');

			expect(errorSpy).toHaveBeenCalled();
			expect(warnSpy).not.toHaveBeenCalled();

			errorSpy.mockRestore();
			warnSpy.mockRestore();
		});

		test('should respect WARN level', () => {
			configureLogger({ level: LogLevel.WARN });

			const logger = createLogger('test');
			const warnSpy = spyOn(console, 'warn');
			const infoSpy = spyOn(console, 'info');

			logger.warn('warn message');
			logger.info('info message');

			expect(warnSpy).toHaveBeenCalled();
			expect(infoSpy).not.toHaveBeenCalled();

			warnSpy.mockRestore();
			infoSpy.mockRestore();
		});

		test('should respect INFO level', () => {
			configureLogger({ level: LogLevel.INFO });

			const logger = createLogger('test');
			const infoSpy = spyOn(console, 'info');
			const debugSpy = spyOn(console, 'debug');

			logger.info('info message');
			logger.debug('debug message');

			expect(infoSpy).toHaveBeenCalled();
			expect(debugSpy).not.toHaveBeenCalled();

			infoSpy.mockRestore();
			debugSpy.mockRestore();
		});

		test('should respect DEBUG level', () => {
			configureLogger({ level: LogLevel.DEBUG });

			const logger = createLogger('test');
			const debugSpy = spyOn(console, 'debug');

			logger.debug('debug message');
			expect(debugSpy).toHaveBeenCalled();

			debugSpy.mockRestore();
		});

		test('should respect TRACE level', () => {
			configureLogger({ level: LogLevel.TRACE });

			const logger = createLogger('test');
			const debugSpy = spyOn(console, 'debug');

			logger.trace('trace message');
			expect(debugSpy).toHaveBeenCalled();

			debugSpy.mockRestore();
		});

		test('should show level indicator in DEBUG mode for non-INFO levels', () => {
			configureLogger({ level: LogLevel.DEBUG });

			const logger = createLogger('test');
			const debugSpy = spyOn(console, 'debug');

			logger.debug('debug message');
			expect(debugSpy).toHaveBeenCalled();
			const callArgs = debugSpy.mock.calls[0];
			expect(callArgs).toContainEqual('[DEBUG]');

			debugSpy.mockRestore();
		});
	});

	describe('namespace filtering', () => {
		test('should filter by exact namespace match', () => {
			configureLogger({ filter: ['test:allowed'] });

			const allowedLogger = createLogger('test:allowed');
			const blockedLogger = createLogger('test:blocked');

			const infoSpy = spyOn(console, 'info');

			allowedLogger.info('allowed message');
			blockedLogger.info('blocked message');

			expect(infoSpy).toHaveBeenCalledTimes(1);

			infoSpy.mockRestore();
		});

		test('should filter by wildcard namespace prefix', () => {
			configureLogger({ filter: ['test:*'] });

			const logger1 = createLogger('test:foo');
			const logger2 = createLogger('test:bar');
			const logger3 = createLogger('other:baz');

			const infoSpy = spyOn(console, 'info');

			logger1.info('message 1');
			logger2.info('message 2');
			logger3.info('message 3');

			expect(infoSpy).toHaveBeenCalledTimes(2);

			infoSpy.mockRestore();
		});

		test('should allow all with wildcard', () => {
			configureLogger({ filter: ['*'] });

			const logger1 = createLogger('foo:bar');
			const logger2 = createLogger('baz:qux');

			const infoSpy = spyOn(console, 'info');

			logger1.info('message 1');
			logger2.info('message 2');

			expect(infoSpy).toHaveBeenCalledTimes(2);

			infoSpy.mockRestore();
		});

		test('should exclude specific namespaces', () => {
			configureLogger({
				filter: ['*'],
				excludeFilter: ['test:verbose'],
			});

			const normalLogger = createLogger('test:normal');
			const verboseLogger = createLogger('test:verbose');

			const infoSpy = spyOn(console, 'info');

			normalLogger.info('normal message');
			verboseLogger.info('verbose message');

			expect(infoSpy).toHaveBeenCalledTimes(1);

			infoSpy.mockRestore();
		});

		test('should exclude wildcard namespace prefixes', () => {
			configureLogger({
				filter: ['*'],
				excludeFilter: ['test:internal:*'],
			});

			const normalLogger = createLogger('test:normal');
			const internalLogger = createLogger('test:internal:debug');

			const infoSpy = spyOn(console, 'info');

			normalLogger.info('normal message');
			internalLogger.info('internal message');

			expect(infoSpy).toHaveBeenCalledTimes(1);

			infoSpy.mockRestore();
		});
	});

	describe('child logger', () => {
		test('should create child logger with extended namespace', () => {
			const parent = createLogger('parent');
			const child = parent.child('child');

			expect(parent.getNamespace()).toBe('parent');
			expect(child.getNamespace()).toBe('parent:child');
		});

		test('should create child from child logger', () => {
			const parent = createLogger('parent');
			const child = parent.child('child');
			const grandchild = child.child('grandchild');

			expect(grandchild.getNamespace()).toBe('parent:child:grandchild');
		});

		test('should create child from empty namespace logger', () => {
			const parent = new Logger('');
			const child = parent.child('child');

			expect(child.getNamespace()).toBe('child');
		});

		test('child should respect parent filter settings', () => {
			configureLogger({
				filter: ['parent:*'],
			});

			const parent = createLogger('parent');
			const child = parent.child('child');

			const infoSpy = spyOn(console, 'info');

			child.info('child message');
			expect(infoSpy).toHaveBeenCalledTimes(1);

			infoSpy.mockRestore();
		});

		test('child should be filtered out when namespace does not match', () => {
			configureLogger({
				filter: ['parent:*'],
				excludeFilter: ['parent:child:*'],
			});

			const parent = createLogger('parent');
			const child = parent.child('child');

			const infoSpy = spyOn(console, 'info');

			parent.info('parent message');
			child.info('child message');

			expect(infoSpy).toHaveBeenCalledTimes(1);

			infoSpy.mockRestore();
		});
	});

	describe('clearCache', () => {
		test('should clear cached enabled state', () => {
			configureLogger({
				filter: ['test:*'],
			});

			const logger = createLogger('test:namespace');

			// First call caches the enabled state
			const infoSpy = spyOn(console, 'info');
			logger.info('first message');

			// Change filter to exclude this namespace
			configureLogger({
				filter: ['other:*'],
			});

			// Without clearCache, the cached state would still say it's enabled
			logger.info('second message');

			// Now clear cache and log again
			logger.clearCache();
			logger.info('third message');

			// First two messages should have been logged (before filter change)
			expect(infoSpy).toHaveBeenCalledTimes(2);

			infoSpy.mockRestore();
		});

		test('should re-evaluate enabled state after cache clear', () => {
			configureLogger({
				filter: ['test:*'],
			});

			const logger = createLogger('test:namespace');

			// Initial state: enabled
			let enabled = logger['isEnabled']();
			expect(enabled).toBe(true);

			// Change filter to exclude
			configureLogger({
				filter: ['other:*'],
			});

			// Still cached as enabled
			enabled = logger['isEnabled']();
			expect(enabled).toBe(true);

			// Clear cache
			logger.clearCache();

			// Now re-evaluates to disabled
			enabled = logger['isEnabled']();
			expect(enabled).toBe(false);
		});
	});

	describe('log method (alias for info)', () => {
		test('should be an alias for info', () => {
			configureLogger({ level: LogLevel.INFO });

			const logger = createLogger('test');
			const infoSpy = spyOn(console, 'info');

			logger.log('log method message');
			logger.info('info method message');

			expect(infoSpy).toHaveBeenCalledTimes(2);

			infoSpy.mockRestore();
		});

		test('should respect log level', () => {
			configureLogger({ level: LogLevel.WARN });

			const logger = createLogger('test');
			const infoSpy = spyOn(console, 'info');

			logger.log('should not log');
			expect(infoSpy).not.toHaveBeenCalled();

			infoSpy.mockRestore();
		});
	});

	describe('trace method', () => {
		test('should log at TRACE level', () => {
			configureLogger({ level: LogLevel.TRACE });

			const logger = createLogger('test');
			const debugSpy = spyOn(console, 'debug');

			logger.trace('trace message');
			expect(debugSpy).toHaveBeenCalled();

			debugSpy.mockRestore();
		});

		test('should not log when level is above TRACE', () => {
			configureLogger({ level: LogLevel.DEBUG });

			const logger = createLogger('test');
			const debugSpy = spyOn(console, 'debug');

			logger.trace('trace message');
			expect(debugSpy).not.toHaveBeenCalled();

			debugSpy.mockRestore();
		});

		test('should show level indicator in DEBUG mode', () => {
			configureLogger({ level: LogLevel.TRACE });

			const logger = createLogger('test');
			const debugSpy = spyOn(console, 'debug');

			logger.trace('trace message');
			const callArgs = debugSpy.mock.calls[0];
			expect(callArgs).toContainEqual('[TRACE]');

			debugSpy.mockRestore();
		});
	});

	describe('timestamps', () => {
		test('should include timestamps when enabled', () => {
			configureLogger({ timestamps: true });

			const logger = createLogger('test');
			const infoSpy = spyOn(console, 'info');

			logger.info('message with timestamp');

			const callArgs = infoSpy.mock.calls[0];
			// First arg should be an ISO date string
			expect(callArgs[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/);

			infoSpy.mockRestore();
		});

		test('should not include timestamps when disabled', () => {
			configureLogger({ timestamps: false });

			const logger = createLogger('test');
			const infoSpy = spyOn(console, 'info');

			logger.info('message without timestamp');

			const callArgs = infoSpy.mock.calls[0];
			// First arg should be namespace prefix, not timestamp
			if (callArgs.length > 0) {
				expect(callArgs[0]).not.toMatch(/^\d{4}-\d{2}-\d{2}T/);
			}

			infoSpy.mockRestore();
		});
	});

	describe('namespace prefix', () => {
		test('should include namespace in output', () => {
			configureLogger({ level: LogLevel.INFO });

			const logger = createLogger('test:namespace');
			const infoSpy = spyOn(console, 'info');

			logger.info('message');

			const callArgs = infoSpy.mock.calls[0];
			expect(callArgs).toContainEqual('[test:namespace]');

			infoSpy.mockRestore();
		});

		test('should not include prefix for empty namespace', () => {
			configureLogger({ level: LogLevel.INFO });

			const logger = new Logger('');
			const infoSpy = spyOn(console, 'info');

			logger.info('message');

			const callArgs = infoSpy.mock.calls[0];
			// Should not have [namespace] prefix
			const hasPrefix = callArgs.some(
				(arg) => typeof arg === 'string' && arg.startsWith('[') && arg.endsWith(']')
			);
			expect(hasPrefix).toBe(false);

			infoSpy.mockRestore();
		});
	});

	describe('getNamespace', () => {
		test('should return the logger namespace', () => {
			const logger = createLogger('my:app:module');
			expect(logger.getNamespace()).toBe('my:app:module');
		});
	});
});
