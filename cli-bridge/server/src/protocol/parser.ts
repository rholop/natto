export type CliEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call'; name: string; args: string; id?: string }
  | { type: 'session_id'; uuid: string }
  | { type: 'end_turn'; stopReason: string }
  | { type: 'error'; message: string };

export type CliEventMapper = (parsed: unknown) => CliEvent | null;

/**
 * Line-buffered JSONL parser. Stdout arrives in arbitrary chunks that may split
 * a line in the middle; feed() buffers partial lines and only emits whole ones.
 */
export class JsonlLineBuffer {
  private buffer = '';

  feed(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const trimmed = line.trim();
      if (trimmed.length > 0) lines.push(trimmed);
    }
    return lines;
  }

  flush(): string[] {
    const remaining = this.buffer.trim();
    this.buffer = '';
    return remaining.length > 0 ? [remaining] : [];
  }
}

export function parseJsonlLine(raw: string, mapper: CliEventMapper): CliEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return mapper(parsed);
}
