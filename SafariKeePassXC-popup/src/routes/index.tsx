import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Moon, Sun } from "lucide-react";
import { Popup } from "@/components/popup/Popup";
import { states, type AppState } from "@/components/popup/data";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "SafariKeePassXC — popup mockup" },
      { name: "description", content: "Interactive Liquid Glass popup mockup for the Safari extension for KeePassXC." },
      { property: "og:title", content: "SafariKeePassXC — popup mockup" },
      { property: "og:description", content: "Liquid Glass prototype of the Safari extension for KeePassXC." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  const [dark, setDark] = useState(false);
  const [state, setState] = useState<AppState>("ok");
  return (
    <div className={cn(dark && "dark")}>
      <div className="scene-bg relative min-h-screen font-sans text-foreground">
        {/* fake page behind */}
        <div className="mx-auto max-w-4xl px-8 pt-28 opacity-60">
          <div className="h-8 w-48 rounded-lg bg-foreground/15" />
          <div className="mt-6 space-y-3">
            {[90, 75, 82, 60].map((w) => <div key={w} className="h-3 rounded bg-foreground/10" style={{ width: `${w}%` }} />)}
          </div>
          <div className="mt-10 max-w-sm space-y-3">
            <div className="h-11 rounded-xl border border-foreground/15 bg-background/40" />
            <div className="h-11 rounded-xl border border-foreground/15 bg-background/40" />
          </div>
        </div>

        {/* toolbar */}
        <div className="glass-panel fixed left-1/2 top-4 z-20 flex -translate-x-1/2 items-center gap-1 rounded-full p-1 text-[12px]">
          {states.map((s) => (
            <button key={s.id} onClick={() => setState(s.id)}
              className={cn("rounded-full px-3 py-1.5 font-medium transition",
                state === s.id ? "bg-mac-blue text-mac-blue-foreground" : "text-foreground/70 hover:text-foreground")}>
              {s.label}
            </button>
          ))}
          <button aria-label="Theme" onClick={() => setDark((d) => !d)} className="ml-1 grid size-7 place-items-center rounded-full text-foreground/70 hover:text-foreground">
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </div>

        <div className="absolute right-10 top-24 z-10">
          <Popup state={state} onStateChange={setState} />
        </div>
      </div>
    </div>
  );
}
