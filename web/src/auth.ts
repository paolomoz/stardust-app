/* Client auth: who's signed in (fetched once at boot), a logout helper, and a
   small user chip. User identity lives here (not in the run store) so Restart /
   new runs don't drop it. */
import { esc } from "./dom";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatar: string;
  providers: string[];
}

let _user: AuthUser | null = null;
export const getUser = (): AuthUser | null => _user;

export async function fetchMe(): Promise<AuthUser | null> {
  try {
    const r = await fetch("/api/me");
    const j = (await r.json()) as { user: AuthUser | null };
    _user = j.user ?? null;
  } catch {
    _user = null;
  }
  return _user;
}

export async function logout(): Promise<void> {
  try { await fetch("/auth/logout", { method: "POST" }); } catch { /* ignore */ }
  location.href = "/";
}

/** Avatar button (data-act="logout") for the header / landing. */
export function userChip(): string {
  const u = _user;
  if (!u) return "";
  const initial = (u.name || u.email || "?").trim().charAt(0).toUpperCase() || "?";
  const inner = u.avatar ? `<img src="${esc(u.avatar)}" alt="" />` : `<span class="ini">${esc(initial)}</span>`;
  return `<button class="userchip" data-act="logout" title="${esc(u.email)} — log out">${inner}</button>`;
}
