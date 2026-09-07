#!/usr/bin/env bash
#
# pdf-to-patch.sh
# ────────────────────────────────────────────────────────────────────────────
# Restore commits from a PDF produced by `scripts/patch-to-pdf.sh`.
#
# Extracts the base64 payload between the BEGIN/END sentinels, decodes it
# back to a raw git-format-patch, verifies its sha1 matches the header, and
# applies it with `git am`.
#
# Requires
# ────────
#   git             (always present)
#   base64
#   pdftotext       (brew install poppler)
#
# Usage
# ─────
#   scripts/pdf-to-patch.sh path/to/commit.pdf                # apply
#   scripts/pdf-to-patch.sh --extract-only path/to/commit.pdf # write .patch, don't apply
#   scripts/pdf-to-patch.sh --check path/to/commit.pdf        # dry-run (git apply --check)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

MODE="apply"
PDF=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --extract-only) MODE="extract"; shift;;
    --check)        MODE="check";   shift;;
    -h|--help)
      sed -n '/^# Usage/,/^set -e/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*) echo "unknown flag: $1" >&2; exit 2;;
    *) PDF="$1"; shift;;
  esac
done

[ -n "$PDF" ] || { echo "usage: $0 [--extract-only|--check] <in.pdf>" >&2; exit 2; }
[ -f "$PDF" ] || { echo "not found: $PDF" >&2; exit 1; }

command -v pdftotext >/dev/null || command -v python3 >/dev/null || {
  echo "[error] Need one of:" >&2
  echo "        pdftotext   →  brew install poppler" >&2
  echo "        python3     →  brew install python  (already on macOS by default)" >&2
  exit 1
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── 1. Extract text with layout preserved ──────────────────────────────────
if command -v pdftotext >/dev/null; then
  pdftotext -layout "$PDF" "$TMP/raw.txt"
else
  # Python fallback: pypdf via a temp venv so we don't touch system Python.
  PYBIN=python3
  if ! python3 -c "import pypdf" 2>/dev/null; then
    if python3 -m venv "$TMP/venv" 2>/dev/null; then
      echo "[info] installing pypdf into a temp venv (one-off, ~2 MB)…"
      "$TMP/venv/bin/pip" install --quiet pypdf
      PYBIN="$TMP/venv/bin/python3"
    else
      echo "[info] venv unavailable, installing pypdf --user…"
      python3 -m pip install --user --quiet pypdf
    fi
  fi
  "$PYBIN" - "$PDF" "$TMP/raw.txt" <<'PY'
import sys
from pypdf import PdfReader
src, dst = sys.argv[1], sys.argv[2]
r = PdfReader(src)
with open(dst, "w") as f:
    for page in r.pages:
        f.write(page.extract_text() or "")
        f.write("\n")
PY
fi

# ── 2. Slice out the base64 payload between sentinels ──────────────────────
awk '
  /^-----[[:space:]]*BEGIN[[:space:]]+PATCH[[:space:]]+BASE64[[:space:]]*-----/ { grab=1; next }
  /^-----[[:space:]]*END[[:space:]]+PATCH[[:space:]]+BASE64[[:space:]]*-----/   { grab=0 }
  grab { print }
' "$TMP/raw.txt" | tr -d ' \t\r\n\014' > "$TMP/commit.b64"

if [ ! -s "$TMP/commit.b64" ]; then
  echo "[error] Couldn't find the base64 payload. Was this PDF made by patch-to-pdf.sh?" >&2
  echo "        Raw extracted text saved at: $TMP/raw.txt" >&2
  exit 1
fi

# ── 3. Decode ──────────────────────────────────────────────────────────────
if ! base64 -d < "$TMP/commit.b64" > "$TMP/commit.patch" 2>/dev/null; then
  # GNU base64 uses -d; some BSD variants use -D. Try both.
  base64 -D < "$TMP/commit.b64" > "$TMP/commit.patch"
fi

# ── 4. Verify sha1 against the header if present ───────────────────────────
expected_sha=$(awk -F': ' '/^sha1\(payload\)/ {print $2; exit}' "$TMP/raw.txt" | tr -d ' \r\n' || true)
actual_sha=$(shasum -a 1 "$TMP/commit.patch" | awk '{print $1}')

if [ -n "$expected_sha" ]; then
  if [ "$expected_sha" != "$actual_sha" ]; then
    echo "[warn] payload sha1 MISMATCH — the PDF may have been re-encoded lossy." >&2
    echo "       expected: $expected_sha" >&2
    echo "       actual:   $actual_sha"   >&2
  else
    echo "[ok] payload sha1 matches: $actual_sha"
  fi
fi

commits=$(grep -c '^From ' "$TMP/commit.patch" || true)
patch_kb=$(du -k "$TMP/commit.patch" | awk '{print $1}')
echo "[extracted] commits=$commits size=${patch_kb}KB path=$TMP/commit.patch"

# ── 5. Extract-only mode ───────────────────────────────────────────────────
if [ "$MODE" = "extract" ]; then
  DST="${PDF%.pdf}.patch"
  cp "$TMP/commit.patch" "$DST"
  echo "[written] $DST"
  echo "Apply manually with: git am \"$DST\""
  exit 0
fi

# ── 6. Check mode (dry-run) ────────────────────────────────────────────────
if [ "$MODE" = "check" ]; then
  echo "--- dry-run: git apply --check ---"
  git -C "$REPO_ROOT" apply --check --whitespace=nowarn "$TMP/commit.patch"
  echo "[ok] Patch parses cleanly and would apply on top of HEAD."
  exit 0
fi

# ── 7. Apply ───────────────────────────────────────────────────────────────
echo "--- applying via git am ---"
if ! git -C "$REPO_ROOT" am --keep-cr --whitespace=nowarn "$TMP/commit.patch"; then
  echo ""
  echo "[fail] git am stopped. Fix conflicts, then:"
  echo "  cd $REPO_ROOT"
  echo "  git am --continue       # after resolving"
  echo "  git am --skip           # skip this commit"
  echo "  git am --abort          # bail out entirely"
  exit 1
fi

echo ""
echo "[done] Applied. Verify with:"
echo "  git -C $REPO_ROOT log -${commits:-1}"
