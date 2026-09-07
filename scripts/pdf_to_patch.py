#!/usr/bin/env python3
"""
pdf_to_patch.py
────────────────────────────────────────────────────────────────────────────
Cross-platform pure-Python restore for PDFs produced by scripts/patch-to-pdf.sh.
Works identically on macOS, Linux, and Windows (Git Bash, PowerShell, cmd).

Requires
────────
    python 3.8+
    pip install pypdf       (auto-attempted if missing)
    git in PATH

Usage
─────
    python scripts/pdf_to_patch.py <in.pdf>                # extract + git am
    python scripts/pdf_to_patch.py --extract-only <in.pdf> # just write the .patch
    python scripts/pdf_to_patch.py --check <in.pdf>        # dry-run git apply
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import pathlib
import re
import shutil
import subprocess
import sys


def _ensure_pypdf():
    try:
        import pypdf  # noqa: F401
    except ImportError:
        print("[info] installing pypdf (one-off)…", file=sys.stderr)
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "--quiet", "--user", "pypdf"]
        )


def extract_text(pdf_path: pathlib.Path) -> str:
    _ensure_pypdf()
    from pypdf import PdfReader
    reader = PdfReader(str(pdf_path))
    return "\n".join((page.extract_text() or "") for page in reader.pages)


BEGIN = re.compile(r"^-+\s*BEGIN\s+PATCH\s+BASE64\s*-+", re.M)
END   = re.compile(r"^-+\s*END\s+PATCH\s+BASE64\s*-+",   re.M)
SHA_HEADER = re.compile(r"^sha1\(payload\)\s*:\s*([0-9a-f]{40})", re.M | re.I)


def parse_payload(text: str) -> tuple[bytes, str | None]:
    b = BEGIN.search(text)
    e = END.search(text)
    if not b or not e or e.start() <= b.end():
        raise SystemExit(
            "[error] Couldn't find the BEGIN/END payload sentinels.\n"
            "        Was this PDF produced by patch-to-pdf.sh?"
        )
    b64 = re.sub(r"\s+", "", text[b.end():e.start()])
    try:
        raw = base64.b64decode(b64, validate=True)
    except Exception as x:
        raise SystemExit(f"[error] Base64 decode failed: {x}")
    m = SHA_HEADER.search(text)
    return raw, m.group(1).lower() if m else None


def run(cmd: list[str], **kw) -> int:
    print("+", " ".join(cmd))
    return subprocess.call(cmd, **kw)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("pdf", type=pathlib.Path)
    p.add_argument("--extract-only", action="store_true")
    p.add_argument("--check",        action="store_true")
    args = p.parse_args()

    if not shutil.which("git"):
        raise SystemExit("[error] `git` not found in PATH.")

    pdf = args.pdf.resolve()
    if not pdf.exists():
        raise SystemExit(f"[error] not found: {pdf}")

    text = extract_text(pdf)
    patch_bytes, expected_sha = parse_payload(text)
    actual_sha = hashlib.sha1(patch_bytes).hexdigest()

    if expected_sha:
        if expected_sha != actual_sha:
            print(f"[warn] payload sha1 MISMATCH — PDF may have been re-encoded lossy.")
            print(f"       expected: {expected_sha}")
            print(f"       actual:   {actual_sha}")
        else:
            print(f"[ok] payload sha1 matches: {actual_sha}")

    n_commits = patch_bytes.count(b"\nFrom ") + (1 if patch_bytes.startswith(b"From ") else 0)
    size_kb = len(patch_bytes) // 1024
    print(f"[extracted] commits={n_commits} size={size_kb}KB")

    # Write the .patch (always — makes recovery easy if apply fails)
    dst_patch = pdf.with_suffix(".patch")
    dst_patch.write_bytes(patch_bytes)
    print(f"[written] {dst_patch}")

    if args.extract_only:
        print(f'Apply manually with:  git am "{dst_patch}"')
        return

    if args.check:
        code = run(["git", "apply", "--check", "--whitespace=nowarn", str(dst_patch)])
        if code == 0:
            print("[ok] Patch parses cleanly and would apply on top of HEAD.")
        sys.exit(code)

    code = run(["git", "am", "--keep-cr", "--whitespace=nowarn", str(dst_patch)])
    if code != 0:
        print("\n[fail] git am stopped. Fix conflicts, then:")
        print("  git am --continue    # after resolving")
        print("  git am --skip        # skip this commit")
        print("  git am --abort       # bail out entirely")
        sys.exit(code)
    print(f"\n[done] Applied. Verify with:  git log -{n_commits}")


if __name__ == "__main__":
    main()
