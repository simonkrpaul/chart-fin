# Round-tripping commits through PDF

Two shell scripts turn a Git commit (or range of commits) into a PDF you can
review/email/upload, then reconstruct the exact same commit on another
machine. Useful when direct `git push` is blocked by a corporate proxy /
approval workflow and PDF is the only sanctioned transport.

| Direction | Script | Platforms |
| --- | --- | --- |
| commits → PDF | [scripts/patch-to-pdf.sh](../scripts/patch-to-pdf.sh) | macOS / Linux |
| PDF → applied commits | [scripts/pdf-to-patch.sh](../scripts/pdf-to-patch.sh) | macOS / Linux |
| PDF → applied commits | [scripts/pdf_to_patch.py](../scripts/pdf_to_patch.py) | **Windows / macOS / Linux** (pure Python) |

Fidelity is **byte-for-byte identical** because the patch is
base64-encoded before being rendered — no risk of PDF word-wrap or
whitespace mangling corrupting the diff.

---

## Prerequisites

| Side | Required tools |
| --- | --- |
| **Source** (produce PDF) | `git`, `base64`, and either **`enscript` + `ps2pdf`** (`brew install enscript ghostscript`) *or* macOS's built-in **`cupsfilter`** (zero install) |
| **Destination** (restore) | `git`, `base64`, and either **`pdftotext`** (`brew install poppler`) *or* **`python3`** (built-in on macOS — the script auto-installs `pypdf` into a temp venv on first run) |

Everything on a stock macOS works out of the box: `patch-to-pdf.sh` falls
back to `cupsfilter`, `pdf-to-patch.sh` falls back to `python3 + pypdf`.

---

## Producing the PDF

### Common recipes

```bash
# Last commit → out/commit-YYYYMMDD-hhmmss.pdf
./scripts/patch-to-pdf.sh

# A range (everything on this branch not yet on origin/main)
./scripts/patch-to-pdf.sh origin/main..HEAD

# A specific SHA
./scripts/patch-to-pdf.sh -1 ea63f30

# Multiple commits by count
./scripts/patch-to-pdf.sh -3 HEAD

# Custom output path
./scripts/patch-to-pdf.sh -o out/sp500-feature.pdf HEAD~3..HEAD
```

### Sample output

```
[done]
  commits:   1
  patch:     324 KB
  pdf:       268 KB
  path:      /Users/you/repo/out/commit-20260908-092209.pdf

Restore with:
  scripts/pdf-to-patch.sh "/Users/you/repo/out/commit-20260908-092209.pdf"
```

### What's inside the PDF

```
===== chart-fin commit patch (base64) =====
generated: 2026-09-08T09:22:09Z
repo:      https://github.com/simonkrpaul/chart-fin.git
range:     -1 HEAD
sha1(payload): 18e3cd443be8461fcafc06f33e93ec6b0e02c632
----- BEGIN PATCH BASE64 -----
RnJvbSBhZWQ3NDA0ZWY2M2NlYjM3MDkzODlhMDdlYjM1YjQwYjcwMTM1MTUxIE1vbiBTZXAgIDEg
MjA6NDA6NTMgMjAyNiArMDEwMApGcm9tOiByYWphbnBzaSA8c2ltb24ucmFqYW5wYXVsQGNiYS5j
b20uYXU+CkRhdGU6IE1vbiwgNyBTZXAgMjAyNiAxNzoxOTozMSArMTAwMApTdWJqZWN0OiBbUEFU
Q0hdIGZlYXQ6IG1ham9yIHVwZGF0ZXMgdG8gaW5nZXN0IHNwIDUwMAotLS0KIC5naXRpZ25vcmUg
…
----- END PATCH BASE64 -----
```

A reviewer sees the header (author, repo URL, sha1) and can eyeball that
the payload is legitimate base64 rather than smuggled binary.

---

## Restoring on the other machine

### Three modes

```bash
# 1) Dry-run — does the patch parse and apply cleanly on top of HEAD?
./scripts/pdf-to-patch.sh --check out/commit-20260908-092209.pdf

# 2) Extract only — write the .patch next to the PDF, don't touch the tree
./scripts/pdf-to-patch.sh --extract-only out/commit-20260908-092209.pdf

# 3) Apply — extract, verify sha1, run `git am`
./scripts/pdf-to-patch.sh out/commit-20260908-092209.pdf
```

### Sample apply output

```
[ok] payload sha1 matches: 18e3cd443be8461fcafc06f33e93ec6b0e02c632
[extracted] commits=1 size=324KB path=/tmp/…/commit.patch
--- applying via git am ---
Applying: feat: major updates to ingest sp 500

[done] Applied. Verify with:
  git log -1
```

### If `git am` conflicts

```
[fail] git am stopped. Fix conflicts, then:
  git am --continue    # after resolving
  git am --skip        # skip this commit
  git am --abort       # bail out entirely
```

Standard `git am` recovery. Resolve conflicts in your editor, `git add`
the fixes, then `git am --continue`.

### Windows destination (or any box without bash)

Use the pure-Python variant — same three modes, same sentinels, same
sha1 verification:

```powershell
# 1) Dry-run
python scripts\pdf_to_patch.py --check out\commit-20260908-092209.pdf

# 2) Extract only
python scripts\pdf_to_patch.py --extract-only out\commit-20260908-092209.pdf

# 3) Apply
python scripts\pdf_to_patch.py out\commit-20260908-092209.pdf
```

Requirements: Python 3.8+ and `git` on `PATH`. The script auto-installs
`pypdf` (`pip install --user pypdf`) on first run if it's missing — no
`poppler` / `pdftotext` needed. Works identically on Git Bash, WSL,
PowerShell, cmd.exe, macOS Terminal, and Linux.

---

## Why this works when a plain PDF would corrupt the diff

- **`base64 -b 72`** encodes the binary/patch data using only 64 ASCII
  characters. No PDF renderer can turn `A` into `Á` or swallow a
  trailing space.
- **Sentinels** (`----- BEGIN PATCH BASE64 -----` / `END`) let the
  extractor find the payload deterministically regardless of what
  headers or footers the PDF pipeline adds.
- **sha1 header** is verified after decoding. If the PDF was
  re-exported by a lossy converter (some SharePoint / DLP scanners
  do this), you'll see `[warn] payload sha1 MISMATCH` **before**
  `git am` fails cryptically 20 minutes later.
- **`--binary`** flag on `git format-patch` keeps binary files
  (PNGs, ZIPs, PDFs inside the repo) intact through the pipeline.

---

## Verify fidelity yourself

Round-trip a commit and diff against the raw `git format-patch`
output — should be byte-identical:

```bash
./scripts/patch-to-pdf.sh -o /tmp/test.pdf
./scripts/pdf-to-patch.sh --extract-only /tmp/test.pdf
diff <(git format-patch --binary --stdout -1 HEAD) /tmp/test.patch \
  && echo '✓ byte-for-byte identical'
```

---

## Corporate transport tips

- **Filenames** in `out/` are timestamped and don't reveal SHAs — safe to
  attach without exposing internal branch history.
- **The `out/` directory is gitignored** so you don't accidentally commit
  the PDFs back.
- **File size** — the PDF is roughly the same size as the patch. A 1 MB
  commit is ~1.3 MB PDF because base64 adds ~33 %.
- **Compliance review** — the PDF is human-readable at the top (author,
  repo, sha1). Reviewers can approve based on the header + line count
  even if they can't manually inspect the payload.
- **DLP scanners** occasionally re-render PDFs, breaking the base64
  extraction. If sha1 mismatches on the destination, ask IT to whitelist
  your file or send the raw `.patch` instead (both scripts also work on
  `.patch` files directly — `pdf-to-patch.sh --extract-only` writes one
  next to the PDF).
