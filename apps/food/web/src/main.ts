// Entry: config, sign-in, a tiny hash router, the tab bar.
//
//   #/day/2026-11-09   #/trends/7   #/fridge   #/history/2026-11

import { NeedsLogin, get, type DayResponse, type FridgeResponse, type HistoryResponse, type TrendsResponse } from "./api";
import { handleCallback, login, logout, type Config } from "./auth";
import { h } from "./dom";
import { dayView, fridgeView, historyView, trendsView } from "./views";

const app = document.getElementById("app")!;
let cfg: Config;
let today = new Date().toISOString().slice(0, 10); // replaced by the server's "today" (user's time zone) on first load

function go(hash: string) {
  if (location.hash === hash) void render();
  else location.hash = hash;
}

const TABS = [
  { hash: "#/day", label: "Aujourd'hui", icon: "◐" },
  { hash: "#/trends", label: "Tendances", icon: "▁▃▅" },
  { hash: "#/fridge", label: "Frigo", icon: "▤" },
  { hash: "#/history", label: "Historique", icon: "▦" },
];

function tabBar(active: string) {
  return h(
    "nav",
    { class: "tabs" },
    ...TABS.map((t) =>
      h("a", { href: t.hash, class: active.startsWith(t.hash) ? "on" : "" }, h("span", { class: "icon", "aria-hidden": "true" }, t.icon), h("span", {}, t.label)),
    ),
  );
}

function show(...content: Node[]) {
  app.replaceChildren(...content);
}

function loginScreen(message?: string) {
  show(
    h(
      "main",
      { class: "login" },
      h("h1", {}, "Food"),
      h("p", { class: "muted" }, "Le tableau de bord de ce que tu notes avec Claude."),
      message ? h("p", { class: "error" }, message) : null,
      h("button", { type: "button", class: "primary", onclick: () => void login(cfg) }, "Se connecter"),
    ),
  );
}

async function render() {
  const [, view = "day", arg] = location.hash.split("/");
  const route = `#/${view}`;
  const main = h("main", {}, h("p", { class: "muted center" }, "Chargement…"));
  show(main, tabBar(route));

  try {
    let content: HTMLElement;
    if (view === "trends") {
      const days = arg === "30" ? 30 : 7;
      content = trendsView(await get<TrendsResponse>(cfg, `/api/trends?days=${days}`), days, go);
    } else if (view === "fridge") {
      content = fridgeView(await get<FridgeResponse>(cfg, "/api/fridge"));
    } else if (view === "history") {
      const month = arg && /^\d{4}-\d{2}$/.test(arg) ? arg : today.slice(0, 7);
      content = historyView(await get<HistoryResponse>(cfg, `/api/history?month=${month}`), today, go);
    } else {
      const date = arg && /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : "";
      const data = await get<DayResponse>(cfg, `/api/day${date ? `?date=${date}` : ""}`);
      today = data.today;
      content = dayView(data, go);
    }
    content.appendChild(h("button", { type: "button", class: "link", onclick: () => logout(cfg) }, "Se déconnecter"));
    main.replaceChildren(content);
  } catch (e) {
    if (e instanceof NeedsLogin) return loginScreen();
    main.replaceChildren(h("p", { class: "error center" }, "Impossible de charger les données."), h("button", { type: "button", onclick: () => void render() }, "Réessayer"));
  }
}

async function start() {
  cfg = (await (await fetch("/config.json", { cache: "no-store" })).json()) as Config;
  const error = await handleCallback(cfg);
  if (error) return loginScreen(error);
  window.addEventListener("hashchange", () => void render());
  // Reopening the home-screen app resumes the page instead of reloading it:
  // refresh what's shown (and the token, if it expired meanwhile).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void render();
  });
  await render();
}

void start();
