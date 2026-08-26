<div align="center">

<img src="resources/linux/code.png" width="110" alt="PSCode">

# PSCode

**A VS Code–based IDE with a local-first AI agent built in.**

Chat, inline edit and an agentic tool loop that run entirely against a model on your own
machine — no API key, no account, no code leaving the laptop.

[Why](#why-i-built-this) · [Features](#features) · [Quick start](#quick-start) ·
[Architecture](#architecture) · [What I wrote](#what-i-wrote-vs-what-came-from-vs-code) ·
[Docs](docs/ARCHITECTURE.md)

</div>

---

## What it looks like

**Chat with real workspace context** — the model found the off-by-one bug in `totalPrice`.
Note the chip at the bottom of the panel: `context (~293 tokens): src/cart.ts`, so you always
see exactly what was sent.

![PSCode AI chat answering a question about the open file](docs/images/chat.png)

**Inline edit (Ctrl+I)** — the proposal streams into a diff beside your file. The red line is
`i <= items.length`, the green one `i < items.length`. Your buffer is untouched until you press
Accept in the editor title bar.

![PSCode AI inline edit shown as a diff](docs/images/inline-edit.png)

All of it running against `qwen2.5:7b` on localhost, on a CPU, with no network access.

---

## Why I built this

Cursor and Antigravity showed that the fastest way to ship an AI-native IDE is to fork VS Code
and add the AI as a first-class citizen rather than a bolted-on plugin. Both are closed source,
and both send your code to someone else's servers.

PSCode is that same architecture, done in the open, pointed at a model running on `localhost`.
I built it to answer a specific question end to end: **what does it actually take to put an AI
agent inside an editor?** Not the prompt — the plumbing. Streaming a token to a UI without
janking it. Reassembling tool-call fragments that arrive four bytes at a time. Refusing to let
a model write to `../../.ssh/id_rsa`. Showing a diff the user can reject.

> **On the fork:** PSCode is a fork of [microsoft/vscode](https://github.com/microsoft/vscode)
> (MIT). The editor, terminal and extension host are Microsoft's work, not mine. Everything AI
> in this repo — `extensions/pscode-ai/`, 3,695 lines across 17 TypeScript modules — is mine, and
> it is deliberately confined to one directory so the boundary is obvious. See
> [What I wrote](#what-i-wrote-vs-what-came-from-vs-code).

---

## Features

### Chat with real workspace context
A side-bar panel that streams from your local model and knows what you are looking at. It sends
your selection, the active file, language-server errors for that file, and the names of your other
open tabs. Type `@filename` to pull any other file in. Every context block sent is shown as a chip
under the composer with an approximate token count, so nothing is attached behind your back.

Every fenced code block in a reply gets **Apply** and **Copy** buttons. Apply replaces your
selection, or inserts at the cursor if nothing is selected.

### Inline edit — <kbd>Ctrl</kbd>+<kbd>I</kbd>
Select code, describe the change, and watch the model rewrite it **into a live diff view** beside
your file. Nothing touches your buffer until you press Accept. If the file changed while the model
was thinking, PSCode notices the version mismatch and refuses to apply a stale edit rather than
silently corrupting your work.

With nothing selected, <kbd>Ctrl</kbd>+<kbd>I</kbd> operates on the current line.

### Agent mode
Switch the panel to **Agent** and the model gets seven tools:

| Tool | What it does | Guard |
|---|---|---|
| `read_file` | Read a file, optionally a line range | path confined to workspace |
| `list_dir` | List a directory | path confined to workspace |
| `search_text` | Find a literal string across the workspace | skips `node_modules`, `.git`, build output |
| `get_diagnostics` | Read compiler/linter errors | — |
| `replace_in_file` | Replace an exact snippet | must match exactly once; diff shown first |
| `write_file` | Create or overwrite a file | modal approval, optional diff preview |
| `run_command` | Run a shell command, return output | modal approval showing the exact command |

The loop is bounded by `pscode.agent.maxIterations` (default 12). When it hits that ceiling it
**says so in the transcript** instead of stopping quietly — a silent stop is indistinguishable
from a finished task, which is how agents end up appearing to lie about their work.

### Bring your own model
| Provider | Use it for | Key needed |
|---|---|---|
| **`ollama`** (default) | Fully local, fully offline | no |
| `openai-compatible` | llama.cpp, LM Studio, vLLM, OpenRouter, OpenAI | depends |
| `anthropic` | Claude, when a 7B model isn't enough | yes |

All three implement one 6-method interface (`LLMProvider`). Chat, inline edit and the agent are
written against that interface only and contain no provider-specific code.

### Extensions still work
PSCode points at [Open VSX](https://open-vsx.org) rather than Microsoft's marketplace, whose terms
restrict it to official VS Code builds. Themes, language packs and most tooling install normally.

---

## Quick start

### 1. Get a model running

```bash
# Ollama — the default, and the simplest
curl -fsSL https://ollama.com/install.sh | sh
ollama serve &
ollama pull qwen2.5:7b        # tool-capable, ~4.7 GB, runs on CPU
```

Any tool-capable model works. `qwen2.5:7b` and `llama3.2` are both good starting points;
Agent mode needs tool calling, so a model without it will only work in Chat mode.

### 2. Build PSCode

```bash
# Linux build prerequisites
sudo apt-get install -y build-essential pkg-config python3 \
    libx11-dev libxkbfile-dev libkrb5-dev

nvm install && nvm use        # honours .nvmrc (Node 24.18.0)
npm install                   # ~10 min
npm run compile               # ~15-30 min the first time
./scripts/code.sh             # launch
```

> Only `native-keymap` (x11 + xkbfile) and `kerberos` (libkrb5) need dev headers — there is no
> `keytar`, so `libsecret` is not required. If you cannot use `sudo`, `apt-get download` works
> unprivileged: fetch those `-dev` packages, `dpkg -x` them into a prefix, repoint the `.pc` files
> at it, and export `PKG_CONFIG_PATH` / `CPATH` / `LIBRARY_PATH`. That is how this build was made.

For a distributable `.deb`:

```bash
npm run gulp vscode-linux-x64-min
npm run gulp vscode-linux-x64-prepare-deb
npm run gulp vscode-linux-x64-build-deb
```

### 3. Use it

| Shortcut | Action |
|---|---|
| <kbd>Ctrl</kbd>+<kbd>L</kbd> | Open the AI chat panel |
| <kbd>Ctrl</kbd>+<kbd>I</kbd> | Edit the selection (or current line) inline |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>L</kbd> | Add the selection to the chat composer |

The status bar shows the live model and turns red when the server is unreachable — click it to
switch models from whatever the server reports it has.

---

## Configuration

All settings live under `pscode.` in Settings (<kbd>Ctrl</kbd>+<kbd>,</kbd>).

| Setting | Default | Notes |
|---|---|---|
| `pscode.ai.provider` | `ollama` | `ollama` \| `openai-compatible` \| `anthropic` |
| `pscode.ai.endpoint` | `http://127.0.0.1:11434` | Base URL, no trailing path |
| `pscode.ai.model` | `qwen2.5:7b` | Must already be pulled |
| `pscode.ai.apiKey` | `""` | `PSCODE_API_KEY` env var wins over this |
| `pscode.ai.temperature` | `0.2` | Low, because these are code edits |
| `pscode.ai.maxTokens` | `4096` | Per response |
| `pscode.ai.requestTimeoutMs` | `300000` | Generous: CPU inference is slow to first token |
| `pscode.ai.contextBudgetChars` | `24000` | Lower it for small-context models |
| `pscode.agent.enabled` | `true` | Turns Agent mode off entirely |
| `pscode.agent.maxIterations` | `12` | Tool rounds before the loop stops |
| `pscode.agent.approveShellCommands` | `true` | **Leave this on** unless you know why you're turning it off |
| `pscode.agent.approveFileWrites` | `true` | **Leave this on** likewise |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Webview  (sandboxed: no Node, no fs, no network)            │
│  media/chat.js · chat.css   — renders markdown, posts intents │
└───────────────────────────┬──────────────────────────────────┘
                            │  postMessage  (the privilege boundary)
┌───────────────────────────▼──────────────────────────────────┐
│  Extension host                                              │
│                                                              │
│  chat/chatViewProvider.ts   owns conversation, brokers all    │
│                             privileged work                   │
│  inline/inlineEdit.ts       Ctrl+I → streamed diff → accept   │
│  inline/proposalDocuments   virtual read-only diff documents  │
│  agent/agentLoop.ts         stream → run tools → repeat       │
│  agent/tools.ts             7 tools + the security boundary   │
│  context/contextBuilder.ts  what the model is allowed to see  │
│                                                              │
│  providers/  ── LLMProvider ────────────────────────────────┐ │
│    ollama.ts          NDJSON, native /api/chat             │ │
│    openaiCompat.ts    SSE, reassembles tool-call fragments  │ │
│    anthropic.ts       SSE, tool_use blocks                  │ │
│    http.ts            Node http/https, zero npm deps        │ │
└──────────────────────────┬───────────────────────────────────┘
                           │  HTTP
                    ┌──────▼──────┐
                    │  localhost  │   Ollama · llama.cpp · LM Studio
                    └─────────────┘
```

Three decisions shape everything else:

1. **The webview has no privileges.** It renders and posts intents. It cannot read a file, run a
   command or open a socket. A strict CSP with a per-render nonce blocks inline script and every
   remote origin. Prompt-injected markdown in a model reply therefore cannot do anything but
   render as text.

2. **The provider interface is the only seam the features know about.** `providers/*.ts` import
   nothing from `vscode`, which is why they can be — and are — tested in plain Node against a
   real model server.

3. **AI output is a proposal, never a write.** Inline edits and agent edits are published to a
   virtual `pscode-proposal:` document and shown in VS Code's own diff editor. The user approves
   the exact text that gets applied.

Full detail: **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## Testing

The provider layer is exercised against a **live local model**, not a mock — the bugs that matter
here (a stream that never terminates, tool arguments in the wrong shape, an unhelpful error on a
dead port) are precisely the ones a mocked socket cannot reproduce.

```bash
ollama serve &
ollama pull llama3.2
node extensions/pscode-ai/test/provider-smoke.js
```

```
PASS  listModels returns models — llama3.2:latest, qwen2.5:7b
PASS  stream emits text events
PASS  stream emits exactly one done
PASS  stream reports usage
PASS  model produced text — "Ready"
PASS  tool call is parsed — read_file({"path":"src/main.ts"})
PASS  tool args normalise to JSON text — path=src/main.ts
PASS  tool call has an id
PASS  dead endpoint throws ProviderError
PASS  error carries an actionable hint
PASS  missing model throws ProviderError

ALL CHECKS PASSED
```

---

## What I wrote vs what came from VS Code

Being precise about this matters more than the line count.

**Mine — `extensions/pscode-ai/`, 3,695 lines, 17 TypeScript modules:**

| Area | Files |
|---|---|
| Provider layer | `providers/{types,http,ollama,openaiCompat,anthropic,registry}.ts` |
| Agent | `agent/{agentLoop,tools,prompts}.ts` |
| Chat | `chat/chatViewProvider.ts`, `media/chat.{js,css}` |
| Inline edit | `inline/{inlineEdit,proposalDocuments}.ts` |
| Context | `context/contextBuilder.ts` |
| Shell | `extension.ts`, `statusBar.ts`, `util/{logger,cancellation}.ts` |
| Test | `test/provider-smoke.js` |

**Upstream files I modified — 8, all of them branding or registration:**

| File | Change |
|---|---|
| `product.json` | Identity, fresh install GUIDs, Open VSX gallery |
| `package.json` | Name, version, author, repository |
| `build/gulpfile.extensions.ts` | Register `pscode-ai` for compilation |
| `build/npm/dirs.ts` | Register `pscode-ai` for dependency install |
| `resources/linux/code.png`, `resources/win32/code.ico` | New app icon |
| `resources/linux/*.desktop` | Tagline and keywords |

**Everything else is Microsoft's.** The editor is Monaco, the terminal is xterm.js + node-pty,
the extension host and IPC are VS Code's. I did not write those and do not claim to.

---

## Known limitations

Stated plainly, because pretending otherwise wastes your time:

- **CPU inference is slow.** On a 12-core CPU with no GPU, a 7B Q4 model produces roughly
  8–20 tokens/sec. Chat and inline edit feel fine. Long agent runs require patience.
- **No tab autocomplete.** Ghost-text completion needs sub-200 ms round trips, which CPU-only
  inference cannot deliver. Shipping a laggy version would be worse than not shipping it.
- **Agent mode is only as good as the model.** 7B models lose track of multi-step plans and
  sometimes emit malformed tool JSON. PSCode handles that (it tells the model to retry rather
  than crashing) but cannot fix it.
- **No conversation persistence.** Chats live in memory and die with the window.
- **Linux is the only tested target.** The build config is cross-platform; I have only run it here.
- **Only the Linux `.deb` path is exercised.** No signed macOS/Windows installers.
- **The built-in Copilot chat panel is still present.** I first removed `defaultChatAgent` from
  `product.json` so the fork would ship no Copilot surface at all. That broke workbench startup:
  `welcomeOnboarding` hard-asserts the key at module scope, and
  `services/accounts/browser/defaultAccount.ts` takes it as a non-optional `IDefaultChatAgent` and
  walks `provider.default.id`. About 51 files read the config. I restored it rather than patch that
  many call sites for a cosmetic win — the merge cost against upstream would have outweighed an
  unused panel. PSCode AI lives in its own side-bar view and is independent of it.

---

## Roadmap

- [ ] Persist conversations across restarts
- [ ] Tab autocomplete with a small FIM model, behind a GPU check
- [ ] Multi-file diff review before applying a whole agent changeset
- [ ] `@symbol` context via the language server, not just `@file`
- [ ] Prompt-token caching to cut the re-send cost of long chats

---

## Licence and attribution

PSCode is MIT, as is the upstream VS Code source it is built from. See [LICENSE.txt](LICENSE.txt).

This is **not** a Microsoft product and is not affiliated with or endorsed by Microsoft.
"Visual Studio Code" and its logo are Microsoft trademarks; PSCode uses neither — it ships its
own name and icon, which is exactly why the rebrand in `product.json` is thorough rather than
cosmetic. For the same reason PSCode uses Open VSX instead of the Visual Studio Marketplace,
whose terms of use permit access only from official VS Code builds.

Built by **Pankaj Sharma** — [github.com/pankajsharma21](https://github.com/pankajsharma21)
