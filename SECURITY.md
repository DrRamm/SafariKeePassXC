# Security Policy

SafariKeePassXC bridges Safari to your local KeePassXC database, so security issues here can expose
saved logins and passwords. If you find a vulnerability, please report it privately rather than
opening a public issue.

## Reporting a Vulnerability

Open a private security advisory on GitHub
(<https://github.com/DrRamm/SafariKeePassXC/security/advisories/new>) with a description of the issue
and, if possible, steps to reproduce. Please do not disclose the issue publicly until a fix has been
released.

## Scope

Security-relevant areas include:

- The `BridgeServer` Unix socket relay between the sandboxed Safari extension and the host app, and
  its token-based authentication (`BridgeToken.swift`)
- The KeePassXC-Browser protocol implementation and its NaCl/libsodium encryption
  (`KeePassXCClient.swift`, `KeePassXCCrypto.swift`)
- Keychain usage for storing the bridge token and the KeePassXC association (data protection
  keychain)
- The Safari extension's native messaging and content-script handling of credentials

General bugs that don't have security impact (UI glitches, autofill not matching a site, etc.)
should be reported as normal GitHub issues instead.

## Security model

KeePassXC exposes a local Unix domain socket that browser extensions connect to and encrypt
messages over using NaCl/libsodium public-key crypto (the same handshake used by the official
KeePassXC-Browser extension). Safari Web Extensions run in a sandboxed app extension process and
cannot reach that socket directly, so SafariKeePassXC relays through a small host app:

```text
Safari Extension (sandboxed)  <--Unix socket-->  Host App (BridgeServer)  <--Unix socket-->  KeePassXC
```

- **Host app ↔ KeePassXC:** encrypted with the KeePassXC-Browser protocol (NaCl `crypto_box`).
- **Safari extension ↔ host app:** a local Unix socket inside the extension's sandbox container.
  Every connection must first present a random 32-byte token generated at launch and stored in the
  shared Keychain access group; the messages on this link are *not* encrypted a second time. They
  never leave your Mac.
- **Clipboard:** generated passwords and TOTP codes you copy from the popup are placed on the system
  clipboard and stay there until something else is copied. Clipboard managers or Universal
  Clipboard (Handoff) may keep or sync them.

## Why it is safe

Everything listed here can be checked against the source in this repository.

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
- **Releases are signed and notarized.** See
  [Verifying a release](docs/RELEASING.md#verifying-a-release).

## Permissions

The extension requests the minimum it needs
(`SafariKeePassXC Extension/Resources/manifest.json`):

| Permission | Why it is needed | What it does **not** allow |
|---|---|---|
| `nativeMessaging` | Talk to the containing macOS app, which is the only path to KeePassXC. | Talking to other apps, reading files, or network access. |
| `activeTab` | Read the URL of the tab the user acts on, to look up matching logins. | Access to tabs the user did not invoke the extension on. |
| `storage` | Persist settings (save group, autofill/save toggles, passkeys toggle). | Storing passwords or the vault. |

There are **no** `host_permissions` and no optional permissions. The only broad access is the
content-script declaration for `http://*/*` and `https://*/*` (top frame only, see below); there is
no `cookies`, `webRequest`, `scripting`, `tabs`, or `<all_urls>` permission.

## Content scripts

| Script | Runs on | When | Frame |
|---|---|---|---|
| `content.js` | `http://*/*`, `https://*/*` | document idle | top frame only |
| `passkeys-page.js` | `https://*/*` | `document_start` | top frame only, `MAIN` world |
| `passkeys-content.js` | `https://*/*` | `document_start` | top frame only |

`passkeys-page.js` is the only web-accessible resource, and only for `https://*/*`. It is the
WebAuthn shim that lets a page ask SafariKeePassXC for a passkey; it does not expose vault data to
the page. All other extension resources (popup, background, locales, icons) are not web-accessible.

## Native side

- The Safari extension itself is sandboxed and only talks to the host app through the
  token-authenticated bridge socket.
- The host app is **not** sandboxed, because a sandboxed app cannot reach KeePassXC's Unix socket.
  A compromise of the host app therefore has the privileges of the user — this is a deliberate,
  documented trade-off.
- Both targets share a single Keychain access group,
  `$(AppIdentifierPrefix)yauheni.tech.SafariKeePassXC` (that is
  `<TeamID>.yauheni.tech.SafariKeePassXC` at runtime), for the bridge token and the KeePassXC
  association. Items use the data-protection keychain with
  `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` / `AfterFirstUnlockThisDeviceOnly`, so they are not
  synced to iCloud.
- Credentials are plaintext in process memory and on the local sockets while autofill runs; the
  sockets are local and owned by the user, and the KeePassXC leg is encrypted.

## Network access

- The **extension makes no network requests at all**. It has no host permissions and its code
  contains no remote `fetch` calls.
- The **host app** performs one outbound HTTPS request: once a week it asks
  `api.github.com/repos/DrRamm/SafariKeePassXC/releases/latest` whether a newer release exists
  (`SafariKeePassXC/UpdateChecker.swift`). The request contains no credentials, no account
  identifiers and no vault data; it is a plain GitHub API call that sends the app version in the
  `SafariKeePassXC/<version>` user agent. No downloads happen automatically — the release page is
  only opened in the browser.

## Caveats

- **Autofill also works on plain HTTP pages.** `content.js` matches `http://*/*` as well as
  `https://*/*`, so a login can be filled into an HTTP form, where it is exposed to network
  attackers. Passkeys are HTTPS-only. The extension does not block or downgrade HTTP pages; prefer
  HTTPS sites.
- **The host app has user-level privileges and unrestricted network access.** It is not sandboxed
  (see above), so "your vault stays local" is a property of the current code, not something macOS
  enforces. The update check described above is the only network request the current code makes.
- **Clipboard contents are visible to other apps** and may be kept or synced by clipboard managers
  and Universal Clipboard.

## Supply chain

- The only third-party runtime dependency is [swift-sodium](https://github.com/jedisct1/swift-sodium)
  (ISC License), pinned to an exact revision in
  `SafariKeePassXC.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved`.
- The WebAuthn RP ID check uses a snapshot of the [Public Suffix List](https://publicsuffix.org)
  (MPL-2.0), generated by `scripts/update-public-suffixes.py` and committed to the repository.
- There is no npm/Node runtime dependency: the popup, background and content scripts are plain
  HTML/CSS/ES modules. Node is only used to run the tests.
- CI runs on every pull request and on `main`; a release is only built from a tagged commit on
  `main` by the workflow described in [docs/RELEASING.md](docs/RELEASING.md).
