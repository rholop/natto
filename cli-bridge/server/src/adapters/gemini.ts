import type { CliAdapter, SpawnParams, SpawnSpec } from './adapter.js';
import type { CliEvent } from '../protocol/parser.js';

export interface GeminiAdapterOptions {
  binary?: string;
  hookBinPath?: string;
}

/**
 * Best-effort Gemini CLI adapter. Three items remain open:
 *   TODO(gemini-resume): confirm the flag equivalent to Claude's --resume <uuid>.
 *   TODO(gemini-schema): confirm the exact JSONL shape emitted by stream-json.
 *   TODO(gemini-hook): confirm how Gemini's permission-prompt-tool equivalent is wired.
 */
export class GeminiAdapter implements CliAdapter {
  readonly provider = 'gemini' as const;
  private readonly binary: string;
  private readonly hookBinPath: string | null;

  constructor(opts: GeminiAdapterOptions = {}) {
    this.binary = opts.binary ?? 'gemini';
    this.hookBinPath = opts.hookBinPath ?? null;
  }

  buildSpawn(params: SpawnParams): SpawnSpec {
    const argv = [this.binary, '-p', params.prompt];
    if (params.resumeUuid) argv.push('--session', params.resumeUuid);
    argv.push('--output-format', 'stream-json');
    if (this.hookBinPath) argv.push('--permission-prompt-tool', this.hookBinPath);
    return {
      argv,
      env: {
        AGUI_HOOK_URL: params.hookUrl,
        AGUI_HOOK_TOKEN: params.hookToken,
      },
    };
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

    if (type === 'tool_call' || type === 'function_call') {
      const name = typeof obj.name === 'string' ? obj.name : '';
      const args =
        obj.args === undefined
          ? obj.arguments === undefined
            ? ''
            : JSON.stringify(obj.arguments)
          : JSON.stringify(obj.args);
      const id = typeof obj.id === 'string' ? obj.id : undefined;
      return { type: 'tool_call', name, args, id };
    }

    if (type === 'tool_result' || type === 'function_result') {
      const toolCallId =
        typeof obj.tool_call_id === 'string'
          ? obj.tool_call_id
          : typeof obj.id === 'string'
            ? obj.id
            : '';
      const content =
        typeof obj.content === 'string'
          ? obj.content
          : obj.content === undefined
            ? ''
            : JSON.stringify(obj.content);
      return { type: 'tool_result', toolCallId, content };
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
}
