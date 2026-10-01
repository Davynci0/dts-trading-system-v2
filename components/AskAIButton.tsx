"use client";

import { useState } from "react";

/**
 * Manual "Ask AI" button (Section 6, use #2). Captures the current chart as a
 * PNG (same pixels the user sees) and sends it to Gemini 3 Flash on demand.
 * Advisory only — the user makes the final call.
 */
export default function AskAIButton() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<string | null>(null);
  const [question, setQuestion] = useState("");

  async function ask() {
    setLoading(true);
    setResponse(null);
    try {
      const dataUrl = window.__dtsChartCapture?.();
      if (!dataUrl) {
        setResponse("Couldn't capture the chart — is it rendered?");
        return;
      }
      const res = await fetch("/api/ask-ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageBase64: dataUrl.split(",")[1],
          question: question.trim() || undefined,
        }),
      });
      const json = await res.json();
      setResponse(json.analysis ?? json.error ?? "No response.");
    } catch (e) {
      setResponse((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        onClick={() => {
          setOpen(true);
          if (!open) ask();
        }}
        className="rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500"
      >
        Ask AI
      </button>
      {open && (
        <div className="absolute right-4 top-14 z-20 w-96 rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-xl">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-neutral-100">Gemini 3 Flash · chart read</h3>
            <button
              onClick={() => setOpen(false)}
              className="text-neutral-400 hover:text-neutral-200"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          <p className="min-h-12 whitespace-pre-wrap text-sm text-neutral-300">
            {loading ? "Analyzing chart…" : response}
          </p>
          <div className="mt-3 flex gap-2">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !loading && ask()}
              placeholder="Optional follow-up…"
              className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100"
            />
            <button
              onClick={ask}
              disabled={loading}
              className="rounded bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
            >
              Send
            </button>
          </div>
        </div>
      )}
    </>
  );
}
