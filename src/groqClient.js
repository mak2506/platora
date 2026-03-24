/**
 * Reusable LLM caller for Groq API.
 * Uses native fetch (Node.js 18+) and API_KEY from environment variables.
 */
export async function callGroq({
  prompt,
  system = "You are a helpful assistant.",
  model = "llama-3.3-70b-versatile",
  temperature = 0.7,
  max_tokens = 500
}) {
  try {
    const apiKey = process.env.API_KEY;
    if (!apiKey) {
      throw new Error("API_KEY environment variable is not defined");
    }

    console.log(`[Groq] Calling model: ${model}`);
    console.log(`[Groq] Prompt length: ${prompt.length}`);

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: prompt }
        ]
      })
    });

    console.log(`[Groq] Response status: ${response.status} ${response.statusText}`);
    const data = await response.json();

    if (!response.ok) {
      console.error("[Groq] API Error Body:", JSON.stringify(data, null, 2));
      throw new Error(data.error?.message || `Groq API error: ${response.statusText}`);
    }

    const content = data.choices?.[0]?.message?.content || "No response content from Groq.";
    console.log(`[Groq] Successfully received response (${content.length} chars)`);
    return content;

  } catch (error) {
    console.error("Groq Error:", error.message);
    return `Something went wrong: ${error.message}`;
  }
}
