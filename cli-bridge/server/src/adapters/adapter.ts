import type { Provider } from '../protocol/events.js';
import type { CliEvent } from '../protocol/parser.js';

export interface SpawnParams {
  prompt: string;
  cwd: string;
  resumeUuid: string | null;
  hookUrl: string;
  hookToken: string;
  sessionId: string;
}

export interface SpawnSpec {
  argv: string[];
  env: Record<string, string>;
}

export interface CliAdapter {
  readonly provider: Provider;
  buildSpawn(params: SpawnParams): SpawnSpec;
  parseJsonlLine(raw: string): CliEvent | null;
}
