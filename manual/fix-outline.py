"""Rewrite duplicated bookmark titles in the generated manual.

Chromium's tagged-PDF writer emits the text of a heading twice in the
structure tree when that heading starts a page, so the generated outline
contains titles such as "ContentsContents". This script clones the PDF and
repairs those titles in place, leaving pages and content untouched.

usage: python fix-outline.py <in.pdf> <out.pdf>
"""
import sys
from pypdf import PdfReader, PdfWriter
from pypdf.generic import NameObject, TextStringObject

# The manual exists in English and Arabic; the Windows console defaults to a
# legacy code page that cannot encode Arabic bookmark titles.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass

src, dst = sys.argv[1], sys.argv[2]
reader = PdfReader(src)
writer = PdfWriter(clone_from=reader)


def undouble(title: str) -> str:
    """Collapse "XYXY" and "XY XY" (space or nbsp separator) to "XY".

    Headings can contain internal spaces, so we cannot simply split on a
    separator; instead test every split point for an exact second copy.
    """
    t = title.strip()
    n = len(t)
    for k in range(1, n):
        a = t[:k]
        b = t[k:]
        if b == a:
            return a
        for sep in (" ", "\u00a0"):
            if b.startswith(sep) and b[len(sep):] == a:
                return a
    return title


fixed = []


def walk(node):
    while node is not None:
        obj = node.get_object()
        title = obj.get("/Title")
        if title is not None:
            text = str(title)
            new = undouble(text)
            if new != text:
                obj[NameObject("/Title")] = TextStringObject(new)
                fixed.append((text, new))
            child = obj.get("/First")
            if child is not None:
                walk(child)
        node = obj.get("/Next")


root = writer._root_object
outlines = root.get("/Outlines")
if outlines is not None:
    walk(outlines.get_object().get("/First"))

writer.add_metadata({"/Title": reader.metadata.get("/Title", "REA Studio — User Manual")})
with open(dst, "wb") as fh:
    writer.write(fh)

print(f"repaired {len(fixed)} bookmark titles")
for old, new in fixed:
    print(f"  {old!r} -> {new!r}")
