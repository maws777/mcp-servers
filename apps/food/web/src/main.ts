// Entry: config, sign-in, a tiny hash router, the tab bar.
//
//   #/day/2026-11-09   #/trends/7   #/fridge   #/history/2026-11

import { NeedsLogin, get, type DayResponse, type FridgeResponse, type HistoryResponse, type SummaryResponse, type TrendsResponse } from "./api";
import { handleCallback, login, logout, type Config } from "./auth";
import { h } from "./dom";
import { dayView, fridgeView, historyView, summaryCard, trendsView } from "./views";

let renderId = 0; // bumped on each render: a late summary for a page that's gone is dropped

/**
 * Loads the day's summary into its slot. When it's being regenerated, asks
 * again a few times (the model takes a few seconds), then stops: the next
 * app open will pick it up.
 */
async function loadSummary(date: string, id: number) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 4000));
    if (id !== renderId) return;
    let data: SummaryResponse;
    try {
      data = await get<SummaryResponse>(cfg, `/api/summary?date=${date}`);
    } catch {
      return; // the summary is a bonus: never break the page for it
    }
    if (id !== renderId) return;
    const working = data.status === "pending" && attempt < 3;
    const card = summaryCard(data, working);
    document.getElementById("summary-slot")?.replaceChildren(...(card ? [card] : []));
    if (!working) return;
  }
}

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
  const id = ++renderId;
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
    if (view !== "trends" && view !== "fridge" && view !== "history") {
      const date = arg && /^\d{4}-\d{2}-\d{2}$/.test(arg) ? arg : today;
      void loadSummary(date, id);
    }
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
