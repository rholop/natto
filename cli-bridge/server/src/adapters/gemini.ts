import type { CliAdapter, SpawnOptions, ToolCallResult } from './adapter.js';
import type { CliEvent } from '../protocol/parser.js';

export interface GeminiAdapterOptions {
  binary?: string;
}

/**
 * Best-effort Gemini CLI adapter. Two items are open (see docs/bridge-server-design.md §11):
 *   - TODO(gemini-resume): confirm the flag equivalent to Claude's --resume <uuid>.
 *   - TODO(gemini-schema): confirm the exact JSONL shape emitted by --output-format stream-json.
 * Until those are verified against a real Gemini CLI build, the mapping below
 * mirrors a generic stream-json shape and is fully exercised via the mock CLI.
 */
export class GeminiAdapter implements CliAdapter {
  readonly provider = 'gemini' as const;
  private readonly binary: string;

  constructor(opts: GeminiAdapterOptions = {}) {
    this.binary = opts.binary ?? 'gemini';
  }

  buildArgv(opts: SpawnOptions): string[] {
    const args = [this.binary, '-p', opts.prompt];
    // TODO(gemini-resume): replace with the actual resume flag once confirmed.
    if (opts.sessionUuid) args.push('--session', opts.sessionUuid);
    args.push('--output-format', 'stream-json');
    return args;
  }

  parseJsonlLine(raw: string): CliEvent | null {
    // TODO(gemini-schema): adjust field names once the real schema is confirmed.
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

    if (type === 'tool_call' || type === 'function_call') {
      const name = typeof obj.name === 'string' ? obj.name : '';
      const args = obj.args === undefined ? (obj.arguments === undefined ? '' : JSON.stringify(obj.arguments)) : JSON.stringify(obj.args);
      const id = typeof obj.id === 'string' ? obj.id : undefined;
      return { type: 'tool_call', name, args, id };
    }

    if (type === 'session' && typeof obj.session_id === 'string') {
      return { type: 'session_id', uuid: obj.session_id };
    }

    if (type === 'end' || type === 'done' || type === 'result') {
      const stopReason = typeof obj.stop_reason === 'string' ? obj.stop_reason : 'end_turn';
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
      return `The user rejected tool "${result.toolName}" (id ${result.toolCallId}). Please try a different approach.`;
    }
    return `Tool "${result.toolName}" (id ${result.toolCallId}) result:\n\n${result.content ?? ''}`;
  }
}
