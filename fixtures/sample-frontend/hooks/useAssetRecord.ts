import { useQuery } from '@tanstack/react-query';
import { backend } from '../lib/apiClient';

// Field consumption lives here, downstream of the BFF passthrough — the transform picks apart the
// response the handler forwarded verbatim.
export function useAssetRecord(id: string) {
  return useQuery({
    queryKey: ['asset-record', id],
    queryFn: async () => {
      const response = await backend.get(`/asset-records/${id}`);
      return {
        email: response.data.user.email,
        skus: response.data.items.map((item: { sku: string }) => item.sku),
      };
    },
  });
}
