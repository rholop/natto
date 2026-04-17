import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface ScenarioLine {
  delay: number;
  line: string;
}

export interface ScenarioTurn {
  matchResume: string | null;
  lines: ScenarioLine[];
  exitCode: number;
  stderr?: string;
}

export interface ScenarioFile {
  sessionId: string | null;
  turns: ScenarioTurn[];
}

class TurnBuilder {
  readonly lines: ScenarioLine[] = [];
  exitCode = 0;
  stderr?: string;

  constructor(
    private readonly parent: Scenario,
    readonly matchResume: string | null,
  ) {}

  text(text: string, delay = 0): this {
    this.lines.push({ delay, line: JSON.stringify({ type: 'text', text }) });
    return this;
  }

  toolCall(name: string, input: unknown, opts: { id?: string; delay?: number } = {}): this {
    const payload: Record<string, unknown> = { type: 'tool_use', name, input };
    if (opts.id) payload.id = opts.id;
    this.lines.push({ delay: opts.delay ?? 0, line: JSON.stringify(payload) });
    this.lines.push({ delay: 0, line: JSON.stringify({ type: 'result', subtype: 'tool_use', stop_reason: 'tool_use' }) });
    return this;
  }

  endTurn(stopReason = 'end_turn'): this {
    this.lines.push({ delay: 0, line: JSON.stringify({ type: 'result', subtype: 'success', stop_reason: stopReason }) });
    return this;
  }

  errorLine(message: string): this {
    this.lines.push({ delay: 0, line: JSON.stringify({ type: 'error', message }) });
    return this;
  }

  rawLine(raw: string, delay = 0): this {
    this.lines.push({ delay, line: raw });
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

  constructor(readonly initialSessionId: string | null = null) {}

  turn(matchResume: string | null): TurnBuilder {
    const t = new TurnBuilder(this, matchResume);
    this.turns.push(t);
    return t;
  }

  build(): ScenarioFile {
    return {
      sessionId: this.initialSessionId,
      turns: this.turns.map((t) => ({
        matchResume: t.matchResume,
        lines: t.lines,
        exitCode: t.exitCode,
        stderr: t.stderr,
      })),
    };
  }

  writeToFile(): string {
    const dir = mkdtempSync(join(tmpdir(), 'agui-scenario-'));
    const path = join(dir, 'scenario.json');
    writeFileSync(path, JSON.stringify(this.build(), null, 2), 'utf8');
    return path;
  }
}
