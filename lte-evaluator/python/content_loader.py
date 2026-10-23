"""
LTE Experiential Learning Platform – Content Loader
=====================================================
Uploads page content (text, PDF, images, video metadata) to the Cloudflare
Worker's KV store via the /api/content/upload endpoint.

Usage
-----
    python content_loader.py --url https://your-worker.workers.dev \\
                              --path ./content_files

    # Upload a single file
    python content_loader.py --url https://your-worker.workers.dev \\
                              --file module1/page3.txt \\
                              --key module1-page3 \\
                              --title "Action Verbs – Deep Dive"

    # Upload a folder of files recursively
    python content_loader.py --url https://your-worker.workers.dev \\
                              --path ./content_files --recursive

    # List what's already stored
    python content_loader.py --url https://your-worker.workers.dev --list

Dependencies
------------
    pip install requests pypdf2 Pillow
    (pypdf2 and Pillow are optional – graceful fallback if missing)
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Optional

import requests

# ── Optional: PDF text extraction ──────────────────────────────────────────
try:
    import PyPDF2
    HAS_PYPDF2 = True
except ImportError:
    HAS_PYPDF2 = False

# ── Optional: Image metadata extraction ────────────────────────────────────
try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

# ── File type helpers ───────────────────────────────────────────────────────
TEXT_EXTENSIONS = {".txt", ".md", ".rst", ".html", ".htm", ".csv", ".json", ".xml"}
PDF_EXTENSIONS = {".pdf"}
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"}
VIDEO_EXTENSIONS = {".mp4", ".mkv", ".avi", ".mov", ".webm"}
AUDIO_EXTENSIONS = {".mp3", ".wav", ".ogg", ".m4a", ".flac"}


def safe_key(filename: str) -> str:
    """Convert a filename to a safe KV key."""
    stem = Path(filename).stem
    return "".join(c if c.isalnum() or c in "-_." else "-" for c in stem).strip("-").lower()


def extract_text_from_pdf(path: Path) -> str:
    """Extract text from a PDF file using PyPDF2."""
    if not HAS_PYPDF2:
        return f"[PDF: {path.name}] (install pypdf2 for text extraction)"
    text_parts = []
    try:
        with open(path, "rb") as f:
            reader = PyPDF2.PdfReader(f)
            for page in reader.pages:
                text = page.extract_text()
                if text:
                    text_parts.append(text)
        return "\n\n".join(text_parts) if text_parts else f"[PDF: {path.name} – no extractable text]"
    except Exception as e:
        return f"[PDF: {path.name} – extraction error: {e}]"


def extract_image_description(path: Path) -> str:
    """Generate a metadata description for an image."""
    desc = f"[IMAGE: {path.name}"
    if HAS_PIL:
        try:
            with Image.open(path) as img:
                desc += f", format={img.format}, size={img.size[0]}x{img.size[1]}, mode={img.mode}"
        except Exception:
            pass
    desc += f", size_bytes={path.stat().st_size}]"
    return desc


def read_file_content(path: Path) -> tuple[str, str]:
    """
    Read a file and return (content_text, content_type).
    content_type is one of: text | pdf | image | video | audio
    """
    ext = path.suffix.lower()

    if ext in TEXT_EXTENSIONS:
        try:
            return path.read_text(encoding="utf-8", errors="replace"), "text"
        except Exception as e:
            return f"[ERROR reading {path.name}: {e}]", "text"

    if ext in PDF_EXTENSIONS:
        return extract_text_from_pdf(path), "pdf"

    if ext in IMAGE_EXTENSIONS:
        return extract_image_description(path), "image"

    if ext in VIDEO_EXTENSIONS:
        stat = path.stat()
        return (
            f"[VIDEO: {path.name}, size_bytes={stat.st_size}, "
            f"modified={time.ctime(stat.st_mtime)}]",
            "video",
        )

    if ext in AUDIO_EXTENSIONS:
        stat = path.stat()
        return (
            f"[AUDIO: {path.name}, size_bytes={stat.st_size}, "
            f"modified={time.ctime(stat.st_mtime)}]",
            "audio",
        )

    # Unknown type – try reading as text
    try:
        return path.read_text(encoding="utf-8", errors="replace"), "text"
    except Exception:
        return f"[BINARY: {path.name}, size={path.stat().st_size} bytes]", "binary"


# ── API client ──────────────────────────────────────────────────────────────

class LTEClient:
    def __init__(self, base_url: str, timeout: int = 60):
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()
        self.timeout = timeout

    def upload_content(
        self,
        key: str,
        title: str,
        content: str,
        content_type: str = "text",
    ) -> dict:
        """Upload content as JSON to /api/content/upload."""
        payload = {
            "key": key,
            "title": title,
            "type": content_type,
            "content": content,
        }
        resp = self.session.post(
            f"{self.base_url}/api/content/upload",
            json=payload,
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return resp.json()

    def upload_file(self, path: Path, key: str, title: str) -> dict:
        """Upload a file as multipart to /api/content/upload."""
        with open(path, "rb") as f:
            files = {"file": (path.name, f, _mime_type(path))}
            data = {"key": key, "title": title, "type": _content_type(path)}
            resp = self.session.post(
                f"{self.base_url}/api/content/upload",
                files=files,
                data=data,
                timeout=self.timeout,
            )
        resp.raise_for_status()
        return resp.json()

    def list_content(self) -> list[dict]:
        resp = self.session.get(
            f"{self.base_url}/api/content/list",
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return resp.json().get("keys", [])

    def health(self) -> dict:
        resp = self.session.get(f"{self.base_url}/api/health", timeout=10)
        resp.raise_for_status()
        return resp.json()


def _mime_type(path: Path) -> str:
    ext = path.suffix.lower()
    mapping = {
        ".txt": "text/plain", ".md": "text/markdown",
        ".pdf": "application/pdf",
        ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
        ".mp4": "video/mp4", ".webm": "video/webm",
        ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg",
    }
    return mapping.get(ext, "application/octet-stream")


def _content_type(path: Path) -> str:
    ext = path.suffix.lower()
    if ext in TEXT_EXTENSIONS or ext in PDF_EXTENSIONS:
        return "text" if ext != ".pdf" else "pdf"
    if ext in IMAGE_EXTENSIONS:
        return "image"
    if ext in VIDEO_EXTENSIONS:
        return "video"
    if ext in AUDIO_EXTENSIONS:
        return "audio"
    return "text"


# ── CLI ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="LTE Content Loader – upload page content to Cloudflare Worker KV",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--url", required=True,
        help="Base URL of your deployed Worker, e.g. https://lte-evaluator.your-subdomain.workers.dev"
    )
    parser.add_argument("--file", help="Path to a single file to upload")
    parser.add_argument("--path", help="Path to a folder of files to upload")
    parser.add_argument("--key", help="KV key for single file upload (default: derived from filename)")
    parser.add_argument("--title", help="Title for single file upload (default: filename)")
    parser.add_argument("--recursive", action="store_true", help="Recurse into subdirectories")
    parser.add_argument("--list", action="store_true", help="List all stored content keys and exit")
    parser.add_argument("--text", help="Upload inline text content (use with --key and --title)")
    parser.add_argument("--timeout", type=int, default=60, help="HTTP timeout in seconds (default: 60)")
    args = parser.parse_args()

    client = LTEClient(args.url, timeout=args.timeout)

    # ── Health check ──────────────────────────────────────────────────────
    print(f"🔗 Connecting to {args.url}…")
    try:
        health = client.health()
        print(f"✅ Worker healthy: {health}")
    except Exception as e:
        print(f"❌ Cannot reach worker: {e}", file=sys.stderr)
        sys.exit(1)

    # ── List mode ─────────────────────────────────────────────────────────
    if args.list:
        keys = client.list_content()
        if not keys:
            print("📭 No content stored yet.")
        else:
            print(f"\n📦 Stored content ({len(keys)} items):\n")
            for k in keys:
                meta = k.get("metadata") or {}
                print(f"  • {k['name']:40s}  type={meta.get('type','?'):8s}  title={meta.get('title','')}")
        return

    # ── Inline text ───────────────────────────────────────────────────────
    if args.text:
        key = args.key or f"content-{int(time.time())}"
        title = args.title or key
        print(f"📤 Uploading inline text as '{key}'…")
        result = client.upload_content(key, title, args.text)
        print(f"✅ {result}")
        return

    # ── Single file ───────────────────────────────────────────────────────
    if args.file:
        path = Path(args.file)
        if not path.exists():
            print(f"❌ File not found: {path}", file=sys.stderr)
            sys.exit(1)
        upload_single(client, path, key=args.key, title=args.title)
        return

    # ── Folder ────────────────────────────────────────────────────────────
    if args.path:
        folder = Path(args.path)
        if not folder.is_dir():
            print(f"❌ Not a directory: {folder}", file=sys.stderr)
            sys.exit(1)

        pattern = "**/*" if args.recursive else "*"
        files = [p for p in folder.glob(pattern) if p.is_file()]

        if not files:
            print("⚠️  No files found.")
            return

        print(f"\n📂 Uploading {len(files)} file(s) from {folder}…\n")
        success, failed = 0, 0
        for f in sorted(files):
            try:
                upload_single(client, f)
                success += 1
            except Exception as e:
                print(f"  ❌ {f.name}: {e}")
                failed += 1

        print(f"\n{'─'*40}")
        print(f"✅ Success: {success}  ❌ Failed: {failed}")
        return

    parser.print_help()


def upload_single(
    client: LTEClient,
    path: Path,
    key: Optional[str] = None,
    title: Optional[str] = None,
) -> None:
    key = key or safe_key(path.name)
    title = title or path.name
    content, ctype = read_file_content(path)

    print(f"  📤 {path.name:40s} → key='{key}'  type={ctype}", end="  ", flush=True)
    result = client.upload_content(key, title, content, ctype)
    print(f"✅ {result.get('bytes', '?')} chars stored")


if __name__ == "__main__":
    main()
