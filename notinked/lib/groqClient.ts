/**
 * Groq client — plain fetch, no SDK dependency needed (Groq's API is
 * OpenAI-compatible). Uses the free tier by default (llama-3.1-8b-instant).
 *
 * Requires GROQ_API_KEY in .env.local — get one at console.groq.com
 */

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const MODEL = "openai/gpt-oss-20b"; // llama-3.1-8b-instant was deprecated & shut down by Groq Aug 16 2026

const SYSTEM_PROMPT = `You are a scam-detection assistant for a crypto/Web3 safety tool called NotInked.

Analyze the pasted message, DM, or offer for scam signals. Look for:
- Urgency or pressure language ("act now", "limited time", "your account will be locked")
- Impersonation of official support, exchanges, or well-known projects
- Requests for seed phrases, private keys, or wallet connection to unknown sites
- Unrealistic returns or "guaranteed" profit claims
- Suspicious or shortened links, fake domains that mimic real ones
- Generic greetings combined with a specific-sounding "opportunity"

Respond ONLY with valid JSON in this exact shape, no other text:
{
  "risk": "red" | "yellow" | "green",
  "score": <number 0-100, higher = more likely a scam>,
  "reasons": ["short reason 1", "short reason 2"],
  "summary": "one plain-English sentence explaining the verdict"
}

risk mapping: red = 70-100 (very likely a scam), yellow = 30-69 (suspicious, be cautious), green = 0-29 (no strong scam signals found).`;

export interface ScamCheckResult {
  risk: "red" | "yellow" | "green";
  score: number;
  reasons: string[];
  summary: string;
}

export function extractUrls(text: string): string[] {
  return Array.from(new Set(
    (text.match(/https?:\/\/[^\s<>()]+/gi) ?? []).map((url) => url.replace(/[),.!?;:]+$/, ""))
  ));
}

export function extractAddresses(text: string): string[] {
  return Array.from(new Set(text.match(/0x[a-fA-F0-9]{40}/g) ?? []));
}

async function resolveUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { redirect: "follow" });
    return new URL(res.url).hostname;
  } catch {
    return null;
  }
}

export async function checkMessageForScam(text: string, context?: string[]): Promise<ScamCheckResult> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error("GROQ_API_KEY is not set — add it to .env.local");
  }

  const resolvedUrls = await Promise.all(extractUrls(text).map(resolveUrl));
  const contextText = [...new Set([...(context ?? []), ...resolvedUrls.filter((domain): domain is string => Boolean(domain))])];
  const userContent = contextText.length > 0
    ? `${text.slice(0, 4000)}\n\nResolved URL/address context:\n${contextText.join("\n")}`
    : text.slice(0, 4000);

  const res = await fetch(GROQ_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0.2,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq API error (${res.status}): ${body}`);
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error("Empty response from Groq");

  let parsed: ScamCheckResult;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Groq returned non-JSON response");
  }

  // Guard against a malformed model response
  if (!["red", "yellow", "green"].includes(parsed.risk)) {
    parsed.risk = "yellow";
  }

  return parsed;
}
