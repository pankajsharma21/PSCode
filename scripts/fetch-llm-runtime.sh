#!/usr/bin/env bash
#
# Fetches the inference engine and the weights that PSCode ships with.
#
# PSCode runs its own model: the engine starts with the window and stops with it, and installing
# the editor is the only install step there is. That means ~2.2GB of binaries and weights have to
# come from somewhere, and it is not git - a repository is a bad place for files that large, and
# GitHub refuses them outright past 100MB. So they are fetched here, into a directory git ignores,
# and the packaging step copies them into the installer.
#
#   ./scripts/fetch-llm-runtime.sh            # fetch anything missing
#   ./scripts/fetch-llm-runtime.sh --force    # re-fetch even if present
#
# Run it once after cloning, and again only when the versions below change. Without it PSCode
# still builds and runs; it just falls back to whatever provider is configured in settings.
set -euo pipefail

# --- what we ship -------------------------------------------------------------------------------
# Pinned, never "latest": a build should produce the same editor tomorrow as it did today.
LLAMA_BUILD="b10679"
LLAMA_ASSET="llama-${LLAMA_BUILD}-bin-ubuntu-x64.tar.gz"
LLAMA_URL="https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${LLAMA_ASSET}"

# Qwen2.5 3B Instruct, 4-bit.
#
# Instruct rather than Coder, which is not the obvious choice for an editor and was not the first
# one: Qwen2.5-Coder-3B writes better code but does not reliably follow the `<tool_call>`
# convention its own template asks for, and agent mode is worthless without that. Instruct follows
# it. Chosen over the 7B because on a CPU-only machine a 7B's first token can take over a minute,
# which reads as a broken editor rather than a thoughtful one.
CHAT_REPO="Qwen/Qwen2.5-3B-Instruct-GGUF"
CHAT_FILE="qwen2.5-3b-instruct-q4_k_m.gguf"
CHAT_NAME="qwen2.5-3b-instruct-q4_k_m"

# The chat template, taken from the *unquantised* model rather than the .gguf.
#
# Quantised repacks routinely embed an older, trimmed template, and the part that goes missing is
# the tool-call section. Measured, not assumed: with the .gguf's own template, Qwen answers a tool
# request with a JSON blob in the message body, llama.cpp has nothing to parse, and agent mode
# sees a model that talked about calling a tool instead of calling one.
TEMPLATE_REPO="Qwen/Qwen2.5-3B-Instruct"

# A separate, much smaller model for @codebase. Kept at f16 rather than quantised: these vectors
# are only ever compared with each other, and quantisation costs ranking quality for ~190MB.
EMBED_REPO="nomic-ai/nomic-embed-text-v1.5-GGUF"
EMBED_FILE="nomic-embed-text-v1.5.f16.gguf"
EMBED_NAME="nomic-embed-text-v1.5"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME="$ROOT/extensions/pscode-ai/runtime"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

# The system curl on some machines is shadowed by a broken libcurl, and this script is the first
# thing a new contributor runs - failing here would look like the project is broken.
if ! command -v wget >/dev/null 2>&1; then
	echo "fetch-llm-runtime: needs wget (the system curl cannot be relied on here)." >&2
	exit 1
fi

mkdir -p "$RUNTIME/bin" "$RUNTIME/models"

# --- helpers ------------------------------------------------------------------------------------

# HuggingFace reports every LFS file's sha256, so a truncated or resumed-wrong download is caught
# here rather than as "the engine exited immediately" three steps later.
expected_sha256() {
	python3 - "$1" "$2" <<-'PY'
	import json, sys, urllib.request
	repo, name = sys.argv[1], sys.argv[2]
	url = f"https://huggingface.co/api/models/{repo}/tree/main"
	for entry in json.load(urllib.request.urlopen(url, timeout=60)):
	    if entry.get("path") == name:
	        print((entry.get("lfs") or {}).get("oid", ""))
	        break
	PY
}

fetch_model() {
	local repo="$1" file="$2" target="$3"
	if [ -s "$target" ] && [ "$FORCE" -eq 0 ]; then
		echo "  already present: $(basename "$target") ($(du -h "$target" | cut -f1))"
		return
	fi
	echo "  downloading $file from $repo"
	wget -q --show-progress -c -O "$target" "https://huggingface.co/${repo}/resolve/main/${file}"

	local want
	want="$(expected_sha256 "$repo" "$file" || true)"
	if [ -n "$want" ]; then
		local got
		got="$(sha256sum "$target" | cut -d' ' -f1)"
		if [ "$want" != "$got" ]; then
			echo "fetch-llm-runtime: checksum mismatch for $file" >&2
			echo "  expected $want" >&2
			echo "  got      $got" >&2
			rm -f "$target"
			exit 1
		fi
		echo "  checksum ok"
	else
		echo "  (no checksum published for $file; skipping verification)"
	fi
}

# --- engine -------------------------------------------------------------------------------------
echo "Engine (llama.cpp ${LLAMA_BUILD}):"
if [ -x "$RUNTIME/bin/llama-server" ] && [ "$FORCE" -eq 0 ]; then
	echo "  already present: llama-server"
else
	TMP="$(mktemp -d)"
	trap 'rm -rf "$TMP"' EXIT
	wget -q --show-progress -O "$TMP/$LLAMA_ASSET" "$LLAMA_URL"
	tar xzf "$TMP/$LLAMA_ASSET" -C "$TMP"
	SRC="$(dirname "$(find "$TMP" -name llama-server -type f | head -1)")"
	[ -n "$SRC" ] || { echo "fetch-llm-runtime: no llama-server in $LLAMA_ASSET" >&2; exit 1; }

	# Only the server and the libraries it links against. The tarball also carries a dozen CLI
	# tools PSCode never runs, and shipping them would triple this directory for nothing.
	cp "$SRC/llama-server" "$RUNTIME/bin/"
	cp "$SRC"/*.so "$SRC"/*.so.* "$RUNTIME/bin/" 2>/dev/null || true
	chmod +x "$RUNTIME/bin/llama-server"
	echo "  installed llama-server + $(ls "$RUNTIME/bin" | grep -c '\.so') shared libraries"
fi

# --- weights ------------------------------------------------------------------------------------
echo "Chat model:"
fetch_model "$CHAT_REPO" "$CHAT_FILE" "$RUNTIME/models/chat.gguf"

echo "Chat template:"
if [ -s "$RUNTIME/models/chat.jinja" ] && [ "$FORCE" -eq 0 ]; then
	echo "  already present: chat.jinja"
else
	python3 - "$TEMPLATE_REPO" "$RUNTIME/models/chat.jinja" <<-'PY'
	import json, sys, urllib.request
	repo, out = sys.argv[1], sys.argv[2]
	url = f"https://huggingface.co/{repo}/resolve/main/tokenizer_config.json"
	template = json.load(urllib.request.urlopen(url, timeout=60)).get("chat_template")
	if not template:
	    raise SystemExit(f"no chat_template in {repo}")
	if "<tool_call>" not in template:
	    raise SystemExit(f"{repo}'s template has no tool-call section; agent mode would not work")
	with open(out, "w") as handle:
	    handle.write(template)
	print(f"  fetched from {repo} ({len(template)} chars, tool-call section present)")
	PY
fi
echo "Embedding model:"
fetch_model "$EMBED_REPO" "$EMBED_FILE" "$RUNTIME/models/embed.gguf"

# --- manifest -----------------------------------------------------------------------------------
# The extension reads this for the names it shows in the status bar and writes into the semantic
# index header, so a rebuilt index is never compared against vectors from a different model.
cat > "$RUNTIME/manifest.json" <<EOF
{
  "engine": "llama.cpp ${LLAMA_BUILD}",
  "chat": { "file": "chat.gguf", "name": "${CHAT_NAME}" },
  "embed": { "file": "embed.gguf", "name": "${EMBED_NAME}" }
}
EOF

echo
echo "Runtime ready in $RUNTIME ($(du -sh "$RUNTIME" | cut -f1))."
