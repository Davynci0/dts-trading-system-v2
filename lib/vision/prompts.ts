/** Prompt for the dashboard's Ask AI button — advisory only. */
export function askAiPrompt(question?: string): string {
  return `You are a trading chart analyst. Analyze the attached chart screenshot: trend, key structure, notable levels, and anything actionable. ${
    question ? `The user also asks: ${question}` : ""
  } Keep it under 6 short sentences. This is advisory only — the user makes the final call.`;
}
