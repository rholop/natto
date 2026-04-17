#!/usr/bin/env tsx
/**
 * Scriptable mock CLI. Replaces `claude` or `gemini` in tests.
 *
 * Invocation contract: argv may include `-p <prompt>`, `--resume <uuid>`,
 * `--output-format stream-json`, `--verbose`. The mock ignores `-p` content
 * entirely; it matches the invocation to a turn via `--resume <uuid>` against
 * the scenario's `matchResume` field (`null` = no --resume flag).
 *
 * The scenario is loaded from the MOCK_CLI_SCENARIO env var (path to JSON).
 */
import { readFileSync } from 'node:fs';

interface ScenarioLine {
  delay: number;
  line: string;
}
interface ScenarioTurn {
  matchResume: string | null;
  lines: ScenarioLine[];
  exitCode: number;
  stderr?: string;
}
interface ScenarioFile {
  sessionId: string | null;
  turns: ScenarioTurn[];
}

function parseArgs(argv: string[]): { resume: string | null } {
  let resume: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--resume' || argv[i] === '--session') {
      resume = argv[i + 1] ?? null;
      i++;
    }
  }
  return { resume };
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const path = process.env.MOCK_CLI_SCENARIO;
  if (!path) {
    process.stderr.write('mock-cli: MOCK_CLI_SCENARIO not set\n');
    process.exit(2);
  }
  const scenario = JSON.parse(readFileSync(path, 'utf8')) as ScenarioFile;
  const { resume } = parseArgs(process.argv.slice(2));

  const turn = scenario.turns.find((t) => t.matchResume === resume);
  if (!turn) {
    process.stderr.write(`mock-cli: no matching turn for resume=${resume ?? 'null'}\n`);
    process.exit(3);
  }

  if (scenario.sessionId) {
    process.stdout.write(
      JSON.stringify({ type: 'system', session_id: scenario.sessionId }) + '\n',
    );
  }

  for (const { delay, line } of turn.lines) {
    if (delay > 0) await sleep(delay);
    process.stdout.write(line + '\n');
  }

  if (turn.stderr) process.stderr.write(turn.stderr);

  // Ensure stdout flushes before exit.
  await new Promise<void>((resolve) => {
    if (process.stdout.writableLength === 0) resolve();
    else process.stdout.once('drain', resolve);
  });

  process.exit(turn.exitCode);
}

main().catch((err) => {
  process.stderr.write(`mock-cli: ${(err as Error).message}\n`);
  process.exit(1);
});
