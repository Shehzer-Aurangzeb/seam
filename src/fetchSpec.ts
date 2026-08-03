export async function fetchSpec(specUrl: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(specUrl);
  } catch (err) {
    throw new Error(`Could not reach ${specUrl}: ${err instanceof Error ? err.message : err}`);
  }
  if (!res.ok) {
    throw new Error(`Spec fetch failed: HTTP ${res.status} ${res.statusText} from ${specUrl}`);
  }
  try {
    return await res.json();
  } catch {
    throw new Error(`Spec at ${specUrl} is not valid JSON.`);
  }
}
