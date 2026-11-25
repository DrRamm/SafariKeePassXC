# SafariKeePassXC — popup mockup (Liquid Glass)

Interactive prototype of the Safari extension popup for KeePassXC.
Light and dark themes, screens: home, settings, password generator, vault search, error states.

---

## What's inside

```
SafariKeePassXC-popup/
├── README.md
├── styles/
│   └── styles.css                 # the whole design-system file: shadcn base tokens + Liquid Glass block
└── src/
    ├── components/
    │   ├── popup/
    │   │   ├── Popup.tsx          # the popup itself: all screens, TOTP chip, toasts
    │   │   ├── data.ts            # mock data: logins, groups, page domain, states
    │   │   └── password.ts        # password generation + strength estimation
    │   └── ui/
    │       ├── switch.tsx         # toggle (Radix)
    │       └── slider.tsx         # password length slider (Radix)
    ├── lib/
    │   └── utils.ts               # cn() — class name merge helper
    └── routes/
        └── index.tsx              # demo page: background, theme switcher, state switcher
```

---

## Option A. React + Vite + Tailwind v4 project

1. Copy the files into the same paths in your project:
   - `src/components/popup/*`
   - `src/components/ui/switch.tsx`, `src/components/ui/slider.tsx`
   - `src/lib/utils.ts`
2. Dependencies:
   ```bash
   npm i lucide-react clsx tailwind-merge @radix-ui/react-switch @radix-ui/react-slider
   ```
3. Styles. In `styles/styles.css` the new block starts at the `/* Liquid Glass tokens */`
   comment and runs to the end of the file. Paste it into your `src/styles.css` **after** the
   shadcn `@theme`, but not inside `@layer base`. If you already have `@theme inline`, merge the
   `--color-glass*`, `--color-mac-blue*`, `--color-success`, `--color-warning` lines into it.
4. The dark theme is applied with a `dark` class on `<html>` (or on the popup root).
5. Usage:
   ```tsx
   import { Popup } from "@/components/popup/Popup";
   <Popup state="ready" onStateChange={setState} />
   ```
   `state`: `ready` | `offline` | `locked` | `unpaired`.

## Option B. React project without Tailwind v4

The components use utility classes, so they won't be styled without Tailwind.
A quick workaround: keep Tailwind only for the popup — include `styles/styles.css`
in `popup.html` and render `<Popup />` into the root div.

## Option C. Plain HTML/CSS popup (no React, no build step)

The design relies on CSS variables, so they can be carried over as-is:

```css
:root {
  --glass-bg: oklch(0.99 0.005 250 / 0.55);
  --glass-fill: oklch(1 0 0 / 0.55);
  --glass-fill-hover: oklch(1 0 0 / 0.8);
  --glass-border: oklch(1 0 0 / 0.7);
  --glass-highlight: oklch(1 0 0 / 0.9);
  --glass-shadow: 0 30px 80px -20px oklch(0.2 0.05 260 / 0.45), 0 2px 6px oklch(0.2 0.05 260 / 0.12);
  --mac-blue: oklch(0.6 0.2 255);
  --success: oklch(0.72 0.18 150);
  --warning: oklch(0.78 0.16 75);
}
.dark {
  --glass-bg: oklch(0.22 0.02 260 / 0.55);
  --glass-fill: oklch(1 0 0 / 0.07);
  --glass-fill-hover: oklch(1 0 0 / 0.13);
  --glass-border: oklch(1 0 0 / 0.14);
  --glass-highlight: oklch(1 0 0 / 0.25);
  --glass-shadow: 0 30px 80px -20px oklch(0 0 0 / 0.7), 0 2px 6px oklch(0 0 0 / 0.3);
  --mac-blue: oklch(0.65 0.19 255);
}

/* equivalent of the glass-panel / glass-chip utilities */
.glass-panel {
  background: var(--glass-bg);
  backdrop-filter: blur(40px) saturate(180%);
  -webkit-backdrop-filter: blur(40px) saturate(180%);
  border: 1px solid var(--glass-border);
  box-shadow: inset 0 1px 0 var(--glass-highlight), var(--glass-shadow);
  border-radius: 28px;
}
.glass-chip {
  background: var(--glass-fill);
  border: 1px solid var(--glass-border);
  box-shadow: inset 0 1px 0 var(--glass-highlight);
}
```

Font: `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif`.
Icons are from lucide; for HTML you can grab them as SVG from `node_modules/lucide-react/dist/esm/icons/`.

---

## Data and logic

- `data.ts` — mock. Replace `pageLogins` / `allLogins` with the real `kpxc-get-logins`
  response from the native KeePassXC host; keep `pageDomain` there too.
- `password.ts` — a pure `generate(opts)` and `strength(pwd)` function,
  portable to any project without changes.
- TOTP in `Popup.tsx` (`useTotp`) currently computes a code from the mock using a 30-second window.
  In the real extension the code comes from KeePassXC — replace the hook body with a
  call to `kpxc-get-totp` and keep the countdown ring and copy behavior.

## What else can be reused

- `Popup.tsx` — the only file with screen markup; if you need SwiftUI
  or a native popup, it serves as an exact spec for spacing, sizes and states.
- `routes/index.tsx` — demo scaffolding only (background, theme and state switchers).
  It is not carried over into the extension itself.
