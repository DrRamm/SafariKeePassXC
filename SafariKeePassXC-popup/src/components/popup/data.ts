export type Login = { id: string; title: string; username: string; group: string; domain: string; totp?: boolean };

export const pageDomain = "example.com";

export const pageLogins: Login[] = [
  { id: "1", title: "Example", username: "user@example.com", group: "Hosting", domain: "example.com", totp: true },
  { id: "2", title: "Example (backup)", username: "backup@example.com", group: "Hosting", domain: "example.com" },
];

export const allLogins: Login[] = [
  ...pageLogins,
  { id: "3", title: "GitHub", username: "octocat", group: "Development", domain: "github.com", totp: true },
  { id: "4", title: "Apple ID", username: "user@example.com", group: "Personal", domain: "appleid.apple.com", totp: true },
  { id: "5", title: "Hetzner", username: "user@example.com", group: "Hosting", domain: "hetzner.com" },
  { id: "6", title: "Figma", username: "designer@example.com", group: "Work", domain: "figma.com" },
  { id: "7", title: "Bank", username: "+1 555 ***-**-01", group: "Finance", domain: "bank.example.com", totp: true },
];

export const groups = [
  "Default group (KeePassXC-Browser Passwords)",
  "Hosting",
  "Development",
  "Personal",
];

export type AppState = "ok" | "empty" | "offline" | "locked" | "unpaired";
export const states: { id: AppState; label: string }[] = [
  { id: "ok", label: "Ready" },
  { id: "empty", label: "No logins" },
  { id: "offline", label: "Not running" },
  { id: "locked", label: "Locked" },
  { id: "unpaired", label: "Not paired" },
];
