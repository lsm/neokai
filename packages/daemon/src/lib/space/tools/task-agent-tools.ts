/**
 * Task Agent Tools — MCP tool handlers for the Task Agent session.
 *
 * These handlers implement the business logic for the 5 Task Agent tools:
 *   spawn_step_agent      — Spawn a sub-session for a workflow step's assigned agent
 *   check_step_status     — Poll the status of a running step agent sub-session
 *   advance_workflow      — Advance the workflow to the next step after current step completes
 *   report_result         — Mark the task as completed/failed and record the result
 *   request_human_input   — Pause execution and surface a question to the human user
 *
 * Design:
 * - Handlers are pure functions tested independently of any MCP server layer.
 * - Dependencies are injected via `TaskAgentToolsConfig`.
 * - The `SubSessionFactory` abstraction allows tests to mock session creation/state.
 * - Session completion is signalled via two paths:
 *     1. Completion callback registered in spawn_step_agent (fires automatically)
 *     2. Polling via check_step_status (Task Agent polls this tool)
 *
 * Following the pattern established in space-agent-tools.ts.
 */

import { randomUUID } from 'node:crypto';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { Space } from '@neokai/shared';
import type { DaemonHub } from '../../daemon-hub';
import { Logger } from '../../logger';
import type { AgentSessionInit } from '../../agent/agent-session';
import type { SpaceRuntime } from '../runtime/space-runtime';
import { WorkflowGateError } from '../runtime/workflow-executor';
import type { SpaceWorkflowManager } from '../managers/space-workflow-manager';
import type { SpaceTaskManager } from '../managers/space-task-manager';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository';
import type { SpaceAgentManager } from '../managers/space-agent-manager';
import { resolveAgentInit, buildCustomAgentTaskMessage } from '../agents/custom-agent';
import { jsonResult } from './tool-result';
import type { ToolResult } from './tool-result';
import {
	SpawnStepAgentSchema,
	CheckStepStatusSchema,
	AdvanceWorkflowSchema,
	ReportResultSchema,
	RequestHumanInputSchema,
} from './task-agent-tool-schemas';
import type {
	SpawnStepAgentInput,
	CheckStepStatusInput,
	AdvanceWorkflowInput,
	ReportResultInput,
	RequestHumanInputInput,
} from './task-agent-tool-schemas';

// Re-export for consumers that want the shared type
export type { ToolResult };

const log = new Logger('task-agent-tools');

// ---------------------------------------------------------------------------
// Sub-session state
// ---------------------------------------------------------------------------

/**
 * Processing state of a sub-session, as reported by SubSessionFactory.
 */
export interface SubSessionState {
	/** Whether the session is actively processing a query */
	isProcessing: boolean;
	/** Whether the session has reached a terminal state (no more processing) */
	isComplete: boolean;
	/** Error details if the session ended in an error state */
	error?: string;
}

// ---------------------------------------------------------------------------
// SubSessionFactory
// ---------------------------------------------------------------------------

/**
 * Abstraction for creating and querying sub-sessions.
 * Injected into the config so tests can mock session behaviour without a real daemon.
 */
export interface SubSessionFactory {
	/**
	 * Creates and starts a new agent sub-session.
	 * Returns the session ID of the created session.
	 */
	create(init: AgentSessionInit): Promise<string>;

	/**
	 * Returns the current processing state of a session, or null if the session
	 * is not known / has been cleaned up.
	 */
	getProcessingState(sessionId: string): SubSessionState | null;

	/**
	 * Registers a callback that is invoked once when the given session completes
	 * (transitions to a terminal state). The callback is called at most once.
	 */
	onComplete(sessionId: string, callback: () => Promise<void>): void;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into createTaskAgentToolHandlers().
 * All fields are required — the caller (TaskAgentManager) wires them up.
 */
export interface TaskAgentToolsConfig {
	/** ID of the main SpaceTask this Task Agent is orchestrating. */
	taskId: string;
	/**
	 * Full Space object — needed for agent init and task message building.
	 * The space ID is available as `space.id`.
	 */
	space: Space;
	/** ID of the active workflow run for this task. */
	workflowRunId: string;
	/** Absolute path to the workspace — forwarded to agent sessions. */
	workspacePath: string;
	/** SpaceRuntime for accessing WorkflowExecutors by run ID. */
	runtime: SpaceRuntime;
	/** Workflow manager for loading workflow definitions. */
	workflowManager: SpaceWorkflowManager;
	/** Task repository for direct DB reads. */
	taskRepo: SpaceTaskRepository;
	/** Workflow run repository for reading and updating runs. */
	workflowRunRepo: SpaceWorkflowRunRepository;
	/** Agent manager for resolving step agents. */
	agentManager: SpaceAgentManager;
	/** Task manager for validated status transitions. */
	taskManager: SpaceTaskManager;
	/** Sub-session factory for creating and querying agent sub-sessions. */
	sessionFactory: SubSessionFactory;
	/**
	 * Injects a message into an existing sub-session as a user turn.
	 * Called after spawn to deliver the step's task context message.
	 */
	messageInjector: (sessionId: string, message: string) => Promise<void>;
	/**
	 * Called by the completion mechanism when a sub-session finishes.
	 * Provided by the TaskAgentManager; updates the step's SpaceTask to `completed`.
	 * The Task Agent handler registers this as the session completion callback.
	 */
	onSubSessionComplete: (stepId: string, sessionId: string) => Promise<void>;
	/**
	 * DaemonHub instance for emitting task completion/failure events.
	 * Optional — if omitted, no events are emitted (e.g. in unit tests that don't need them).
	 */
	daemonHub?: DaemonHub;
}

// ---------------------------------------------------------------------------
// Tool handlers (separated for testability)
// ---------------------------------------------------------------------------

/**
 * Create handler functions that can be tested directly without an MCP server.
 * Returns a map of tool name → async handler function.
 */
export function createTaskAgentToolHandlers(config: TaskAgentToolsConfig) {
	const {
		taskId,
		space,
		workflowRunId,
		workspacePath,
		runtime,
		workflowManager,
		taskRepo,
		workflowRunRepo,
		agentManager,
		taskManager,
		sessionFactory,
		messageInjector,
		onSubSessionComplete,
		daemonHub,
	} = config;

	return {
		/**
		 * Spawn a sub-session for a workflow step's assigned agent.
		 *
		 * Flow:
		 * 1. Validate the workflow run and workflow definition
		 * 2. Find the step by step_id in the workflow
		 * 3. Find the pending SpaceTask created by the WorkflowExecutor for this step
		 * 4. Resolve the agent session init via resolveAgentInit()
		 * 5. Create the sub-session via sessionFactory.create()
		 * 6. Register completion callback (onSubSessionComplete) via sessionFactory.onComplete()
		 * 7. Record the sub-session ID on the step task (BEFORE message injection, so
		 *    check_step_status can track the session even if injection later fails)
		 * 8. Transition main task from pending → in_progress if not already in_progress
		 * 9. Build and inject the task context message via messageInjector
		 *    (non-fatal if injection fails — sub-session is already running and trackable)
		 */
		async spawn_step_agent(args: SpawnStepAgentInput): Promise<ToolResult> {
			const { step_id, instructions } = args;

			// Load the workflow run
			const run = workflowRunRepo.getRun(workflowRunId);
			if (!run) {
				return jsonResult({ success: false, error: `Workflow run not found: ${workflowRunId}` });
			}

			// Load the workflow definition
			const workflow = workflowManager.getWorkflow(run.workflowId);
			if (!workflow) {
				return jsonResult({ success: false, error: `Workflow not found: ${run.workflowId}` });
			}

			// Find the step
			const step = workflow.steps.find((s) => s.id === step_id);
			if (!step) {
				return jsonResult({
					success: false,
					error: `Step not found: ${step_id} in workflow ${run.workflowId}`,
				});
			}

			// Find the pending task for this step (created by WorkflowExecutor.followTransition)
			const allRunTasks = taskRepo.listByWorkflowRun(workflowRunId);
			const stepTasks = allRunTasks.filter((t) => t.workflowStepId === step_id);
			if (stepTasks.length === 0) {
				return jsonResult({
					success: false,
					error:
						`No task found for step "${step.name}" (id: ${step_id}). ` +
						`Ensure advance_workflow was called first to create the step task.`,
				});
			}

			// Use the most recently created task for this step.
			const stepTask = stepTasks[stepTasks.length - 1];

			// Idempotency guard: if this step already has a tracked sub-session, return it
			// without creating a duplicate. Prevents double-spawning from orphaning the first
			// session when the Task Agent retries a spawn_step_agent call.
			if (stepTask.taskAgentSessionId) {
				return jsonResult({
					success: true,
					sessionId: stepTask.taskAgentSessionId,
					stepId: step_id,
					stepName: step.name,
					taskId: stepTask.id,
					alreadySpawned: true,
				});
			}

			// Ensure customAgentId is set — fall back to step.agentId for preset agents.
			// WorkflowExecutor sets customAgentId to undefined for coder/general preset roles,
			// but those agents are still SpaceAgent records indexed by step.agentId.
			const effectiveTask = {
				...stepTask,
				customAgentId: stepTask.customAgentId ?? step.agentId,
			};

			// Apply optional instruction override
			if (instructions) {
				effectiveTask.description = instructions;
			}

			// Generate a new session ID for the sub-session.
			// Note: the factory may assign a different ID internally. All subsequent code
			// uses `actualSessionId` returned by sessionFactory.create(), not subSessionId.
			// The subSessionId is embedded in the init only so the SDK can pre-wire it.
			const subSessionId = randomUUID();

			// Resolve the agent session init
			let init: AgentSessionInit;
			try {
				init = resolveAgentInit({
					task: effectiveTask,
					space,
					agentManager,
					sessionId: subSessionId,
					workspacePath,
					workflowRun: run,
					workflow,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: `Failed to resolve agent init: ${message}` });
			}

			// Create and start the sub-session
			let actualSessionId: string;
			try {
				actualSessionId = await sessionFactory.create(init);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: `Failed to create sub-session: ${message}` });
			}

			// Register the completion callback — fires when the sub-session finishes.
			sessionFactory.onComplete(actualSessionId, async () => {
				await onSubSessionComplete(step_id, actualSessionId);
			});

			// Record the sub-session ID on the step task BEFORE message injection.
			// This ensures check_step_status can locate and track the session even if
			// the subsequent message injection fails.
			taskRepo.updateTask(stepTask.id, {
				taskAgentSessionId: actualSessionId,
				currentStep: `Running agent for step: ${step.name}`,
			});

			// Transition main task from pending → in_progress (first step spawn)
			const mainTask = taskRepo.getTask(taskId);
			if (mainTask && mainTask.status === 'pending') {
				try {
					await taskManager.setTaskStatus(taskId, 'in_progress');
				} catch {
					// Non-fatal — task may have already been transitioned elsewhere
				}
			}

			// Update main task's currentStep to reflect which step is being executed
			taskRepo.updateTask(taskId, { currentStep: `Executing step: ${step.name}` });

			// Build the task context message and inject it into the sub-session.
			// This is non-fatal: if injection fails the sub-session still runs (and is
			// already trackable via taskAgentSessionId recorded above), just without its
			// initial task context. Return success with a warning field so the Task Agent
			// can still poll check_step_status.
			try {
				// resolveAgentInit() already validated that the agent exists, so this
				// getById() call should always succeed. If it somehow returns null after
				// resolveAgentInit() passed, that is a data inconsistency worth surfacing.
				const agent = agentManager.getById(effectiveTask.customAgentId!);
				if (!agent) {
					return jsonResult({
						success: true,
						sessionId: actualSessionId,
						stepId: step_id,
						stepName: step.name,
						taskId: stepTask.id,
						warning:
							`Agent ${effectiveTask.customAgentId} not found when building task message — ` +
							`sub-session is running without initial task context. This should not happen.`,
					});
				}
				const taskMessage = buildCustomAgentTaskMessage({
					customAgent: agent,
					task: effectiveTask,
					workflowRun: run,
					workflow,
					space,
					sessionId: actualSessionId,
					workspacePath,
				});
				await messageInjector(actualSessionId, taskMessage);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				// Return success:true because the sub-session was created, the completion
				// callback is registered, and taskAgentSessionId is persisted. The Task Agent
				// can still track completion via check_step_status. The warning informs it
				// that the sub-session started without its initial task context message.
				return jsonResult({
					success: true,
					sessionId: actualSessionId,
					stepId: step_id,
					stepName: step.name,
					taskId: stepTask.id,
					warning: `Message injection failed: ${message}. Sub-session is running without initial task context.`,
				});
			}

			return jsonResult({
				success: true,
				sessionId: actualSessionId,
				stepId: step_id,
				stepName: step.name,
				taskId: stepTask.id,
			});
		},

		/**
		 * Check the processing state of a step's sub-session.
		 *
		 * This is the primary mechanism for the Task Agent to detect sub-session completion.
		 * The Task Agent polls this tool after spawning a step agent.
		 *
		 * If step_id is omitted, checks the workflow run's current step.
		 * Returns status = 'completed' when the step task has been marked completed in the DB
		 * (which happens via the completion callback registered in spawn_step_agent).
		 */
		async check_step_status(args: CheckStepStatusInput): Promise<ToolResult> {
			// Resolve step ID — use provided step_id or fall back to current step on run
			let stepId = args.step_id;
			if (!stepId) {
				const run = workflowRunRepo.getRun(workflowRunId);
				if (!run) {
					return jsonResult({
						success: false,
						error: `Workflow run not found: ${workflowRunId}`,
					});
				}
				if (!run.currentStepId) {
					return jsonResult({
						success: false,
						error: 'No current step on the workflow run. Call spawn_step_agent first.',
					});
				}
				stepId = run.currentStepId;
			}

			// Find task(s) for this step
			const stepTasks = taskRepo
				.listByWorkflowRun(workflowRunId)
				.filter((t) => t.workflowStepId === stepId);

			if (stepTasks.length === 0) {
				return jsonResult({
					success: true,
					stepId,
					taskStatus: 'not_found',
					sessionStatus: 'not_started',
					message: 'No task found for this step. Has spawn_step_agent been called?',
				});
			}

			const stepTask = stepTasks[stepTasks.length - 1];

			// Fast path: task already marked completed by the completion callback
			if (stepTask.status === 'completed') {
				return jsonResult({
					success: true,
					stepId,
					taskId: stepTask.id,
					taskStatus: 'completed',
					sessionStatus: 'completed',
					message: 'Step has completed successfully.',
				});
			}

			// If no sub-session has been started yet, report not_started
			if (!stepTask.taskAgentSessionId) {
				return jsonResult({
					success: true,
					stepId,
					taskId: stepTask.id,
					taskStatus: stepTask.status,
					sessionStatus: 'not_started',
					message: 'Sub-session not yet started for this step. Call spawn_step_agent.',
				});
			}

			// Query the sub-session processing state.
			// The guard above ensures taskAgentSessionId is non-null here.
			const state = sessionFactory.getProcessingState(stepTask.taskAgentSessionId);
			if (!state) {
				return jsonResult({
					success: true,
					stepId,
					taskId: stepTask.id,
					taskStatus: stepTask.status,
					sessionStatus: 'unknown',
					message:
						'Sub-session state not available. ' +
						'The session may have ended or been cleaned up before the completion callback fired.',
				});
			}

			if (state.isComplete) {
				return jsonResult({
					success: true,
					stepId,
					taskId: stepTask.id,
					taskStatus: stepTask.status,
					sessionStatus: 'completed',
					error: state.error,
					message: state.error
						? `Sub-session ended with an error: ${state.error}`
						: 'Sub-session has completed. Waiting for completion callback to update task status.',
				});
			}

			return jsonResult({
				success: true,
				stepId,
				taskId: stepTask.id,
				taskStatus: stepTask.status,
				sessionStatus: state.isProcessing ? 'running' : 'idle',
				message: state.isProcessing
					? 'Sub-session is actively processing. Check back soon.'
					: 'Sub-session is idle (not currently processing). It may be waiting for input.',
			});
		},

		/**
		 * Advance the workflow to the next step after the current step completes.
		 *
		 * Pre-conditions:
		 * - The current step's SpaceTask must have status = 'completed' in the DB
		 *   (set by the completion callback registered in spawn_step_agent)
		 *
		 * Flow:
		 * 1. Get the WorkflowExecutor for this run
		 * 2. Verify the current step task is completed
		 * 3. If the main task is needs_attention (waiting for human), reset to in_progress
		 * 4. Call executor.advance() to evaluate transitions and move to next step
		 * 5. Handle WorkflowGateError → return gate-blocked status (caller calls request_human_input)
		 * 6. Return next step info (or terminal state)
		 *
		 * Note: WorkflowExecutor.advance() accepts `{ stepResult?: string }` for
		 * task_result condition evaluation. The `step_result` field from the tool input
		 * is forwarded to the executor, which uses it as a fallback when the DB result
		 * is absent (DB result takes precedence — the most recently completed task on
		 * the step is queried first).
		 */
		async advance_workflow(args: AdvanceWorkflowInput): Promise<ToolResult> {
			const executor = runtime.getExecutor(workflowRunId);
			if (!executor) {
				return jsonResult({
					success: false,
					error:
						`No active executor found for workflow run: ${workflowRunId}. ` +
						`The run may have completed or been cancelled.`,
				});
			}

			if (executor.isComplete()) {
				return jsonResult({
					success: false,
					error: 'Workflow run is already complete. Call report_result to close the task.',
				});
			}

			const currentStep = executor.getCurrentStep();
			if (!currentStep) {
				return jsonResult({
					success: false,
					error: 'No current step on the workflow executor. The run may be in an invalid state.',
				});
			}

			// Verify the current step's task is completed in the DB
			const stepTasks = taskRepo
				.listByWorkflowRun(workflowRunId)
				.filter((t) => t.workflowStepId === currentStep.id);

			const allCompleted = stepTasks.length > 0 && stepTasks.every((t) => t.status === 'completed');

			if (!allCompleted) {
				const taskStatus =
					stepTasks.length > 0 ? stepTasks[stepTasks.length - 1].status : 'not_found';
				return jsonResult({
					success: false,
					error:
						`Current step "${currentStep.name}" has not completed yet. ` +
						`Task status: ${taskStatus}. ` +
						`Wait for the step agent to finish before calling advance_workflow.`,
					currentStepId: currentStep.id,
					currentStepName: currentStep.name,
					taskStatus,
				});
			}

			// If the main task is needs_attention (waiting after a human gate), reset to in_progress
			const mainTask = taskRepo.getTask(taskId);
			if (mainTask && mainTask.status === 'needs_attention') {
				try {
					await taskManager.setTaskStatus(taskId, 'in_progress');
				} catch {
					// Non-fatal — if transition fails, continue with advance attempt
				}
			}

			try {
				const { step: nextStep, tasks: newTasks } = await executor.advance({
					stepResult: args.step_result,
				});

				if (newTasks.length === 0) {
					// Terminal step reached — executor marked run as completed.
					// `nextStep` is the step that was just completed (the terminal one).
					return jsonResult({
						success: true,
						terminal: true,
						terminalStep: {
							id: nextStep.id,
							name: nextStep.name,
						},
						message:
							'Workflow has reached a terminal step. ' +
							`Call report_result with status "completed" to close the task.`,
					});
				}

				// Workflow advanced to the next step
				return jsonResult({
					success: true,
					terminal: false,
					nextStep: {
						id: nextStep.id,
						name: nextStep.name,
						instructions: nextStep.instructions,
						agentId: nextStep.agentId,
					},
					newTasks: newTasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
					message: `Workflow advanced to step "${nextStep.name}". Call spawn_step_agent to execute it.`,
				});
			} catch (err) {
				if (err instanceof WorkflowGateError) {
					return jsonResult({
						success: true,
						gateBlocked: true,
						message: err.message,
						instruction:
							'A human gate is blocking workflow advancement. ' +
							'Call request_human_input to surface this to the human user. ' +
							'When the human responds, call advance_workflow again.',
					});
				}

				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Report the final outcome of the task and close the task lifecycle.
		 *
		 * Updates the main SpaceTask status to one of:
		 *   completed        — task succeeded; summary records the result
		 *   needs_attention  — task requires human intervention; error describes the issue
		 *   cancelled        — task was cancelled
		 */
		async report_result(args: ReportResultInput): Promise<ToolResult> {
			const { status, summary, error: errorDetail } = args;

			const mainTask = taskRepo.getTask(taskId);
			if (!mainTask) {
				return jsonResult({ success: false, error: `Task not found: ${taskId}` });
			}

			try {
				await taskManager.setTaskStatus(taskId, status, {
					result: summary,
					error: errorDetail,
				});

				// Emit DaemonHub event so the Space Agent is notified of task completion/failure.
				if (daemonHub) {
					const eventPayload = {
						sessionId: 'global',
						taskId,
						spaceId: space.id,
						status,
						summary: summary ?? '',
						workflowRunId,
						taskTitle: mainTask.title,
					};
					const eventName = status === 'completed' ? 'space.task.completed' : 'space.task.failed';
					void daemonHub.emit(eventName, eventPayload).catch((err) => {
						log.warn(
							`Failed to emit ${eventName} for task ${taskId}: ${err instanceof Error ? err.message : String(err)}`
						);
					});
				}

				return jsonResult({
					success: true,
					taskId,
					status,
					summary,
					message: `Task has been marked as "${status}". The task lifecycle is now closed.`,
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},

		/**
		 * Pause workflow execution and surface a question to the human user.
		 *
		 * Updates the main task status to `needs_attention` and stores the question
		 * in the `currentStep` field so the human can see it in the UI.
		 * The full question + context is stored in the `error` field for complete context.
		 *
		 * Gate re-engagement:
		 * When the human responds (via space.task.sendMessage), the message is injected
		 * into this Task Agent session as a normal conversation message. The Task Agent
		 * receives it, sees the human's response, and calls advance_workflow to proceed.
		 * The advance_workflow handler resets the task to in_progress before advancing.
		 */
		async request_human_input(args: RequestHumanInputInput): Promise<ToolResult> {
			const { question, context: questionContext } = args;

			const mainTask = taskRepo.getTask(taskId);
			if (!mainTask) {
				return jsonResult({ success: false, error: `Task not found: ${taskId}` });
			}

			// Only transition to needs_attention from valid states.
			// Valid transitions: in_progress → needs_attention, review → needs_attention.
			const canTransition = mainTask.status === 'in_progress' || mainTask.status === 'review';

			if (!canTransition) {
				return jsonResult({
					success: false,
					error:
						`Cannot request human input when task status is "${mainTask.status}". ` +
						`Task must be in_progress or review.`,
				});
			}

			// The `error` field stores the full question + context for complete diagnostic context.
			// The `currentStep` field stores just the bare question for UI display — it is
			// intentionally shorter than `error` to fit the summary display in the task list.
			const questionWithContext = questionContext
				? `${question}\n\nContext: ${questionContext}`
				: question;

			try {
				await taskManager.setTaskStatus(taskId, 'needs_attention', {
					error: questionWithContext,
				});

				// Update currentStep to the bare question for visible UI display
				taskRepo.updateTask(taskId, { currentStep: question });

				return jsonResult({
					success: true,
					taskId,
					question,
					context: questionContext,
					message:
						'Human input has been requested. The question is now visible to the human in the UI. ' +
						'Wait — do not call any other tools until the human responds. ' +
						"When the human's response appears in the conversation, " +
						'read it and then call advance_workflow to continue execution.',
				});
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return jsonResult({ success: false, error: message });
			}
		},
	};
}

// ---------------------------------------------------------------------------
// MCP server factory
// ---------------------------------------------------------------------------

/**
 * Create an MCP server exposing all Task Agent tools.
 * Pass the returned server to the SDK session init for the Task Agent session.
 */
export function createTaskAgentMcpServer(config: TaskAgentToolsConfig) {
	const handlers = createTaskAgentToolHandlers(config);

	const tools = [
		tool(
			'spawn_step_agent',
			"Start a sub-session for a workflow step's assigned agent. " +
				'Call this to execute each workflow step. ' +
				'Returns the session ID of the spawned sub-session.',
			SpawnStepAgentSchema.shape,
			(args) => handlers.spawn_step_agent(args)
		),
		tool(
			'check_step_status',
			'Poll the status of a running step agent sub-session. ' +
				'Call this periodically after spawn_step_agent to detect when a step has completed.',
			CheckStepStatusSchema.shape,
			(args) => handlers.check_step_status(args)
		),
		tool(
			'advance_workflow',
			'Advance the workflow to the next step after the current step completes. ' +
				'The current step must be completed before calling this. ' +
				'Returns the next step info, a terminal state, or a gate-blocked status.',
			AdvanceWorkflowSchema.shape,
			(args) => handlers.advance_workflow(args)
		),
		tool(
			'report_result',
			'Mark the task as completed, failed, or cancelled and record the result summary. ' +
				'Call this when the workflow reaches a terminal step or an unrecoverable error occurs.',
			ReportResultSchema.shape,
			(args) => handlers.report_result(args)
		),
		tool(
			'request_human_input',
			'Pause workflow execution and surface a question to the human user. ' +
				'The task will be marked as needs_attention until the human responds. ' +
				'When the human responds, their message will appear in this conversation.',
			RequestHumanInputSchema.shape,
			(args) => handlers.request_human_input(args)
		),
	];

	return createSdkMcpServer({ name: 'task-agent', tools });
}

export type TaskAgentMcpServer = ReturnType<typeof createTaskAgentMcpServer>;
