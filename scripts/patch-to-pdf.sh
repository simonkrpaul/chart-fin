#!/usr/bin/env bash
#
# patch-to-pdf.sh
# ────────────────────────────────────────────────────────────────────────────
# Turn one or more Git commits into a PDF that can be safely round-tripped
# back into a repo. Fidelity is guaranteed because the actual patch is
# base64-encoded before rendering, so wrapping / whitespace loss inside the
# PDF can't corrupt it.
#
# On the destination machine, use `scripts/pdf-to-patch.sh <in.pdf>` to
# extract the patch and apply it with `git am`.
#
# Requires
# ────────
#   git                          (always present)
#   base64                       (always present on macOS)
#   Either of:
#     enscript + ps2pdf   (brew install enscript ghostscript)   — best output
#     cupsfilter                                                 — zero-install fallback
#
# Usage
# ─────
#   scripts/patch-to-pdf.sh                     # last commit → out/last-commit.pdf
#   scripts/patch-to-pdf.sh HEAD~3..HEAD        # range
#   scripts/patch-to-pdf.sh -1 abc1234          # single commit by sha
#   scripts/patch-to-pdf.sh -o mybundle.pdf …   # custom output path
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$REPO_ROOT/out"
OUT="$OUT_DIR/commit-$(date +%Y%m%d-%H%M%S).pdf"

# Parse -o/--output
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output) OUT="$2"; shift 2;;
    -h|--help)
      sed -n '/^# Usage/,/^set -e/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) args+=("$1"); shift;;
  esac
done

# Default = last commit if nothing else was specified
if [ ${#args[@]} -eq 0 ]; then
  args=(-1 HEAD)
fi

mkdir -p "$OUT_DIR"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── 1. Produce the raw patch ────────────────────────────────────────────────
git -C "$REPO_ROOT" format-patch --binary --stdout "${args[@]}" > "$TMP/commit.patch"

if [ ! -s "$TMP/commit.patch" ]; then
  echo "[error] git format-patch produced nothing for: ${args[*]}" >&2
  exit 1
fi

# ── 2. Base64-encode so the PDF round-trip is lossless ─────────────────────
# Fold at 72 chars — most base64 tools accept anything, but 72 is standard.
base64 -b 72 < "$TMP/commit.patch" > "$TMP/commit.b64" 2>/dev/null || \
  base64      < "$TMP/commit.patch" > "$TMP/commit.b64"

# Sentinels help the extractor find the payload deterministically.
{
  echo "===== chart-fin commit patch (base64) ====="
  echo "generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "repo:      $(git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || echo local)"
  echo "range:     ${args[*]}"
  echo "sha1(payload): $(shasum -a 1 "$TMP/commit.patch" | awk '{print $1}')"
  echo "----- BEGIN PATCH BASE64 -----"
  cat "$TMP/commit.b64"
  echo "----- END PATCH BASE64 -----"
} > "$TMP/payload.txt"

# ── 3. Render to PDF ────────────────────────────────────────────────────────
if command -v enscript >/dev/null && command -v ps2pdf >/dev/null; then
  enscript --quiet --font=Courier7 --media=A4 --landscape --header='' \
    "$TMP/payload.txt" -o - | ps2pdf - "$OUT"
elif command -v cupsfilter >/dev/null; then
  # macOS zero-install path. Output is plain text but pdftotext will read it fine.
  cupsfilter -m application/pdf "$TMP/payload.txt" > "$OUT" 2>/dev/null
else
  echo "[error] Need either 'enscript + ps2pdf' (brew install enscript ghostscript)"  >&2
  echo "        or 'cupsfilter' (macOS built-in) to make the PDF."                    >&2
  echo "        Raw payload is at: $TMP/payload.txt"                                  >&2
  cp "$TMP/payload.txt" "${OUT%.pdf}.txt"
  echo "        Saved as: ${OUT%.pdf}.txt"                                            >&2
  exit 1
fi

# ── 4. Summary ─────────────────────────────────────────────────────────────
patch_kb=$(du -k "$TMP/commit.patch" | awk '{print $1}')
pdf_kb=$(du -k "$OUT" | awk '{print $1}')
commits=$(grep -c '^From ' "$TMP/commit.patch" || true)
echo "[done]"
echo "  commits:   $commits"
echo "  patch:     ${patch_kb} KB"
echo "  pdf:       ${pdf_kb} KB"
echo "  path:      $OUT"
echo ""
echo "Restore with:"
echo "  scripts/pdf-to-patch.sh \"$OUT\""
