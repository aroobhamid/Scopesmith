const API = "https://api.github.com";

export type TreeEntry = { path: string; size: number };

export type RepoFacts = {
  owner: string;
  repo: string;
  url: string;
  branch: string;
  description: string;
  stars: number;
  forks: number;
  openIssues: number;
  license: string | null;
  pushedAt: string;
  languages: Record<string, number>;
  tree: TreeEntry[];
  truncated: boolean;
  readme: string;
  manifests: { path: string; content: string }[];
  keyFiles: { path: string; content: string }[];
  commits: { date: string; author: string }[];
};

function headers(): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "scopesmith-hackathon",
  };
  if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return h;
}

async function gh<T>(path: string): Promise<T> {
  const r = await fetch(API + path, { headers: headers(), cache: "no-store" });
  if (r.status === 404) throw new Error("Repository not found. It must be a public GitHub repo.");
  if (r.status === 403 || r.status === 429)
    throw new Error("GitHub rate limit reached. Set GITHUB_TOKEN on the server or try later.");
  if (!r.ok) throw new Error(`GitHub request failed (${r.status}).`);
  return (await r.json()) as T;
}

export function parseRepo(input: string): { owner: string; repo: string } | null {
  const s = input.trim();
  const url = s.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i);
  if (url) return { owner: url[1], repo: url[2] };
  const short = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (short) return { owner: short[1], repo: short[2] };
  return null;
}

const VENDOR = /(^|\/)(node_modules|vendor|dist|build|out|\.next|coverage|__pycache__|\.git|\.venv|venv|third_party|bower_components)\//i;
const SRC_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|py|java|cs|go|rb|php|rs|kt|swift|cpp|c|h|vue|svelte|scala)$/i;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|e2e)\/|\.(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py)$/i;

export const isVendor = (p: string) => VENDOR.test(p);
export const isTest = (p: string) => TEST_PATH.test(p);
export const isSource = (p: string) => SRC_EXT.test(p) && !isVendor(p) && !/\.min\./.test(p);

export const blobUrl = (f: { owner: string; repo: string; branch: string }, path: string) =>
  `https://github.com/${f.owner}/${f.repo}/blob/${f.branch}/${path.split("/").map(encodeURIComponent).join("/")}`;

async function raw(
  owner: string,
  repo: string,
  branch: string,
  path: string,
  max: number,
): Promise<string | null> {
  try {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path
      .split("/")
      .map(encodeURIComponent)
      .join("/")}`;
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    return (await r.text()).slice(0, max);
  } catch {
    return null;
  }
}

function scoreKeyFile(e: TreeEntry, focus: string[]): number {
  const name = e.path.split("/").pop() ?? "";
  const depth = e.path.split("/").length - 1;
  let s = 0;
  if (/^(index|main|app|server|routes?|router|api|handler|controller|config|settings|models?|views?|manage|wsgi)\b/i.test(name)) s += 3;
  if (/(route|controller|service|checkout|payment|auth|order|cart|db|database)/i.test(e.path)) s += 1.5;
  for (const f of focus) if (f && e.path.toLowerCase().includes(f.toLowerCase())) s += 4;
  s -= depth * 0.35;
  if (e.size < 300 || e.size > 40_000) s -= 5;
  return s;
}

export async function scoutRepo(
  owner: string,
  repo: string,
  focus: string[],
  log: (m: string) => void,
): Promise<RepoFacts> {
  const meta = await gh<{
    default_branch: string;
    description: string | null;
    stargazers_count: number;
    forks_count: number;
    open_issues_count: number;
    license: { spdx_id: string } | null;
    pushed_at: string;
    html_url: string;
  }>(`/repos/${owner}/${repo}`);
  log(`Found ${owner}/${repo} (${meta.stargazers_count} stars, branch ${meta.default_branch})`);

  const branch = meta.default_branch;
  const [languages, treeRes, commitsRes] = await Promise.all([
    gh<Record<string, number>>(`/repos/${owner}/${repo}/languages`).catch(() => ({})),
    gh<{ tree: { path: string; type: string; size?: number }[]; truncated: boolean }>(
      `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    ),
    gh<{ commit: { author: { date: string; name: string } | null } }[]>(
      `/repos/${owner}/${repo}/commits?per_page=50`,
    ).catch(() => []),
  ]);

  const tree: TreeEntry[] = treeRes.tree
    .filter((t) => t.type === "blob")
    .map((t) => ({ path: t.path, size: t.size ?? 0 }));
  log(`Read file tree: ${tree.length} files${treeRes.truncated ? " (truncated by GitHub)" : ""}`);

  const readmeEntry = tree.find((t) => /^readme(\.(md|rst|txt))?$/i.test(t.path));
  const manifestEntries = tree
    .filter(
      (t) =>
        !isVendor(t.path) &&
        t.path.split("/").length <= 3 &&
        /(^|\/)(package\.json|requirements[\w.-]*\.txt)$/i.test(t.path),
    )
    .slice(0, 5);
  const keyEntries = tree
    .filter((t) => isSource(t.path) && !isTest(t.path))
    .map((t) => ({ t, s: scoreKeyFile(t, focus) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 12)
    .map((x) => x.t);

  const [readme, manifests, keyFiles] = await Promise.all([
    readmeEntry ? raw(owner, repo, branch, readmeEntry.path, 4000) : Promise.resolve(null),
    Promise.all(
      manifestEntries.map(async (e) => ({
        path: e.path,
        content: (await raw(owner, repo, branch, e.path, 60_000)) ?? "",
      })),
    ),
    Promise.all(
      keyEntries.map(async (e) => ({
        path: e.path,
        content: (await raw(owner, repo, branch, e.path, 2500)) ?? "",
      })),
    ),
  ]);
  log(`Sampled ${keyFiles.filter((k) => k.content).length} key files and ${manifests.length} manifests`);

  return {
    owner,
    repo,
    url: meta.html_url,
    branch,
    description: meta.description ?? "",
    stars: meta.stargazers_count,
    forks: meta.forks_count,
    openIssues: meta.open_issues_count,
    license: meta.license?.spdx_id ?? null,
    pushedAt: meta.pushed_at,
    languages,
    tree,
    truncated: treeRes.truncated,
    readme: readme ?? "",
    manifests: manifests.filter((m) => m.content),
    keyFiles: keyFiles.filter((k) => k.content),
    commits: commitsRes
      .filter((c) => c.commit.author)
      .map((c) => ({ date: c.commit.author!.date, author: c.commit.author!.name })),
  };
}
