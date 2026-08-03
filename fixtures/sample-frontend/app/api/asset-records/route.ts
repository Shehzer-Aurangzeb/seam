import { BACKEND_BASE } from '../../../lib/apiClient';

// BFF route handler: the browser hits /api/asset-records, we forward to the real backend.
export async function GET(request: Request) {
  const search = new URL(request.url).searchParams.toString();
  const upstream = await fetch(`${BACKEND_BASE}/asset-records?${search}`, {
    headers: { accept: 'application/json' },
  });
  return Response.json(await upstream.json(), { status: upstream.status });
}

export async function POST(request: Request) {
  const body = await request.json();
  const upstream = await fetch(`${BACKEND_BASE}/asset-records`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return Response.json(await upstream.json(), { status: upstream.status });
}
