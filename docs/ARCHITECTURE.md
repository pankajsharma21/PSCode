# PSCode architecture

How the AI layer inside PSCode is put together, and why each piece is shaped the way it is.
This document covers `extensions/pscode-ai/` only — the editor, terminal and extension host are
upstream VS Code and unchanged.

---

## 1. Where the code runs

VS Code splits a window across processes, and getting AI features right means knowing which of
them you are in.

| Process | What runs there | What PSCode puts there |
|---|---|---|
| **Renderer** | The workbench UI (Electron renderer) | nothing of mine directly |
| **Webview** | An isolated iframe, no Node, its own origin | `media/chat.js`, `media/chat.css` |

The chat view is contributed to `viewsContainers.secondarySidebar`, which maps to
`ViewContainerLocation.AuxiliaryBar` — the right-hand bar. That is deliberate: it is the slot a
cloud assistant normally occupies, and PSCode ships a local one there instead. The bundled
Copilot extension is deleted, and `product.json`'s `disableCloudChat` flag makes
`chatEntitlementService` set `ChatContextKeys.Setup.hidden`, which collapses the core chat view,
the editor watermark hints, the help-menu entries and the onboarding walkthroughs in one move.

| **Extension host** | Node.js, full `vscode` API, filesystem, sockets | all 27 modules in `src/` |
| **Model server** | Separate OS process on a port picked at startup | llama.cpp's `llama-server`, shipped inside PSCode and owned by it |

The webview and the extension host communicate **only** by `postMessage`. That boundary is the
security model, not a convenience:

- The webview cannot read a file, spawn a process or open a socket. It posts an intent such as
  `{ type: 'apply', code }` and the extension host decides whether to honour it.
- The webview's HTML carries a strict CSP built per render, with a fresh nonce:

  ```
  default-src 'none';
  img-src <cspSource> data:;
  style-src <cspSource>;
  font-src <cspSource>;
  script-src 'nonce-<32 random chars>'
  ```

  `default-src 'none'` means no network of any kind, and `script-src` with a nonce means an
  injected `<script>` tag cannot execute. This matters specifically because the webview renders
  **model output**: a reply containing `<img src=x onerror=...>` is escaped to text, and even if
  escaping had a hole, the CSP gives the payload nowhere to go.

`localResourceRoots` is restricted to `media/`, so the webview cannot load anything from the
user's workspace either.

---

## 2. The provider abstraction

`src/providers/types.ts` defines the whole contract:

```ts
interface LLMProvider {
  readonly id: string;
  readonly label: string;
  readonly supportsTools: boolean;
  listModels(signal: AbortSignal): Promise<string[]>;
  stream(request: CompletionRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
}
```

Two properties of this design carry most of the value:

**Providers emit events, not responses.** `stream()` returns an `AsyncIterable<StreamEvent>`:

```ts
type StreamEvent =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; call: ToolCall }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number }
  | { type: 'done'; reason: 'stop' | 'length' | 'toolCalls' | 'cancelled' };
```

An async iterable, rather than a callback or an `EventEmitter`, means consumers use a plain
`for await` loop and get backpressure and cancellation for free. On CPU inference, where a full
reply can take 30 seconds, rendering the first token immediately is the difference between
"working" and "hung".

**Providers never import `vscode`.** That single rule is why `providers/*.ts` can be compiled and
run in plain Node — which is exactly what `test/provider-smoke.js` does against a real model.
Anything that needs the editor lives above the provider layer.

### The three wire formats

| Provider | Transport | Tool calls arrive as |
|---|---|---|
| `bundled.ts` | awaits the engine PSCode started, then delegates to `openaiCompat` | the endpoint is discovered, not configured |
| `ollama.ts` | newline-delimited JSON on `/api/chat` | a complete object per chunk, `arguments` already decoded |
| `openaiCompat.ts` | SSE on `/v1/chat/completions` | **fragments**, keyed only by array index |
| `anthropic.ts` | SSE on `/v1/messages` | `tool_use` blocks, input as incremental JSON text |

`http.ts` absorbs the shared work: both formats are line-delimited, so it yields complete lines
and each provider only interprets lines instead of managing sockets and partial chunks.

The fragment reassembly in `openaiCompat.ts` is the subtlest part of the codebase. A single tool
call can arrive as:

```
{"index":0,"id":"call_abc","function":{"name":"read_","arguments":""}}
{"index":0,"function":{"name":"file","arguments":"{\"pa"}}
{"index":0,"function":{"arguments":"th\":\"src/a.ts\"}"}}
```

Name and arguments are both split mid-token, and only `index` ties the pieces together. They are
accumulated into a `Map<number, …>` and emitted once the stream ends — never mid-flight, because
partial JSON is not executable.

### Normalising tool arguments

Ollama hands back `arguments` as a decoded object; OpenAI and Anthropic hand back JSON text.
Rather than making every caller handle both, `ToolCall.args` is defined as **raw JSON text** and
each provider normalises to it. `agentLoop.ts` parses exactly once, in one place.

### Errors that say what to do

`http.ts` translates socket-level failures into messages with a next action, because
`ECONNREFUSED 127.0.0.1:11434` explains nothing to someone setting up a local model for the
first time:

| Condition | Message | Hint |
|---|---|---|
| `ECONNREFUSED` | Could not connect to the model server at … | Only reachable for a provider you run yourself; the bundled engine is started by PSCode |
| HTTP 404 | … returned 404: model 'x' not found | Either the model is not pulled, or the endpoint path is wrong |
| HTTP 401/403 | The server rejected the request | Check the key; local servers usually need none |
| `ETIMEDOUT` | The server did not respond in time | CPU inference is slow to first token; raise the timeout |

Error bodies are read and parsed before being surfaced, since model servers put the useful part
(`model 'x' not found`) in the body and not the status line. URLs are stripped to origin first,
so credentials in an endpoint never reach a log.

---

## 3. Context building

`src/context/contextBuilder.ts` decides what the model sees. With a 32k-context 7B model, this
is a budgeting problem, so context is assembled in **priority order** and each section spends
from one shared character budget:

1. **Workspace shape** — folder names. Cheap, orients the model.
2. **Selection** — the strongest signal of intent, so it is funded before anything else.
3. **`@file` mentions** — the user named these on purpose, so they outrank inference.
4. **Active file** — skipped if it already arrived as a mention.
5. **Diagnostics** — language-server errors for the active file. Small, and the single
   highest-value context for "fix this".
6. **Other open tabs** — names only. Tells the model what exists for near-zero cost.

Truncation is explicit: a clipped file gets a
`/* ...truncated by PSCode: file exceeds the context budget... */` marker, so the model knows it
is looking at a fragment instead of assuming the file simply ends there.

`@mention` resolution tries the literal path first, then falls back to a filename search, so
`@extension.ts` works without typing the full path.

The context block is attached to **the user's turn**, not the system prompt. Older turns keep the
context they were asked with, which stops a follow-up question from silently reinterpreting an
earlier answer against different files.

---

## 4. The agent loop

`src/agent/agentLoop.ts` is intentionally about 80 lines of actual logic:

```
for iteration in 1..maxIterations:
    stream a turn, collecting text and tool calls
    push the assistant message
    if no tool calls: done
    for each tool call:
        execute it
        push a tool-result message
```

Design choices worth defending:

**Bounded.** `pscode.agent.maxIterations` (default 12) caps the loop. An unbounded agent against
a user's filesystem is not a feature.

**Exhaustion is reported, not swallowed.** Hitting the ceiling appends a visible message to the
transcript. A loop that stops silently looks exactly like a loop that finished, which is the
mechanism behind most "the agent lied about its work" complaints.

**Malformed tool JSON is a message, not an exception.** Small models truncate JSON arguments
regularly. The loop replies *"your arguments were not valid JSON, send them again"* and lets the
model recover — a thrown exception would end the run instead.

**A missing tool name lists the real ones.** When a model hallucinates `edit_file`, the result
enumerates the seven tools that exist, which recovers the turn instead of wasting it.

**Repetition is blocked in code, not just in the prompt.** Small models loop: they re-issue an
identical tool call, or keep "improving" a file they already edited. Observed directly — one task
produced three successive edits to the same file, the third of which corrupted a function
signature. So the loop fingerprints every call as `name:args` and refuses an exact repeat, and caps
mutating calls at two per file per task. Both refusals come back as tool *results*, not exceptions,
because a message the model reads is the only thing that actually breaks the loop.

**Cancellation is checked between every step** — before each iteration, during each stream, and
before each tool call, so Stop actually stops rather than finishing the current tool first.

### Working across a project, not a file

Chat context is deliberately narrow: the active file, the selection, its diagnostics, plus the
*names* of other open tabs. Agent mode is where project scope comes from, through three tools that
go via the language server rather than text matching:

| Tool | Backed by |
|---|---|
| `find_symbol` | `vscode.executeWorkspaceSymbolProvider` |
| `find_usages` | `executeWorkspaceSymbolProvider` to locate the definition, then `executeReferenceProvider` |
| `project_map` | `workspace.findFiles`, grouped by directory, capped at 40 entries per directory |

Choosing the language server over an embedding index was deliberate. An index has to be built,
stored and invalidated on every edit, and vector similarity only ever *guesses* that two pieces of
code are related. The language server already exists in the editor and actually knows what a symbol
resolves to, so `find_usages` returns the real reference set — the thing you need before changing
anything shared. The honest cost is that it cannot answer a conceptual question like "where do we
handle discounts?" unless you name the symbol; `search_text` (with optional regex) is the fallback,
and a real embedding index is the thing that would close that gap.

### Tool security

`src/agent/tools.ts` holds the security boundary, and `resolveInWorkspace()` is the whole of it:

```ts
const rel = path.relative(path.resolve(parent), path.resolve(child));
return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
```

Every path from the model — relative or absolute — is resolved and then verified to sit inside an
open workspace folder. `../../.ssh/id_rsa` is refused. The check is done after `path.resolve()`,
so `a/../../b` and symlink-shaped inputs collapse before the comparison rather than after it.

On top of that:

- `write_file` and `replace_in_file` open a side-by-side diff and then wait on an
  **Accept / Reject card rendered in the chat panel**. This replaced a modal dialog for two
  reasons: a modal steals focus, and a modal is confirmed by Enter, so a stray keypress can
  approve a file write. The card resolves only when the webview echoes back the matching
  request id (`ApprovalRegistry` in `agent/approvals.ts`), which a keystroke cannot forge.
  Outstanding approvals are declined — never left pending — when the turn ends, the user
  presses Stop, or the panel is disposed, because an unresolved promise would hang the loop.
- `run_command` shows the exact command and working directory in the same card, and the model
  is asked to supply a one-line reason that is displayed with it.
- `replace_in_file` refuses a `find` string that matches zero or more than one time, so an
  ambiguous edit becomes a retry rather than a wrong edit in the wrong place.
- Tool output is clipped to 20 000 characters with a visible marker, so one `cat` of a huge file
  cannot blow the context window.
- Declining an action returns *"the user declined; do not retry"* to the model, which stops the
  approval-prompt loop that otherwise happens.

---

## 5. Never writing without consent

Both inline edit and agent edits go through `src/inline/proposalDocuments.ts`, a
`TextDocumentContentProvider` registered for the `pscode-proposal:` scheme.

```
model output ──► setProposal(uri, text) ──► onDidChange fires
                                              │
                                              ▼
                                    VS Code re-reads the virtual doc
                                              │
                                              ▼
                                    the open diff editor repaints
```

Firing the change event on every streamed delta is what makes the diff animate live. Because the
document is virtual and read-only, the user's file is untouched until they accept.

Accepting re-checks `document.version` against the version captured when the edit started. If the
file moved underneath — another edit, a format-on-save, a git checkout — the proposal is discarded
with an explanation instead of being applied to text that no longer exists.

The proposal is rendered as **the whole file with the range substituted**, not just the changed
snippet, so the diff shows the change in context rather than as a wholesale replacement.

---

## 6. Streaming into the UI without jank

Deltas arrive faster than a browser paints. `media/chat.js` therefore does not re-render per
delta; it accumulates raw markdown and coalesces renders to one per frame:

```js
function queueRender() {
    if (renderQueued || !streamTarget) return;
    renderQueued = true;
    requestAnimationFrame(() => {
        renderQueued = false;
        const stick = atBottom();
        streamTarget.innerHTML = renderMarkdown(streamRaw);
        if (stick) transcript.scrollTop = transcript.scrollHeight;
    });
}
```

`atBottom()` is sampled *before* the re-render: autoscroll only continues if the user was already
at the bottom, so scrolling up to read does not get yanked back down by the next token.

The markdown renderer is hand-written (~90 lines) rather than a dependency, for two reasons: a
built-in extension shipping inside the product should not pull an npm supply chain in for this,
and streaming needs one specific behaviour off-the-shelf renderers do not have — the fence regex
matches an **unterminated** final fence, so a code block renders as a code block while it is
still arriving instead of flickering from prose into code at the closing backticks.

Escaping order is load-bearing: HTML is escaped **first**, then inline formatting is applied to
the already-escaped text. Formatting can therefore never introduce markup.

Every colour in `chat.css` is a VS Code theme variable (`--vscode-*`). That is what makes the
panel correct in light, dark and high-contrast themes with no media queries and no theme
detection code.

---

## 7. Prompting for small models

`src/agent/prompts.ts` reads as blunt and rule-shaped, which is deliberate. A frontier model
infers conventions from a short prompt; a 7B model needs them spelled out and breaks its output
format when they are not.

The inline-edit prompt is the clearest case. Its output is spliced directly into a file, so it
states absolutes: output only the replacement code, no prose, no fences, preserve indentation,
and if the instruction cannot be applied, return the snippet unchanged.

Models still occasionally wrap output in a fence despite being told not to, so
`inlineEdit.ts` defends anyway:

```ts
const fenced = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed);
return fenced ? fenced[1] : trimmed;
```

Prompt discipline reduces bad output; it does not eliminate it. Both layers are needed.

---

## 8. Build integration

VS Code discovers built-in extensions from two hardcoded lists, so PSCode registers in both:

| File | Line added | Purpose |
|---|---|---|
| `build/gulpfile.extensions.ts` | `'extensions/pscode-ai/tsconfig.json'` | compile with `compile-extension:pscode-ai` |
| `build/npm/dirs.ts` | `'extensions/pscode-ai'` | include in the dependency install pass |

`extensions/pscode-ai/tsconfig.json` extends `extensions/tsconfig.base.json`, so the extension is
held to VS Code's own compiler settings — `strict`, `noUnusedLocals`, `noUnusedParameters`,
`noImplicitReturns`, `noImplicitOverride`. It compiles clean under all of them.

The extension has **zero runtime npm dependencies**. Everything it needs is Node's standard
library plus the `vscode` API.

---

## 9. Deliberate omissions

| Not built | Why |
|---|---|
| Tab autocomplete | Needs sub-200 ms round trips; CPU-only inference cannot deliver that, and a laggy version is worse than none |
| Embeddings / RAG over the repo | Needs an embedding model and an index to maintain; `search_text` plus `@file` covers most real questions at a fraction of the complexity |
| Conversation persistence | Straightforward, just not built yet |
| Multi-file diff review | Agent changesets are approved file by file today; one combined review would be better |
| Provider-side prompt caching | The largest available win for long chats, and the next thing worth doing |
