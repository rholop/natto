import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import type { SpawnParams, SpawnSpec } from '../../src/adapters/adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TSX_BIN = resolve(__dirname, '../../../node_modules/.bin/tsx');
const MOCK_CLI = resolve(__dirname, './mock-cli.ts');

export interface MockCliAdapterOptions {
  scenarioPath: string;
}

/**
 * Adapter used in integration tests. Reuses ClaudeCodeAdapter's JSONL parser
 * (the mock CLI emits Claude-Code-shaped events) but rewrites the spawn to
 * invoke the mock CLI via tsx, carrying the scenario path through env.
 */
export class MockCliAdapter extends ClaudeCodeAdapter {
  constructor(private readonly mockOpts: MockCliAdapterOptions) {
    super();
  }

  override buildSpawn(params: SpawnParams): SpawnSpec {
    const argv = [TSX_BIN, MOCK_CLI, '-p', params.prompt];
    if (params.resumeUuid) argv.push('--resume', params.resumeUuid);
    argv.push('--output-format', 'stream-json', '--verbose');
    return {
      argv,
      env: {
        MOCK_CLI_SCENARIO: this.mockOpts.scenarioPath,
        AGUI_HOOK_URL: params.hookUrl,
        AGUI_HOOK_TOKEN: params.hookToken,
        AGUI_SESSION_ID: params.sessionId,
      },
    };
  }
}
