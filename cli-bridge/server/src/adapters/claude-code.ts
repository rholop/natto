import type { CliAdapter, SpawnOptions, ToolCallResult } from './adapter.js';
import type { CliEvent } from '../protocol/parser.js';

export interface ClaudeCodeAdapterOptions {
  binary?: string;
}

export class ClaudeCodeAdapter implements CliAdapter {
  readonly provider = 'claude-code' as const;
  private readonly binary: string;

  constructor(opts: ClaudeCodeAdapterOptions = {}) {
    this.binary = opts.binary ?? 'claude';
  }

  buildArgv(opts: SpawnOptions): string[] {
    const args = [this.binary, '-p', opts.prompt];
    if (opts.sessionUuid) args.push('--resume', opts.sessionUuid);
    args.push('--output-format', 'stream-json', '--verbose');
    return args;
  }

  parseJsonlLine(raw: string): CliEvent | null {
    let obj: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      obj = parsed as Record<string, unknown>;
    } catch {
      return null;
    }

    const type = typeof obj.type === 'string' ? obj.type : undefined;

    if (type === 'text' && typeof obj.text === 'string') {
      return { type: 'text_delta', delta: obj.text };
    }

    if (type === 'tool_use') {
      const name = typeof obj.name === 'string' ? obj.name : '';
      const input = obj.input;
      const args = input === undefined ? '' : JSON.stringify(input);
      const id = typeof obj.id === 'string' ? obj.id : undefined;
      return { type: 'tool_call', name, args, id };
    }

    if (type === 'system' && typeof obj.session_id === 'string') {
      return { type: 'session_id', uuid: obj.session_id };
    }

    if (type === 'result') {
      const stopReason =
        typeof obj.stop_reason === 'string' ? obj.stop_reason :
        typeof obj.subtype === 'string' ? obj.subtype :
        'unknown';
      // A "tool_use" stop_reason is a pause, not a real end-of-turn.
      // The tool_call event already signalled the pause; skip this line.
      if (stopReason === 'tool_use') return null;
      return { type: 'end_turn', stopReason };
    }

    if (type === 'error') {
      const message = typeof obj.message === 'string' ? obj.message : 'unknown error';
      return { type: 'error', message };
    }

    return null;
  }

  buildResumePrompt(result: ToolCallResult): string {
    if (!result.approved) {
      return `The user rejected the tool call "${result.toolName}" (id ${result.toolCallId}). Please try a different approach.`;
    }
    const content = result.content ?? '';
    return `Tool "${result.toolName}" (id ${result.toolCallId}) returned:\n\n${content}`;
  }
}
