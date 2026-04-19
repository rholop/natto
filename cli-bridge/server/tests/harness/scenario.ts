import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type ScenarioStep =
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

export interface ScenarioTurn {
  matchResume: string | null;
  steps: ScenarioStep[];
  exitCode: number;
  stderr?: string;
}

export interface ScenarioFile {
  turns: ScenarioTurn[];
}

class TurnBuilder {
  readonly steps: ScenarioStep[] = [];
  exitCode = 0;
  stderr?: string;

  constructor(
    private readonly parent: Scenario,
    readonly matchResume: string | null,
  ) {}

  sessionId(uuid: string, delay = 0): this {
    this.steps.push({ kind: 'session_id', delay, uuid });
    return this;
  }

  assistantText(text: string, delay = 0): this {
    this.steps.push({ kind: 'text', delay, text });
    return this;
  }

  toolCall(
    name: string,
    args: unknown,
    opts: {
      toolCallId?: string;
      delay?: number;
      onApprove?: { result: string; delay?: number };
      onDeny?: { skipText?: string; delay?: number };
    } = {},
  ): this {
    this.steps.push({
      kind: 'tool_call',
      delay: opts.delay ?? 0,
      toolCallId: opts.toolCallId ?? `tc-${this.steps.length}`,
      name,
      args,
      onApprove: opts.onApprove,
      onDeny: opts.onDeny,
    });
    return this;
  }

  endTurn(stopReason = 'end_turn', delay = 0): this {
    this.steps.push({ kind: 'end_turn', delay, stopReason });
    return this;
  }

  errorLine(message: string, delay = 0): this {
    this.steps.push({ kind: 'error', delay, message });
    return this;
  }

  rawLine(line: string, delay = 0): this {
    this.steps.push({ kind: 'raw', delay, line });
    return this;
  }

  stderrText(text: string, delay = 0): this {
    this.steps.push({ kind: 'stderr', delay, text });
    return this;
  }

  exit(code: number, stderr?: string): this {
    this.exitCode = code;
    this.stderr = stderr;
    return this;
  }

  turn(matchResume: string | null): TurnBuilder {
    return this.parent.turn(matchResume);
  }

  build(): ScenarioFile {
    return this.parent.build();
  }

  writeToFile(): string {
    return this.parent.writeToFile();
  }
}

export class Scenario {
  private readonly turns: TurnBuilder[] = [];

  turn(matchResume: string | null): TurnBuilder {
    const t = new TurnBuilder(this, matchResume);
    this.turns.push(t);
    return t;
  }

  build(): ScenarioFile {
    return {
      turns: this.turns.map((t) => ({
        matchResume: t.matchResume,
        steps: t.steps,
        exitCode: t.exitCode,
        stderr: t.stderr,
      })),
    };
  }

  writeToFile(prefix = 'agui-scenario-'): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    const path = join(dir, 'scenario.json');
    writeFileSync(path, JSON.stringify(this.build(), null, 2), 'utf8');
    return path;
  }
}
