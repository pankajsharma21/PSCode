# PSCode — interview guide

Preparation notes for presenting this project. Everything here is answerable from the code in
this repo; nothing is invented to sound better than it is.

The single most important rule: **be precise about what you wrote.** A fork of VS Code is
impressive when you own the boundary and unimpressive the moment you blur it. Owning it early
turns your biggest vulnerability into a credibility win.

---

## 1. The 30-second pitch

> "PSCode is a fork of VS Code with an AI agent built into the product rather than installed as a
> plugin — the same architecture Cursor and Antigravity use. The difference is that it runs
> entirely against a model on localhost, so no code leaves the machine.
>
> The editor is Microsoft's. What I built is the AI layer: about 3,700 lines in one extension —
> a provider abstraction over three model backends, a bounded agent loop with seven sandboxed
> tools, and a diff-based edit flow where nothing is written until you accept it."

Then stop talking. You have named the fork, the boundary, and the interesting part, and you have
left them three threads to pull.

---

## 2. The five-minute demo

Run through this end to end at least twice before the interview. **Have PSCode already built** —
never build on camera. There is no model server to remember to start: PSCode brings up its own
engine when the window opens.

**Pre-flight (do this 10 minutes before):**

```bash
./scripts/code.sh <a small demo repo>
```

Confirm the status bar shows `✨ qwen2.5-14b-instruct-q4_k_m` and is **not** red — it goes green a
few seconds after the window opens, once the weights are loaded. Open a file with a real bug in
it.

**The demo, in order — each step shows something the previous one did not:**

1. **Status bar** — "This shows the live model. It goes red if the server dies, because with a
   local model, silence is the failure mode." *(30s)*

2. **Chat with context** — <kbd>Ctrl</kbd>+<kbd>L</kbd>, ask *"what does this file do?"* Point at
   the context chips under the composer: "It sent the active file and the language-server errors,
   about 1,800 tokens. It shows you what it sent — nothing goes behind your back." *(60s)*

3. **Inline edit** — select a function, <kbd>Ctrl</kbd>+<kbd>I</kbd>, *"add null handling"*.
   Point at the diff appearing live: "That's a virtual document, not my file. Nothing is written
   until I press Accept." Then press **Discard** — showing the reject path is more convincing
   than showing accept. *(90s)*

4. **A real task** — no mode to switch, just type it: *"find where the retry limit is defined
   and raise it to five"*. Narrate the trace as it appears: "it searched, it read, now it wants to
   edit — and here's the approval prompt with the exact diff." Worth saying out loud that you never
   picked a mode: the imperative is what selected the tool path. *(120s)*

5. **The failure case** — this is the step that separates you. Open an untrusted folder and type
   a *task*, not a question. It gets answered anyway, with a line saying why, and the panel reads
   `RESTRICTED MODE — answers only, this folder is not trusted` with the fix one click away. Say:
   "The tools can run commands, so opening a repository must never be enough to run its code.
   Answering needs no tools, so it still works — and notice it didn't throw away what I typed. The
   editor degrades to what is safe instead of disappearing."

   If you want a second one: `ps` the engine PSCode started, kill it, and send another message —
   the next turn restarts it, because the editor owns that process rather than depending on it.
   *(45s)*

Most candidates demo the happy path. Demoing a *good* failure is what people remember.

---

## 3. The question you must get right

**"How much of this is actually yours?"**

Answer immediately and specifically. Never hedge.

> "The editor, the terminal and the extension host are Microsoft's — that's VS Code, MIT-licensed.
> I touched twelve upstream files: the identity in `product.json`, two build files to register my
> extension, the icons and desktop entry, a product flag that hides the bundled cloud assistant,
> and three files where "VS Code" appears in visible UI text. I also deleted the bundled Copilot
> extension — 4,122 files, about 87% of the repo.
>
> Everything AI is mine, and I kept it in one directory — `extensions/pscode-ai/`, 6,216 lines
> across 27 TypeScript modules — precisely so this question has a clean answer. Happy to walk any
> file in it."

Then offer `git log` or `git diff` against upstream. Being the one to offer proof reads as
confidence.

**If they push: "so you just rebranded VS Code?"**

> "The rebrand was maybe an hour — a JSON file and an icon. The project is the AI layer. If it
> helps, ignore the fork entirely and look at `extensions/pscode-ai/` as a standalone codebase;
> the fork is just what makes it a product instead of a plugin."

---

## 4. Technical questions, with honest answers

### Architecture and process model

**Q: Walk me through what happens when I type a message in the chat panel.**

The webview posts `{ type: 'send', text, mode }` to the extension host. `ChatViewProvider.send()`
builds context, pushes a user message onto the conversation, and calls either the provider
directly (Chat) or `runAgent()` (Agent). The provider opens an HTTP stream to localhost and yields
`StreamEvent`s. Each text event is posted back to the webview, which accumulates raw markdown and
re-renders once per animation frame.

**Q: Why is the webview separate? Why not render in the extension host?**

You can't — a webview is a sandboxed iframe with its own origin and no Node. But it is also what
you'd want anyway: the panel renders **model output**, which is untrusted input. Keeping it
privilege-free means a prompt-injected reply has nothing to reach. The webview posts intents; the
extension host decides what to honour.

**Q: How do you stop a malicious model reply from doing damage?**

Four layers. HTML is escaped before any formatting is applied, so formatting can't introduce
markup. A strict CSP with `default-src 'none'` and a per-render nonce blocks inline script and all
network access. The webview has no Node and `localResourceRoots` limited to `media/`. And every
privileged action goes through the extension host, where paths are workspace-confined and writes
and commands require approval.

### Streaming

**Q: Why `AsyncIterable` rather than callbacks or an EventEmitter?**

Consumers write a plain `for await` loop, and get backpressure, early `break`, and `try/finally`
cleanup for free. With a callback API, cancelling mid-stream and unwinding cleanly is manual in
every consumer. There are three consumers — chat, inline edit, the agent loop — so that
multiplies.

**Q: Rendering markdown on every token — isn't that O(n²)?**

Yes, and it's bounded and coalesced. Renders are throttled to one per animation frame via
`requestAnimationFrame`, so cost is tied to frames, not tokens. At 15 tokens/sec on CPU that's
already fewer renders than deltas. For a 4,000-character reply, re-parsing is well under a
millisecond. If it ever mattered, the fix is to render only the last block — but measuring first
is the point.

**Q: Why does autoscroll not fight the user?**

`atBottom()` is sampled *before* the re-render. Autoscroll only continues if the user was already
within 40px of the bottom, so scrolling up to read something stops the pull-down.

### Tool calling

**Q: What was the hardest part?**

Reassembling OpenAI-style tool calls. Ollama gives you a complete object per chunk; OpenAI streams
fragments where the function *name* and the JSON *arguments* are both split mid-token, and only an
array `index` ties the pieces together. They're accumulated into a `Map<number, …>` and emitted
only when the stream ends — partial JSON isn't executable. Anthropic is a third shape again,
`tool_use` blocks with incremental `input_json_delta`.

Normalising all three to one `ToolCall` type with `args` as raw JSON text means the agent loop
parses once, in one place.

**Q: What happens when a 7B model emits malformed JSON?**

It happens often, so it's handled as a message rather than an exception: the loop returns *"your
arguments were not valid JSON, send them again as a single valid JSON object"* and the model
usually recovers. Throwing would end the run. Same idea for hallucinated tool names — the error
lists the seven tools that actually exist.

**Q: How do you stop the agent running forever?**

`maxIterations`, default 12. Critically, hitting the ceiling **appends a visible message to the
transcript**. A silent stop is indistinguishable from a finished task, which is exactly how agents
end up appearing to lie about their work.

### Security

**Q: The model asks to read `../../../etc/passwd`. What happens?**

Refused. Every path goes through `resolveInWorkspace()`, which resolves it and then checks
containment:

```ts
const rel = path.relative(path.resolve(parent), path.resolve(child));
return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
```

The check happens **after** `path.resolve()`, so `a/../../b` collapses before comparison rather
than after. Absolute paths are allowed only if they land inside an open folder.

**Q: `run_command` executes arbitrary shell. Isn't that dangerous?**

Yes, which is why it's approval-gated by default with the exact command and working directory
shown, plus a model-supplied reason. Users can disable approval, and the setting says plainly
what that means. Honestly: an agent that can edit files and run `npm test` is inherently powerful,
and the right answer is informed consent at the moment of action, not pretending the risk isn't
there.

### Testing

**Q: How do you test something this stochastic?**

By testing the plumbing, not the model. The provider layer imports nothing from `vscode`, so it
compiles and runs in plain Node — `test/runtime-smoke.js` starts the real bundled engine and
asserts structural properties that must hold regardless of what the model says: exactly one `done`
event per stream, tool arguments parse as JSON, a dead port raises `ProviderError` with an
actionable hint, a missing model produces a useful message.

Those are precisely the bugs a mocked socket cannot catch. I don't assert on model *content*,
because that isn't a property of my code.

**Q: What's untested?**

The VS Code-facing layer — `chatViewProvider`, `inlineEdit`, `tools` — because it needs the
extension-host test harness. That's the honest gap. The next thing I'd add is
`@vscode/test-electron` coverage of the accept/reject path, since that's where a bug would
actually damage a user's file.

### Trade-offs

**Q: Why a fork instead of an extension?**

For this project, because I wanted the product-level surface — own name, own icon, own installer,
own default settings, and a marketplace that works. An extension can't change any of that.

The cost is real and worth naming: every upstream VS Code release has to be merged. I kept my
footprint to twelve upstream files specifically to keep those merges cheap.

**Q: Tell me about something that broke and what you did about it.**

I tried to strip Copilot out of the fork by deleting `defaultChatAgent` from `product.json`.
It launched to a completely blank window.

The first error was `welcomeOnboarding` doing `assertDefined(product.defaultChatAgent, ...)` at
*module scope* — so it threw during workbench load and killed the render before anything painted.
I made that one consistent with the rest of the file's neighbours, which all read the config with
`?.` and a fallback. Still blank: next was
`services/accounts/browser/defaultAccount.ts`, which takes the config as a non-optional
`IDefaultChatAgent` and walks `provider.default.id`.

At that point I grepped and found about 51 files reading it. So I stopped and reverted. Removing
Copilot was cosmetic — the panel is unused, PSCode AI has its own view — and patching 51 call
sites would have made every future upstream merge painful for no user-visible gain. Wrong trade.

Later I found the lever I should have looked for first. `chatEntitlementService` already hides
every Copilot surface when the platform doesn't support it, by setting one context key — and the
chat view, the watermark hints, the help entries and the walkthroughs are all gated on that same
key. So I added a `disableCloudChat` flag to `product.json`, set the key when it's on, and deleted
the bundled extension. Two small upstream edits instead of fifty-one, and the panel is genuinely
gone rather than merely unused.

The lesson I'd actually claim from it: in a fork, the cost of a change isn't the diff, it's the
diff *times every future rebase*. Deleting config that the product treats as required is the
expensive way; finding the switch the product already has is the cheap one. Twice now the failure
looked identical — a blank window — and twice the cause was a `product.json` key being read
unguarded, once `defaultChatAgent` and once `builtInExtensionsEnabledWithAutoUpdates`, where
removing the key broke *all* extension scanning and silently disabled my own extension too.

**Q: Why no tab autocomplete? Cursor's headline feature.**

Because it would have been bad. Ghost text needs sub-200ms round trips to feel useful. On a 12-core
CPU with no GPU, a small FIM model doesn't get close. I'd rather ship three features that feel good
than four where one makes the product feel broken. With a GPU it goes back on the roadmap.

**Q: Why write your own markdown renderer?**

Two reasons. A built-in extension shipping inside the product shouldn't pull an npm supply chain in
for something this small — the extension has zero runtime dependencies. And streaming needs a
behaviour off-the-shelf renderers don't have: the fence regex matches an *unterminated* final
fence, so a code block renders as code while it's still arriving rather than flickering from prose
into code at the closing backticks.

**Q: Why local models when hosted ones are better?**

Because a lot of real code can't leave the building — that's the constraint at plenty of companies,
including where I work. Hosted models are better and PSCode supports them; the default is local
because the interesting engineering problem is making a small slow model genuinely useful.

---

## 5. Draw it from memory

Practise this on paper. If you can't draw it without notes, you don't know it yet.

```
Webview (sandboxed, no Node, strict CSP)
   │  postMessage  ← the privilege boundary
Extension host (Node)
   ├── ChatViewProvider ── conversation state, brokers privilege
   ├── contextBuilder ──── budgeted: selection > @mentions > active file > diagnostics
   ├── agentLoop ───────── stream → tools → repeat, bounded
   ├── tools ───────────── 11 tools, workspace-confined, approval-gated
   └── providers/ ──────── LLMProvider: bundled | ollama | openai-compatible | anthropic
            │  HTTP
        localhost:11434
```

Three sentences to say while drawing:
1. "The webview has no privileges — it renders and posts intents."
2. "Everything above the provider layer is written against one interface, so backends are swappable."
3. "AI output is a proposal in a virtual document; the user's file changes only on accept."

---

## 6. Own these before they find them

Volunteering a weakness reads as senior. Being caught hiding one reads as the opposite.

| Weakness | How to say it |
|---|---|
| No UI tests | "The provider layer is tested against a live model. The VS Code-facing layer isn't — it needs `@vscode/test-electron`. That's my honest gap and the next thing I'd add." |
| CPU inference is slow | "8–20 tokens/sec on this machine. Fine for chat and inline edit, and it's why there's no autocomplete." |
| Agent unreliable on 7B | "It loses multi-step plans and emits bad JSON. I handle it — retry messages instead of crashes — but I can't fix the model." |
| No persistence | "Chats die with the window. Straightforward to add, just not done." |
| Only tested on Linux | "The build config is cross-platform; I've only run it here. I wouldn't claim macOS works without building it." |
| Merge burden of a fork | "Every upstream release needs a merge. Eight files touched keeps that cheap, but it isn't free." |

---

## 7. Ask them something real

- "Where would you draw the approval boundary? I gate writes and shell commands by default — in a
  team setting, would you gate reads too?"
- "How do you test agent behaviour beyond structural properties? I stopped at 'the plumbing is
  correct' and I'm not sure what the next rung looks like."
- "Are you running models locally for anything, or is it all hosted?"

---

## 8. Pre-interview checklist

- [ ] PSCode **already built**, and `./scripts/fetch-llm-runtime.sh` has been run — never build live
- [ ] One window opened and closed once, so the weights are in the page cache and the first answer
      is fast
- [ ] A small demo repo open with a real, fixable bug in it
- [ ] Status bar green before you share your screen
- [ ] Demo rehearsed twice, including the kill-the-server failure step
- [ ] Can state the 8 modified upstream files from memory
- [ ] Can draw the architecture on paper without notes
- [ ] `git log` presentable — no "wip" or "asdf" commits
- [ ] Know your own numbers: 6,216 lines, 27 modules, 11 tools, 4 providers, 29 upstream files

---

## 9. If you only remember three things

1. **Name the boundary before they ask.** "The editor is Microsoft's; the AI layer is mine, 3,700
   lines in one directory."
2. **Demo a failure on purpose.** Kill the server. Good error messages are an engineering
   argument, and almost nobody shows one.
3. **Volunteer a real weakness.** "No UI tests" costs you nothing and buys you credibility on
   everything else you claim.
