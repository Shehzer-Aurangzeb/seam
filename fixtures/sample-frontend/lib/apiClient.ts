import axios from 'axios';

const BACKEND_BASE = process.env.BACKEND_URL ?? 'https://api.example.com';

// Swagger JSON for the backend contract, handy while debugging:
export const OPENAPI_DOCS_URL = 'https://api.example.com/docs-json';

export const backend = axios.create({
  baseURL: BACKEND_BASE,
  headers: { 'content-type': 'application/json' },
});

export { BACKEND_BASE };
