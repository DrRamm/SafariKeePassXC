import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  KeyRound, Search, Settings, Wand2, ChevronLeft, Copy, RefreshCw, ClipboardPaste,
  PowerOff, Lock, Link2, Plus, Globe, Check, X,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import { allLogins, groups, pageDomain, pageLogins, type AppState, type Login } from "./data";
import { generate, strength, type GenOpts } from "./password";

type Screen = "home" | "settings" | "generator" | "search";

export function Popup({ state, onStateChange }: { state: AppState; onStateChange: (s: AppState) => void }) {
  const [screen, setScreen] = useState<Screen>("home");
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const navigate = (next: Screen) => {
    setDirection(next === "home" ? "back" : "forward");
    setScreen(next);
  };
  const [toast, setToast] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const notify = (m: string) => {
    setToast(m);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 1800);
  };

  const blocked = state === "offline" || state === "locked" || state === "unpaired";
  const current: Screen = blocked && screen !== "settings" ? "home" : screen;

  return (
    <div className="relative w-[360px] font-sans text-foreground">
      <div className="glass-panel overflow-hidden rounded-[28px]">
        {current === "home" ? (
          <Header state={state} onNav={navigate} disabled={blocked} />
        ) : (
          <SubHeader
            title={{ settings: "Settings", generator: "Password generator", search: "Search vault", home: "" }[current]}
            onBack={() => navigate("home")}
          />
        )}
        <div key={current} className={cn("px-4 pb-4", direction === "forward" ? "animate-screen-forward" : "animate-screen-back")}>
          {current === "home" && (
            blocked ? <ErrorState state={state} onFix={() => { onStateChange("ok"); notify("Connected"); }} />
              : <Home state={state} notify={notify} onNav={navigate} />
          )}
          {current === "settings" && <SettingsScreen state={state} notify={notify} />}
          {current === "generator" && <Generator notify={notify} />}
          {current === "search" && <SearchScreen notify={notify} />}
        </div>
      </div>
      <div
        className={cn(
          "pointer-events-none absolute left-1/2 top-full mt-3 flex -translate-x-1/2 items-center gap-2 rounded-full bg-foreground/85 px-4 py-2 text-[13px] font-medium text-background shadow-lg transition-all duration-300",
          toast ? "translate-y-0 opacity-100" : "-translate-y-2 opacity-0",
        )}
      >
        <Check className="size-4" /> {toast}
      </div>
    </div>
  );
}

function IconBtn({ label, onClick, children, disabled }: { label: string; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return (
    <button
      aria-label={label} title={label} onClick={onClick} disabled={disabled}
      className="glass-chip grid size-8 place-items-center rounded-full text-foreground/80 transition hover:bg-glass-fill-hover hover:text-foreground active:scale-95 disabled:opacity-35 disabled:pointer-events-none"
    >
      {children}
    </button>
  );
}

function Header({ state, onNav, disabled }: { state: AppState; onNav: (s: Screen) => void; disabled: boolean }) {
  const status = {
    ok: { dot: "bg-success", text: "Connected · 2.8.0" },
    empty: { dot: "bg-success", text: "Connected · 2.8.0" },
    locked: { dot: "bg-warning", text: "Vault is locked" },
    offline: { dot: "bg-destructive", text: "KeePassXC is not running" },
    unpaired: { dot: "bg-warning", text: "Extension is not paired" },
  }[state];
  return (
    <div className="flex items-center gap-3 px-4 pt-4 pb-3">
      <div className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-mac-blue text-mac-blue-foreground shadow-[inset_0_1px_0_var(--glass-highlight)]">
        <KeyRound className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-semibold tracking-tight">SafariKeePassXC</div>
        <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <span className={cn("size-1.5 rounded-full", status.dot)} />
          <span className="truncate">{status.text}</span>
        </div>
      </div>
      <div className="flex gap-1.5">
        <IconBtn label="Search" onClick={() => onNav("search")} disabled={disabled}><Search className="size-4" /></IconBtn>
        <IconBtn label="Generator" onClick={() => onNav("generator")} disabled={disabled}><Wand2 className="size-4" /></IconBtn>
        <IconBtn label="Settings" onClick={() => onNav("settings")}><Settings className="size-4" /></IconBtn>
      </div>
    </div>
  );
}

function SubHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-2 px-3 pt-4 pb-3">
      <button onClick={onBack} className="flex items-center rounded-full py-1 pr-2 text-[14px] font-medium text-mac-blue transition hover:opacity-75">
        <ChevronLeft className="size-5" /> Back
      </button>
      <div className="absolute left-1/2 -translate-x-1/2 text-[15px] font-semibold">{title}</div>
    </div>
  );
}

function SectionLabel({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-2 mt-1 flex items-center justify-between px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      <span>{children}</span>{right}
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <div className="grid size-9 shrink-0 place-items-center rounded-full bg-mac-blue/15 text-[14px] font-semibold text-mac-blue">
      {name[0]?.toUpperCase()}
    </div>
  );
}

const RING = 2 * Math.PI * 7.5;

function totpFor(seed: string, counter: number) {
  let h = 2166136261 >>> 0;
  const s = `${seed}:${counter}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return String(h % 1000000).padStart(6, "0");
}

function useTotp(seed: string) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Math.floor(Date.now() / 1000));
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, []);
  const counter = Math.floor(now / 30);
  return { ready: now > 0, code: totpFor(seed, counter), remaining: now > 0 ? 30 - (now % 30) : 30 };
}

function TotpChip({ seed, notify }: { seed: string; notify: (m: string) => void }) {
  const { ready, code, remaining } = useTotp(seed);
  const low = remaining <= 5;
  const copy = () => {
    if (!ready) return;
    navigator.clipboard?.writeText(code);
    notify("TOTP code copied");
  };
  return (
    <button
      onClick={copy} aria-label="Copy TOTP code" title="Copy TOTP code"
      className="group/totp glass-chip flex h-9 shrink-0 items-center gap-2 rounded-[12px] px-2.5 transition hover:bg-glass-fill-hover active:scale-95"
    >
      <span className="font-mono text-[13px] font-semibold tabular-nums tracking-[0.06em]">
        {ready ? `${code.slice(0, 3)} ${code.slice(3)}` : "······"}
      </span>
      <span className="relative grid size-4 place-items-center text-muted-foreground">
        <svg viewBox="0 0 20 20" className={cn("size-4 -rotate-90 transition group-hover/totp:opacity-0", low && "text-warning")}>
          <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="2" className="opacity-25" />
          <circle
            cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
            strokeDasharray={RING} strokeDashoffset={RING * (1 - remaining / 30)}
          />
        </svg>
        <Copy className="size-3.5 absolute opacity-0 transition group-hover/totp:opacity-100" />
      </span>
    </button>
  );
}

function LoginRow({ login, onFill, notify, sub }: { login: Login; onFill: () => void; notify: (m: string) => void; sub?: string }) {
  return (
    <div className="group flex items-center gap-3 rounded-[16px] px-2.5 py-2 transition hover:bg-glass-fill-hover">
      <button onClick={onFill} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <Avatar name={login.title} />
        <div className="min-w-0">
          <div className="truncate text-[14px] font-semibold">{login.title}</div>
          <div className="truncate text-[12px] text-muted-foreground">{sub ?? login.username}</div>
        </div>
      </button>
      {login.totp && <TotpChip seed={login.id} notify={notify} />}
    </div>
  );
}

function PillButton({ children, onClick, primary, className }: { children: ReactNode; onClick: () => void; primary?: boolean; className?: string }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex h-10 items-center justify-center gap-2 rounded-full px-4 text-[13px] font-medium transition active:scale-[0.97]",
        primary ? "bg-mac-blue text-mac-blue-foreground shadow-[inset_0_1px_0_var(--glass-highlight)] hover:brightness-110" : "glass-chip hover:bg-glass-fill-hover",
        className,
      )}
    >
      {children}
    </button>
  );
}

function Home({ state, notify, onNav }: { state: AppState; notify: (m: string) => void; onNav: (s: Screen) => void }) {
  const logins = state === "empty" ? [] : pageLogins;
  return (
    <>
      <SectionLabel right={<span className="flex items-center gap-1 normal-case tracking-normal"><Globe className="size-3" />{pageDomain}</span>}>
        For this site
      </SectionLabel>
      {logins.length ? (
        <div className="glass-chip rounded-[20px] p-1">
          {logins.map((l) => (
            <LoginRow key={l.id} login={l} notify={notify} onFill={() => notify(`Filled: ${l.title}`)} />
          ))}
        </div>
      ) : (
        <div className="glass-chip rounded-[20px] px-4 py-5 text-center">
          <div className="text-[14px] font-semibold">No logins for {pageDomain}</div>
          <div className="mt-1 text-[12px] text-muted-foreground">Find an entry in the vault or create a new one.</div>
          <div className="mt-3 flex justify-center gap-2">
            <PillButton onClick={() => onNav("search")}><Search className="size-4" />Search</PillButton>
            <PillButton primary onClick={() => notify("New login created")}><Plus className="size-4" />Create</PillButton>
          </div>
        </div>
      )}
    </>
  );
}

function ErrorState({ state, onFix }: { state: AppState; onFix: () => void }) {
  const c = {
    offline: { icon: PowerOff, title: "KeePassXC is not running", text: "Open KeePassXC and enable browser integration.", btn: "Retry", btnIcon: RefreshCw },
    locked: { icon: Lock, title: "Vault is locked", text: "Unlock the vault to see your logins.", btn: "Unlock in KeePassXC", btnIcon: Lock },
    unpaired: { icon: Link2, title: "Pairing required", text: "Confirm the extension connection in the KeePassXC window.", btn: "Pair", btnIcon: Link2 },
  }[state as "offline" | "locked" | "unpaired"];
  const Icon = c.icon;
  const BtnIcon = c.btnIcon;
  return (
    <div className="flex flex-col items-center px-4 pt-4 pb-2 text-center">
      <div className="glass-chip grid size-16 place-items-center rounded-full">
        <Icon className="size-7 text-muted-foreground" />
      </div>
      <div className="mt-4 text-[16px] font-semibold">{c.title}</div>
      <div className="mt-1 max-w-[260px] text-[13px] text-muted-foreground">{c.text}</div>
      <PillButton primary onClick={onFix} className="mt-5 w-full"><BtnIcon className="size-4" />{c.btn}</PillButton>
    </div>
  );
}

function Row({ title, hint, children }: { title: string; hint?: string | undefined; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{title}</div>
        {hint && <div className="mt-0.5 text-[11.5px] leading-snug text-muted-foreground">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Group({ children }: { children: ReactNode }) {
  return <div className="glass-chip mb-3 divide-y divide-glass-border overflow-hidden rounded-[18px]">{children}</div>;
}

function SettingsScreen({ state, notify }: { state: AppState; notify: (m: string) => void }) {
  const [passkeys, setPasskeys] = useState(true);
  const [autofill, setAutofill] = useState(false);
  const [save, setSave] = useState(true);
  const [group, setGroup] = useState(groups[0]!);
  const connected = state === "ok" || state === "empty";
  return (
    <>
      <SectionLabel>Saving</SectionLabel>
      <Group>
        <div className="px-3.5 py-3">
          <div className="mb-2 text-[13px] font-medium">Save new logins to</div>
          <select value={group} onChange={(e) => setGroup(e.target.value)}
            className="glass-chip h-9 w-full rounded-[10px] px-3 text-[13px] text-foreground outline-none focus:ring-2 focus:ring-mac-blue/50">
            {groups.map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </div>
        <Row title="Offer to save passwords"><Switch checked={save} onCheckedChange={setSave} /></Row>
      </Group>
      <SectionLabel>Autofill</SectionLabel>
      <Group>
        <Row title="Passkeys via KeePassXC" hint="Takes effect after the page reloads. When off, Safari handles passkeys.">
          <Switch checked={passkeys} onCheckedChange={setPasskeys} />
        </Row>
        <Row title="Autofill on page load" hint="When a single login is found for the site."><Switch checked={autofill} onCheckedChange={setAutofill} /></Row>
      </Group>
      <SectionLabel>Connection</SectionLabel>
      <Group>
        <Row title={connected ? "Connected to KeePassXC 2.8.0" : "Not connected"} hint={connected ? "Vault: Passwords.kdbx · key \"This Mac\"" : undefined}>
          <span className={cn("size-2 rounded-full", connected ? "bg-success" : "bg-destructive")} />
        </Row>
        <button onClick={() => notify("Reconnected")} className="flex w-full items-center gap-2 px-3.5 py-3 text-[13px] font-medium text-mac-blue hover:bg-glass-fill-hover">
          <RefreshCw className="size-4" /> Reconnect
        </button>
      </Group>
      <div className="text-center text-[11px] text-muted-foreground/70">SafariKeePassXC v1.2.4 (2611241)</div>
    </>
  );
}

function Generator({ notify }: { notify: (m: string) => void }) {
  const [o, setO] = useState<GenOpts>({ length: 20, upper: true, lower: true, digits: true, symbols: true, phrase: false });
  const [seed, setSeed] = useState(0);
  const [pw, setPw] = useState("");
  useEffect(() => setPw(generate(o)), [o, seed]);
  const s = useMemo(() => strength(o), [o]);
  const set = (k: keyof GenOpts, v: boolean | number) => setO((p) => ({ ...p, [k]: v }));
  const colors = ["bg-destructive", "bg-warning", "bg-success", "bg-success"];
  const toggles: { k: keyof GenOpts; label: string }[] = [
    { k: "upper", label: "A–Z" }, { k: "lower", label: "a–z" }, { k: "digits", label: "0–9" }, { k: "symbols", label: "!@#" },
  ];
  return (
    <>
      <div className="glass-chip rounded-[20px] p-4">
        <div className="min-h-[52px] break-all font-mono text-[17px] leading-snug tracking-wide" suppressHydrationWarning>
          {pw.split("").map((ch, i) => (
            <span key={i} className={/[0-9]/.test(ch) ? "text-mac-blue" : /[^a-zA-Z]/.test(ch) ? "text-warning" : ""}>{ch}</span>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <div className="flex flex-1 gap-1">
            {[1, 2, 3, 4].map((n) => (
              <div key={n} className={cn("h-1 flex-1 rounded-full", n <= s.score ? colors[s.score - 1] : "bg-foreground/10")} />
            ))}
          </div>
          <span className="text-[11px] font-medium text-muted-foreground">{s.label}</span>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2">
        <PillButton onClick={() => setSeed((x) => x + 1)}><RefreshCw className="size-4" /></PillButton>
        <PillButton onClick={() => { navigator.clipboard?.writeText(pw); notify("Password copied"); }}><Copy className="size-4" /></PillButton>
        <PillButton primary onClick={() => notify("Password pasted")}><ClipboardPaste className="size-4" /></PillButton>
      </div>
      <div className="mt-3" />
      <Group>
        <div className="px-3.5 py-3">
          <div className="mb-3 flex justify-between text-[13px] font-medium">
            <span>{o.phrase ? "Phrase length" : "Length"}</span><span className="tabular-nums text-muted-foreground">{o.length}</span>
          </div>
          <Slider min={8} max={64} step={1} value={[o.length]} onValueChange={([v]) => set("length", v ?? 20)} />
        </div>
        {!o.phrase && (
          <div className="grid grid-cols-4 gap-1.5 px-3.5 py-3">
            {toggles.map((t) => (
              <button key={t.k} onClick={() => set(t.k, !o[t.k])}
                className={cn("h-8 rounded-full font-mono text-[12px] font-medium transition",
                  o[t.k] ? "bg-mac-blue text-mac-blue-foreground" : "bg-foreground/5 text-muted-foreground hover:bg-foreground/10")}>
                {t.label}
              </button>
            ))}
          </div>
        )}
        <Row title="Passphrase" hint="Hyphen-separated words are easier to remember."><Switch checked={o.phrase} onCheckedChange={(v) => set("phrase", v)} /></Row>
      </Group>
    </>
  );
}

function SearchScreen({ notify }: { notify: (m: string) => void }) {
  const [q, setQ] = useState("");
  const res = allLogins.filter((l) => (l.title + l.username + l.domain + l.group).toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="glass-chip mb-3 flex h-10 items-center gap-2 rounded-full px-3.5">
        <Search className="size-4 text-muted-foreground" />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, username or site"
          className="flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted-foreground" />
        {q && <button onClick={() => setQ("")} className="text-muted-foreground"><X className="size-4" /></button>}
      </div>
      <SectionLabel>{q ? `Found: ${res.length}` : "All entries"}</SectionLabel>
      <div className="glass-chip max-h-[300px] overflow-y-auto rounded-[20px] p-1">
        {res.length ? res.map((l) => (
          <LoginRow key={l.id} login={l} sub={`${l.username} · ${l.group}`} notify={notify} onFill={() => notify(`Filled: ${l.title}`)} />
        )) : <div className="py-6 text-center text-[13px] text-muted-foreground">Nothing found</div>}
      </div>
    </>
  );
}
