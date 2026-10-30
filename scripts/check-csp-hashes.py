#!/usr/bin/env python3
"""Fail if an inline <script> in either app's index.html is not allowed by
the proxy's Content-Security-Policy (ops/nginx/snippets/filspay-headers.conf).
Inline scripts are allowed by SHA-256 hash, so editing one without updating
the CSP would make the browser block it behind the proxy."""
import base64, hashlib, re, sys

csp = open("ops/nginx/snippets/filspay-headers.conf").read()
missing = []
for page in ("apps/web/index.html", "apps/admin/index.html"):
    html = open(page).read()
    for body in re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", html, re.S):
        digest = "'sha256-" + base64.b64encode(hashlib.sha256(body.encode()).digest()).decode() + "'"
        if digest not in csp:
            missing.append(f"{page}: add {digest} to script-src")
print("\n".join(missing) or "csp: every inline script is allowed by hash")
sys.exit(1 if missing else 0)
