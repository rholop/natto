#!/usr/bin/env tsx
/**
 * Scriptable mock CLI. Replaces `claude` or `gemini` in tests.
 *
 * Invocation contract: argv may include `-p <prompt>`, `--resume <uuid>`,
 * `--output-format stream-json`, `--verbose`. The mock matches the invocation
 * to a turn via `--resume <uuid>` against the scenario's `matchResume` field
 * (`null` = no --resume flag).
 *
 * The scenario is loaded from MOCK_CLI_SCENARIO (path to JSON). For tool_call
 * steps, the mock POSTs to AGUI_HOOK_URL with bearer AGUI_HOOK_TOKEN, awaits
 * `{allow,reason?}`, then either emits the tool_result stream-json line (when
 * approved) or a skip text line (when denied).
 */
import { readFileSync } from 'node:fs';
import { request } from 'node:http';

type Step =
  | { kind: 'text'; delay: number; text: string }
  | { kind: 'session_id'; delay: number; uuid: string }
  | {
      kind: 'tool_call';
      delay: number;
      toolCallId: string;
      name: string;
      args: unknown;
      onApprove?: { result: string; delay?: number };
      onDeny?: { skipText?: string; delay?: number };
    }
  | { kind: 'end_turn'; delay: number; stopReason: string }
  | { kind: 'error'; delay: number; message: string }
  | { kind: 'raw'; delay: number; line: string }
  | { kind: 'stderr'; delay: number; text: string };

interface Turn {
  matchResume: string | null;
  steps: Step[];
  exitCode: number;
  stderr?: string;
}

interface ScenarioFile {
  turns: Turn[];
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

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

interface HookResponse {
  allow: boolean;
  reason?: string;
}

function postHook(
  urlStr: string,
  token: string,
  payload: { sessionId: string; toolCallId: string; name: string; args: string },
): Promise<HookResponse> {
  return new Promise((resolve) => {
    const url = new URL(urlStr);
    const body = JSON.stringify({ token, ...payload });
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: `Bearer ${token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HookResponse;
            resolve(parsed);
          } catch {
            resolve({ allow: false, reason: 'invalid_hook_response' });
          }
        });
      },
    );
    req.on('error', () => resolve({ allow: false, reason: 'hook_request_failed' }));
    req.write(body);
    req.end();
  });
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

  const hookUrl = process.env.AGUI_HOOK_URL ?? '';
  const hookToken = process.env.AGUI_HOOK_TOKEN ?? '';
  const sessionId = process.env.AGUI_SESSION_ID ?? '';

  for (const step of turn.steps) {
    if (step.delay > 0) await sleep(step.delay);
    switch (step.kind) {
      case 'session_id':
        emit({ type: 'system', session_id: step.uuid });
        break;
      case 'text':
        emit({ type: 'text', text: step.text });
        break;
      case 'end_turn':
        emit({ type: 'result', subtype: 'success', stop_reason: step.stopReason });
        break;
      case 'error':
        emit({ type: 'error', message: step.message });
        break;
      case 'raw':
        process.stdout.write(step.line + '\n');
        break;
      case 'stderr':
        process.stderr.write(step.text);
        break;
      case 'tool_call': {
        emit({
          type: 'tool_use',
          id: step.toolCallId,
          name: step.name,
          input: step.args,
        });
        if (!hookUrl || !hookToken) {
          process.stderr.write('mock-cli: tool_call but AGUI_HOOK_URL/TOKEN missing\n');
          process.exit(4);
        }
        const decision = await postHook(hookUrl, hookToken, {
          sessionId,
          toolCallId: step.toolCallId,
          name: step.name,
          args: JSON.stringify(step.args),
        });
        if (decision.allow) {
          if (step.onApprove?.delay) await sleep(step.onApprove.delay);
          const content = step.onApprove?.result ?? '';
          emit({
            type: 'tool_result',
            tool_use_id: step.toolCallId,
            content,
          });
        } else {
          if (step.onDeny?.delay) await sleep(step.onDeny.delay);
          const skip = step.onDeny?.skipText ?? `(skipped ${step.name}: ${decision.reason ?? 'denied'})`;
          emit({ type: 'text', text: skip });
        }
        break;
      }
    }
  }

  if (turn.stderr) process.stderr.write(turn.stderr);

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
