/**
 * Unified Logger for Liuboer
 *
 * Features:
 * - Log levels: SILENT, ERROR, WARN, INFO, DEBUG, TRACE
 * - Namespace support with filtering (e.g., "liuboer:messagehub:*")
 * - Environment-based defaults (test=SILENT, prod=WARN, dev=INFO)
 * - Child logger creation for scoped logging
 * - Works in both Node.js and browser environments
 *
 * Environment Variables:
 * - LOG_LEVEL: Override default log level (silent, error, warn, info, debug, trace)
 * - LOG_FILTER: Namespace filter patterns (comma-separated, supports wildcards)
 *   - "*" = all namespaces
 *   - "liuboer:messagehub" = exact match
 *   - "liuboer:messagehub:*" = prefix match
 *   - "-liuboer:transport" = exclude namespace
 *
 * Usage:
 *   import { createLogger, logger } from '@liuboer/shared/logger';
 *
 *   // Use default logger
 *   logger.info('Application started');
 *
 *   // Create namespaced logger
 *   const log = createLogger('liuboer:messagehub');
 *   log.debug('Processing message', { id: '123' });
 *
 *   // Create child logger
 *   const childLog = log.child('client');
 *   childLog.info('Connected'); // [liuboer:messagehub:client] Connected
 */

/**
 * Log levels from least to most verbose
 */
export enum LogLevel {
	SILENT = 0,
	ERROR = 1,
	WARN = 2,
	INFO = 3,
	DEBUG = 4,
	TRACE = 5,
}

/**
 * String to LogLevel mapping
 */
const LOG_LEVEL_MAP: Record<string, LogLevel> = {
	silent: LogLevel.SILENT,
	error: LogLevel.ERROR,
	warn: LogLevel.WARN,
	info: LogLevel.INFO,
	debug: LogLevel.DEBUG,
	trace: LogLevel.TRACE,
};

/**
 * LogLevel to string mapping for output
 */
const LOG_LEVEL_NAMES: Record<LogLevel, string> = {
	[LogLevel.SILENT]: 'SILENT',
	[LogLevel.ERROR]: 'ERROR',
	[LogLevel.WARN]: 'WARN',
	[LogLevel.INFO]: 'INFO',
	[LogLevel.DEBUG]: 'DEBUG',
	[LogLevel.TRACE]: 'TRACE',
};

/**
 * Logger configuration
 */
export interface LoggerConfig {
	level: LogLevel;
	filter: string[];
	excludeFilter: string[];
	timestamps: boolean;
}

/**
 * Get environment variable safely (works in browser and Node.js)
 */
function getEnv(name: string): string | undefined {
	// Node.js environment
	if (typeof process !== 'undefined' && process.env) {
		return process.env[name];
	}
	// Browser environment - check globalThis.ENV if available
	const globalEnv = (globalThis as unknown as Record<string, unknown>).ENV;
	if (globalEnv && typeof globalEnv === 'object') {
		return (globalEnv as Record<string, string>)[name];
	}
	return undefined;
}

/**
 * Get default log level based on environment
 */
function getDefaultLevel(): LogLevel {
	const nodeEnv = getEnv('NODE_ENV');

	// Check LOG_LEVEL override first
	const logLevelStr = getEnv('LOG_LEVEL')?.toLowerCase();
	if (logLevelStr && logLevelStr in LOG_LEVEL_MAP) {
		return LOG_LEVEL_MAP[logLevelStr];
	}

	// Environment-based defaults
	switch (nodeEnv) {
		case 'test':
			// In tests: silent mode to avoid confusing LLM with test output noise
			return LogLevel.SILENT;
		case 'production':
			// In production: show warnings and errors
			return LogLevel.WARN;
		case 'development':
		default:
			// In development: show info level
			return LogLevel.INFO;
	}
}

/**
 * Parse LOG_FILTER environment variable
 * Returns { include: string[], exclude: string[] }
 */
function parseFilter(): { include: string[]; exclude: string[] } {
	const filterStr = getEnv('LOG_FILTER');
	const include: string[] = [];
	const exclude: string[] = [];

	if (!filterStr) {
		// Default: allow all
		return { include: ['*'], exclude: [] };
	}

	for (const pattern of filterStr.split(',')) {
		const trimmed = pattern.trim();
		if (!trimmed) continue;

		if (trimmed.startsWith('-')) {
			// Exclusion pattern
			exclude.push(trimmed.slice(1));
		} else {
			include.push(trimmed);
		}
	}

	// If no includes specified, default to all
	if (include.length === 0) {
		include.push('*');
	}

	return { include, exclude };
}

/**
 * Check if a namespace matches a pattern
 */
function matchesPattern(namespace: string, pattern: string): boolean {
	if (pattern === '*') return true;

	if (pattern.endsWith(':*')) {
		// Prefix match: "liuboer:messagehub:*" matches "liuboer:messagehub:foo"
		const prefix = pattern.slice(0, -1); // Remove the *
		return namespace === pattern.slice(0, -2) || namespace.startsWith(prefix);
	}

	// Exact match
	return namespace === pattern;
}

/**
 * Check if a namespace should be logged based on filters
 */
function shouldLog(namespace: string, include: string[], exclude: string[]): boolean {
	// Check exclusions first
	for (const pattern of exclude) {
		if (matchesPattern(namespace, pattern)) {
			return false;
		}
	}

	// Check inclusions
	for (const pattern of include) {
		if (matchesPattern(namespace, pattern)) {
			return true;
		}
	}

	return false;
}

/**
 * Global logger configuration
 * Can be modified at runtime via configureLogger()
 */
let globalConfig: LoggerConfig = {
	level: getDefaultLevel(),
	...parseFilter(),
	filter: parseFilter().include,
	excludeFilter: parseFilter().exclude,
	timestamps: false,
};

/**
 * Configure the global logger
 */
export function configureLogger(config: Partial<LoggerConfig>): void {
	globalConfig = { ...globalConfig, ...config };
}

/**
 * Get current logger configuration
 */
export function getLoggerConfig(): LoggerConfig {
	return { ...globalConfig };
}

/**
 * Logger class with namespace support
 */
export class Logger {
	private readonly namespace: string;
	private readonly prefix: string;
	private cachedEnabled: boolean | null = null;

	constructor(namespace: string = 'liuboer') {
		this.namespace = namespace;
		this.prefix = namespace ? `[${namespace}]` : '';
	}

	/**
	 * Check if this logger is enabled (caches result for performance)
	 */
	private isEnabled(): boolean {
		if (this.cachedEnabled !== null) {
			return this.cachedEnabled;
		}

		this.cachedEnabled = shouldLog(this.namespace, globalConfig.filter, globalConfig.excludeFilter);
		return this.cachedEnabled;
	}

	/**
	 * Clear cached enabled state (call after reconfiguring)
	 */
	clearCache(): void {
		this.cachedEnabled = null;
	}

	/**
	 * Check if a specific level should be logged
	 */
	private shouldLogLevel(level: LogLevel): boolean {
		return level <= globalConfig.level && this.isEnabled();
	}

	/**
	 * Format the message with prefix and optional timestamp
	 */
	private formatMessage(level: LogLevel, args: unknown[]): unknown[] {
		const parts: unknown[] = [];

		if (globalConfig.timestamps) {
			parts.push(new Date().toISOString());
		}

		if (this.prefix) {
			parts.push(this.prefix);
		}

		// Add level indicator for non-info levels in debug mode
		if (globalConfig.level >= LogLevel.DEBUG && level !== LogLevel.INFO) {
			parts.push(`[${LOG_LEVEL_NAMES[level]}]`);
		}

		return [...parts, ...args];
	}

	/**
	 * Create a child logger with extended namespace
	 */
	child(name: string): Logger {
		const childNamespace = this.namespace ? `${this.namespace}:${name}` : name;
		return new Logger(childNamespace);
	}

	/**
	 * Log at TRACE level - most verbose, for detailed debugging
	 */
	trace(...args: unknown[]): void {
		if (this.shouldLogLevel(LogLevel.TRACE)) {
			console.debug(...this.formatMessage(LogLevel.TRACE, args));
		}
	}

	/**
	 * Log at DEBUG level - for debugging information
	 */
	debug(...args: unknown[]): void {
		if (this.shouldLogLevel(LogLevel.DEBUG)) {
			console.debug(...this.formatMessage(LogLevel.DEBUG, args));
		}
	}

	/**
	 * Log at INFO level - for general information
	 */
	info(...args: unknown[]): void {
		if (this.shouldLogLevel(LogLevel.INFO)) {
			console.info(...this.formatMessage(LogLevel.INFO, args));
		}
	}

	/**
	 * Alias for info() - for compatibility with existing code
	 */
	log(...args: unknown[]): void {
		this.info(...args);
	}

	/**
	 * Log at WARN level - for warnings
	 */
	warn(...args: unknown[]): void {
		if (this.shouldLogLevel(LogLevel.WARN)) {
			console.warn(...this.formatMessage(LogLevel.WARN, args));
		}
	}

	/**
	 * Log at ERROR level - for errors
	 */
	error(...args: unknown[]): void {
		if (this.shouldLogLevel(LogLevel.ERROR)) {
			console.error(...this.formatMessage(LogLevel.ERROR, args));
		}
	}

	/**
	 * Get the namespace of this logger
	 */
	getNamespace(): string {
		return this.namespace;
	}
}

/**
 * Create a new logger with the given namespace
 */
export function createLogger(namespace: string): Logger {
	return new Logger(namespace);
}
