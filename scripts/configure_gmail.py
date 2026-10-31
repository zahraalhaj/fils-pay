#!/usr/bin/env python3
"""Save backend Gmail credentials locally; never prints or sends them."""
from getpass import getpass
from pathlib import Path
import json
import os
import re
import tempfile

root = Path(__file__).resolve().parent.parent
path = root / "ops/.env.docker"
values = {}
for key in ("GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"):
    value = getpass(key + " (hidden): ").strip()
    if not value or any(c in value for c in "\r\n"):
        raise SystemExit("Empty or invalid value. Nothing changed.")
    values[key] = value
values["OTP_FROM_EMAIL"] = "FilsPay <roro2004yousif@gmail.com>"
values["OTP_DEV_EXPOSE"] = "false"
lines = path.read_text().splitlines() if path.exists() else []
lines = [line for line in lines if not any(re.match(r"^\s*" + key + r"\s*=", line) for key in values)]
lines.extend(key + "=" + json.dumps(value) for key, value in values.items())
fd, temp = tempfile.mkstemp(dir=path.parent, prefix=".gmail-env-")
try:
    with os.fdopen(fd, "w") as stream:
        stream.write("\n".join(lines) + "\n")
    os.replace(temp, path)
finally:
    if os.path.exists(temp):
        os.unlink(temp)
print("Gmail settings saved. Recreate the API container to load them.")
