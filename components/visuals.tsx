"use client";
import { useEffect, useRef, useState } from "react";
import { AGENTS, type AgentId, type Health } from "@/lib/types";

export type AgentState = Record<AgentId, { status: "idle" | "running" | "done" | "error"; message: string }>;

export function AgentGraph({ state }: { state: AgentState }) {
  return (
    <div className="graph" role="list" aria-label="Agent pipeline">
      {AGENTS.map((a, i) => {
        const s = state[a.id];
        return (
          <div key={a.id} role="listitem" className={`node ${s.status}`}>
            <b>
              <span className="dot" aria-hidden />
              {i + 1}. {a.name}
            </b>
            <small>{s.message || a.role}</small>
          </div>
        );
      })}
    </div>
  );
}

export function Radar({ health }: { health: Health }) {
  const size = 260;
  const c = size / 2;
  const r = 90;
  const n = health.dimensions.length;
  const pt = (i: number, v: number) => {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [c + Math.cos(a) * r * v, c + Math.sin(a) * r * v] as const;
  };
  const poly = health.dimensions.map((d, i) => pt(i, d.score / 100).join(",")).join(" ");
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width="100%" style={{ maxWidth: 300 }} role="img" aria-label="Health radar chart">
      {[0.25, 0.5, 0.75, 1].map((k) => (
        <polygon
          key={k}
          points={health.dimensions.map((_, i) => pt(i, k).join(",")).join(" ")}
          fill="none"
          stroke="var(--border)"
        />
      ))}
      <polygon points={poly} fill="var(--accent)" fillOpacity={0.25} stroke="var(--accent)" strokeWidth={2} />
      {health.dimensions.map((d, i) => {
        const [x, y] = pt(i, 1.28);
        return (
          <text key={d.name} x={x} y={y} fontSize={10} textAnchor="middle" fill="var(--muted)">
            {d.name}
          </text>
        );
      })}
    </svg>
  );
}

export function MermaidView({ code }: { code: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: dark ? "dark" : "default" });
        const { svg } = await mermaid.render(`m${Math.random().toString(36).slice(2)}`, code);
        if (!cancelled && ref.current) ref.current.innerHTML = svg;
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (failed) return <pre className="code">{code}</pre>;
  return <div className="mermaid-box" ref={ref} aria-label="Architecture diagram" />;
}
