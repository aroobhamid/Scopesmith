import OpenAI from "openai";

let cached: OpenAI | null = null;

function client(): OpenAI {
  if (!cached) {
    cached = new OpenAI({
      apiKey: process.env.LITELLM_API_KEY,
      baseURL: process.env.LITELLM_BASE_URL,
      maxRetries: 1,
    });
  }
  return cached;
}

export function llmConfigured(): boolean {
  return Boolean(
    process.env.LITELLM_API_KEY && process.env.LITELLM_BASE_URL && process.env.LITELLM_MODEL,
  );
}

/** One model call through the LiteLLM gateway. Never leaks provider errors to the browser. */
export async function ask(
  system: string,
  user: string,
  opts: { maxTokens?: number } = {},
): Promise<string> {
  try {
    const res = await client().chat.completions.create(
      {
        model: process.env.LITELLM_MODEL!,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        max_tokens: opts.maxTokens ?? 1800,
        temperature: 0.2,
      },
      { timeout: 55_000 },
    );
    return res.choices[0]?.message?.content ?? "";
  } catch (err) {
    console.error("LLM call failed", err);
    throw new Error("The AI gateway call failed. Check the server logs.");
  }
}

/** Extracts the first JSON object from a model reply, tolerating code fences and chatter. */
export function parseJson<T>(text: string): T | null {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

export async function askJson<T>(
  system: string,
  user: string,
  opts: { maxTokens?: number } = {},
): Promise<T | null> {
  const text = await ask(
    system + "\nReply with a single JSON object only. No prose, no code fences.",
    user,
    opts,
  );
  const parsed = parseJson<T>(text);
  if (parsed) return parsed;
  // one repair attempt
  const retry = await ask(
    system + "\nReply with a single valid JSON object only.",
    user + "\n\nYour previous reply was not valid JSON. Return only the JSON object.",
    opts,
  );
  return parseJson<T>(retry);
}
