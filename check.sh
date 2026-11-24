#!/usr/bin/env bash
# Reproducible acceptance check for the security-audit fixes (upstream issue #3 and
# the semi-supervised audit). Run from the repository root:  ./check.sh
# Exit status 0 = all checks passed.
set -u
status=0
fail() { printf 'FAIL %s\n' "$1"; status=1; }
ok()   { printf 'ok   %s\n' "$1"; }

# 1 - manifest: top-frame only, exact permission set, shipping version.
python3 - <<'PY' || status=1
import json, sys
m = json.load(open("SafariKeePassXC Extension/Resources/manifest.json"))
cs = m["content_scripts"][0]
assert cs["all_frames"] is False, "all_frames must be false (top frame only)"
assert m["permissions"] == ["nativeMessaging", "activeTab", "storage"], m["permissions"]
assert m["version"] == "1.2.4", m["version"]
print("ok   manifest: all_frames=false, permissions=%s, version=%s"
      % (m["permissions"], m["version"]))
PY

# 2 - sandbox flags in the project file match what SECURITY.md documents.
python3 - <<'PY' || status=1
lines = open("SafariKeePassXC.xcodeproj/project.pbxproj").read().splitlines()
def value_at(n):
    return lines[n - 1].split("=", 1)[1].strip().rstrip(";")
assert value_at(611) == "NO" and value_at(653) == "NO", "host app must be unsandboxed"
assert value_at(392) == "YES" and value_at(438) == "YES", "extension must stay sandboxed"
doc = open("SECURITY.md").read()
for needle in ("ENABLE_APP_SANDBOX = NO", "ENABLE_APP_SANDBOX = YES",
               "611", "653", "392", "438",
               "length-prefixed JSON", "crypto_box", "plaintext in process memory"):
    assert needle in doc, "SECURITY.md missing %r" % needle
print("ok   SECURITY.md documents the unsandboxed host app, the plaintext "
      "length-prefixed JSON relay and the encrypted KeePassXC leg")
PY

# 3 - README download section references the published checksum of the attached DMG.
python3 - <<'PY' || status=1
import hashlib, os, urllib.request
readme = open("README.md").read()
published = open("SafariKeePassXC-1.2.3.dmg.sha256").read().split()[0]
assert published in readme, "README does not reference %s" % published
assert "SafariKeePassXC-1.2.3.dmg.sha256" in readme, "README missing checksum file name"
path = "SafariKeePassXC-1.2.3.dmg"
if not os.path.exists(path):
    try:
        with urllib.request.urlopen(
                "https://griesslehner.at/downloads/SafariKeePassXC-1.2.3.dmg", 30) as r:
            open(path, "wb").write(r.read())
    except OSError as error:
        print("skip  DMG digest (unavailable: %s); README matches the published "
              "checksum file %s" % (error, published))
        raise SystemExit(0)
digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
assert digest == published, "%s != %s" % (digest, published)
print("ok   README references the DMG checksum %s (recomputed from the DMG)" % digest)
PY

# 4 - popup.js clears the clipboard entries after both clipboard writes.
python3 - <<'PY' || status=1
src = open("SafariKeePassXC Extension/Resources/popup.js").read()
assert src.count("navigator.clipboard.writeText(") == 2, src.count("navigator.clipboard.writeText(")
assert src.count("clearClipboardEntries(") == 3, "helper + two call sites"
for marker in ("async function generatePassword", "async function copyTotp"):
    body = src.split(marker, 1)[1]
    write = body.index("navigator.clipboard.writeText(")
    clear = body.index("clearClipboardEntries(", write)
    assert write < clear, "%s clears before the write settles" % marker
print("ok   popup.js clears the clipboard entries after each write")
PY

# 5 - both extension scripts still parse.
for f in "SafariKeePassXC Extension/Resources/popup.js" \
         "SafariKeePassXC Extension/Resources/background.js" \
         "SafariKeePassXC Extension/Resources/content.js"; do
  if node --check "$f"; then ok "node --check $f"; else fail "node --check $f"; fi
done

# XCTest: SafariKeePassXCTests uses swift-testing + Darwin and needs xcodebuild,
# which is unavailable on this Linux runner, so it is reported as not verified.
if command -v xcodebuild >/dev/null 2>&1; then
  xcodebuild test -project SafariKeePassXC.xcodeproj -scheme SafariKeePassXC && ok "xcodebuild test" \
    || fail "xcodebuild test"
else
  printf 'skip SafariKeePassXCTests (xcodebuild/swift unavailable on this Linux runner)\n'
fi

exit $status
