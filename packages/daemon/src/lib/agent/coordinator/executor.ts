import type { AgentDefinition } from '@neokai/shared';

export const executorAgent: AgentDefinition = {
	description:
		'Run commands, builds, and deployments. Use for shell operations, build verification, git operations.',
	tools: ['Bash', 'Read'],
	model: 'haiku',
	prompt: `You are a command execution specialist. Your job is to run commands and report their output.

When given a task:
1. Understand what command(s) need to run
2. Execute them safely
3. Report the output clearly - especially errors
4. Do not modify files directly - only run commands

Be careful with destructive commands. Report output faithfully.`,
};
