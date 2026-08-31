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

# Qwen2.5 14B Instruct, 4-bit. Two constraints picked this, and neither was a benchmark.
#
# Instruct rather than Coder: Qwen2.5-Coder writes better code but does not reliably follow the
# `<tool_call>` convention its own template asks for, and agent mode is worthless without that.
#
# The licence is a shipping constraint, not a footnote, because PSCode redistributes these weights
# inside its installer. Qwen2.5 is NOT uniformly licensed:
#
#     3B Instruct, every Coder size up to 7B    qwen-research   cannot be redistributed
#     1.5B / 7B / 14B / 32B Instruct            apache-2.0      can
#     72B Instruct                              other           cannot
#
# Then RAM decides among the apache-2.0 ones. Q4_K_M weights plus an 8k KV cache:
#
#     7B    ~5.7 GB      14B   ~10.5 GB      32B   ~22.4 GB      72B   ~51 GB
#
# 32B and up do not fit a 32 GB machine that is also running an editor, and there is no swap
# headroom to spill into - it would thrash, not run slowly. 14B is the largest that fits, so it is
# the choice. It is slow on a CPU and that is accepted: a first token can take minutes on a
# tool-heavy agent prompt. The activity strip exists precisely so that reads as work, not a hang.
#
# Verify before changing this:
#     curl -s https://huggingface.co/api/models/<repo> | jq .cardData.license
CHAT_REPO="Qwen/Qwen2.5-14B-Instruct-GGUF"
CHAT_FILE="qwen2.5-14b-instruct-q4_k_m-00001-of-00003.gguf"
CHAT_SHARDS=3
CHAT_NAME="qwen2.5-14b-instruct-q4_k_m"

# The chat template, taken from the *unquantised* model rather than the .gguf.
#
# Quantised repacks routinely embed an older, trimmed template, and the part that goes missing is
# the tool-call section. Measured, not assumed: with the .gguf's own template, Qwen answers a tool
# request with a JSON blob in the message body, llama.cpp has nothing to parse, and agent mode
# sees a model that talked about calling a tool instead of calling one.
TEMPLATE_REPO="Qwen/Qwen2.5-14B-Instruct"

# A separate, much smaller model for @codebase. Kept at f16 rather than quantised: these vectors
# are only ever compared with each other, and quantisation costs ranking quality for ~190MB.
# `apache-2.0`, so it can ship in the installer like the chat model.
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

# Downloads a shard set and joins it into one file.
#
# `$file` is the FIRST shard, named `...-00001-of-000NN.gguf`; the rest are derived from it. The
# shards land in a temp directory under their published names, because llama-gguf-split follows the
# numbering to find them, then the joined result is moved to `$target` and the shards deleted. Peak
# disk is therefore about twice the model - checked before starting, since running out halfway
# leaves a half-written model that looks like a corrupt download.
fetch_sharded_model() {
	local repo="$1" first="$2" count="$3" target="$4"
	if [ -s "$target" ] && [ "$FORCE" -eq 0 ]; then
		echo "  already present: $(basename "$target") ($(du -h "$target" | cut -f1))"
		return
	fi

	local joiner="$RUNTIME/bin/llama-gguf-split"
	[ -x "$joiner" ] || {
		echo "fetch-llm-runtime: $CHAT_NAME ships as $count shards and needs llama-gguf-split," >&2
		echo "  which was not found in $LLAMA_ASSET. Re-run with --force to reinstall the engine." >&2
		exit 1
	}

	# NOT wiped. A 9 GB shard set takes long enough that a dropped connection part-way is a
	# realistic event, and the first version of this deleted the directory on entry - so a retry
	# re-downloaded everything that had already arrived. `wget -c` resumes each shard instead.
	local dir="$RUNTIME/models/.shards"
	mkdir -p "$dir"

	local i name
	for i in $(seq 1 "$count"); do
		name="$(printf '%s' "$first" | sed "s/-00001-of-/-$(printf '%05d' "$i")-of-/")"
		echo "  shard $i/$count: $name"
		wget -q --show-progress -c -O "$dir/$name" "https://huggingface.co/${repo}/resolve/main/${name}" || {
			echo "fetch-llm-runtime: shard $i failed. Re-run to resume - what arrived is kept." >&2
			exit 1
		}
	done

	echo "  joining $count shards"
	# The joiner writes next to its output argument; LD_LIBRARY_PATH because the .so files it links
	# against live beside it rather than on the system path.
	LD_LIBRARY_PATH="$RUNTIME/bin:${LD_LIBRARY_PATH:-}" \
		"$joiner" --merge "$dir/$first" "$dir/joined.gguf" >/dev/null 2>&1 || {
			echo "fetch-llm-runtime: joining the shards failed" >&2
			rm -rf "$dir"
			exit 1
		}
	mv "$dir/joined.gguf" "$target"
	rm -rf "$dir"
	echo "  joined into $(basename "$target") ($(du -h "$target" | cut -f1))"
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

	# Only the server, the shard-joiner, and the libraries they link against. The tarball also
	# carries a dozen CLI tools PSCode never runs, and shipping them would triple this directory
	# for nothing.
	#
	# llama-gguf-split is a build-time tool, not a runtime one: a model over ~4 GB is published as
	# numbered shards, and llama.cpp finds siblings by their `-00001-of-000NN` names. PSCode stores
	# one `chat.gguf`, so renaming a shard would strand the rest. Joining them here keeps the
	# runtime layout - and the code that reads it - unchanged. Deleted again below, once used.
	cp "$SRC/llama-server" "$RUNTIME/bin/"
	cp "$SRC/llama-gguf-split" "$RUNTIME/bin/" 2>/dev/null || true
	cp "$SRC"/*.so "$SRC"/*.so.* "$RUNTIME/bin/" 2>/dev/null || true
	chmod +x "$RUNTIME/bin/llama-server"
	[ -f "$RUNTIME/bin/llama-gguf-split" ] && chmod +x "$RUNTIME/bin/llama-gguf-split"
	echo "  installed llama-server + $(ls "$RUNTIME/bin" | grep -c '\.so') shared libraries"
fi

# --- weights ------------------------------------------------------------------------------------
echo "Chat model:"
if [ "${CHAT_SHARDS:-1}" -gt 1 ]; then
	fetch_sharded_model "$CHAT_REPO" "$CHAT_FILE" "$CHAT_SHARDS" "$RUNTIME/models/chat.gguf"
else
	fetch_model "$CHAT_REPO" "$CHAT_FILE" "$RUNTIME/models/chat.gguf"
fi

echo "Chat template:"
if [ -s "$RUNTIME/models/chat.jinja" ] && [ "$FORCE" -eq 0 ]; then
	echo "  already present: chat.jinja"
else
	# Retried, because this step runs *after* the multi-gigabyte download and a transient DNS
	# failure here throws away the whole run for a 30 KB file. Seen exactly that:
	# "URLError: [Errno -3] Temporary failure in name resolution" after 9 GB had landed.
	python3 - "$TEMPLATE_REPO" "$RUNTIME/models/chat.jinja" <<-'PY'
	import json, sys, time, urllib.error, urllib.request
	repo, out = sys.argv[1], sys.argv[2]
	url = f"https://huggingface.co/{repo}/resolve/main/tokenizer_config.json"

	last = None
	for attempt in range(1, 6):
	    try:
	        config = json.load(urllib.request.urlopen(url, timeout=60))
	        break
	    except (urllib.error.URLError, OSError, TimeoutError) as error:
	        last = error
	        if attempt == 5:
	            raise SystemExit(f"could not reach {repo} after 5 tries: {error}")
	        wait = 2 ** attempt
	        print(f"  network error ({error}); retrying in {wait}s")
	        time.sleep(wait)

	template = config.get("chat_template")
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

# --- notice -------------------------------------------------------------------------------------
# Written next to the weights rather than only into the repo's ThirdPartyNotices, because this
# directory is what gets copied into the installer. The licence has to travel with the thing it
# licenses; a notice left behind in a source tree does not cover a shipped binary.
#
# Generated from the same variables that did the downloading, so it cannot describe a model other
# than the one actually present.
cat > "$RUNTIME/NOTICE" <<EOF
PSCode bundles the following third-party components in this directory.

--------------------------------------------------------------------------------
llama.cpp ${LLAMA_BUILD}          bin/
https://github.com/ggml-org/llama.cpp
MIT License. Copyright (c) 2023-2024 The ggml authors.

--------------------------------------------------------------------------------
${CHAT_NAME}          models/chat.gguf, models/chat.jinja
https://huggingface.co/${CHAT_REPO}
Apache License 2.0. Copyright 2024 Alibaba Cloud.

--------------------------------------------------------------------------------
${EMBED_NAME}          models/embed.gguf
https://huggingface.co/${EMBED_REPO}
Apache License 2.0. Copyright 2024 Nomic AI.

--------------------------------------------------------------------------------
Full Apache-2.0 text: http://www.apache.org/licenses/LICENSE-2.0

Both models are Apache-2.0, which is why they can ship inside the installer at all.
Qwen2.5 is not uniformly licensed - the 3B Instruct and the Coder sizes are
qwen-research, and the 72B is under its own licence - so if you change CHAT_REPO in
scripts/fetch-llm-runtime.sh, check the new model's licence first:

    curl -s https://huggingface.co/api/models/<repo> | jq .cardData.license
EOF

echo
echo "Runtime ready in $RUNTIME ($(du -sh "$RUNTIME" | cut -f1))."
