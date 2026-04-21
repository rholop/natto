import { Fragment, h } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import * as smd from 'streaming-markdown';
import type {
  AssistantMessage,
  Message,
  ToolCallMessage,
  UserMessage,
} from './protocol.js';

type Props = {
  messages: Message[];
};

export function App({ messages }: Props) {
  return (
    <Fragment>
      {messages.map((m) => (
        <MessageItem key={m.messageId} message={m} />
      ))}
    </Fragment>
  );
}

function MessageItem({ message }: { message: Message }) {
  switch (message.role) {
    case 'user':
      return <UserItem message={message} />;
    case 'assistant':
      return <AssistantItem message={message} />;
    case 'tool_call':
      return <ToolCallItem message={message} />;
  }
}

function UserItem({ message }: { message: UserMessage }) {
  return (
    <div class="msg msg-user" data-message-id={message.messageId}>
      <div class="msg-role">You</div>
      <div class="msg-body">{message.content}</div>
    </div>
  );
}

function AssistantItem({ message }: { message: AssistantMessage }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const parserRef = useRef<ReturnType<typeof smd.parser> | null>(null);
  const writtenRef = useRef(0);
  const endedRef = useRef(false);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const renderer = smd.default_renderer(el);
    parserRef.current = smd.parser(renderer);
    writtenRef.current = 0;
    endedRef.current = false;
    return () => {
      parserRef.current = null;
    };
  }, []);

  useEffect(() => {
    const parser = parserRef.current;
    if (!parser) return;
    const pending = message.content.slice(writtenRef.current);
    if (pending.length > 0) {
      smd.parser_write(parser, pending);
      writtenRef.current = message.content.length;
    }
    if (!endedRef.current && message.status !== 'in_progress') {
      smd.parser_end(parser);
      endedRef.current = true;
    }
  }, [message.content, message.status]);

  return (
    <div
      class={`msg msg-assistant msg-${message.status}`}
      data-message-id={message.messageId}
    >
      <div class="msg-role">Assistant</div>
      <div class="msg-body markdown" ref={bodyRef} />
    </div>
  );
}

function ToolCallItem({ message }: { message: ToolCallMessage }) {
  const args = formatArgs(message.args);
  return (
    <div
      class={`msg msg-tool msg-${message.approval}`}
      data-message-id={message.messageId}
      data-tool-call-id={message.toolCallId}
    >
      <div class="msg-role">
        <span class="tool-name">{message.name}</span>
        <span class="tool-approval">{message.approval}</span>
      </div>
      <pre class="tool-args">{args}</pre>
      {message.result && (
        <pre class="tool-result">
          {message.result.preview}
          {message.result.truncated ? '\n… (truncated)' : ''}
        </pre>
      )}
    </div>
  );
}

function formatArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
