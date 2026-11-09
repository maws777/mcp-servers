// The four screens. Each takes API data and returns DOM, built with h()/s()
// only (text nodes, never parsed HTML).

import type { DayResponse, FridgeResponse, HistoryResponse, Nutrition, TrendsResponse } from "./api";
import { h, s } from "./dom";

// --- Formatting ------------------------------------------------------------------

const num = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
const num1 = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
const kcal = (n: number) => `${num.format(n)} kcal`;
const grams = (n: number) => `${num.format(n)} g`;

function dateLabel(date: string, today: string): string {
  if (date === today) return "Aujourd'hui";
  if (date === shift(today, -1)) return "Hier";
  return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

export function shift(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

const MEALS: { key: string; label: string }[] = [
  { key: "breakfast", label: "Petit-déjeuner" },
  { key: "lunch", label: "Déjeuner" },
  { key: "dinner", label: "Dîner" },
  { key: "snack", label: "En-cas" },
  { key: "none", label: "Autre" },
];

function bar(value: number, target: number | undefined) {
  const pct = target ? Math.min(100, (value / target) * 100) : 0;
  const fill = h("span", { class: "fill" });
  fill.style.width = `${pct}%`;
  return h("span", { class: "bar" }, fill);
}

// --- Aujourd'hui ----------------------------------------------------------------------

export function dayView(data: DayResponse, go: (hash: string) => void): HTMLElement {
  const { summary, entries, today } = data;
  const t = summary.targets ?? {};
  const eaten = summary.totals;

  const nav = h(
    "header",
    { class: "daynav" },
    h("button", { type: "button", "aria-label": "Jour précédent", onclick: () => go(`#/day/${shift(summary.date, -1)}`) }, "‹"),
    h("h1", {}, dateLabel(summary.date, today)),
    h(
      "button",
      { type: "button", "aria-label": "Jour suivant", disabled: summary.date >= today, onclick: () => go(`#/day/${shift(summary.date, 1)}`) },
      "›",
    ),
  );

  const left = t.kcal !== undefined ? t.kcal - eaten.kcal : null;
  const headline = h(
    "section",
    { class: "card hero" },
    h("div", { class: "big" }, num.format(eaten.kcal), h("small", {}, t.kcal ? ` / ${num.format(t.kcal)} kcal` : " kcal")),
    t.kcal ? bar(eaten.kcal, t.kcal) : null,
    left === null
      ? h("p", { class: "muted" }, "Pas d'objectif : demande à Claude de le fixer.")
      : h("p", { class: "muted" }, left >= 0 ? `Encore ${kcal(left)} pour l'objectif` : `${kcal(-left)} au-dessus de l'objectif, belle journée !`),
  );

  const macro = (label: string, key: keyof Nutrition) =>
    h(
      "div",
      { class: "macro" },
      h("span", {}, label),
      bar(eaten[key], t[key]),
      h("span", { class: "val" }, t[key] ? `${num.format(eaten[key])} / ${grams(t[key]!)}` : grams(eaten[key])),
    );
  const macros = h("section", { class: "card" }, macro("Protéines", "protein_g"), macro("Glucides", "carbs_g"), macro("Lipides", "fat_g"), macro("Fibres", "fiber_g"));

  const meals = MEALS.map(({ key, label }) => {
    const list = entries.filter((e) => (e.meal ?? "none") === key);
    if (list.length === 0) return null;
    const total = list.reduce((sum, e) => sum + e.totals.kcal, 0);
    return h(
      "section",
      { class: "card" },
      h("h2", {}, label, h("span", { class: "muted" }, ` · ${kcal(total)}`)),
      ...list.map((e) => {
        const details = h("ul", { class: "items", hidden: true }, ...e.items.map((i) => h("li", {}, i.quantity ? `${i.name}, ${i.quantity}` : i.name, h("span", {}, kcal(i.kcal)))));
        return h(
          "div",
          { class: "entry" },
          h(
            "button",
            { type: "button", class: "row", onclick: () => (details.hidden = !details.hidden) },
            h("span", { class: "time" }, e.local_time.slice(0, 5)),
            h("span", { class: "desc" }, e.description, e.from_batch ? h("span", { class: "tag" }, " batch") : null),
            h("span", { class: "kcal" }, num.format(e.totals.kcal)),
          ),
          details,
        );
      }),
    );
  });

  const empty = entries.length === 0 ? h("p", { class: "muted center" }, "Rien de noté ce jour-là.") : null;
  return h("div", {}, nav, headline, macros, ...meals, empty);
}

// --- Tendances ------------------------------------------------------------------------

function kcalChart(daily: TrendsResponse["daily"], target: number | undefined): SVGElement {
  const W = 320;
  const H = 140;
  const max = Math.max(target ?? 0, ...daily.map((d) => d.kcal), 1) * 1.1;
  const step = W / daily.length;
  const y = (v: number) => H - (v / max) * H;
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": "Calories par jour" });
  daily.forEach((d, i) => {
    if (!d.logged) return;
    const over = target !== undefined && d.kcal > target * 1.1;
    svg.appendChild(s("rect", { x: i * step + step * 0.15, y: y(d.kcal), width: step * 0.7, height: H - y(d.kcal), rx: 2, class: over ? "over" : "ok" }));
  });
  if (target) svg.appendChild(s("line", { x1: 0, x2: W, y1: y(target), y2: y(target), class: "target" }));
  return svg;
}

export function trendsView(data: TrendsResponse, days: number, go: (hash: string) => void): HTMLElement {
  const avg = data.average_per_logged_day;
  const t = data.targets ?? {};
  const choose = (n: number) => h("button", { type: "button", class: n === days ? "on" : "", onclick: () => go(`#/trends/${n}`) }, `${n} jours`);
  const stat = (label: string, value: string) => h("div", { class: "stat" }, h("span", { class: "muted" }, label), h("strong", {}, value));

  return h(
    "div",
    {},
    h("header", { class: "daynav" }, h("h1", {}, "Tendances")),
    h("div", { class: "segmented" }, choose(7), choose(30)),
    h("section", { class: "card" }, kcalChart(data.daily, t.kcal), t.kcal ? h("p", { class: "muted small" }, `Ligne : objectif de ${kcal(t.kcal)}`) : null),
    h(
      "section",
      { class: "card stats" },
      stat("Moyenne", avg ? kcal(avg.kcal) : "-"),
      stat("Protéines / jour", avg ? grams(avg.protein_g) : "-"),
      stat("Jours notés", `${data.days_logged} / ${data.days_complete}`),
      stat("Série en cours", `${data.logging_streak_days} j`),
      data.days_on_target?.kcal_within_10pct != null ? stat("Dans l'objectif (±10 %)", `${data.days_on_target.kcal_within_10pct} j`) : null,
      data.weight?.last ? stat("Poids", `${num1.format(data.weight.last.kg)} kg`) : null,
      data.weight?.change_kg != null ? stat("Évolution", `${data.weight.change_kg > 0 ? "+" : ""}${num1.format(data.weight.change_kg)} kg`) : null,
    ),
  );
}

// --- Frigo ----------------------------------------------------------------------------

export function fridgeView(data: FridgeResponse): HTMLElement {
  const cards = data.batches.map((b) => {
    const left: string[] = [`${num.format(b.remaining_fraction * 100)} %`];
    if (b.total_grams) left.push(`~${grams(b.total_grams * b.remaining_fraction)}`);
    if (b.portions) left.push(`~${num1.format(b.portions * b.remaining_fraction)} portion${b.portions * b.remaining_fraction >= 2 ? "s" : ""}`);
    const age = b.age_days === 0 ? "cuisiné aujourd'hui" : `cuisiné il y a ${b.age_days} j`;
    return h(
      "section",
      { class: `card batch${b.age_days >= 4 ? " old" : ""}` },
      h("h2", {}, b.name),
      bar(b.remaining_fraction, 1),
      h("p", {}, `Reste ${left.join(", ")}`),
      h("p", { class: "muted" }, `${age} · ${kcal(b.remaining_nutrition.kcal)} restantes`),
    );
  });
  return h(
    "div",
    {},
    h("header", { class: "daynav" }, h("h1", {}, "Frigo")),
    ...cards,
    cards.length === 0 ? h("p", { class: "muted center" }, "Aucun plat en cours.") : null,
  );
}

// --- Historique -----------------------------------------------------------------------

export function historyView(data: HistoryResponse, today: string, go: (hash: string) => void): HTMLElement {
  const label = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${data.month}-15T12:00:00Z`));
  const first = new Date(`${data.month}-01T12:00:00Z`).getUTCDay(); // 0 = Sunday
  const blanks = (first + 6) % 7; // weeks start on Monday
  const target = data.target_kcal;

  const cells = data.days.map((d) => {
    let cls = "day";
    if (d.logged && target) cls += Math.abs(d.kcal - target) <= target * 0.1 ? " near" : d.kcal < target ? " under" : " over";
    else if (d.logged) cls += " logged";
    if (d.date === today) cls += " today";
    return h(
      "button",
      { type: "button", class: cls, disabled: d.date > today, onclick: () => go(`#/day/${d.date}`), "aria-label": d.logged ? `${d.date}, ${kcal(d.kcal)}` : d.date },
      String(Number(d.date.slice(8))),
    );
  });

  return h(
    "div",
    {},
    h(
      "header",
      { class: "daynav" },
      h("button", { type: "button", "aria-label": "Mois précédent", onclick: () => go(`#/history/${shiftMonth(data.month, -1)}`) }, "‹"),
      h("h1", {}, label),
      h("button", { type: "button", "aria-label": "Mois suivant", disabled: data.month >= today.slice(0, 7), onclick: () => go(`#/history/${shiftMonth(data.month, 1)}`) }, "›"),
    ),
    h(
      "section",
      { class: "card" },
      h("div", { class: "calendar" }, ...["L", "M", "M", "J", "V", "S", "D"].map((d) => h("span", { class: "dow" }, d)), ...Array.from({ length: blanks }, () => h("span", {})), ...cells),
      target
        ? h("p", { class: "legend muted small" }, h("i", { class: "near" }), " ±10 % ", h("i", { class: "under" }), " en dessous ", h("i", { class: "over" }), " au-dessus")
        : null,
    ),
  );
}
