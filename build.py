#!/usr/bin/env python3
"""Regenerate derived files. Currently: sidepanel.html from popup.html.

The side panel shows the same UI as the popup; the only differences are a
small override <style> (fluid width, hidden logo/title) and a provenance
comment. Edit popup.html, then run:  python3 build.py
"""
import os

ROOT = os.path.dirname(os.path.abspath(__file__))

OVERRIDE = (
    "  <style>html,body{width:auto !important;max-width:none;} body{padding:16px;}"
    " .header img,.header h1{display:none;} .header{min-height:32px;}</style>\n"
    "  <!-- GENERATED from popup.html by build.py — do not edit -->\n"
)


def main():
    src = open(os.path.join(ROOT, "popup.html"), encoding="utf-8").read()
    if "</head>" not in src:
        raise SystemExit("popup.html: no </head> found")
    out = src.replace("</head>", OVERRIDE + "</head>", 1)
    with open(os.path.join(ROOT, "sidepanel.html"), "w", encoding="utf-8") as f:
        f.write(out)
    print("wrote sidepanel.html")


if __name__ == "__main__":
    main()
