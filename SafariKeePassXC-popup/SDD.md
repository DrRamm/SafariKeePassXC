# SDD — Liquid Glass Popup: Design-to-Project Integration

| | |
|---|---|
| **Status** | Draft for review |
| **Date** | 2026-11-25 |
| **Design source** | `SafariKeePassXC-popup/` (Lovable export, commit `cd32d35` "add design from lovable") |
| **Target** | Safari extension popup — `SafariKeePassXC Extension/Resources/popup.{html,css,js}` |
| **Related code** | `SafariKeePassXC/KeePassXC/*` (native bridge), `SafariKeePassXC Extension/Resources/{background,content}.js`, `_locales/{en,de}` |
| **Out of scope** | Host app window (`SafariKeePassXC/Base.lproj/Main.storyboard`, `Resources/Script.js`), background-mode refactor (`d117563`) |

---

## 1. Purpose

This document audits the Liquid Glass popup design against the current project and specifies how to bring it into the existing Safari extension popup: target stack, screen-by-screen mapping, data-model and API changes, new fields/storage keys/i18n keys, protocol gaps, file-level change plan, and test plan.

The design is a standalone React + Tailwind v4 + shadcn/Lovable prototype. The project is a native macOS host app (Swift) plus a Safari Web Extension whose popup is a dependency-free HTML/CSS/JS page. The gap between the two is the subject of this document.

---

## 2. Executive summary

1. **The popup must stay HTML.** Safari renders the extension's `action.default_popup` as an HTML document (`manifest.json` → `popup.html`, `strict_min_version: 18.4`). A SwiftUI popup is not possible. The native Swift layer (`KeePassXCClient`, `BridgeServer`, crypto, passkeys) is already "as native as it gets" and does not change. The design is ported as **vanilla HTML/CSS/JS** using the design's CSS tokens (README "Option C") — no npm build step, no new Xcode pipeline.
2. **The design adds four screens** (home, settings, generator, search), a shell with header/sub-header/toasts, per-entry TOTP chips, and three error states.
3. **Six gaps require implementation or a decision**: full-database search (not supported by the KeePassXC-Browser protocol), the "Create" login flow, database name/key display (not exposed by the protocol), the autofill-on-load toggle, the save-prompt toggle, and TOTP refresh on the 30-second rollover.
4. **All UI strings must be localized.** The design is in English and hardcodes its copy in `Popup.tsx`/`data.ts`; the extension uses `browser.i18n` with `en` + `de`. About 50 new keys are needed, with German translations.
5. **The Node test suite is partly broken**: `tests/passkeys-page.test.mjs` reads `specs/002-safari-passkeys/fixtures/…`, deleted by commit `03e8e14` "drop specs". The other two Node test files pass. Fix separately from the UI work.
6. **No Xcode project changes are needed** for the popup rewrite: the extension target uses a `PBXFileSystemSynchronizedRootGroup`, so files under `SafariKeePassXC Extension/Resources/` are picked up automatically.

---

## 3. Current state audit

### 3.1 Components and data flow

```
popup.html/css/js ──browser.runtime.sendMessage──▶ background.js ──sendNativeMessage──▶
SafariWebExtensionHandler.swift ──HostBridgeConnection──▶ BridgeServer (Unix socket) ──▶
KeePassXCClient.swift ──encrypted KeePassXC-Browser protocol──▶ KeePassXC (Unix socket)
```

| Component | Path | Role |
|---|---|---|
| Popup UI | `SafariKeePassXC Extension/Resources/popup.{html,css,js}` | Current popup: entries list, save group, passkeys toggle, generate/copy TOTP, version footer |
| Background | `.../Resources/background.js` | Message router, pending-save queue, passkey validation, native forwarding |
| Content script | `.../Resources/content.js` | Form detection, autofill on load, TOTP autofill, save banner |
| Native handler | `.../SafariWebExtensionHandler.swift` | Validates and forwards requests to the host app |
| Host bridge | `SafariKeePassXC/KeePassXC/BridgeServer.swift` | Unix socket + `BridgeRouter` action dispatch |
| KeePassXC client | `SafariKeePassXC/KeePassXC/KeePassXCClient.swift` | Protocol client (NaCl crypto, association) |
| Locales | `.../Resources/_locales/{en,de}/messages.json` | `browser.i18n` strings |

### 3.2 Popup today

- Width **300 px**, single page, no navigation.
- Sections: header + status line, "Logins for this page" list (click = fill), save-group select, passkeys toggle, action buttons (Connect / Generate password / Copy TOTP), result `<pre>`, footer.
- Behavior: on open it calls `status`, then `get-logins` for the active tab, `get-database-groups`, `get-version`. Passwords are never rendered. TOTP is copied from the first entry that has one.
- Styling: `color-scheme: light dark`, `prefers-color-scheme`, `color-mix()`; no external dependencies.

### 3.3 Bridge API today

| Action | Direction | Notes |
|---|---|---|
| `ping` | ext → host | Health check |
| `status` | ext → host | `connected`, `associated`, `databaseHash`, `keePassXCVersion`, `error` |
| `associate` | ext → host | Starts KeePassXC association |
| `get-logins` | ext → host | Entries for a URL: `name`, `login`, `password`, `uuid`, `group?`, `totp?`, `expired` |
| `get-database-groups` | ext → host | `{ name, uuid }[]` (flattened paths) |
| `generate-password` | ext → host | One opaque password string (KeePassXC settings, no options) |
| `set-login` | ext → host | Write; **only** reachable through `confirm-pending-save` |
| `passkeys-register` / `passkeys-get` | ext → host | WebAuthn via KeePassXC |
| `get-version` | ext → host | Bundle version/build; handled by `SafariWebExtensionHandler.swift`, not `BridgeRouter` |
| `queue-save` / `get-pending-save` / `confirm-pending-save` / `dismiss-pending-save` | ext-local | Save banner queue in `background.js` |

### 3.4 KeePassXC-Browser protocol capabilities (relevant subset)

Supported: `change-public-keys`, `associate`, `test-associate`, `get-logins` (URL match), `get-totp`, `get-database-groups`, `get-databasehash`, `generate-password` (no parameters), `set-login`, `lock-database`, `create-new-group`, passkeys actions, `database-locked` / `database-unlocked` signals.

**Not supported: any "list all entries" or "search" action.** The protocol only returns entries matching a URL. This directly constrains the design's search screen (see §7.1).

### 3.5 Build and tests

- Xcode 16 folder-synchronized groups: adding/replacing files in `SafariKeePassXC Extension/Resources/` requires no `project.pbxproj` edit.
- Swift unit tests: `SafariKeePassXCTests` (crypto/bridge) — unaffected.
- Node tests: `tests/passkeys-{background,content}.test.mjs` pass (20 tests). `tests/passkeys-page.test.mjs` **fails** because its fixtures live in the removed `specs/` tree.

### 3.6 Working tree

The background-mode refactor (`AppDelegate.swift`, `Main.storyboard`, `ViewController.swift`) is committed as `d117563` "keep app running in background when window is closed". It is unrelated to the design and must not be touched by this work. This SDD and the popup port are uncommitted work in the current tree.

---

## 4. Design audit

### 4.1 What the design provides

| File | Content |
|---|---|
| `src/components/popup/Popup.tsx` | All screens, shell, TOTP chip, toasts, error states |
| `src/components/popup/data.ts` | Mock entries, groups, page domain, `AppState` |
| `src/components/popup/password.ts` | Pure `generate(opts)` + `strength(opts)` |
| `styles/styles.css` | shadcn tokens + Liquid Glass tokens + `glass-panel` / `glass-chip` utilities |
| `src/components/ui/{switch,slider}.tsx` | Radix primitives (React-only) |
| `src/routes/index.tsx` | Demo harness: scene background, theme and state switchers |
| `README.md` | Three integration variants; notes that `Popup.tsx` is the spec for a native popup |

### 4.2 Demo-only parts (not ported)

- `src/routes/index.tsx` — scene background, theme toggle, state switcher.
- Mock data (`data.ts`) — replaced by live bridge data.
- `totpFor()` / `useTotp()` — replaced by the real `totp` from KeePassXC.
- `.dark` class toggle — replaced by `prefers-color-scheme`.
- `scene-bg` tokens — demo backdrop only.
- Radix `switch`/`slider` components — replaced by native `<input type="checkbox">` styled as a switch and `<input type="range">` styled as a slider.

### 4.3 Stack decision

**Port to vanilla HTML/CSS/JS** in `SafariKeePassXC Extension/Resources/`, keeping the existing architecture:

- Safari requires the popup to be HTML — SwiftUI/AppKit cannot render it.
- The project has no npm pipeline; adding React/Vite/Tailwind would add a build step to an Xcode project for a single 360 px page.
- The design's own README documents this exact path ("Option C"): tokens are plain CSS custom properties, icons are inline SVGs.
- ES modules are available (`popup.html` already loads `popup.js` as `type="module"`), so the generator/search logic can live in separate, testable modules.

**SwiftUI note (decision log):** the request to "make it as native as possible" is satisfied by keeping all logic in Swift. A native popup would require replacing Safari's popup mechanism, which is not possible for a Safari Web Extension; the design remains the specification if a native UI is ever built elsewhere (e.g. a future menu-bar app window).

### 4.4 Layout and design tokens

- Panel width **360 px**; the outer corners are Safari's popover corners, inner cards 12–20 px.
- Typography: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif`; sizes 11–17 px.
- Colors (light / dark) — adapted from `styles.css`:

| Token | Light | Dark |
|---|---|---|
| `--glass-fill` | `oklch(1 0 0 / 0.6)` | `oklch(1 0 0 / 0.07)` |
| `--glass-fill-hover` | `oklch(0.2 0.04 260 / 0.06)` | `oklch(1 0 0 / 0.13)` |
| `--glass-border` | `oklch(0.2 0.04 260 / 0.1)` | `oklch(1 0 0 / 0.14)` |
| `--glass-highlight` | `oklch(1 0 0 / 0.9)` | `oklch(1 0 0 / 0.25)` |
| `--mac-blue` | `oklch(0.6 0.2 255)` | `oklch(0.65 0.19 255)` |
| `--success` | `oklch(0.72 0.18 150)` | same |
| `--warning` | `oklch(0.78 0.16 75)` | same |
| `--destructive` | `oklch(0.577 0.245 27.325)` | `oklch(0.704 0.191 22.216)` |

The design's `--glass-bg` and `--glass-shadow` are intentionally not ported: they belong to the panel that Safari now draws.

- `inset 0 1px 0 var(--glass-highlight)` on chips.
- **No popup background.** The popup page is transparent and Safari renders the system Liquid Glass material behind it; the port therefore does not paint a body gradient, panel fill, border, shadow or `backdrop-filter`. The panel keeps `overflow: hidden` only.
- Because the material is near-white in light mode, the light `--glass-border` is a faint **neutral** outline (10% dark) instead of the design's white border; otherwise cards, dividers, the group select, chips and icon buttons would be invisible. Dark mode keeps the design's white borders.
- Screen transition: `screen-in 0.28s cubic-bezier(0.2, 0.8, 0.2, 1)` (translateX 16px → 0, opacity 0 → 1).
- Dark mode: the source file switches themes with a `.dark` class; in the port use `@media (prefers-color-scheme: dark)` overriding the same tokens (no `.dark` class).

---

## 5. Screen specifications

### 5.1 Shell

| Element | Design | Port notes |
|---|---|---|
| Panel | `glass-panel`, 360 px, radius 28 px, overflow hidden | Transparent page; Safari supplies the material and the rounded corners. `popup.css` keeps only `overflow: hidden` |
| Header | 40 px blue tile with key icon, "SafariKeePassXC", status dot + text, 3 icon buttons (search, generator, settings) | Inline key SVG on a blue tile. Icon buttons disabled while blocked (except settings) |
| Sub-header | "‹ Back" left, centered title | One screen at a time; `screen` state |
| Toast | Bottom pill, 1.8 s, check icon | Replaces the `<pre id="result">` block |
| Theme | System only | `prefers-color-scheme` |

**Brand mark.** One mark everywhere: a blue rounded square with a white diagonal key (the header tile). It is used for the Safari toolbar icon (`images/toolbar-icon-{16,19,32,38}.png`), the extension icons (`images/icon-{48..512}.png`), the macOS app icon (`Assets.xcassets/AppIcon.appiconset`) and the host window icon (`Resources/Icon.png`). The toolbar sizes are rendered from the same vector with a 1 px transparent margin so the square does not touch the slot edge.

Status text mapping (`AppState`):

| State | Dot | Text (i18n key) |
|---|---|---|
| `ok` / `empty` | success | `status_connected_short` = "Connected · $VERSION$" |
| `locked` | warning | `status_locked` = "Vault is locked" |
| `offline` | destructive | `status_offline` = "KeePassXC is not running" |
| `unpaired` | warning | `status_unpaired` = "Extension is not paired" |

### 5.2 Home

- Section label "For this site" + globe + page domain (from the active tab URL).
- Entries card: one row per entry — avatar (first letter of `name`), `name`, `login`, optional TOTP chip. Click = fill via the content script (`fill-credentials`), then close the popup.
- Empty state: "No logins for {domain}", hint, buttons **Search** (→ search screen) and **Create** (see §7.2).
- Data: `get-logins` for the active tab URL (already implemented). `expired` entries: keep current behavior (content script prefers non-expired); optionally render a muted "expired" hint.

### 5.3 Error states

| State | Icon | Title | Text | CTA |
|---|---|---|---|---|
| `offline` | power-off | `status_offline` | `error_offline_hint` = "Open KeePassXC and enable browser integration." | `button_retry` = "Retry" → re-run `status` |
| `locked` | lock | `status_locked` | `error_locked_hint` = "Unlock the vault to see your logins." | `button_unlock_in_keepassxc` = "Unlock in KeePassXC" → re-issue `status`/`get-logins` (may trigger KeePassXC's unlock prompt); no direct unlock exists |
| `unpaired` | link | `error_pairing_required` = "Pairing required" | `error_unpaired_hint` = "Confirm the extension connection in the KeePassXC window." | `button_pair` = "Pair" → `associate`, then re-init |

`empty` is not an error screen — it is the home empty state.

### 5.4 Settings

| Row | Source | Status |
|---|---|---|
| "Save new logins to" (group select) | `get-database-groups`, `storage.saveGroup {uuid,name}` | Exists, move to settings |
| "Offer to save passwords" toggle | new `storage.savePromptEnabled` | **New** — gate `queue-save` in `background.js` (§7.6) |
| "Passkeys via KeePassXC" toggle + hint | `storage.passkeysEnabled` | Exists, move to settings |
| "Autofill on page load" toggle | new `storage.autofillOnLoad` | **New** — gate `attemptAutofill` in `content.js` (§7.5) |
| Connection row (status dot + version) | `status` | Exists; database name/key **not available** (§7.3) |
| "Reconnect" | `status`, then `associate` if unpaired | New button |
| Footer version | `get-version` | Exists |

Section labels in the design: "Saving", "Autofill", "Connection".

### 5.5 Generator

- Password display: monospace, digits in `--mac-blue`, symbols in `--warning`, word-wrapped.
- Strength bar: 4 segments + label (Weak / Medium / Strong / Very strong).
- Buttons: regenerate, copy, paste-into-page (design shows a clipboard-paste action — decide: copy only, or fill the focused field; recommend copy only in v1).
- Length slider 8–64 (`<input type="range">`).
- Character set toggles A–Z / a–z / 0–9 / !@#.
- Passphrase toggle + hint; word list per locale (see §7.7).
- Logic: port `password.ts` (pure JS, `crypto.getRandomValues`) into `popup-password.js` with exports for tests. The passphrase entropy uses the actual word-list size (`count × log2(words)`), not the mock's hardcoded `12`; the word list is 64 English words.
- **No KeePassXC call**: KeePassXC's `generate-password` has no options. The existing "Generate password" button (KeePassXC generator, copies to clipboard without display) can be kept as a secondary action or removed — decision §7.8.

### 5.6 Search

- Input with placeholder "Title, username or site", clear button, autofocus.
- Results list: same row component as home, subtitle `login · group`.
- Empty result text: "Nothing found".
- **Scope: entries for the active page** (see §7.1). Label changes from "All entries" to "Entries for this site"; screen title "Search vault".
- **"Search in KeePassXC" button** below the field: sends `request-autotype` with the query (or the page domain when empty), closes the popup, and lets KeePassXC search the whole database in its own window.

### 5.7 TOTP chip

- Per entry that has `totp`: code formatted `123 456`, 30-second ring, copy on click, toast.
- Ring: `strokeDashoffset = RING * (1 - remaining/30)`, `remaining = 30 - (now % 30)`; warning color at ≤ 5 s.
- Code source: `entry.totp` from `get-logins` (a snapshot). On window rollover the popup must re-fetch entries to get a fresh code (§7.4); otherwise the ring resets over a stale code.

---

## 6. Data model and API mapping

### 6.1 Entry mapping

| Design (`Login`) | Real (`LoginEntry`) | Notes |
|---|---|---|
| `id` | `uuid` | Row key |
| `title` | `name` | Avatar letter = `name[0]` |
| `username` | `login` | |
| `group` | `group?` | Search subtitle |
| `domain` | — | Derived from the active tab URL host (not from KeePassXC) |
| `totp?: boolean` | `totp?: string` | Presence = chip; value = current code |
| — | `password` | Never rendered; used only for `fill-credentials` |
| — | `expired` | Optional muted hint; keep current fill preference |

### 6.2 Status mapping

| UI | Source |
|---|---|
| Header dot/text | `status.connected`, `status.associated`, `status.keePassXCVersion`, `status.error` |
| Settings connection row | same |
| Footer version | `get-version` (`version`, `build`) |

`databaseHash` exists but is not user-friendly; the design's connection hint is `Vault: Passwords.kdbx · key "This Mac"`, which is **not available** — the protocol exposes neither the database file name nor the association key name. (`associate` returns the association `id`, but `status` does not, and the `id` is not a human-readable key name.) Recommendation: show the KeePassXC version and a shortened `databaseHash`, or omit the second line.

### 6.3 Storage keys

| Key | Type | Default | Consumer |
|---|---|---|---|
| `saveGroup` | `{uuid,name}` | — | exists |
| `passkeysEnabled` | boolean | `false` | exists |
| `autofillOnLoad` | boolean | `true` (preserve current behavior) | `content.js` |
| `savePromptEnabled` | boolean | `true` (preserve current behavior) | `background.js` |

### 6.4 New bridge actions

- `request-autotype` — added. Forwards the search query to KeePassXC's global auto-type search (`request-autotype`, protocol 2.7.0+). This is the only way to search the whole database; the results are shown by KeePassXC, not in the popup.
- `get-totp` — protocol-supported; a possible follow-up for refreshing a single TOTP without re-fetching all entries.
- `search-logins` — **not possible**: no such action exists in the KeePassXC-Browser protocol.

---

## 7. Gaps and decisions

### 7.1 Full-database search — protocol limitation

The design's search screen filters `allLogins` (all mock entries). The KeePassXC-Browser protocol only returns entries matching a URL (`get-logins`); there is no list-all or search action. Even the official KeePassXC-Browser extension searches the database in the KeePassXC app, not in its popup.

**Options:** (a) scope search to entries for the active page — feasible today, no protocol change; (b) implement full search — requires a protocol capability that does not exist, i.e. changes in KeePassXC itself; (c) forward the query to KeePassXC's global auto-type search (`request-autotype`) — a real full-database search, but the results are shown by KeePassXC.

**Decision:** (a) for the in-popup list plus (c) for the whole database, via the "Search in KeePassXC" button. The UI hint documents the page scope.

### 7.2 "Create" login flow

The design's empty state has a "Create" button. Today the only write path is the save banner (`queue-save` → `confirm-pending-save` → `set-login`), and `set-login` is explicitly forbidden as a direct popup action (`background.js`).

**Options:** (a) omit "Create" in v1 (keep "Search"); (b) add a popup form (title/username/password/group) that submits through a new, explicitly allowed flow with user confirmation. Recommend (a) for v1; (b) as a separate feature.

### 7.3 Database name / key name

Not exposed by the protocol. Show KeePassXC version and optionally a shortened `databaseHash`; do not invent a database name.

### 7.4 TOTP refresh on rollover

`entry.totp` is a snapshot. While the popup is open, re-fetch `get-logins` when the 30-second window rolls (only if at least one visible entry has TOTP). Keep the last code if the refresh fails. Follow-up: add a `get-totp` bridge action.

### 7.5 Autofill-on-load semantics

The design says "when a single login is found". Current `content.js` autofills whenever a password field exists, choosing the first non-expired entry. Decision: preserve the current "best match" behavior behind `autofillOnLoad` (default `true`). The toggle gates both `attemptAutofill` and `attemptTotpFill`, so disabling it stops all automatic filling.

### 7.6 Save-prompt toggle

The design adds an "Offer to save passwords" switch. Today `background.js` always queues credentials on form submit (`queue-save`) and the content script always shows the save banner. Add `storage.savePromptEnabled` (default `true` to preserve current behavior) and skip queuing/showing the banner when it is off. No protocol change.

### 7.7 Passphrase word list

The design's word list is English (`glacier`, `sail`, `coffee`, …). The app ships `en` + `de`. Either reuse the English list for both locales, or provide a German list for `de`. The mock list is a placeholder — replace it with a reviewed list of the target size.

### 7.8 KeePassXC generator

Keep the existing "Generate password" (KeePassXC settings, copy without display) as a secondary button in the generator screen, or remove it. Recommended: keep it, labelled "KeePassXC password", because it respects the user's KeePassXC generator settings.

### 7.9 Unlock CTA

The extension cannot unlock KeePassXC. The "Unlock in KeePassXC" button should re-issue a request (which may cause KeePassXC to show its unlock prompt, depending on its settings) and otherwise show the instruction.

### 7.10 Popup width

360 px (design) vs 300 px (current). Use 360 px.

### 7.11 Password display

The home/search screens never render passwords (unchanged). The generator displays a client-generated password — acceptable, but note clipboard behavior and that the password is not stored until the user saves it.

---

## 8. i18n plan

All strings from the design move to `_locales/{en,de}/messages.json`; no hardcoded copy. Reuse existing keys where the design string matches (update the message text when the design renames a control).

### 8.1 Reused keys

`status_associating`, `error_generic`, `button_generate` (if the KeePassXC generator is kept), `entry_fill_tooltip`, `save_group_label`, `save_group_default`, `passkeys_toggle_label` (message updated to "Passkeys via KeePassXC"), `passkeys_toggle_hint` (message updated to "Takes effect after the page reloads. When off, Safari handles passkeys."), `passkeys_reload_hint`, `password_copied` (KeePassXC generator only), `clipboard_failed`, `fill_no_form`, `fill_no_access`.

Keys that become unused with the new popup (keep only if another surface still uses them): `status_connected`, `status_not_associated`, `button_associate`, `button_totp`, `entries_heading`, `entries_empty`, `totp_no_website`, `totp_no_entry`, `copied_to_clipboard`.

`error_keepassxc_not_reachable`, `error_database_locked`, `error_not_associated`, `error_generic` and `error_host_app_not_running` stay in use through the popup's `friendlyError()` toasts. `button_create`, `toast_login_created`, `toast_password_pasted`, `generator_keepassxc`, `button_generate` and `password_copied` are reserved for the deferred v2 features (Create flow, paste, KeePassXC generator).

### 8.2 New keys (draft)

| Key | English draft |
|---|---|
| `nav_search` / `nav_generator` / `nav_settings` | Search / Generator / Settings |
| `nav_back` | Back |
| `screen_search_title` | Search vault |
| `screen_generator_title` | Password generator |
| `screen_settings_title` | Settings |
| `status_connected_short` | Connected · $VERSION$ |
| `status_locked` | Vault is locked |
| `status_offline` | KeePassXC is not running |
| `status_unpaired` | Extension is not paired |
| `section_for_site` | For this site |
| `home_empty_title` | No logins for $DOMAIN$ |
| `home_empty_hint` | Find an entry in the vault or create a new one. |
| `button_search` | Search |
| `button_create` | Create |
| `toast_filled` | Filled: $TITLE$ |
| `toast_totp_copied` | TOTP code copied |
| `toast_connected` | Connected |
| `toast_reconnected` | Reconnected |
| `toast_login_created` | New login created |
| `toast_password_copied` | Password copied |
| `toast_password_pasted` | Password pasted |
| `error_offline_hint` | Open KeePassXC and enable browser integration. |
| `error_locked_hint` | Unlock the vault to see your logins. |
| `error_pairing_required` | Pairing required |
| `error_unpaired_hint` | Confirm the extension connection in the KeePassXC window. |
| `button_retry` | Retry |
| `button_unlock_in_keepassxc` | Unlock in KeePassXC |
| `button_pair` | Pair |
| `section_saving` | Saving |
| `section_autofill` | Autofill |
| `settings_save_prompt` | Offer to save passwords |
| `settings_autofill` | Autofill on page load |
| `settings_autofill_hint` | When a single login is found for the site. |
| `section_connection` | Connection |
| `settings_connected_to` | Connected to KeePassXC $VERSION$ |
| `settings_not_connected` | Not connected |
| `settings_reconnect` | Reconnect |
| `totp_copy_label` | Copy TOTP code |
| `generator_length` | Length |
| `generator_phrase_length` | Phrase length |
| `generator_phrase` | Passphrase |
| `generator_phrase_hint` | Hyphen-separated words are easier to remember. |
| `generator_strength_weak` / `_medium` / `_strong` / `_very_strong` | Weak / Medium / Strong / Very strong |
| `generator_keepassxc` | KeePassXC password |
| `search_placeholder` | Title, username or site |
| `search_hint` | Searches logins for this site. |
| `search_in_keepassxc` | Search in KeePassXC |
| `search_results` | Found: $COUNT$ |
| `search_all` | Entries for this site |
| `search_empty` | Nothing found |
| `footer_author` | by Markus Griesslehner |

German translations required for the same keys. Placeholders use the `$NAME$` convention already used in `messages.json`.

---

## 9. File-level change plan

| File | Action | Content |
|---|---|---|
| `SafariKeePassXC Extension/Resources/popup.html` | **Replace** | Shell markup: header, sub-header, four screen containers, toast, `data-i18n` attributes |
| `SafariKeePassXC Extension/Resources/popup.css` | **Replace** | Liquid Glass tokens, `prefers-color-scheme`, components (panel, chip, row, switch, slider, toast, ring) |
| `SafariKeePassXC Extension/Resources/popup.js` | **Replace** | Screen state machine, data loading, actions, TOTP timer, toasts |
| `SafariKeePassXC Extension/Resources/popup-password.js` | **Add** | Pure `generate(opts)` + `strength(opts)` (port of `password.ts`), ES module exports |
| `SafariKeePassXC Extension/Resources/popup-search.js` | **Add** | Pure `filterEntries(entries, query)` for the search screen |
| `.../Resources/_locales/en/messages.json` | **Update** | New keys |
| `.../Resources/_locales/de/messages.json` | **Update** | New keys |
| `.../Resources/content.js` | **Update** | Gate `attemptAutofill` / `attemptTotpFill` on `autofillOnLoad`; skip the save banner when `queue-save` returns `skipped` |
| `.../Resources/background.js` | **Update** | Gate `queue-save` on `savePromptEnabled` |
| `SafariKeePassXC/KeePassXC/KeePassXCClient.swift` | **Update** | Add `requestAutotype(search:)` |
| `SafariKeePassXC/KeePassXC/BridgeServer.swift` | **Update** | Add the `request-autotype` action |
| `tests/fixtures/*.json` | **Add** | Restored passkey fixtures (moved out of the deleted `specs/` tree) |
| `tests/popup-password.test.mjs`, `tests/popup-search.test.mjs` | **Add** | Unit tests for the new pure modules |
| `tests/passkeys-page.test.mjs` | **Update** | Fixture path `tests/fixtures/…` |
| `SafariKeePassXC-popup/` | **Keep** | Design reference; not built, not shipped |
| `SafariKeePassXC.xcodeproj/project.pbxproj` | **No change** | Folder-synchronized group picks up new files |

---

## 10. Test plan

### 10.1 Fix existing tests (prerequisite)

`tests/passkeys-page.test.mjs` references `specs/002-safari-passkeys/fixtures/…`, removed in `03e8e14`. Either restore the fixtures under `tests/fixtures/` and update the paths, or delete the affected test. The other two Node test files (`passkeys-background`, `passkeys-content`) pass and need no change.

### 10.2 New tests

- `tests/popup-password.test.mjs` — `generate()` respects length/charset/phrase options, never returns an empty set; `strength()` thresholds.
- `tests/popup-search.test.mjs` — search filter over entries (case-insensitive, matches name/login/group).
- `tests/content-autofill.test.mjs` — autofill gated by `autofillOnLoad` (if the logic is extracted).

### 10.3 Manual QA matrix

| Area | Cases |
|---|---|
| States | ok, empty, offline, locked, unpaired — header dot/text, home vs error screen |
| Screens | home, settings, generator, search; back navigation; disabled nav while blocked |
| Theme | light/dark system appearance; contrast of glass tokens |
| TOTP | code format, ring countdown, copy toast, rollover refresh, ≤5 s warning |
| Fill | click entry → form filled → popup closes; no-form and no-access errors |
| Settings | group select persists; save-prompt toggle gates the banner; autofill toggle gates autofill; passkeys toggle + hint; reconnect |
| Generator | length 8–64, charsets, phrase, strength labels, copy |
| Search | matches, empty result, clear button, group subtitle |
| i18n | en and de; no hardcoded copy; missing-key fallback |
| A11y | focus order, labels on icon buttons, keyboard operation |

---

## 11. Security and privacy

- Passwords are never rendered on home/search; only the client-generated password is displayed in the generator.
- Clipboard: generated passwords and TOTP codes go to the system clipboard (existing README note about clipboard managers / Universal Clipboard).
- No new network access, no new native surface, no new protocol actions.
- All i18n strings are static, developer-controlled.
- The `set-login` write path stays restricted to the save banner.

---

## 12. Out of scope

- SwiftUI/native popup (not possible for Safari Web Extensions).
- Host app window redesign.
- Full-database search (protocol limitation).
- New KeePassXC protocol actions.
- The background-mode refactor (`AppDelegate.swift` / `Main.storyboard` / `ViewController.swift`, commit `d117563`).
- The React prototype's build tooling.

---

## 13. Open questions

1. "Create" button: omit in v1 or implement a popup form? (recommend omit)
2. Autofill semantics: keep "best match" or switch to "only when exactly one login"? (recommend keep)
3. Connection row second line: version + short hash, or omit? (recommend version only)
4. Passphrase words: reuse the English list for both locales, or add a German list for `de`? (recommend per-locale)
5. KeePassXC generator button: keep as secondary action or remove? (recommend keep)
6. Paste-into-page button in the generator: copy only, or fill the focused field? (recommend copy only)

---

## 14. Implementation status (v1)

Implemented in the extension:

- Shell: glass panel, header (status dot + version), sub-header, screen transitions, toast, system dark mode.
- Home: page domain, entry rows with avatars, per-entry TOTP chips with a 30-second ring and rollover refresh, empty state with Search.
- Error states: offline (Retry), locked (Unlock in KeePassXC), unpaired (Pair).
- Settings: save group, "Offer to save passwords", "Passkeys via KeePassXC" (with the existing version/connection/page diagnostics), "Autofill on page load", connection row, Reconnect, version footer.
- Generator: client-side generation, strength meter, length slider 8–64, character-set toggles, passphrase mode, regenerate, copy.
- Search: page-scoped filter with group subtitle and result count, plus a "Search in KeePassXC" button that opens KeePassXC's global search for the whole database.
- i18n: ~60 new keys in `en` and `de`; existing passkey label/hint updated to the design wording.
- Settings gating: `autofillOnLoad` gates autofill and TOTP autofill in `content.js`; `savePromptEnabled` gates the save banner in `background.js`.
- Tests: `popup-password` and `popup-search` unit tests; the passkey fixtures were restored under `tests/fixtures/` and `passkeys-page` is green again.

Deferred (documented above): the "Create" login flow (§7.2), paste-into-page (§5.5), the KeePassXC generator button (§7.8), and full-database search (§7.1).

---

## Appendix A — Design token source

Adapt from `SafariKeePassXC-popup/styles/styles.css`:

1. The `/* Liquid Glass tokens */` block through the end of the file (light/dark glass tokens, `--mac-blue*`, `--success`, `--warning`, `glass-chip`).
2. From the shadcn `:root` / `.dark` blocks above it: `--destructive` and `--destructive-foreground` (used by the strength bar and the error dot).

Keep only the tokens and utilities used by the popup; drop `scene-*` and `@theme inline` (Tailwind-specific). `glass-panel` is not ported: Safari draws the popup material and its corners, so the page stays transparent.

## Appendix B — Component inventory → DOM

| Design component | DOM |
|---|---|
| `glass-panel` | Safari popover (the page paints no panel) |
| `glass-chip` | `.group`, `.pill`, `.totp-chip`, `.icon-btn` (shared fill + border) |
| `IconBtn` | `button.icon-btn` with inline SVG |
| `PillButton` | `button.pill` / `button.pill.primary` |
| `SectionLabel` | `.section-label` |
| `Avatar` | `.avatar` |
| `LoginRow` | `.login-row` |
| `TotpChip` | `button.totp-chip` (code + SVG ring) |
| `Switch` | `input[type=checkbox].switch` |
| `Slider` | `input[type=range].slider` |
| `Row` / `Group` | `.row` / `.group` |
| Toast | `.toast` |
| `ErrorState` | `.error-state` |

## Appendix C — Icon set (inline SVG, from lucide)

`key-round`, `search`, `wand-2`, `settings`, `chevron-left`, `copy`, `refresh-cw`, `clipboard-paste`, `power-off`, `lock`, `link-2`, `plus`, `globe`, `check`, `x`.
