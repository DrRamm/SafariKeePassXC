# SafariKeePassXC

A Safari Web Extension that connects Safari to [KeePassXC](https://keepassxc.org) using the same
[KeePassXC-Browser protocol](https://github.com/keepassxreboot/keepassxc-browser) implemented by the
official browser extensions for Chrome and Firefox. It lets you autofill logins, save new entries,
use passkeys, and generate passwords directly from Safari on macOS, backed by your local KeePassXC
database.

## How it works

KeePassXC exposes a local Unix domain socket that browser extensions connect to and encrypt messages
over using NaCl/libsodium public-key crypto (the same handshake used by the official KeePassXC-Browser
extension).

Safari Web Extensions, however, run in a sandboxed app extension process and cannot reach that socket
directly. SafariKeePassXC works around this with a small relay:

```
Safari Extension (sandboxed)  <--Unix socket-->  Host App (BridgeServer)  <--Unix socket-->  KeePassXC
```

### Security model

- **Host app ↔ KeePassXC:** encrypted with the KeePassXC-Browser protocol (NaCl `crypto_box`).
- **Safari extension ↔ host app:** a local Unix socket inside the extension's sandbox container.
  Every connection must first present a random 32-byte token generated at launch and stored in the
  shared Keychain access group; the messages on this link are *not* encrypted a second time. They
  never leave your Mac.
- **Clipboard:** generated passwords and TOTP codes you copy from the popup are placed on the system
  clipboard and stay there until something else is copied. Clipboard managers or Universal Clipboard
  (Handoff) may keep or sync them.

## Security

SafariKeePassXC is a password manager bridge, so its security properties are documented explicitly
below. Everything listed here can be checked against the source in this repository.

### Why it is safe

- **Your vault stays local.** The extension never talks to a server. Passwords, TOTP secrets and
  passkeys are read from KeePassXC over a local Unix socket and are never uploaded anywhere.
- **Only KeePassXC can decrypt the traffic.** The host app speaks the KeePassXC-Browser protocol:
  X25519 key exchange plus `crypto_box` (XSalsa20-Poly1305) authenticated encryption. The extension
  never sees KeePassXC's private key.
- **Only the real extension can use the bridge.** The host app generates a fresh random 32-byte token
  on every launch and stores it in the shared Keychain access group. A connection that does not
  present the correct token (compared in constant time) is rejected before any request is processed
  (`SafariKeePassXC/KeePassXC/BridgeServer.swift`, `BridgeToken.swift`).
- **The extension is sandboxed.** It cannot open files, spawn processes, or reach the network. Its
  only way out is `nativeMessaging` to the containing app.
- **Autofill stays in the top frame.** `all_frames` is disabled for every content script, so
  embedded cross-origin iframes can never receive credentials.
- **Passkeys are validated twice.** The page-world adapter only runs on HTTPS, the background script
  derives the origin from the sender URL (never from page-supplied data), and the RP ID must be the
  origin host or a registrable suffix of it, checked against the bundled Public Suffix List
  (`background.js`, `scripts/update-public-suffixes.py`). The native handler re-checks the request
  shape (`SafariWebExtensionHandler.swift`, `PasskeyRequest.swift`).
- **Every socket operation has a timeout**, so a hung peer cannot block the app forever.
- **Releases are signed and notarized.** See [Verifying a release](#verifying-a-release).

### Permissions

The extension requests the minimum it needs (`SafariKeePassXC Extension/Resources/manifest.json`):

| Permission | Why it is needed | What it does **not** allow |
|---|---|---|
| `nativeMessaging` | Talk to the containing macOS app, which is the only path to KeePassXC. | Talking to other apps, reading files, or network access. |
| `activeTab` | Read the URL of the tab the user acts on, to look up matching logins. | Access to tabs the user did not invoke the extension on. |
| `storage` | Persist settings (save group, autofill/save toggles, passkeys toggle). | Storing passwords or the vault. |

There are **no** `host_permissions` and no optional permissions. The only broad access is the
content-script declaration for `http://*/*` and `https://*/*` (top frame only, see below); there is
no `cookies`, `webRequest`, `scripting`, `tabs`, or `<all_urls>` permission.

### Content scripts

| Script | Runs on | When | Frame |
|---|---|---|---|
| `content.js` | `http://*/*`, `https://*/*` | document idle | top frame only |
| `passkeys-page.js` | `https://*/*` | `document_start` | top frame only, `MAIN` world |
| `passkeys-content.js` | `https://*/*` | `document_start` | top frame only |

`passkeys-page.js` is the only web-accessible resource, and only for `https://*/*`. It is the
WebAuthn shim that lets a page ask SafariKeePassXC for a passkey; it does not expose vault data to
the page. All other extension resources (popup, background, locales, icons) are not web-accessible.

### Native side

- The Safari extension itself is sandboxed and only talks to the host app through the
  token-authenticated bridge socket.
- The host app is **not** sandboxed, because a sandboxed app cannot reach KeePassXC's Unix socket.
  A compromise of the host app therefore has the privileges of the user — this is a deliberate,
  documented trade-off (see [SECURITY.md](SECURITY.md)).
- Both targets share a single Keychain access group,
  `$(AppIdentifierPrefix)dev.kotsareu.SafariKeePassXC` (that is
  `<TeamID>.dev.kotsareu.SafariKeePassXC` at runtime), for the bridge token and the KeePassXC
  association. Items use the data-protection keychain with
  `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` / `AfterFirstUnlockThisDeviceOnly`, so they are not
  synced to iCloud.
- Credentials are plaintext in process memory and on the local sockets while autofill runs; the
  sockets are local and owned by the user, and the KeePassXC leg is encrypted.

### Network access

- The **extension makes no network requests at all**. It has no host permissions and its code
  contains no remote `fetch` calls.
- The **host app** performs one outbound HTTPS request: once a week it asks
  `api.github.com/repos/DrRamm/SafariKeePassXC/releases/latest` whether a newer release exists
  (`SafariKeePassXC/UpdateChecker.swift`). The request contains no credentials, no account
  identifiers and no vault data; it is a plain GitHub API call that sends the app version in the
  `SafariKeePassXC/<version>` user agent. No downloads happen automatically — the release page is
  only opened in the browser.

### Caveats

- **Autofill also works on plain HTTP pages.** `content.js` matches `http://*/*` as well as
  `https://*/*`, so a login can be filled into an HTTP form, where it is exposed to network
  attackers. Passkeys are HTTPS-only. The extension does not block or downgrade HTTP pages; prefer
  HTTPS sites.
- **The host app has user-level privileges and unrestricted network access.** It is not sandboxed
  (see above), so "your vault stays local" is a property of the current code, not something macOS
  enforces. The update check described above is the only network request the current code makes.
- **Clipboard contents are visible to other apps** and may be kept or synced by clipboard managers
  and Universal Clipboard.

### Supply chain

- The only third-party runtime dependency is [swift-sodium](https://github.com/jedisct1/swift-sodium)
  (ISC License), pinned to an exact revision in
  `SafariKeePassXC.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`.
- The WebAuthn RP ID check uses a snapshot of the [Public Suffix List](https://publicsuffix.org)
  (MPL-2.0), generated by `scripts/update-public-suffixes.py` and committed to the repository.
- There is no npm/Node runtime dependency: the popup, background and content scripts are plain
  HTML/CSS/ES modules. Node is only used to run the tests.
- CI runs on every pull request and on `main`; a release is only built from a tagged commit on
  `main` by the workflow described in [Releases](#releases).

### Verifying a release

Every release DMG is signed with a **Developer ID Application** certificate, notarized by Apple and
stapled. You can verify a download yourself:

```bash
# 1. Check the checksum published next to the DMG
shasum -a 256 -c SafariKeePassXC-<version>.dmg.sha256

# 2. Check the signature and the notarization ticket
codesign --verify --deep --strict --verbose=2 /Applications/SafariKeePassXC.app
codesign -dv --verbose=4 /Applications/SafariKeePassXC.app     # Authority: Developer ID Application: …
spctl -a -vvv -t exec /Applications/SafariKeePassXC.app        # accepted, source=Notarized Developer ID

# 3. Check the DMG itself
xcrun stapler validate SafariKeePassXC-<version>.dmg
spctl -a -t open --context context:primary-signature -v SafariKeePassXC-<version>.dmg
```

### Reporting a vulnerability

Please do not open a public issue for security problems. See [SECURITY.md](SECURITY.md) for the
private reporting address and the in-scope areas.

## Requirements

- macOS 26.5 (Tahoe) or later, with the Safari version that ships with it
- [KeePassXC](https://keepassxc.org) installed, with the browser integration enabled in
  **Settings → Browser Integration**
- Xcode 26 or later to build the app

## Download

- [GitHub Releases](https://github.com/DrRamm/SafariKeePassXC/releases) — signed and notarized DMGs
- [SafariKeePassXC Official Website](https://www.griesslehner.at/safarikeepassxc.html)

## Install

1. Download the latest `SafariKeePassXC-<version>.dmg` from
   [GitHub Releases](https://github.com/DrRamm/SafariKeePassXC/releases).
2. Open the DMG and drag **SafariKeePassXC** to **Applications**.
3. Launch the app once. macOS verifies the signature and the notarization ticket.
4. In Safari, open **Settings → Extensions**, enable **SafariKeePassXC**, and allow it on the sites
   you want to use it on.
5. Open the extension popup and pair it with KeePassXC when prompted.

## Building

1. Open `SafariKeePassXC.xcodeproj` in Xcode.
2. Select your own Development Team in the project's signing settings for both the `SafariKeePassXC`
   and `SafariKeePassXC Extension` targets (required for local code signing).
3. Build and run the `SafariKeePassXC` scheme.
4. Enable the extension in Safari under **Settings → Extensions**.

## Tests

The project has two test suites, both run by CI:

```bash
# JavaScript unit tests (popup generator/search, passkey adapters)
node --test tests/*.test.mjs

# Swift unit tests (crypto, bridge, sockets, passkey validation)
xcodebuild test \
  -project SafariKeePassXC.xcodeproj \
  -scheme SafariKeePassXC \
  -destination 'platform=macOS' \
  -only-testing:SafariKeePassXCTests \
  CODE_SIGNING_ALLOWED=NO
```

The Keychain-backed tests (`AssociationStore`, `BridgeToken.verify`) are skipped automatically when
the test host is not signed with a provisioning profile (for example with `CODE_SIGNING_ALLOWED=NO`
in CI), because the data-protection keychain is unavailable to unsigned builds. Run the tests from
Xcode with your team selected to execute them.

You can also run the Swift tests from Xcode. `scripts/check-versions.sh` verifies that the app and
extension `MARKETING_VERSION` values and the extension manifest version all match.

## Releases

Releases are fully automated by GitHub Actions. Nothing is built on a maintainer's machine.

### Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every pull request and on pushes to
`main`:

1. checks that `MARKETING_VERSION` (app and extension targets) and `version`
   (`manifest.json`) are identical;
2. validates `manifest.json` and every `_locales/*/messages.json` as JSON;
3. runs the JavaScript test suite;
4. builds the app and runs the Swift unit tests (unsigned, keychain tests skipped).

A red CI run should block merging — enable branch protection on `main` to enforce it.

### Cutting a release

1. Bump the version in **both** places (they must match):
   - `MARKETING_VERSION` in `SafariKeePassXC.xcodeproj/project.pbxproj` (app and extension targets);
   - `version` in `SafariKeePassXC Extension/Resources/manifest.json`.
2. Commit the bump on `main` and push.
3. Tag the commit and push the tag:

   ```bash
   git tag v1.2.5
   git push origin v1.2.5
   ```

4. [`.github/workflows/release.yml`](.github/workflows/release.yml) takes over:
   - runs the same checks as CI first and refuses to publish if they fail;
   - refuses to run unless the tag points to a commit on `main`;
   - fails immediately if the tag does not match the versions from step 1;
   - imports the signing certificates into a temporary keychain;
   - archives the app in `Release` configuration and exports it with **Developer ID Application**
     signing (automatic signing, profiles managed through the App Store Connect API key);
   - verifies that the app and the embedded `.appex` carry a `Developer ID Application` authority;
   - notarizes the app, staples the ticket, and checks it with `spctl`;
   - builds `SafariKeePassXC-<version>.dmg` (app + `/Applications` shortcut), signs the DMG,
     notarizes it, staples it, and validates it;
   - writes `SafariKeePassXC-<version>.dmg.sha256`;
   - publishes a GitHub Release with the DMG, the checksum and auto-generated release notes.

The tag and the release are the only source of truth: the DMG in a GitHub Release is exactly the
artifact that CI signed and notarized.

### Required repository secrets

Add these under **Settings → Secrets and variables → Actions** (or with `gh secret set`):

| Secret | Content |
|---|---|
| `APPLE_DEVELOPER_ID_CERT_P12_BASE64` | Base64 of a `.p12` containing the **Developer ID Application** certificate and an **Apple Development** certificate, both with their private keys. |
| `APPLE_DEVELOPER_ID_CERT_PASSWORD` | Password used when exporting the `.p12`. |
| `APPLE_KEYCHAIN_PASSWORD` | Any random password for the temporary CI keychain. |
| `APPLE_TEAM_ID` | Apple Developer Team ID that owns the app IDs. |
| `APPLE_NOTARY_KEY_P8` | Contents of the App Store Connect API key (`.p8`). |
| `APPLE_NOTARY_KEY_ID` | Key ID of that API key. |
| `APPLE_NOTARY_ISSUER_ID` | Issuer ID of the App Store Connect API key. |

How to create them:

1. **Certificates** — in
   [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates)
   create a *Developer ID Application* certificate (and make sure an *Apple Development* certificate
   exists for the same team). Add both to your login keychain, select them **together** in Keychain
   Access and export them as one `.p12` **with their private keys**. The archive step uses the
   development identity, the export step re-signs with Developer ID. Encode the file for CI:

   ```bash
   base64 -i Signing.p12 | pbcopy   # paste into APPLE_DEVELOPER_ID_CERT_P12_BASE64
   ```

2. **App Store Connect API key** — in
   [App Store Connect → Users and Access → Integrations](https://appstoreconnect.apple.com/access/integrations/api)
   create a key with the *App Manager* role. Download the `.p8` (it can only be downloaded once) and
   copy the Key ID and Issuer ID.

3. The App IDs `dev.kotsareu.SafariKeePassXC` and
   `dev.kotsareu.SafariKeePassXC.Extension` must exist in that team, and the team must be allowed to
   create Developer ID provisioning profiles.

The certificates and the API key are only used inside the release workflow; the temporary keychain
and the API key file are deleted at the end of the run.

## License

SafariKeePassXC is licensed under the [GNU General Public License v3.0](LICENSE).

It depends on [Sodium](https://github.com/jedisct1/swift-sodium) (ISC License), a Swift wrapper around
[libsodium](https://libsodium.org), fetched as a Swift Package Manager dependency.
