import Anthropic from '@anthropic-ai/sdk';

export const MODEL = 'claude-haiku-4-5-20251001';

/** Models sometimes wrap JSON in fences despite instructions. */
export function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim();
}

/** One call, text back, fences already stripped. Throws on missing key or any API failure. */
export async function completeJson(options: {
  system: string;
  user: string;
  maxTokens: number;
}): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set.');

  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: options.maxTokens,
    system: options.system,
    messages: [{ role: 'user', content: options.user }],
  });
  return stripFences(message.content.map((block) => (block.type === 'text' ? block.text : '')).join(''));
}
