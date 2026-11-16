// What the summary model gets to see ("memory", design section 3). Every
// number is computed here, in code, from the same views the tools and the
// dashboard use; the model only comments on them.

import { listBatches } from "../store/batches";
import type { Entry } from "../store/entries";
import { fingerprint } from "../store/db";
import type { Profile } from "../store/profile";
import { localParts } from "../domain/time";
import { batchView, startOf, summarizeDay, trends } from "../views";
import { listNotes } from "./store";

/**
 * The state of a day a summary is built from: which entries (and their
 * versions) and the targets. Anything else changing (time of day, the fridge)
 * doesn't justify a new model call.
 */
export function dayHash(entries: Entry[], profile: Profile): string {
  return fingerprint({
    entries: entries.map((e) => [e.entry_id, e.updated_at]).sort(),
    targets: profile.targets ?? null,
  });
}

/**
 * How old a cooked dish is, as a rule the model applies rather than a call
 * it makes: cooked food keeps about 3-4 days in the fridge, so from day 4 the
 * model may only suggest checking it, never eating it (a 7-day-old chili
 * suggested as dinner was the first real summary's bug).
 */
export function fridgeState(ageDays: number): "frais" | "à finir bientôt" | "à vérifier" {
  if (ageDays >= 4) return "à vérifier";
  if (ageDays >= 2) return "à finir bientôt";
  return "frais";
}

function averages(t: Awaited<ReturnType<typeof trends>>) {
  return {
    jours_notes: t.days_logged,
    jours_complets: t.days_complete,
    moyenne_par_jour_note: t.average_per_logged_day,
    jours_kcal_dans_objectif_10pct: t.days_on_target?.kcal_within_10pct ?? null,
    jours_proteines_atteintes: t.days_on_target?.protein_reached ?? null,
  };
}

export async function buildContext(sub: string, date: string, entries: Entry[], profile: Profile, final: boolean, now = new Date()) {
  const [week, month, batches, notes] = await Promise.all([
    trends(sub, 7, now),
    trends(sub, 30, now),
    listBatches(sub, false),
    listNotes(sub, startOf(date, 15), startOf(date, 2)), // the 14 days before this one
  ]);
  const day = summarizeDay(date, entries, profile);

  return {
    stats: {
      date,
      heure_locale: final ? null : localParts(now, profile.time_zone).time.slice(0, 5),
      journee_terminee: final,
      total_du_jour: day.totals,
      objectifs: day.targets,
      reste_pour_objectif: day.remaining_to_target,
      sept_derniers_jours: averages(week),
      trente_derniers_jours: averages(month),
      serie_jours_notes: week.logging_streak_days,
      frigo: batches.map((b) => {
        const v = batchView(b, now);
        return {
          nom: v.name,
          cuisine_il_y_a_jours: v.age_days,
          reste_pourcentage: Math.round(v.remaining_fraction * 100),
          etat: fridgeState(v.age_days),
        };
      }),
    },
    // Written from what I typed or photographed: untrusted, kept apart.
    repas: entries.map((e) => ({
      heure: e.local_time.slice(0, 5),
      repas: e.meal ?? null,
      description: e.description,
      kcal: e.totals.kcal,
      proteines_g: e.totals.protein_g,
    })),
    notes_precedentes: notes,
  };
}

export type SummaryContext = Awaited<ReturnType<typeof buildContext>>;
