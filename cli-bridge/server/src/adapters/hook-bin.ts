#!/usr/bin/env node
import { request } from 'node:http';
import { readFileSync } from 'node:fs';

interface HookInput {
  tool_use_id?: string;
  tool_name?: string;
  input?: unknown;
}

interface HookResponse {
  allow: boolean;
  reason?: string;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c: Buffer) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    if (process.stdin.isTTY) resolve('');
  });
}

async function main(): Promise<void> {
  const url = process.env.AGUI_HOOK_URL;
  const token = process.env.AGUI_HOOK_TOKEN;
  const sessionId = process.env.AGUI_SESSION_ID;
  if (!url || !token || !sessionId) {
    process.stderr.write('hook-bin: missing AGUI_HOOK_URL/TOKEN/SESSION_ID env\n');
    respondDeny('hook_not_configured');
    return;
  }

  let body: HookInput = {};
  const fromFile = process.env.AGUI_HOOK_INPUT_FILE;
  if (fromFile) {
    try {
      body = JSON.parse(readFileSync(fromFile, 'utf8')) as HookInput;
    } catch {
      // leave empty
    }
  } else {
    const raw = await readStdin();
    if (raw.trim()) {
      try {
        body = JSON.parse(raw) as HookInput;
      } catch {
        // leave empty
      }
    }
  }

  const toolCallId = body.tool_use_id ?? '';
  const name = body.tool_name ?? '';
  const args = body.input === undefined ? '' : JSON.stringify(body.input);

  const response = await postHook(url, {
    token,
    sessionId,
    toolCallId,
    name,
    args,
  });
  process.stdout.write(JSON.stringify(response));
  process.exit(response.allow ? 0 : 1);
}

function respondDeny(reason: string): void {
  process.stdout.write(JSON.stringify({ allow: false, reason }));
  process.exit(1);
}

function postHook(
  urlStr: string,
  payload: { token: string; sessionId: string; toolCallId: string; name: string; args: string },
): Promise<HookResponse> {
  return new Promise((resolve) => {
    const url = new URL(urlStr);
    const body = JSON.stringify(payload);
    const req = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          authorization: `Bearer ${payload.token}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            const parsed = JSON.parse(text) as HookResponse;
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

main().catch(() => respondDeny('hook_bin_crashed'));
