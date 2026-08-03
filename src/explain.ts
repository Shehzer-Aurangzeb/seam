import { z } from 'zod';
import type { ClassifiedChange } from './classify.js';
import { completeJson } from './llm.js';

const MAX_TOKENS = 2048;

const ExplainSchema = z.object({
  operations: z.array(
    z.object({
      method: z.string(),
      path: z.string(),
      impact: z.string(),
      action: z.string(),
    }),
  ),
  backendMessage: z.string(),
});

export type ExplainResult = z.infer<typeof ExplainSchema>;

const SYSTEM_PROMPT = `You explain OpenAPI contract changes to a FRONTEND developer who consumes the affected endpoints.

You will receive JSON describing operations that have ALREADY been detected and classified by a deterministic engine. The severities and reasons are GROUND TRUTH.

CRITICAL: Do not question, re-rank, re-classify, add, remove, or speculate about changes. Do not invent changes that are not listed. Only explain what you are given.

For each operation produce:
- "impact": 1-2 sentences in plain language on what could break in the frontend.
- "action": one short suggested action for the frontend developer.

Then produce ONE "backendMessage": a paste-ready message to the backend team summarising the breaking changes and asking them to confirm the changes were intentional. Keep it concise and professional.

Return JSON ONLY — no markdown fences, no commentary — matching exactly:
{"operations":[{"method":"...","path":"...","impact":"...","action":"..."}],"backendMessage":"..."}

Include one entry in "operations" for every operation given, preserving its method and path verbatim.`;

export async function explainChanges(changes: ClassifiedChange[]): Promise<ExplainResult | null> {
  if (!process.env.ANTHROPIC_API_KEY || changes.length === 0) return null;

  // Reasons only — never the spec, never the config, never anything secret.
  const operations = changes.map((change) => ({
    method: change.method,
    path: change.path,
    severity: change.severity,
    reasons: change.reasons,
  }));

  try {
    const text = await completeJson({
      system: SYSTEM_PROMPT,
      user: JSON.stringify({ operations }, null, 2),
      maxTokens: MAX_TOKENS,
    });
    return ExplainSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}
