import { askJson, ask } from "./llm";
import { scoutRepo, parseRepo, isSource, type RepoFacts } from "./github";
import { checkOutdated, parseDeps, queryOsv, scanSecrets } from "./osv";
import { computeHealth, computeMetrics, deterministicFindings } from "./metrics";
import { estimate } from "./estimate";
import type {
  AgentId,
  Architecture,
  CriticReport,
  Emit,
  Finding,
  ResultKey,
  Severity,
  Story,
} from "./types";

type Input = { repoUrl: string; brief: string };

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
const SIZES: Story["size"][] = ["S", "M", "L", "XL"];
const PHASES: Story["phase"][] = ["foundation", "build", "launch"];

const asStrings = (v: unknown, max = 8): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : [];

export async function runPipeline(input: Input, emit: Emit): Promise<void> {
  const log = (agent: AgentId, message: string) => emit({ type: "log", agent, message });
  const start = (agent: AgentId, message: string) => emit({ type: "agent", agent, status: "start", message });
  const done = (agent: AgentId, message: string) => emit({ type: "agent", agent, status: "done", message });
  const result = (key: ResultKey, data: unknown) => emit({ type: "result", key, data });

  const parsed = parseRepo(input.repoUrl);
  if (!parsed) throw new Error("Enter a GitHub repo URL like https://github.com/owner/repo.");
  const brief = input.brief.trim() || "No brief provided. Assess the codebase and propose a sensible modernization plan.";

  // 1. PLANNER ---------------------------------------------------------------
  start("planner", "Reading the brief and planning the inspection");
  const plan =
    (await askJson<{ goals?: unknown; focus?: unknown; risks?: unknown }>(
      "You are the Planner on a software consultancy's presales team. Given a client brief and a repository name, decide what the team must establish. " +
        'Return {"goals": string[] (max 5 client goals), "focus": string[] (max 6 lowercase keywords likely to appear in relevant file paths, e.g. "checkout","auth"), "risks": string[] (max 4 things to watch for)}.',
      `Repository: ${parsed.owner}/${parsed.repo}\nClient brief: ${brief}`,
      { maxTokens: 600 },
    )) ?? {};
  const goals = asStrings(plan.goals, 5);
  const focus = asStrings(plan.focus, 6);
  log("planner", `Goals: ${goals.join("; ") || "general assessment"}`);
  log("planner", `Will focus on paths matching: ${focus.join(", ") || "entry points"}`);
  done("planner", "Inspection plan ready");

  // 2. SCOUT -----------------------------------------------------------------
  start("scout", "Fetching repository facts from GitHub");
  const facts: RepoFacts = await scoutRepo(parsed.owner, parsed.repo, focus, (m) => log("scout", m));
  const langs = Object.entries(facts.languages)
    .sort((a, b) => b[1] - a[1])
    .map(([k]) => k);
  const metrics = computeMetrics(facts);
  result("repo", {
    owner: facts.owner,
    repo: facts.repo,
    url: facts.url,
    description: facts.description,
    stars: facts.stars,
    pushedAt: facts.pushedAt,
    languages: langs.slice(0, 5),
    sourceFiles: metrics.sourceFiles,
    testFiles: metrics.testFiles,
  });
  done("scout", `${facts.tree.length} files indexed, ${facts.keyFiles.length} sampled`);

  // 3. AUDITOR + QUALITY + ARCHITECT run in parallel ---------------------------
  let counter = 0;
  const nextId = () => `F${++counter}`;
  const treeSet = new Set(facts.tree.map((t) => t.path));

  const auditorTask = (async () => {
    start("auditor", "Checking dependencies against OSV.dev and scanning for secrets");
    const deps = parseDeps(facts.manifests);
    log("auditor", `Parsed ${deps.length} pinned dependencies from ${facts.manifests.length} manifests`);
    const [vulns, outdated] = await Promise.all([
      queryOsv(deps).catch(() => []),
      checkOutdated(deps).catch(() => ({ checked: 0, outdated: [] })),
    ]);
    const secrets = scanSecrets([...facts.keyFiles, ...facts.manifests]);
    log("auditor", `${vulns.length} packages with known vulnerabilities, ${outdated.outdated.length} major versions behind, ${secrets.length} secret-like strings`);
    done("auditor", `${vulns.length} vulnerable packages found`);
    return { vulns, outdated, secrets };
  })();

  const qualityTask = (async () => {
    start("quality", "Measuring tests, CI, activity and file sizes");
    log("quality", `${metrics.testFiles} test files, ${metrics.sourceFiles} source files, CI ${metrics.hasCI ? "found" : "missing"}`);
    done("quality", "Quality metrics computed");
  })();

  const architectTask = (async () => {
    start("architect", "Mapping the system architecture from sampled files");
    const validPaths = facts.tree.map((t) => t.path).filter((p) => isSource(p) || /\.(json|ya?ml|toml|md)$/i.test(p));
    const run = async (note: string) =>
      askJson<{
        summary?: string;
        components?: { name?: string; description?: string; files?: unknown }[];
        mermaid?: string;
        findings?: { title?: string; severity?: string; detail?: string; file?: string }[];
      }>(
        "You are the Architect on a software consultancy's presales team. Infer the architecture from the evidence provided and nothing else. " +
          'Return {"summary": string (2-3 sentences), "components": [{"name","description","files": string[]}] (max 8), ' +
          '"mermaid": a Mermaid flowchart (start with "flowchart TD", max 12 nodes, node labels in double quotes, simple alphanumeric node ids), ' +
          '"findings": [{"title","severity": "critical"|"high"|"medium"|"low","detail","file"}] (max 6 code-level concerns)}. ' +
          "Every file value MUST be an exact path from the provided file list. Do not speculate beyond the evidence." +
          note,
        [
          `Repo: ${facts.owner}/${facts.repo} — ${facts.description}`,
          `Languages: ${langs.join(", ")}`,
          `Client goals: ${goals.join("; ")}`,
          `README excerpt:\n${facts.readme.slice(0, 1500)}`,
          `File list (sample, ${validPaths.length} total):\n${validPaths.slice(0, 150).join("\n")}`,
          `Key files:\n${facts.keyFiles.map((k) => `--- ${k.path}\n${k.content}`).join("\n").slice(0, 14000)}`,
        ].join("\n\n"),
        { maxTokens: 2200 },
      );

    let out = await run("");
    // Critic loop: reject findings whose evidence path does not exist, send the Architect back (max 2 times)
    let attempts = 0;
    while (attempts < 2) {
      const bad = (out?.findings ?? []).filter((f) => !f.file || !treeSet.has(f.file));
      if (!bad.length) break;
      attempts++;
      log("critic", `Architect cited ${bad.length} path(s) that do not exist in the repo. Sending back (attempt ${attempts}/2).`);
      out = await run(
        `\nYour previous answer cited invalid file paths: ${bad.map((b) => b.file).join(", ")}. Use ONLY paths from the file list.`,
      );
    }
    const kept: Finding[] = [];
    let dropped = 0;
    for (const f of out?.findings ?? []) {
      if (f.title && f.file && treeSet.has(f.file)) {
        kept.push({
          id: nextId(),
          title: f.title,
          severity: SEVERITIES.includes(f.severity as Severity) ? (f.severity as Severity) : "medium",
          category: "Code",
          detail: f.detail ?? "",
          evidenceLabel: f.file,
          evidenceUrl: `https://github.com/${facts.owner}/${facts.repo}/blob/${facts.branch}/${f.file}`,
          source: "architect",
        });
      } else {
        dropped++;
      }
    }
    if (dropped) log("critic", `Dropped ${dropped} finding(s) with no verifiable evidence`);
    const arch: Architecture = {
      summary: out?.summary ?? "The architecture could not be inferred from the sampled files.",
      components: (out?.components ?? []).slice(0, 8).map((c) => ({
        name: c.name ?? "Component",
        description: c.description ?? "",
        files: asStrings(c.files).filter((p) => treeSet.has(p)),
      })),
      mermaid: /^\s*(flowchart|graph)\b/.test(out?.mermaid ?? "") && !/<script|click /i.test(out?.mermaid ?? "") ? out!.mermaid! : "",
    };
    result("architecture", arch);
    done("architect", `${arch.components.length} components mapped, ${kept.length} verified findings`);
    return { arch, kept, dropped };
  })();

  const [audit, , archOut] = await Promise.all([auditorTask, qualityTask, architectTask]);

  const health = computeHealth(facts, metrics, audit.vulns, audit.outdated, audit.secrets);
  result("health", health);
  const findings: Finding[] = [
    ...deterministicFindings(facts, metrics, audit.vulns, audit.outdated, audit.secrets, nextId),
    ...archOut.kept,
  ].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity));
  result("findings", findings);

  // 4. REQUIREMENTS ANALYST --------------------------------------------------
  start("analyst", "Turning the brief and findings into user stories");
  const storyRaw = await askJson<{ stories?: Partial<Story>[] }>(
    "You are the Requirements Analyst on a software consultancy's presales team. Convert the client brief and the audit findings into 6-9 delivery user stories. " +
      "Include remediation stories for the most serious findings. " +
      'Return {"stories": [{"id": "S1", "title", "description", "acceptance": string[] (2-3 testable criteria), ' +
      '"area": one of security|testing|devops|migration|feature|performance|docs|refactor, "size": "S"|"M"|"L"|"XL", "phase": "foundation"|"build"|"launch"}]}. ' +
      "Foundation = stabilise and de-risk first, build = main client work, launch = rollout and handover.",
    [
      `Client brief: ${brief}`,
      `Repo health ${health.score}/100: ${health.dimensions.map((d) => `${d.name} ${d.score}`).join(", ")}`,
      `Top findings:\n${findings.slice(0, 10).map((f) => `- [${f.severity}] ${f.title}`).join("\n")}`,
      `Architecture: ${archOut.arch.summary}`,
    ].join("\n\n"),
    { maxTokens: 2500 },
  );
  const stories: Story[] = (storyRaw?.stories ?? []).slice(0, 10).map((s, i) => ({
    id: s.id || `S${i + 1}`,
    title: s.title || `Story ${i + 1}`,
    description: s.description || "",
    acceptance: asStrings(s.acceptance, 4),
    area: s.area || "feature",
    size: SIZES.includes(s.size as Story["size"]) ? (s.size as Story["size"]) : "M",
    phase: PHASES.includes(s.phase as Story["phase"]) ? (s.phase as Story["phase"]) : "build",
  }));
  if (!stories.length) throw new Error("The Requirements Analyst returned no usable stories. Try again.");
  result("stories", stories);
  done("analyst", `${stories.length} user stories written`);

  // 5. ESTIMATOR -------------------------------------------------------------
  start("estimator", "Calculating three-point estimates from story sizes and repo health");
  let est = estimate(stories, health);
  result("estimate", est);
  log("estimator", `First pass: ${est.totals.optimistic}–${est.totals.pessimistic} hours (likely ${est.totals.likely})`);
  done("estimator", "First estimate ready");

  // 6. CRITIC ----------------------------------------------------------------
  start("critic", "Challenging the stories and the estimate");
  const review = await askJson<{ verdict?: string; concerns?: unknown; contingencyPct?: number }>(
    "You are the sceptical Critic on a software consultancy's presales team. Review the user stories and estimate against the audit evidence. " +
      "Look for missing work, unrealistic optimism and unsupported assumptions. " +
      'Return {"verdict": "ok"|"concerns", "concerns": string[] (max 5, specific), "contingencyPct": number 0-30 (extra contingency you would add, 0 if the estimate is sound)}.',
    [
      `Brief: ${brief}`,
      `Health ${health.score}/100`,
      `Findings:\n${findings.slice(0, 10).map((f) => `- [${f.severity}] ${f.title}`).join("\n")}`,
      `Stories:\n${stories.map((s) => `- ${s.id} ${s.title} (${s.size}, ${s.area})`).join("\n")}`,
      `Estimate: ${est.totals.optimistic}/${est.totals.likely}/${est.totals.pessimistic} hours (optimistic/likely/pessimistic)`,
    ].join("\n\n"),
    { maxTokens: 800 },
  );
  const contingency = Math.max(0, Math.min(30, Math.round(Number(review?.contingencyPct ?? 0)) || 0));
  const concerns = asStrings(review?.concerns, 5);
  concerns.forEach((c) => log("critic", `Concern: ${c}`));
  if (contingency > 0) {
    log("critic", `Requested ${contingency}% contingency. Sending back to the Estimator.`);
    start("estimator", `Re-estimating with ${contingency}% contingency`);
    est = estimate(stories, health, contingency);
    result("estimate", est);
    done("estimator", `Final: ${est.totals.optimistic}–${est.totals.pessimistic} hours`);
  }
  const report: CriticReport = {
    verdict: concerns.length || contingency ? "concerns" : "ok",
    concerns,
    droppedFindings: archOut.dropped,
  };
  result("critic", report);
  done("critic", report.verdict === "ok" ? "No major concerns" : `${concerns.length} concerns raised`);

  // 7. PROPOSAL WRITER ---------------------------------------------------------
  start("writer", "Writing the client proposal");
  const money = (n: number) => `$${n.toLocaleString("en-US")}`;
  const proposal = await ask(
    "You are the Proposal Writer for a software house. Write a client-ready proposal in Markdown using ONLY the case file provided. " +
      "Sections: Executive summary; Current state of the system (health score and key evidence); Proposed approach in phases (foundation, build, launch) referencing story ids; " +
      "Timeline and team; Investment (a table with low / likely / high hours, cost and weeks); Risks and mitigations (use the Critic's concerns); Assumptions; Next steps. " +
      "Cite findings by title. Do not invent numbers, dates, names or technologies. Label the numbers as indicative.",
    JSON.stringify({
      client_brief: brief,
      repo: `${facts.owner}/${facts.repo}`,
      languages: langs.slice(0, 5),
      health,
      architecture: archOut.arch.summary,
      top_findings: findings.slice(0, 10).map((f) => ({ severity: f.severity, title: f.title, evidence: f.evidenceUrl })),
      stories: stories.map((s) => ({ id: s.id, title: s.title, phase: s.phase, size: s.size, acceptance: s.acceptance })),
      estimate: {
        hours: est.totals,
        cost: { low: money(est.cost.low), likely: money(est.cost.likely), high: money(est.cost.high) },
        weeks: est.weeks,
        team: est.teamSize,
        assumptions: est.assumptions,
      },
      critic_concerns: concerns,
    }),
    { maxTokens: 3000 },
  );
  result("proposal", proposal);
  done("writer", "Proposal ready");
}
