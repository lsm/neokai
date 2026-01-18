/**
 * API Error Circuit Breaker
 *
 * Detects and breaks infinite error loops caused by repeated API failures.
 *
 * Problem: When Claude Agent SDK hits certain API errors (like "prompt is too long"),
 * it captures the error as a user message and tries to respond to it, creating an
 * infinite loop that consumes resources and clutters the conversation.
 *
 * Solution: Track error patterns and trip the circuit breaker when the same error
 * occurs repeatedly within a short time window.
 *
 * Error patterns detected:
 * - "prompt is too long" (context exceeded)
 * - Repeated 400/429 API errors
 * - Any error appearing 3+ times within 30 seconds
 */

import { Logger } from "../logger";

/**
 * Tracked error occurrence
 */
interface ErrorOccurrence {
  pattern: string;
  timestamp: number;
  fullMessage: string;
}

/**
 * Circuit breaker state
 */
export interface CircuitBreakerState {
  isTripped: boolean;
  tripReason: string | null;
  tripCount: number;
  lastTripTime: number | null;
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  /** Number of identical errors before tripping (default: 3) */
  errorThreshold: number;
  /** Time window in ms to count errors (default: 30000 = 30s) */
  timeWindowMs: number;
  /** How long to stay tripped before auto-reset (default: 60000 = 1 min) */
  cooldownMs: number;
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  errorThreshold: 3,
  timeWindowMs: 30000,
  cooldownMs: 60000,
};

/**
 * Error patterns that trigger the circuit breaker
 * These are critical errors that should NOT cause retry loops
 */
const FATAL_ERROR_PATTERNS = [
  // Context exceeded - SDK should NOT retry this
  /prompt is too long:\s*\d+\s*tokens?\s*>\s*\d+\s*maximum/i,
  // Invalid request that won't succeed on retry
  /invalid_request_error/i,
  // Connection errors - indicate network/API unavailability
  /Error:\s*Connection\s+error/i,
  /Connection\s+error/i,
];

export class ApiErrorCircuitBreaker {
  private logger: Logger;
  private config: CircuitBreakerConfig;
  private recentErrors: ErrorOccurrence[] = [];
  private state: CircuitBreakerState = {
    isTripped: false,
    tripReason: null,
    tripCount: 0,
    lastTripTime: null,
  };

  // Callback to execute when circuit breaker trips
  private onTrip?: (reason: string, errorCount: number) => Promise<void>;

  constructor(sessionId: string, config: Partial<CircuitBreakerConfig> = {}) {
    this.logger = new Logger(`CircuitBreaker ${sessionId}`);
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set callback to execute when circuit breaker trips
   */
  setOnTripCallback(
    callback: (reason: string, errorCount: number) => Promise<void>,
  ): void {
    this.onTrip = callback;
  }

  /**
   * Check if a message contains an API error pattern
   * Returns the error pattern if found, null otherwise
   */
  private extractErrorPattern(messageContent: string): string | null {
    // Check for local-command-stderr errors (SDK error capture format)
    const stderrMatch = messageContent.match(
      /<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/,
    );
    if (stderrMatch) {
      const errorContent = stderrMatch[1];

      // Check for fatal error patterns
      for (const pattern of FATAL_ERROR_PATTERNS) {
        if (pattern.test(errorContent)) {
          // Extract a normalized pattern for grouping
          const promptTooLongMatch = errorContent.match(
            /prompt is too long:\s*(\d+)\s*tokens?\s*>\s*(\d+)\s*maximum/i,
          );
          if (promptTooLongMatch) {
            return `prompt_too_long:${promptTooLongMatch[2]}`; // Normalize by max tokens
          }

          // Connection error
          if (/Connection\s+error/i.test(errorContent)) {
            return "connection_error";
          }

          return "invalid_request_error";
        }
      }

      // Check for generic API errors (400, 429, etc.)
      const apiErrorMatch = errorContent.match(/Error:\s*(\d{3})\s*\{/);
      if (apiErrorMatch) {
        const statusCode = apiErrorMatch[1];
        // 400 and 429 are retriable in some cases, but repeated failures should trip
        if (statusCode === "400" || statusCode === "429") {
          return `api_error:${statusCode}`;
        }
      }
    }

    return null;
  }

  /**
   * Process an incoming SDK message and check for error patterns
   * Returns true if circuit breaker tripped, false otherwise
   */
  async checkMessage(message: unknown): Promise<boolean> {
    // Only check user messages (SDK injects errors as user messages)
    const msg = message as { type?: string; message?: { content?: unknown } };
    if (msg.type !== "user") {
      return false;
    }

    // Extract message content
    const content = msg.message?.content;
    let messageText = "";

    if (typeof content === "string") {
      messageText = content;
    } else if (Array.isArray(content)) {
      // Content blocks format
      for (const block of content) {
        if (typeof block === "object" && block !== null) {
          const b = block as { type?: string; text?: string; content?: string };
          if (b.type === "text" && b.text) {
            messageText += b.text;
          } else if (b.type === "tool_result" && b.content) {
            messageText += b.content;
          }
        }
      }
    }

    if (!messageText) {
      return false;
    }

    // Check for error pattern
    const errorPattern = this.extractErrorPattern(messageText);
    if (!errorPattern) {
      return false;
    }

    // Record this error occurrence
    const now = Date.now();
    this.recentErrors.push({
      pattern: errorPattern,
      timestamp: now,
      fullMessage: messageText.substring(0, 200), // Truncate for logging
    });

    // Clean up old errors outside time window
    const cutoff = now - this.config.timeWindowMs;
    this.recentErrors = this.recentErrors.filter((e) => e.timestamp > cutoff);

    // Count occurrences of this pattern
    const patternCount = this.recentErrors.filter(
      (e) => e.pattern === errorPattern,
    ).length;

    this.logger.log(
      `Detected error pattern: ${errorPattern} (count: ${patternCount}/${this.config.errorThreshold})`,
    );

    // Check if threshold exceeded
    if (patternCount >= this.config.errorThreshold) {
      await this.trip(errorPattern, patternCount);
      return true;
    }

    return false;
  }

  /**
   * Trip the circuit breaker
   */
  private async trip(reason: string, errorCount: number): Promise<void> {
    this.state.isTripped = true;
    this.state.tripReason = reason;
    this.state.tripCount++;
    this.state.lastTripTime = Date.now();

    this.logger.log(
      `CIRCUIT BREAKER TRIPPED: ${reason} (${errorCount} errors in ${this.config.timeWindowMs}ms)`,
    );

    // Clear recent errors after trip
    this.recentErrors = [];

    // Execute callback if set
    if (this.onTrip) {
      try {
        await this.onTrip(reason, errorCount);
      } catch (error) {
        this.logger.error("Error executing onTrip callback:", error);
      }
    }
  }

  /**
   * Reset the circuit breaker (after successful operation or manual reset)
   */
  reset(): void {
    if (this.state.isTripped) {
      this.logger.log("Circuit breaker reset");
    }
    this.state.isTripped = false;
    this.state.tripReason = null;
    this.recentErrors = [];
  }

  /**
   * Mark a successful API call (resets error tracking)
   */
  markSuccess(): void {
    // Clear recent errors on success
    this.recentErrors = [];
  }

  /**
   * Get current circuit breaker state
   */
  getState(): CircuitBreakerState {
    return { ...this.state };
  }

  /**
   * Check if circuit breaker is currently tripped
   */
  isTripped(): boolean {
    // Auto-reset after cooldown period
    if (this.state.isTripped && this.state.lastTripTime) {
      const elapsed = Date.now() - this.state.lastTripTime;
      if (elapsed > this.config.cooldownMs) {
        this.logger.log("Circuit breaker auto-reset after cooldown");
        this.reset();
      }
    }
    return this.state.isTripped;
  }

  /**
   * Get human-readable message for the trip reason
   */
  getTripMessage(): string {
    if (!this.state.tripReason) {
      return "Unknown error";
    }

    if (this.state.tripReason.startsWith("prompt_too_long:")) {
      const maxTokens = this.state.tripReason.split(":")[1];
      return `Context limit exceeded (${maxTokens} tokens maximum).

**Possible causes:**
- A single tool output was extremely large (e.g., huge file, massive diff)
- The conversation context has grown too large

**What to do:**
- Output limiting is now **enabled by default** to prevent this
- If you still see this error, reduce limits further in .claude/settings.local.json:
  - outputLimiter.bash.headLines (default: 100)
  - outputLimiter.bash.tailLines (default: 200)
  - outputLimiter.read.maxChars (default: 50000)
  - outputLimiter.grep.maxMatches (default: 500)
- Use filtering in tools (e.g., grep with patterns, head/tail for files)
- Start a new session if context is too large
- Use /compact to reduce conversation context`;
    }

    if (this.state.tripReason === "invalid_request_error") {
      return "The API rejected the request. This usually means the conversation context is too large or malformed.";
    }

    if (this.state.tripReason === "connection_error") {
      return `Connection error detected repeatedly.

**Possible causes:**
- Network connectivity issues
- API service temporarily unavailable
- Firewall or proxy blocking the connection

**What to do:**
- Check your internet connection
- Verify your API key is valid and has not expired
- Try again in a few moments
- If the problem persists, check the Anthropic API status page`;
    }

    if (this.state.tripReason.startsWith("api_error:")) {
      const statusCode = this.state.tripReason.split(":")[1];
      if (statusCode === "429") {
        return "Rate limit exceeded. Please wait a moment before continuing.";
      }
      return `API error (${statusCode}). The request could not be processed.`;
    }

    return `Error detected: ${this.state.tripReason}`;
  }
}
