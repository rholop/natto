import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import type { SpawnOptions } from '../../src/adapters/adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const TSX_BIN = resolve(__dirname, '../../../node_modules/.bin/tsx');
const MOCK_CLI = resolve(__dirname, './mock-cli.ts');

/**
 * Adapter used in integration tests. Reuses ClaudeCodeAdapter's JSONL parser
 * (the mock CLI emits Claude-Code-shaped events) but rewrites argv to invoke
 * the mock CLI via tsx. The scenario path is passed to the mock via the
 * MOCK_CLI_SCENARIO env var; tests set this on process.env before spawning.
 */
export class MockCliAdapter extends ClaudeCodeAdapter {
  override buildArgv(opts: SpawnOptions): string[] {
    const args = [TSX_BIN, MOCK_CLI, '-p', opts.prompt];
    if (opts.sessionUuid) args.push('--resume', opts.sessionUuid);
    args.push('--output-format', 'stream-json', '--verbose');
    return args;
  }
}
