import type { CliAdapter, SpawnParams, SpawnSpec } from './adapter.js';
import type { CliEvent } from '../protocol/parser.js';

export interface ClaudeCodeAdapterOptions {
  binary?: string;
  hookBinPath?: string;
}

export class ClaudeCodeAdapter implements CliAdapter {
  readonly provider = 'claude-code' as const;
  private readonly binary: string;
  private readonly hookBinPath: string | null;

  constructor(opts: ClaudeCodeAdapterOptions = {}) {
    this.binary = opts.binary ?? 'claude';
    this.hookBinPath = opts.hookBinPath ?? null;
  }

  buildSpawn(params: SpawnParams): SpawnSpec {
    const argv = [this.binary, '-p', params.prompt];
    if (params.resumeUuid) argv.push('--resume', params.resumeUuid);
    argv.push('--output-format', 'stream-json', '--verbose');
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

    if (type === 'tool_use') {
      const name = typeof obj.name === 'string' ? obj.name : '';
      const input = obj.input;
      const args = input === undefined ? '' : JSON.stringify(input);
      const id = typeof obj.id === 'string' ? obj.id : undefined;
      return { type: 'tool_call', name, args, id };
    }

    if (type === 'tool_result') {
      const toolCallId =
        typeof obj.tool_use_id === 'string'
          ? obj.tool_use_id
          : typeof obj.tool_call_id === 'string'
            ? obj.tool_call_id
            : '';
      const content =
        typeof obj.content === 'string'
          ? obj.content
          : obj.content === undefined
            ? ''
            : JSON.stringify(obj.content);
      return { type: 'tool_result', toolCallId, content };
    }

    if (type === 'system' && typeof obj.session_id === 'string') {
      return { type: 'session_id', uuid: obj.session_id };
    }

    if (type === 'result') {
      const stopReason =
        typeof obj.stop_reason === 'string'
          ? obj.stop_reason
          : typeof obj.subtype === 'string'
            ? obj.subtype
            : 'unknown';
      if (stopReason === 'tool_use') return null;
      return { type: 'end_turn', stopReason };
    }

    if (type === 'error') {
      const message = typeof obj.message === 'string' ? obj.message : 'unknown error';
      return { type: 'error', message };
    }

    return null;
  }
}
