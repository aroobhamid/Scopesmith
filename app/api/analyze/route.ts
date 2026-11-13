import { llmConfigured } from "@/lib/llm";
import { runPipeline } from "@/lib/pipeline";
import { runDemo } from "@/lib/demo";
import type { StreamEvent } from "@/lib/types";

export const maxDuration = 300;

export async function POST(req: Request) {
  let body: { repoUrl?: unknown; brief?: unknown; passcode?: unknown; demo?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }

  const repoUrl = typeof body.repoUrl === "string" ? body.repoUrl.slice(0, 200) : "";
  const brief = typeof body.brief === "string" ? body.brief.slice(0, 2000) : "";
  const passcode = typeof body.passcode === "string" ? body.passcode : "";
  // Demo replays a recorded run: no LLM, no network, no cost, so it needs no passcode.
  const demo = body.demo === true;

  if (!demo) {
    const required = process.env.APP_PASSCODE;
    if (required && passcode !== required) {
      return Response.json({ error: "Wrong or missing passcode." }, { status: 401 });
    }
    if (!llmConfigured()) {
      return Response.json(
        { error: "The server is not configured yet (missing LITELLM_* settings). You can still try the demo." },
        { status: 500 },
      );
    }
    if (!repoUrl) {
      return Response.json({ error: "Enter a GitHub repository URL." }, { status: 400 });
    }
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: StreamEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          /* client disconnected */
        }
      };
      try {
        if (demo) await runDemo(emit);
        else await runPipeline({ repoUrl, brief }, emit);
        emit({ type: "done" });
      } catch (err) {
        console.error("pipeline failed", err);
        emit({ type: "error", message: err instanceof Error ? err.message : "Something went wrong." });
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
