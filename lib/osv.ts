import type { Severity } from "./types";

export type Dep = { name: string; version: string; ecosystem: "npm" | "PyPI"; file: string };

export type VulnPackage = {
  dep: Dep;
  vulns: { id: string; summary: string; severity: Severity }[];
  worst: Severity;
};

export type OutdatedDep = { dep: Dep; latest: string; majorsBehind: number };

const RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3, critical: 4 };
export const worstOf = (a: Severity, b: Severity): Severity => (RANK[a] >= RANK[b] ? a : b);

export function parseDeps(manifests: { path: string; content: string }[]): Dep[] {
  const out: Dep[] = [];
  for (const m of manifests) {
    if (m.path.endsWith("package.json")) {
      try {
        const j = JSON.parse(m.content) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        for (const [name, range] of Object.entries({ ...j.dependencies, ...j.devDependencies })) {
          const v = String(range).match(/^[\^~>=v\s]*(\d+\.\d+\.\d+)/);
          if (v) out.push({ name, version: v[1], ecosystem: "npm", file: m.path });
        }
      } catch {
        /* ignore unparsable manifest */
      }
    } else if (/requirements[\w.-]*\.txt$/.test(m.path)) {
      for (const line of m.content.split(/\r?\n/)) {
        const r = line.trim().match(/^([A-Za-z0-9_.-]+)\s*(?:==|>=|~=)\s*(\d[\w.]*)/);
        if (r) out.push({ name: r[1], version: r[2], ecosystem: "PyPI", file: m.path });
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((d) => {
    const k = `${d.ecosystem}:${d.name}@${d.version}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function mapSeverity(raw: unknown): Severity {
  const s = String(raw ?? "").toUpperCase();
  if (s === "CRITICAL") return "critical";
  if (s === "HIGH") return "high";
  if (s === "LOW") return "low";
  return "medium";
}

/** Queries OSV.dev (free, no key) for known vulnerabilities in declared dependency versions. */
export async function queryOsv(deps: Dep[]): Promise<VulnPackage[]> {
  const list = deps.slice(0, 100);
  if (!list.length) return [];
  const res = await fetch("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      queries: list.map((d) => ({
        package: { name: d.name, ecosystem: d.ecosystem },
        version: d.version,
      })),
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { results: { vulns?: { id: string }[] }[] };

  const ids = new Set<string>();
  data.results.forEach((r) => r.vulns?.forEach((v) => ids.add(v.id)));
  const detail = new Map<string, { summary: string; severity: Severity }>();
  await Promise.all(
    [...ids].slice(0, 25).map(async (id) => {
      try {
        const r = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(id)}`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) return;
        const j = (await r.json()) as {
          summary?: string;
          details?: string;
          database_specific?: { severity?: string };
        };
        detail.set(id, {
          summary: (j.summary || j.details || id).slice(0, 160),
          severity: mapSeverity(j.database_specific?.severity),
        });
      } catch {
        /* skip */
      }
    }),
  );

  const out: VulnPackage[] = [];
  data.results.forEach((r, i) => {
    if (!r.vulns?.length) return;
    const vulns = r.vulns.map((v) => ({
      id: v.id,
      summary: detail.get(v.id)?.summary ?? v.id,
      severity: detail.get(v.id)?.severity ?? ("medium" as Severity),
    }));
    out.push({
      dep: list[i],
      vulns,
      worst: vulns.reduce<Severity>((w, v) => worstOf(w, v.severity), "low"),
    });
  });
  return out.sort((a, b) => RANK[b.worst] - RANK[a.worst]);
}

/** Compares declared npm versions with the latest published major version. */
export async function checkOutdated(deps: Dep[]): Promise<{ checked: number; outdated: OutdatedDep[] }> {
  const npm = deps.filter((d) => d.ecosystem === "npm").slice(0, 30);
  const results = await Promise.all(
    npm.map(async (dep): Promise<OutdatedDep | null> => {
      try {
        const r = await fetch(`https://registry.npmjs.org/${encodeURIComponent(dep.name).replace("%40", "@")}/latest`, {
          signal: AbortSignal.timeout(8_000),
        });
        if (!r.ok) return null;
        const { version } = (await r.json()) as { version: string };
        const behind = parseInt(version.split(".")[0], 10) - parseInt(dep.version.split(".")[0], 10);
        return { dep, latest: version, majorsBehind: Number.isFinite(behind) ? behind : 0 };
      } catch {
        return null;
      }
    }),
  );
  const ok = results.filter((r): r is OutdatedDep => r !== null);
  return { checked: ok.length, outdated: ok.filter((o) => o.majorsBehind >= 1) };
}

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "AWS access key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "API key (sk-...)", re: /\bsk-[A-Za-z0-9]{24,}/ },
  { name: "Private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "Hardcoded password", re: /\b(?:password|passwd|secret)\b\s*[:=]\s*["'][^"'\s]{6,}["']/i },
];

export type SecretHit = { path: string; kind: string };

/** Scans sampled files for secret-shaped strings. Never returns the secret value itself. */
export function scanSecrets(files: { path: string; content: string }[]): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const f of files) {
    if (/\.(md|txt|lock)$|example|sample|test|spec|fixture/i.test(f.path)) continue;
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(f.content)) hits.push({ path: f.path, kind: p.name });
    }
  }
  return hits;
}
