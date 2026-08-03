import { useMutation, useQuery } from '@tanstack/react-query';
import { backend } from '../lib/apiClient';

// A different convention from the BFF handlers: these hooks talk to the backend directly.
export function useReportSummary(reportId: string) {
  return useQuery({
    queryKey: ['report', reportId],
    queryFn: async () => {
      const { data } = await backend.get(`/reports/${reportId}`);
      return data;
    },
  });
}

export function useExportReport() {
  return useMutation({
    mutationFn: async (payload: { format: string }) => {
      const { data } = await backend.post('/reports/export', payload);
      return data;
    },
  });
}

export function useReplaceReportConfig() {
  return useMutation({
    mutationFn: async (config: Record<string, unknown>) => {
      const { data } = await backend.put('/reports/config', config);
      return data;
    },
  });
}
