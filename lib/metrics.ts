import { blobUrl, isSource, isTest, type RepoFacts } from "./github";
import type { OutdatedDep, SecretHit, VulnPackage } from "./osv";
import type { AgentId, Finding, Health, Severity } from "./types";

export type Metrics = {
  sourceFiles: number;
  testFiles: number;
  hasCI: boolean;
  bigFiles: { path: string; size: number }[];
  daysSincePush: number;
  recentCommits: number;
  topAuthorShare: number;
  authors: number;
};

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

export function computeMetrics(f: RepoFacts): Metrics {
  const sourceFiles = f.tree.filter((t) => isSource(t.path) && !isTest(t.path)).length;
  const testFiles = f.tree.filter((t) => isTest(t.path) && isSource(t.path)).length;
  const hasCI = f.tree.some((t) =>
    /^(\.github\/workflows\/|\.gitlab-ci\.yml|Jenkinsfile|azure-pipelines\.yml|\.circleci\/|\.travis\.yml)/.test(t.path),
  );
  const bigFiles = f.tree
    .filter((t) => isSource(t.path) && t.size > 30_000)
    .sort((a, b) => b.size - a.size)
    .slice(0, 5);
  const daysSincePush = Math.floor((Date.now() - new Date(f.pushedAt).getTime()) / 86_400_000);
  const counts = new Map<string, number>();
  f.commits.forEach((c) => counts.set(c.author, (counts.get(c.author) ?? 0) + 1));
  const top = Math.max(0, ...counts.values());
  return {
    sourceFiles,
    testFiles,
    hasCI,
    bigFiles,
    daysSincePush,
    recentCommits: f.commits.length,
    topAuthorShare: f.commits.length ? top / f.commits.length : 0,
    authors: counts.size,
  };
}

export function computeHealth(
  f: RepoFacts,
  m: Metrics,
  vulns: VulnPackage[],
  deps: { checked: number; outdated: OutdatedDep[] },
  secrets: SecretHit[],
): Health {
  // Security
  const sev = (s: Severity) => vulns.filter((v) => v.worst === s).length;
  const security = clamp(100 - sev("critical") * 25 - sev("high") * 12 - sev("medium") * 5 - sev("low") * 2 - secrets.length * 30);
  const secNote = `${vulns.length} vulnerable packages (${sev("critical")} critical, ${sev("high")} high)${secrets.length ? `, ${secrets.length} possible secrets` : ""}`;

  // Testing
  const ratio = m.sourceFiles ? m.testFiles / m.sourceFiles : 0;
  const testing = m.testFiles === 0 ? 5 : clamp((ratio / 0.3) * 100);
  const testNote = `${m.testFiles} test files for ${m.sourceFiles} source files`;

  // Maintainability
  let maint = 100;
  if (!m.hasCI) maint -= 25;
  if (f.readme.length < 500) maint -= 15;
  if (!f.license) maint -= 10;
  maint -= Math.min(30, m.bigFiles.length * 8);
  const maintNote = `${m.hasCI ? "CI present" : "no CI"}, ${f.readme.length < 500 ? "thin README" : "README ok"}, ${m.bigFiles.length} very large files`;

  // Activity
  const d = m.daysSincePush;
  let activity = d <= 90 ? 100 : d <= 365 ? 65 : d <= 730 ? 35 : 10;
  if (m.recentCommits >= 10 && m.topAuthorShare > 0.8) activity -= 15;
  const actNote = `last push ${d} days ago, ${m.authors} recent authors`;

  // Dependencies
  let deptScore = 60;
  let depNote = "not assessed (no supported manifest)";
  if (deps.checked > 0) {
    const one = deps.outdated.filter((o) => o.majorsBehind === 1).length;
    const two = deps.outdated.filter((o) => o.majorsBehind >= 2).length;
    deptScore = clamp(100 - (40 * one + 70 * two) / deps.checked);
    depNote = `${deps.outdated.length} of ${deps.checked} checked packages are a major version behind`;
  }

  const dimensions = [
    { name: "Security", score: security, note: secNote },
    { name: "Testing", score: testing, note: testNote },
    { name: "Maintainability", score: clamp(maint), note: maintNote },
    { name: "Activity", score: clamp(activity), note: actNote },
    { name: "Dependencies", score: deptScore, note: depNote },
  ];
  const weights = [0.3, 0.2, 0.2, 0.1, 0.2];
  const score = clamp(dimensions.reduce((s, dim, i) => s + dim.score * weights[i], 0));
  return { score, dimensions };
}

/** Findings that come straight from tool output: every one has a verifiable evidence link. */
export function deterministicFindings(
  f: RepoFacts,
  m: Metrics,
  vulns: VulnPackage[],
  deps: { checked: number; outdated: OutdatedDep[] },
  secrets: SecretHit[],
  nextId: () => string,
): Finding[] {
  const out: Finding[] = [];
  const add = (x: Omit<Finding, "id">) => out.push({ id: nextId(), ...x });

  for (const v of vulns.slice(0, 8)) {
    add({
      title: `${v.dep.name}@${v.dep.version} has ${v.vulns.length} known ${v.vulns.length === 1 ? "vulnerability" : "vulnerabilities"}`,
      severity: v.worst,
      category: "Security",
      detail: `Declared in ${v.dep.file}. ${v.vulns[0].summary} (${v.vulns.slice(0, 3).map((x) => x.id).join(", ")}).`,
      evidenceLabel: v.vulns[0].id,
      evidenceUrl: `https://osv.dev/vulnerability/${encodeURIComponent(v.vulns[0].id)}`,
      source: "auditor",
    });
  }
  for (const s of secrets) {
    add({
      title: `Possible hardcoded secret: ${s.kind}`,
      severity: "critical",
      category: "Security",
      detail: `A ${s.kind} pattern appears in ${s.path}. The value is not shown here. Rotate it and move it to environment variables.`,
      evidenceLabel: s.path,
      evidenceUrl: blobUrl(f, s.path),
      source: "auditor",
    });
  }
  if (m.testFiles === 0 && m.sourceFiles > 10) {
    add({
      title: "No automated tests found",
      severity: "high",
      category: "Testing",
      detail: `${m.sourceFiles} source files and no test files were detected, so refactoring or migration carries high regression risk.`,
      evidenceLabel: "repository file tree",
      evidenceUrl: `${f.url}/tree/${f.branch}`,
      source: "quality",
    });
  } else if (m.sourceFiles > 10 && m.testFiles / m.sourceFiles < 0.1) {
    add({
      title: "Very thin test coverage",
      severity: "medium",
      category: "Testing",
      detail: `Only ${m.testFiles} test files for ${m.sourceFiles} source files.`,
      evidenceLabel: "repository file tree",
      evidenceUrl: `${f.url}/tree/${f.branch}`,
      source: "quality",
    });
  }
  if (!m.hasCI) {
    add({
      title: "No CI pipeline detected",
      severity: "medium",
      category: "DevOps",
      detail: "No GitHub Actions, GitLab CI, Jenkins, Azure Pipelines or CircleCI configuration was found.",
      evidenceLabel: "repository file tree",
      evidenceUrl: `${f.url}/tree/${f.branch}`,
      source: "quality",
    });
  }
  if (m.recentCommits >= 10 && m.topAuthorShare > 0.8) {
    add({
      title: "Bus-factor risk: one author dominates recent commits",
      severity: "medium",
      category: "Team",
      detail: `${Math.round(m.topAuthorShare * 100)}% of the last ${m.recentCommits} commits come from one author.`,
      evidenceLabel: "commit history",
      evidenceUrl: `${f.url}/commits/${f.branch}`,
      source: "quality",
    });
  }
  if (m.daysSincePush > 730) {
    add({
      title: "Repository looks unmaintained",
      severity: "medium",
      category: "Maintenance",
      detail: `The last push was ${m.daysSincePush} days ago.`,
      evidenceLabel: "commit history",
      evidenceUrl: `${f.url}/commits/${f.branch}`,
      source: "quality",
    });
  }
  const behind = deps.outdated.filter((o) => o.majorsBehind >= 2);
  if (behind.length) {
    add({
      title: `${behind.length} dependencies are 2+ major versions behind`,
      severity: behind.length > 4 ? "high" : "medium",
      category: "Dependencies",
      detail: behind
        .slice(0, 5)
        .map((o) => `${o.dep.name} ${o.dep.version} → ${o.latest}`)
        .join("; "),
      evidenceLabel: behind[0].dep.file,
      evidenceUrl: blobUrl(f, behind[0].dep.file),
      source: "auditor",
    });
  }
  if (m.bigFiles.length) {
    add({
      title: `${m.bigFiles.length} very large source files`,
      severity: "low",
      category: "Maintainability",
      detail: m.bigFiles.map((b) => `${b.path} (${Math.round(b.size / 1024)} KB)`).join("; "),
      evidenceLabel: m.bigFiles[0].path,
      evidenceUrl: blobUrl(f, m.bigFiles[0].path),
      source: "quality" as AgentId,
    });
  }
  return out;
}
