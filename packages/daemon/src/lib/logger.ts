/**
 * Logger utility - respects NODE_ENV to reduce test verbosity
 */

export class Logger {
	private debug: boolean;

	constructor(private prefix: string) {
		// Only enable debug logs in development mode, not in test mode
		this.debug = process.env.NODE_ENV === 'development';
	}

	log(...args: unknown[]): void {
		if (this.debug) {
			console.log(`[${this.prefix}]`, ...args);
		}
	}

	error(...args: unknown[]): void {
		if (this.debug) {
			console.error(`[${this.prefix}]`, ...args);
		}
	}

	warn(...args: unknown[]): void {
		if (this.debug) {
			console.warn(`[${this.prefix}]`, ...args);
		}
	}

	info(...args: unknown[]): void {
		if (this.debug) {
			console.info(`[${this.prefix}]`, ...args);
		}
	}
}
