import { createOpenAICompatible, structured, agent, defineTool, Budget } from "../src/index.ts";

const llm = createOpenAICompatible({
  baseUrl: "https://api.deepseek.com",
  apiKey: process.env.DEEPSEEK_API_KEY!,
  model: "deepseek-chat",
});

// 1. Reliable structured output with a live model
const profile = await structured<{ name: string; project: string }>(llm, {
  system: "Extract the person's name and what they are building.",
  messages: (s) => [
    { role: "system", content: s },
    { role: "user", content: "I'm Ana and I'm building a booking site for villas." },
  ],
  validate: (v) =>
    v && typeof v === "object" &&
    typeof (v as { name?: unknown }).name === "string" &&
    typeof (v as { project?: unknown }).project === "string"
      ? { ok: true, value: v as { name: string; project: string } }
      : { ok: false, error: "need { name, project }" },
});
console.log("1. structured() →", JSON.stringify(profile));

// 2. A real tool-calling agent loop with a budget guardrail
const multiply = defineTool<{ a: number; b: number }>({
  name: "multiply",
  description: "Multiply two numbers and return the product.",
  parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } },
  run: ({ a, b }) => a * b,
});

const budget = new Budget({ maxTokens: 4000, maxCostUsd: 0.2 });
const answer = await agent({
  llm,
  tools: [multiply],
  system: "You must use the multiply tool for arithmetic. Answer in one short sentence.",
  maxSteps: 6,
  budget,
});
console.log("2. agent() →", answer);
console.log("budget spent:", JSON.stringify(budget.spent));
