/**
 * AskUserQuestionHandler - Handles the AskUserQuestion tool via canUseTool callback
 *
 * The Claude Agent SDK expects AskUserQuestion to be handled via the `canUseTool`
 * callback, NOT via tool_result messages through streaming input. This handler:
 *
 * 1. Intercepts AskUserQuestion in the canUseTool callback
 * 2. Transitions the agent to waiting_for_input state
 * 3. Stores a Promise that waits for user input
 * 4. When user responds via RPC, resolves the Promise with formatted answers
 * 5. The SDK automatically continues with the answers
 *
 * See: https://platform.claude.com/docs/en/agent-sdk/permissions#handling-the-askuserquestion-tool
 */

import type {
  PendingUserQuestion,
  QuestionDraftResponse,
} from "@liuboer/shared";
import type { DaemonHub } from "../daemon-hub";
import type {
  CanUseTool,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk/sdk";
import type { ProcessingStateManager } from "./processing-state-manager";
import { Logger } from "../logger";

/**
 * Type for the AskUserQuestion input from SDK
 */
interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    header: string;
    options: Array<{
      label: string;
      description: string;
    }>;
    multiSelect: boolean;
  }>;
  answers?: Record<string, string>;
}

/**
 * Stored resolver for pending question
 */
interface PendingQuestionResolver {
  toolUseId: string;
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
}

export class AskUserQuestionHandler {
  private logger: Logger;
  private pendingResolver: PendingQuestionResolver | null = null;

  constructor(
    private sessionId: string,
    private stateManager: ProcessingStateManager,
    private daemonHub: DaemonHub,
  ) {
    this.logger = new Logger(`AskUserQuestionHandler ${sessionId}`);
  }

  /**
   * Create the canUseTool callback for SDK options
   *
   * This callback intercepts AskUserQuestion and returns a Promise that
   * waits for user input before allowing the tool to proceed.
   */
  createCanUseToolCallback(): CanUseTool {
    return async (
      toolName: string,
      input: Record<string, unknown>,
      options: {
        signal: AbortSignal;
        toolUseID: string;
        suggestions?: unknown[];
        blockedPath?: string;
        decisionReason?: string;
        agentID?: string;
      },
    ): Promise<PermissionResult> => {
      // Only intercept AskUserQuestion tool
      if (toolName !== "AskUserQuestion") {
        // Allow all other tools (they go through permission mode settings)
        return { behavior: "allow", updatedInput: input };
      }

      this.logger.log(`AskUserQuestion detected, waiting for user input...`);

      const askInput = input as unknown as AskUserQuestionInput;

      // Build the pending question structure for UI
      // Use the SDK's toolUseID for consistency
      const pendingQuestion: PendingUserQuestion = {
        toolUseId: options.toolUseID,
        questions: askInput.questions.map((q) => ({
          question: q.question,
          header: q.header,
          options: q.options.map((o) => ({
            label: o.label,
            description: o.description,
          })),
          multiSelect: q.multiSelect,
        })),
        askedAt: Date.now(),
      };

      // Transition to waiting_for_input state
      // This will persist to DB and broadcast to clients
      await this.stateManager.setWaitingForInput(pendingQuestion);

      // Emit event for logging/debugging
      await this.daemonHub.emit("question.asked", {
        sessionId: this.sessionId,
        pendingQuestion,
      });

      this.logger.log(
        "Transitioned to waiting_for_input state, awaiting user response",
      );

      // Return a Promise that waits for user input
      return new Promise<PermissionResult>((resolve, reject) => {
        // Store the resolver so handleQuestionResponse can complete it
        this.pendingResolver = {
          toolUseId: options.toolUseID,
          input,
          resolve,
          reject,
        };
      });
    };
  }

  /**
   * Handle user's response to an AskUserQuestion
   *
   * This is called from the RPC handler when user submits their answer.
   * It resolves the Promise in canUseTool callback with the formatted answers.
   *
   * @param toolUseId - The tool use ID from the question (for validation)
   * @param responses - Array of user responses for each question
   */
  async handleQuestionResponse(
    toolUseId: string,
    responses: QuestionDraftResponse[],
  ): Promise<void> {
    const currentState = this.stateManager.getState();

    // Verify we're in waiting_for_input state
    if (currentState.status !== "waiting_for_input") {
      throw new Error(
        `Cannot respond to question: agent is not waiting for input (status: ${currentState.status})`,
      );
    }

    // Verify we have a pending resolver
    if (!this.pendingResolver) {
      throw new Error("No pending question to respond to");
    }

    // Verify the toolUseId matches (uses SDK's toolUseID)
    if (currentState.pendingQuestion.toolUseId !== toolUseId) {
      throw new Error(
        `Tool use ID mismatch: expected ${currentState.pendingQuestion.toolUseId}, got ${toolUseId}`,
      );
    }

    this.logger.log(`Handling question response for toolUseId: ${toolUseId}`);

    // Format the answers as expected by the SDK
    // Maps question text to selected option label(s)
    const answers: Record<string, string> = {};
    for (const response of responses) {
      const question =
        currentState.pendingQuestion.questions[response.questionIndex];
      if (!question) continue;

      if (response.customText) {
        // User provided custom text via "Other" option
        answers[question.question] = response.customText;
      } else if (response.selectedLabels.length > 0) {
        // User selected one or more predefined options
        // Multi-select answers are comma-separated
        answers[question.question] = response.selectedLabels.join(", ");
      }
    }

    this.logger.log(`Formatted answers:`, answers);

    // Transition back to processing state
    await this.stateManager.setProcessing(toolUseId, "streaming");

    // Resolve the pending Promise with the answers
    // This allows the SDK to continue with the user's input
    const resolver = this.pendingResolver;
    this.pendingResolver = null;

    resolver.resolve({
      behavior: "allow",
      updatedInput: {
        ...resolver.input,
        answers,
      },
    });

    this.logger.log("Question response sent to SDK");
  }

  /**
   * Handle user cancelling a pending question
   *
   * This denies the AskUserQuestion tool, which tells Claude the user
   * declined to answer.
   */
  async handleQuestionCancel(toolUseId: string): Promise<void> {
    const currentState = this.stateManager.getState();

    // Verify we're in waiting_for_input state
    if (currentState.status !== "waiting_for_input") {
      throw new Error(
        `Cannot cancel question: agent is not waiting for input (status: ${currentState.status})`,
      );
    }

    // Verify we have a pending resolver
    if (!this.pendingResolver) {
      throw new Error("No pending question to cancel");
    }

    // Verify the toolUseId matches
    if (currentState.pendingQuestion.toolUseId !== toolUseId) {
      throw new Error(
        `Tool use ID mismatch: expected ${currentState.pendingQuestion.toolUseId}, got ${toolUseId}`,
      );
    }

    this.logger.log(`Handling question cancel for toolUseId: ${toolUseId}`);

    // Transition back to processing state
    await this.stateManager.setProcessing(toolUseId, "streaming");

    // Resolve with a deny behavior
    // This tells Claude the user declined to answer
    const resolver = this.pendingResolver;
    this.pendingResolver = null;

    resolver.resolve({
      behavior: "deny",
      message:
        "User cancelled: The user chose not to answer this question. Please proceed accordingly or ask a different question if needed.",
    });

    this.logger.log("Question cancellation sent to SDK");
  }

  /**
   * Update draft responses for pending question
   * Called by question.saveDraft RPC to preserve user selections
   */
  async updateQuestionDraft(
    draftResponses: QuestionDraftResponse[],
  ): Promise<void> {
    await this.stateManager.updateQuestionDraft(draftResponses);
    this.logger.log(
      `Updated question draft with ${draftResponses.length} responses`,
    );
  }

  /**
   * Cleanup any pending resolvers (called during session cleanup)
   */
  cleanup(): void {
    if (this.pendingResolver) {
      this.pendingResolver.reject(new Error("Session cleanup"));
      this.pendingResolver = null;
    }
  }
}
