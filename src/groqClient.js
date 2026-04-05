/**
 * Reusable LLM caller for Groq API.
 * Uses native fetch (Node.js 18+) and API_KEY from environment variables.
 * Includes a configurable timeout to avoid hanging requests.
 */

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 20000; // 20 seconds

export async function callGroq({
  prompt,
  system = "You are a helpful assistant.",
  model = "llama-3.3-70b-versatile",
  temperature = 0.7,
  max_tokens = 500,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API_KEY environment variable is not defined");
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    console.log(`[${new Date().toISOString()}] [Groq] Calling model: ${model} (prompt: ${prompt.length} chars)`);

    const response = await fetch(GROQ_API_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt },
        ],
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error(`[${new Date().toISOString()}] [Groq] API Error (${response.status}):`, data?.error?.message ?? response.statusText);
      throw new Error(data?.error?.message || `Groq API error: ${response.statusText}`);
    }

    const content = data.choices?.[0]?.message?.content ?? "";
    if (!content) {
      throw new Error("Groq returned an empty response.");
    }

    console.log(`[${new Date().toISOString()}] [Groq] Success (${content.length} chars)`);
    return content;
  } catch (error) {
    if (error.name === "AbortError") {
      console.error(`[${new Date().toISOString()}] [Groq] Request timed out after ${timeoutMs}ms`);
      throw new Error("Groq API request timed out. Please try again.");
    }
    console.error(`[${new Date().toISOString()}] [Groq] Error:`, error.message);
    throw error; // Re-throw so callers can handle fallbacks
  } finally {
    clearTimeout(timeoutHandle);
  }
}
