export const styles = /* css */ `
:host {
  display: block;
  font-family: var(--natto-font-sans, system-ui, sans-serif);
  color: var(--natto-color-text, #1a1a18);
  line-height: 1.5;
}
.natto-root {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.msg {
  padding: 0.6rem 0.8rem;
  border-radius: 8px;
  background: var(--natto-color-bg, #f5f5f4);
  border: 1px solid var(--natto-color-border, rgba(0, 0, 0, 0.08));
}
.msg-role {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--natto-color-muted, #5f5e5a);
  margin-bottom: 0.35rem;
  display: flex;
  gap: 0.5rem;
  align-items: baseline;
}
.msg-body {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.markdown :first-child { margin-top: 0; }
.markdown :last-child { margin-bottom: 0; }
.markdown pre {
  background: var(--natto-color-code-bg, rgba(0, 0, 0, 0.06));
  padding: 0.6rem;
  border-radius: 6px;
  overflow-x: auto;
  font-family: var(--natto-font-mono, ui-monospace, monospace);
  font-size: 0.85em;
}
.markdown code {
  background: var(--natto-color-code-bg, rgba(0, 0, 0, 0.06));
  padding: 0.05em 0.3em;
  border-radius: 3px;
  font-family: var(--natto-font-mono, ui-monospace, monospace);
  font-size: 0.9em;
}
.markdown pre code { background: transparent; padding: 0; }
.msg-user { background: var(--natto-color-user-bg, #e8f0ff); }
.msg-assistant { }
.msg-tool {
  background: var(--natto-color-tool-bg, #fff7e0);
  font-family: var(--natto-font-mono, ui-monospace, monospace);
  font-size: 0.85rem;
}
.tool-name { font-weight: 700; text-transform: none; letter-spacing: 0; }
.tool-approval {
  padding: 0 0.4em;
  border-radius: 999px;
  font-size: 0.7rem;
  background: rgba(0, 0, 0, 0.08);
}
.msg-approved .tool-approval { background: #d0f0d8; }
.msg-denied .tool-approval { background: #f4cccc; }
.tool-args, .tool-result {
  margin: 0.3rem 0 0;
  padding: 0.4rem 0.6rem;
  background: rgba(0, 0, 0, 0.05);
  border-radius: 4px;
  white-space: pre-wrap;
  overflow-x: auto;
}
.msg-interrupted { opacity: 0.7; }
`;
