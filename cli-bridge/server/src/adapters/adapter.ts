import type { Provider } from '../protocol/events.js';
import type { CliEvent } from '../protocol/parser.js';

export interface SpawnOptions {
  sessionUuid: string | null;
  prompt: string;
  cwd: string;
  env?: Record<string, string>;
}

export interface ToolCallResult {
  toolCallId: string;
  toolName: string;
  approved: boolean;
  content?: string;
}

export interface CliAdapter {
  readonly provider: Provider;
  buildArgv(opts: SpawnOptions): string[];
  parseJsonlLine(raw: string): CliEvent | null;
  buildResumePrompt(toolResult: ToolCallResult): string;
}
