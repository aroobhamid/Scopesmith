export type AgentId =
  | "planner"
  | "scout"
  | "auditor"
  | "quality"
  | "architect"
  | "analyst"
  | "estimator"
  | "critic"
  | "writer";

export const AGENTS: { id: AgentId; name: string; role: string }[] = [
  { id: "planner", name: "Planner", role: "Plans the inspection" },
  { id: "scout", name: "Repo Scout", role: "Fetches repo facts" },
  { id: "auditor", name: "Auditor", role: "Dependencies & secrets" },
  { id: "quality", name: "Quality Analyst", role: "Tests, CI, activity" },
  { id: "architect", name: "Architect", role: "Maps the system" },
  { id: "analyst", name: "Requirements Analyst", role: "Brief → user stories" },
  { id: "estimator", name: "Estimator", role: "Effort ranges" },
  { id: "critic", name: "Critic", role: "Challenges the work" },
  { id: "writer", name: "Proposal Writer", role: "Writes the proposal" },
];

export type Severity = "critical" | "high" | "medium" | "low";

export type Finding = {
  id: string;
  title: string;
  severity: Severity;
  category: string;
  detail: string;
  evidenceLabel?: string;
  evidenceUrl?: string;
  source: AgentId;
};

export type Health = {
  score: number;
  dimensions: { name: string; score: number; note: string }[];
};

export type Architecture = {
  summary: string;
  components: { name: string; description: string; files: string[] }[];
  mermaid: string;
};

export type Story = {
  id: string;
  title: string;
  description: string;
  acceptance: string[];
  area: string;
  size: "S" | "M" | "L" | "XL";
  phase: "foundation" | "build" | "launch";
};

export type EstimateLine = {
  storyId: string;
  title: string;
  phase: string;
  optimistic: number;
  likely: number;
  pessimistic: number;
};

export type Estimate = {
  lines: EstimateLine[];
  totals: { optimistic: number; likely: number; pessimistic: number };
  riskFactor: number;
  contingencyPct: number;
  rate: number;
  cost: { low: number; likely: number; high: number };
  weeks: { low: number; likely: number; high: number };
  teamSize: number;
  assumptions: string[];
};

export type RepoSummary = {
  owner: string;
  repo: string;
  url: string;
  description: string;
  stars: number;
  pushedAt: string;
  languages: string[];
  sourceFiles: number;
  testFiles: number;
};

export type CriticReport = {
  verdict: "ok" | "concerns";
  concerns: string[];
  droppedFindings: number;
};

export type ResultKey =
  | "repo"
  | "health"
  | "architecture"
  | "findings"
  | "stories"
  | "estimate"
  | "critic"
  | "proposal";

export type StreamEvent =
  | { type: "agent"; agent: AgentId; status: "start" | "done" | "error"; message: string }
  | { type: "log"; agent: AgentId; message: string }
  | { type: "result"; key: ResultKey; data: unknown }
  | { type: "done" }
  | { type: "error"; message: string };

export type Emit = (e: StreamEvent) => void;
