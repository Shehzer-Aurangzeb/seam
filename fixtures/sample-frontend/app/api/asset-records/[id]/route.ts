import { BACKEND_BASE } from '../../../../lib/apiClient';

type Params = { params: { id: string } };

export async function GET(_request: Request, { params }: Params) {
  const upstream = await fetch(`${BACKEND_BASE}/asset-records/${params.id}`);
  return Response.json(await upstream.json(), { status: upstream.status });
}

export async function PATCH(request: Request, { params }: Params) {
  const upstream = await fetch(`${BACKEND_BASE}/asset-records/${params.id}`, {
    method: 'PATCH',
    body: JSON.stringify(await request.json()),
  });
  return Response.json(await upstream.json(), { status: upstream.status });
}

export async function DELETE(_request: Request, { params }: Params) {
  const upstream = await fetch(`${BACKEND_BASE}/asset-records/${params.id}`, { method: 'DELETE' });
  return new Response(null, { status: upstream.status });
}
