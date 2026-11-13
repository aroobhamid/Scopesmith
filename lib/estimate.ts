import type { Estimate, Health, Story } from "./types";

// Three-point hours per T-shirt size: [optimistic, likely, pessimistic]
const SIZE_HOURS: Record<Story["size"], [number, number, number]> = {
  S: [6, 10, 18],
  M: [16, 28, 48],
  L: [40, 70, 120],
  XL: [90, 150, 260],
};

const RATE = 55; // illustrative blended USD/hour
const TEAM = 3;
const PRODUCTIVE_HOURS_PER_WEEK = 30;

/**
 * Deterministic estimator. The LLM never does this arithmetic.
 * A weaker health score widens the range (more on the pessimistic side).
 */
export function estimate(stories: Story[], health: Health, contingencyPct = 0): Estimate {
  const risk = (100 - health.score) / 100; // 0..1
  const c = 1 + contingencyPct / 100;
  const lines = stories.map((s) => {
    const [o, l, p] = SIZE_HOURS[s.size];
    return {
      storyId: s.id,
      title: s.title,
      phase: s.phase,
      optimistic: Math.round(o * (1 + 0.2 * risk) * c),
      likely: Math.round(l * (1 + 0.5 * risk) * c),
      pessimistic: Math.round(p * (1 + 1.0 * risk) * c),
    };
  });
  const sum = (k: "optimistic" | "likely" | "pessimistic") => lines.reduce((t, x) => t + x[k], 0);
  const totals = { optimistic: sum("optimistic"), likely: sum("likely"), pessimistic: sum("pessimistic") };
  const weeks = (h: number) => Math.max(1, Math.ceil(h / (TEAM * PRODUCTIVE_HOURS_PER_WEEK)));
  return {
    lines,
    totals,
    riskFactor: Math.round(risk * 100) / 100,
    contingencyPct,
    rate: RATE,
    cost: { low: totals.optimistic * RATE, likely: totals.likely * RATE, high: totals.pessimistic * RATE },
    weeks: { low: weeks(totals.optimistic), likely: weeks(totals.likely), high: weeks(totals.pessimistic) },
    teamSize: TEAM,
    assumptions: [
      `Blended rate of $${RATE}/hour (illustrative, not a quote).`,
      `Team of ${TEAM} engineers at ${PRODUCTIVE_HOURS_PER_WEEK} productive hours per person per week.`,
      `Repo health score ${health.score}/100 adds a risk factor of ${Math.round(risk * 100)}%: it widens the optimistic, likely and pessimistic hours by roughly 20%, 50% and 100% of that factor.`,
      contingencyPct ? `Critic-requested contingency of ${contingencyPct}% is included.` : "No extra contingency requested by the Critic.",
      "Based only on public repository signals and the brief. A discovery phase should confirm scope before any commitment.",
    ],
  };
}
