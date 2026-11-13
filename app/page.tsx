"use client";
import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AgentGraph, MermaidView, Radar, type AgentState } from "@/components/visuals";
import {
  AGENTS,
  type Architecture,
  type CriticReport,
  type Estimate,
  type Finding,
  type Health,
  type RepoSummary,
  type Story,
  type StreamEvent,
} from "@/lib/types";

type Results = {
  repo?: RepoSummary;
  health?: Health;
  architecture?: Architecture;
  findings?: Finding[];
  stories?: Story[];
  estimate?: Estimate;
  critic?: CriticReport;
  proposal?: string;
};

type Tab = "scorecard" | "architecture" | "findings" | "estimate" | "proposal";

const EXAMPLES = [
  { label: "OWASP NodeGoat (intentionally vulnerable Node app)", repo: "https://github.com/OWASP/NodeGoat" },
  { label: "Flask (Python)", repo: "https://github.com/pallets/flask" },
  { label: "Express (Node)", repo: "https://github.com/expressjs/express" },
];
const SAMPLE_BRIEF =
  "The client runs this application on a single on-prem server. They want to move to cloud hosting, add a mobile app for customers, and fix security and performance problems before their next audit.";

const initialAgents = (): AgentState =>
  Object.fromEntries(AGENTS.map((a) => [a.id, { status: "idle", message: "" }])) as AgentState;

const fmt = (n: number) => n.toLocaleString("en-US");
const usd = (n: number) => `$${fmt(n)}`;

export default function Home() {
  const [repoUrl, setRepoUrl] = useState("");
  const [brief, setBrief] = useState("");
  const [passcode, setPasscode] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [agents, setAgents] = useState<AgentState>(initialAgents);
  const [logs, setLogs] = useState<{ agent: string; message: string }[]>([]);
  const [results, setResults] = useState<Results>({});
  const [tab, setTab] = useState<Tab>("scorecard");
  const [editing, setEditing] = useState(false);
  const [isDemo, setIsDemo] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const agentName = (id: string) => AGENTS.find((a) => a.id === id)?.name ?? id;

  function handle(e: StreamEvent) {
    if (e.type === "agent") {
      setAgents((s) => ({
        ...s,
        [e.agent]: { status: e.status === "start" ? "running" : e.status, message: e.message },
      }));
      setLogs((l) => [...l, { agent: e.agent, message: e.message }]);
    } else if (e.type === "log") {
      setLogs((l) => [...l, { agent: e.agent, message: e.message }]);
    } else if (e.type === "result") {
      setResults((r) => ({ ...r, [e.key]: e.data }));
    } else if (e.type === "error") {
      setError(e.message);
    }
    requestAnimationFrame(() => logRef.current?.scrollTo({ top: logRef.current.scrollHeight }));
  }

  async function run(demo = false) {
    setError("");
    setIsDemo(demo);
    setResults({});
    setLogs([]);
    setAgents(initialAgents());
    setEditing(false);
    setTab("scorecard");
    setRunning(true);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl, brief, passcode, demo }),
      });
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(j?.error ?? `Request failed (${res.status}).`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) handle(JSON.parse(line) as StreamEvent);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setRunning(false);
    }
  }

  function download() {
    const blob = new Blob([results.proposal ?? ""], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${results.repo?.repo ?? "proposal"}-proposal.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const hasResults = Object.keys(results).length > 0;
  const est = results.estimate;
  const maxHours = est ? Math.max(1, ...est.lines.map((l) => l.pessimistic)) : 1;

  return (
    <main className="wrap">
      <header className="brand">
        <h1>ScopeSmith</h1>
        <p>Paste a public GitHub repo and a client brief. A team of agents audits the code and writes the proposal.</p>
      </header>

      <section className="card" aria-label="Input">
        <label htmlFor="repo">Public GitHub repository</label>
        <input id="repo" value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/owner/repo" />
        <div className="row" style={{ marginTop: 8 }}>
          {EXAMPLES.map((x) => (
            <button
              key={x.repo}
              className="chip"
              type="button"
              onClick={() => {
                setRepoUrl(x.repo);
                if (!brief) setBrief(SAMPLE_BRIEF);
              }}
            >
              {x.label}
            </button>
          ))}
        </div>
        <label htmlFor="brief">Client brief (optional)</label>
        <textarea id="brief" rows={3} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="What does the client want? e.g. move to the cloud, add a mobile app, fix slow checkout" />
        <div className="row" style={{ marginTop: 12 }}>
          <div style={{ flex: "0 1 220px" }}>
            <label htmlFor="pass" style={{ marginTop: 0 }}>Passcode (if required)</label>
            <input id="pass" type="password" value={passcode} onChange={(e) => setPasscode(e.target.value)} autoComplete="off" />
          </div>
          <button className="primary" type="button" onClick={() => run(false)} disabled={running || !repoUrl.trim()} style={{ alignSelf: "flex-end" }}>
            {running && !isDemo ? "Agents working…" : "Run the agents"}
          </button>
          <button type="button" onClick={() => run(true)} disabled={running} style={{ alignSelf: "flex-end" }}>
            {running && isDemo ? "Replaying demo…" : "Try the demo (no key needed)"}
          </button>
        </div>
        <p className="hint">Public repositories and made-up briefs only. Do not paste client or company data.</p>
        {error && <div className="error" role="alert">{error}</div>}
      </section>

      {isDemo && (running || logs.length > 0) && (
        <div className="notice" role="note">
          <b>Demo mode.</b> Repo facts, health score, vulnerabilities and evidence links are recorded from a real run on
          OWASP/NodeGoat. The architecture, user stories, Critic notes and proposal text are hand-written samples, not
          live AI output.
        </div>
      )}

      {(running || logs.length > 0) && (
        <section className="card" aria-label="Agent activity">
          <h2>Agent team</h2>
          <AgentGraph state={agents} />
          <div className="log" ref={logRef} aria-live="polite">
            {logs.map((l, i) => (
              <div key={i}>
                <span>{agentName(l.agent)}</span> {l.message}
              </div>
            ))}
          </div>
        </section>
      )}

      {hasResults && (
        <section aria-label="Results">
          {results.repo && (
            <div className="card">
              <h2>
                <a href={results.repo.url} target="_blank" rel="noreferrer">
                  {results.repo.owner}/{results.repo.repo}
                </a>
              </h2>
              <p className="hint" style={{ marginTop: 0 }}>{results.repo.description || "No description"}</p>
              <div className="stat" style={{ marginTop: 10 }}>
                <div><b>{results.repo.languages.join(", ") || "n/a"}</b><span>Main languages</span></div>
                <div><b>{fmt(results.repo.sourceFiles)}</b><span>Source files</span></div>
                <div><b>{fmt(results.repo.testFiles)}</b><span>Test files</span></div>
                <div><b>{fmt(results.repo.stars)}</b><span>Stars</span></div>
              </div>
            </div>
          )}

          <div className="tabs" role="tablist">
            {(
              [
                ["scorecard", "Scorecard"],
                ["architecture", "Architecture"],
                ["findings", `Findings${results.findings ? ` (${results.findings.length})` : ""}`],
                ["estimate", "Stories & estimate"],
                ["proposal", "Proposal"],
              ] as [Tab, string][]
            ).map(([id, label]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>

          <div className="card" role="tabpanel" style={{ marginTop: 0, borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
            {tab === "scorecard" &&
              (results.health ? (
                <div className="grid2">
                  <div>
                    <div className="score">{results.health.score}<span style={{ fontSize: 18, color: "var(--muted)" }}>/100</span></div>
                    <p className="hint" style={{ marginTop: 4 }}>Overall repo health, from deterministic checks.</p>
                    <Radar health={results.health} />
                  </div>
                  <div>
                    {results.health.dimensions.map((d) => (
                      <div className="dim" key={d.name}>
                        <div className="row" style={{ justifyContent: "space-between" }}>
                          <b>{d.name}</b>
                          <span>{d.score}</span>
                        </div>
                        <div className="bar"><i style={{ width: `${d.score}%` }} /></div>
                        <span className="hint">{d.note}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="hint">Waiting for the Auditor and Quality Analyst…</p>
              ))}

            {tab === "architecture" &&
              (results.architecture ? (
                <div>
                  <p>{results.architecture.summary}</p>
                  {results.architecture.mermaid && (
                    <div style={{ marginTop: 12 }}>
                      <MermaidView key={results.architecture.mermaid} code={results.architecture.mermaid} />
                    </div>
                  )}
                  <table style={{ marginTop: 12 }}>
                    <thead><tr><th>Component</th><th>What it does</th><th>Files</th></tr></thead>
                    <tbody>
                      {results.architecture.components.map((c) => (
                        <tr key={c.name}>
                          <td><b>{c.name}</b></td>
                          <td>{c.description}</td>
                          <td style={{ fontSize: 12 }}>{c.files.join(", ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="hint">Waiting for the Architect…</p>
              ))}

            {tab === "findings" &&
              (results.findings ? (
                <div>
                  {results.critic && results.critic.droppedFindings > 0 && (
                    <p className="hint" style={{ marginBottom: 8 }}>
                      The Critic dropped {results.critic.droppedFindings} finding(s) that cited files which do not exist.
                    </p>
                  )}
                  <table>
                    <thead><tr><th>Severity</th><th>Finding</th><th>Evidence</th></tr></thead>
                    <tbody>
                      {results.findings.map((f) => (
                        <tr key={f.id}>
                          <td><span className={`sev ${f.severity}`}>{f.severity}</span></td>
                          <td>
                            <b>{f.title}</b>
                            <div className="hint" style={{ marginTop: 2 }}>{f.category} · found by {agentName(f.source)}</div>
                            <div>{f.detail}</div>
                          </td>
                          <td style={{ fontSize: 12, wordBreak: "break-all" }}>
                            {f.evidenceUrl ? (
                              <a href={f.evidenceUrl} target="_blank" rel="noreferrer">{f.evidenceLabel}</a>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="hint">Waiting for findings…</p>
              ))}

            {tab === "estimate" &&
              (results.stories ? (
                <div>
                  {est && (
                    <div className="stat" style={{ marginBottom: 14 }}>
                      <div><b>{fmt(est.totals.optimistic)}–{fmt(est.totals.pessimistic)} h</b><span>Range (likely {fmt(est.totals.likely)} h)</span></div>
                      <div><b>{usd(est.cost.low)}–{usd(est.cost.high)}</b><span>Cost range (likely {usd(est.cost.likely)})</span></div>
                      <div><b>{est.weeks.low}–{est.weeks.high} weeks</b><span>With {est.teamSize} engineers</span></div>
                      <div><b>+{Math.round(est.riskFactor * 100)}%</b><span>Risk from repo health{est.contingencyPct ? `, +${est.contingencyPct}% contingency` : ""}</span></div>
                    </div>
                  )}
                  <table>
                    <thead><tr><th>Story</th><th>Phase</th><th style={{ width: "34%" }}>Hours (opt / likely / pess)</th></tr></thead>
                    <tbody>
                      {results.stories.map((s) => {
                        const line = est?.lines.find((l) => l.storyId === s.id);
                        return (
                          <tr key={s.id}>
                            <td>
                              <b>{s.id}. {s.title}</b> <span className="hint">({s.size}, {s.area})</span>
                              <div className="hint">{s.description}</div>
                              {s.acceptance.length > 0 && (
                                <ul className="hint" style={{ paddingLeft: 18 }}>
                                  {s.acceptance.map((a, i) => <li key={i}>{a}</li>)}
                                </ul>
                              )}
                            </td>
                            <td>{s.phase}</td>
                            <td>
                              {line ? (
                                <>
                                  <div className="bar">
                                    <i className="p" style={{ width: `${(line.pessimistic / maxHours) * 100}%` }} />
                                    <i className="l" style={{ width: `${(line.likely / maxHours) * 100}%` }} />
                                    <i style={{ width: `${(line.optimistic / maxHours) * 100}%` }} />
                                  </div>
                                  <span className="hint">{line.optimistic} / {line.likely} / {line.pessimistic}</span>
                                </>
                              ) : "…"}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {results.critic && results.critic.concerns.length > 0 && (
                    <div style={{ marginTop: 14 }}>
                      <h2>Critic&apos;s concerns</h2>
                      <ul style={{ paddingLeft: 20 }}>
                        {results.critic.concerns.map((c, i) => <li key={i}>{c}</li>)}
                      </ul>
                    </div>
                  )}
                  {est && (
                    <div style={{ marginTop: 14 }}>
                      <h2>Assumptions</h2>
                      <ul className="hint" style={{ paddingLeft: 20 }}>
                        {est.assumptions.map((a, i) => <li key={i}>{a}</li>)}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <p className="hint">Waiting for the Requirements Analyst…</p>
              ))}

            {tab === "proposal" &&
              (results.proposal ? (
                <div>
                  <div className="row" style={{ marginBottom: 10 }}>
                    <button onClick={() => setEditing((v) => !v)}>{editing ? "Preview" : "Edit"}</button>
                    <button onClick={download}>Download .md</button>
                    <button onClick={() => window.print()}>Print / save as PDF</button>
                  </div>
                  {editing ? (
                    <textarea
                      className="md-edit"
                      value={results.proposal}
                      onChange={(e) => setResults((r) => ({ ...r, proposal: e.target.value }))}
                    />
                  ) : (
                    <div className="md print-area">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{results.proposal}</ReactMarkdown>
                    </div>
                  )}
                </div>
              ) : (
                <p className="hint">The Proposal Writer runs last…</p>
              ))}
          </div>
        </section>
      )}
    </main>
  );
}
