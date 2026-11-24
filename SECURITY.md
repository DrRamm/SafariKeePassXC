# Security Policy

SafariKeePassXC bridges Safari to your local KeePassXC database, so security issues here can expose
saved logins and passwords. If you find a vulnerability, please report it privately rather than opening
a public issue.

## Reporting a Vulnerability

Email **markus@griesslehner.at** with a description of the issue and, if possible, steps to reproduce.
Please do not disclose the issue publicly until a fix has been released.

## Scope

Security-relevant areas include:

- The `BridgeServer` Unix socket relay between the sandboxed Safari extension and the host app, and its
  token-based authentication (`BridgeToken.swift`)
- The KeePassXC-Browser protocol implementation and its NaCl/libsodium encryption
  (`KeePassXCClient.swift`, `KeePassXCCrypto.swift`)
- Keychain usage for storing the bridge token and the KeePassXC association (data protection keychain)
- The Safari extension's native messaging and content-script handling of credentials

## Known Design Decisions

- **The host app is not sandboxed.** It has to reach KeePassXC's Unix socket, which a sandboxed app cannot
  do. `ENABLE_APP_SANDBOX = NO` is set for both host-app configurations in
  `SafariKeePassXC.xcodeproj/project.pbxproj` (lines 611 and 653); the two extension-target configurations
  use `ENABLE_APP_SANDBOX = YES` (lines 392 and 438). A compromise of the host app therefore has the full
  privileges of the user.
- **The extension ↔ host app relay is plaintext, length-prefixed JSON.** `HostBridgeConnection.swift`
  frames every message as a `UInt32` little-endian byte length followed by the raw UTF-8 JSON body
  (`BridgeServer.swift` uses the same wire format). These frames are *not* encrypted; the only
  authentication on this link is the random bridge token from the data protection keychain that every
  connection must present first (`BridgeToken.swift`). The socket is a local, user-owned Unix domain
  socket and the frames never leave the Mac.
- **The KeePassXC leg stays encrypted.** Host app ↔ KeePassXC uses the KeePassXC-Browser protocol with
  NaCl/libsodium `crypto_box` encryption (`KeePassXCClient.swift`, `KeePassXCCrypto.swift`).
- **Credentials are plaintext in process memory and on the local sockets.** Autofill needs the clear-text
  password in the content script, so the password, the login and the TOTP code also exist as ordinary
  cleartext JavaScript/`String` values in the extension and host-app processes. The sockets are local,
  owned by the user, and the bridge requires the token; the KeePassXC leg uses KeePassXC-Browser's
  encryption.
- **Autofill runs in the top frame only** (`all_frames` is disabled), so embedded cross-origin frames
  can't receive credentials.
- **Socket timeouts** bound every connect, send and receive, so a hung peer can't block the app forever.

General bugs that don't have security impact (UI glitches, autofill not matching a site, etc.) should
be reported as normal GitHub issues instead.
