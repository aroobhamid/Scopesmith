import data from "./demo-nodegoat.json";
import { estimate } from "./estimate";
import type {
  AgentId,
  Architecture,
  CriticReport,
  Emit,
  Finding,
  Health,
  RepoSummary,
  ResultKey,
  Story,
} from "./types";

/**
 * Demo mode: replays a pre-recorded run with no LLM and no network.
 * - Real: repo facts, health score, vulnerability findings and evidence links
 *   (recorded from OWASP/NodeGoat), plus the estimate arithmetic (computed live).
 * - Sample: architecture, user stories, Critic notes and proposal text are hand-written
 *   illustrations, NOT model output. The UI labels the run accordingly.
 */
const DEMO_BRIEF =
  "The client runs this application on a single on-prem server. They want to move to cloud hosting, add a mobile app for customers, and fix security and performance problems before their next audit.";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const repo = data.repo as unknown as RepoSummary;
const health = data.health as unknown as Health;
const findings = data.findings as unknown as Finding[];

const architecture: Architecture = {
  summary:
    "A server-rendered Node.js/Express monolith. server.js wires up route handlers, which call data-access objects that talk to MongoDB, and render HTML views.",
  components: [
    { name: "Express server", description: "Entry point: middleware, sessions and routing setup.", files: ["server.js", "config/config.js"] },
    { name: "Route handlers", description: "One handler per feature: contributions, benefits, memos, profile, research and sessions.", files: ["app/routes/index.js", "app/routes/contributions.js", "app/routes/session.js", "app/routes/profile.js"] },
    { name: "Data access layer", description: "DAO modules that read and write MongoDB collections.", files: ["app/data/user-dao.js", "app/data/contributions-dao.js", "app/data/memos-dao.js"] },
    { name: "HTML views", description: "Server-side rendered templates for each page.", files: ["app/views/layout.html", "app/views/dashboard.html", "app/views/login.html"] },
  ],
  mermaid: `flowchart TD
  Browser["Browser"] --> Server["server.js (Express)"]
  Server --> Config["config/config.js"]
  Server --> Routes["Route handlers (app/routes)"]
  Routes --> DAO["Data access (app/data)"]
  DAO --> Mongo[("MongoDB")]
  Routes --> Views["HTML views (app/views)"]
  Views --> Browser`,
};

const stories: Story[] = [
  { id: "S1", title: "Upgrade vulnerable dependencies", description: "Upgrade packages with known critical and high vulnerabilities and fix breakages.", acceptance: ["No critical or high advisories remain in the dependency scan", "App passes smoke tests after upgrade"], area: "security", size: "M", phase: "foundation" },
  { id: "S2", title: "Fix injection and access-control weaknesses in route handlers", description: "Review and harden request handling in the main routes before the audit.", acceptance: ["Inputs validated on all state-changing routes", "Authorization checked per resource"], area: "security", size: "L", phase: "foundation" },
  { id: "S3", title: "Automate build, test and dependency scanning in CI", description: "Run tests and a vulnerability scan on every pull request.", acceptance: ["CI runs on each pull request", "Failing scan blocks merge"], area: "devops", size: "M", phase: "foundation" },
  { id: "S4", title: "Containerise and migrate to cloud hosting", description: "Package the app and deploy it to a managed cloud environment.", acceptance: ["App runs from a container image", "Staging environment mirrors production"], area: "migration", size: "XL", phase: "build" },
  { id: "S5", title: "Move MongoDB to a managed database with backups", description: "Migrate data with a rehearsed cutover and automated backups.", acceptance: ["Backup and restore tested", "Cutover rehearsed in staging"], area: "migration", size: "L", phase: "build" },
  { id: "S6", title: "Expose a versioned REST API for the mobile app", description: "Add token-based API endpoints for the features customers need.", acceptance: ["API documented", "Authenticated and rate-limited"], area: "feature", size: "L", phase: "build" },
  { id: "S7", title: "Build the customer mobile app", description: "Build the first release of the mobile client on the new API.", acceptance: ["Login and core flows work on iOS and Android", "Published to test channels"], area: "feature", size: "XL", phase: "build" },
  { id: "S8", title: "Baseline and improve performance", description: "Measure key pages, fix the worst bottlenecks and load test.", acceptance: ["Performance baseline recorded", "Agreed targets met under load test"], area: "performance", size: "M", phase: "launch" },
  { id: "S9", title: "Roll out, monitor and hand over", description: "Production cutover, monitoring and documentation for the client's team.", acceptance: ["Monitoring and alerts live", "Runbook delivered"], area: "docs", size: "M", phase: "launch" },
];

const concerns = [
  "The mobile app scope is vague (platforms, offline use, authentication), so S7 is the largest uncertainty.",
  "Several dependencies are far behind their current versions, so upgrades in S1 may force code changes beyond the estimate.",
  "Data migration needs a rehearsed cutover and downtime plan; make sure S5 includes a dress rehearsal.",
];

type Step = { agent: AgentId; start: string; logs: string[]; done: string; results?: [ResultKey, unknown][]; wait?: number };

export async function runDemo(emit: Emit): Promise<void> {
  const log = (agent: AgentId, message: string) => emit({ type: "log", agent, message });
  const run = async (s: Step) => {
    emit({ type: "agent", agent: s.agent, status: "start", message: s.start });
    await sleep(s.wait ?? 700);
    for (const l of s.logs) {
      log(s.agent, l);
      await sleep(350);
    }
    for (const [key, d] of s.results ?? []) emit({ type: "result", key, data: d });
    emit({ type: "agent", agent: s.agent, status: "done", message: s.done });
    await sleep(250);
  };

  await run({
    agent: "planner",
    start: "Reading the brief and planning the inspection",
    logs: [
      `Brief: ${DEMO_BRIEF.slice(0, 80)}…`,
      "Goals: move to the cloud; add a mobile app; fix security and performance before the audit",
      "Will focus on paths matching: routes, auth, data, config",
    ],
    done: "Inspection plan ready",
  });
  await run({
    agent: "scout",
    start: "Fetching repository facts from GitHub",
    logs: data.logs.scout,
    results: [["repo", repo]],
    done: `${data.treeCount} files indexed, ${data.keyFilePaths.length} sampled`,
  });
  await run({
    agent: "auditor",
    start: "Checking dependencies against OSV.dev and scanning for secrets",
    logs: data.logs.auditor,
    done: "Vulnerable packages found",
  });
  await run({
    agent: "quality",
    start: "Measuring tests, CI, activity and file sizes",
    logs: data.logs.quality,
    results: [["health", health]],
    done: "Quality metrics computed",
  });
  await run({
    agent: "architect",
    start: "Mapping the system architecture from sampled files",
    logs: ["Sample output: component map built from the real file tree"],
    results: [["architecture", architecture], ["findings", findings]],
    done: `${architecture.components.length} components mapped`,
  });
  await run({
    agent: "analyst",
    start: "Turning the brief and findings into user stories",
    logs: [`${stories.length} sample user stories drafted`],
    results: [["stories", stories]],
    done: `${stories.length} user stories written`,
  });

  let est = estimate(stories, health);
  await run({
    agent: "estimator",
    start: "Calculating three-point estimates from story sizes and repo health",
    logs: [`First pass: ${est.totals.optimistic}–${est.totals.pessimistic} hours (likely ${est.totals.likely})`],
    results: [["estimate", est]],
    done: "First estimate ready",
  });

  emit({ type: "agent", agent: "critic", status: "start", message: "Challenging the stories and the estimate" });
  await sleep(700);
  for (const c of concerns) {
    log("critic", `Concern: ${c}`);
    await sleep(350);
  }
  log("critic", "Requested 10% contingency. Sending back to the Estimator.");
  await sleep(350);
  await run({
    agent: "estimator",
    start: "Re-estimating with 10% contingency",
    logs: [],
    done: "Final estimate ready",
    wait: 500,
  });
  est = estimate(stories, health, 10);
  emit({ type: "result", key: "estimate", data: est });
  const report: CriticReport = { verdict: "concerns", concerns, droppedFindings: 0 };
  emit({ type: "result", key: "critic", data: report });
  emit({ type: "agent", agent: "critic", status: "done", message: `${concerns.length} concerns raised` });
  await sleep(250);

  const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
  const top = findings.slice(0, 3).map((f) => `- **${f.title}** (${f.severity})`).join("\n");
  const proposal = `# Modernization proposal: ${repo.owner}/${repo.repo}

> Sample proposal text for the demo. Numbers come from the recorded audit and the live estimator.

## Executive summary
The application is a server-rendered Node.js monolith with a repository health score of **${health.score}/100**. We propose a three-phase programme to harden it, move it to managed cloud hosting and deliver a customer mobile app.

## Current state
${health.dimensions.map((d) => `- **${d.name}: ${d.score}/100**, ${d.note}`).join("\n")}

Most serious findings:
${top}

## Proposed approach
- **Foundation:** S1 dependency upgrades, S2 route-handler hardening, S3 CI with scanning.
- **Build:** S4 containerisation and cloud migration, S5 managed database, S6 mobile API, S7 mobile app.
- **Launch:** S8 performance work, S9 rollout, monitoring and handover.

## Timeline and team
${est.teamSize} engineers, about **${est.weeks.low}–${est.weeks.high} weeks** (likely ${est.weeks.likely}).

## Investment (indicative)
| Scenario | Hours | Cost | Weeks |
|---|---|---|---|
| Low | ${est.totals.optimistic} | ${usd(est.cost.low)} | ${est.weeks.low} |
| Likely | ${est.totals.likely} | ${usd(est.cost.likely)} | ${est.weeks.likely} |
| High | ${est.totals.pessimistic} | ${usd(est.cost.high)} | ${est.weeks.high} |

## Risks and mitigations
${concerns.map((c) => `- ${c}`).join("\n")}

## Assumptions
${est.assumptions.map((a) => `- ${a}`).join("\n")}

## Next steps
Agree scope in a short discovery phase, confirm the mobile app requirements, then start the foundation phase.
`;
  emit({ type: "agent", agent: "writer", status: "start", message: "Writing the client proposal" });
  await sleep(900);
  emit({ type: "result", key: "proposal", data: proposal });
  emit({ type: "agent", agent: "writer", status: "done", message: "Proposal ready" });
}
