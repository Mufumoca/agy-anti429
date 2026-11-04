import { createProxy } from './server.mjs';

function number(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

if (!process.env.PROXY_API_KEY || process.env.PROXY_API_KEY.length < 16) throw new Error('Set PROXY_API_KEY to a random key of at least 16 characters');
const host = process.env.HOST || '127.0.0.1';
if (!['127.0.0.1', '::1'].includes(host)) throw new Error('Only loopback HOST addresses are supported; use an authenticated TLS tunnel for remote access');
const config = {
  binary: process.env.AGY_BIN || 'agy', apiKey: process.env.PROXY_API_KEY,
  maxSessions: number('MAX_SESSIONS', 4), timeoutMs: number('REQUEST_TIMEOUT_MS', 180000),
  toolTtlMs: number('TOOL_TTL_MS', 300000), maxBodyBytes: number('MAX_BODY_BYTES', 1048576),
  maxOutputBytes: number('MAX_OUTPUT_BYTES', 2097152),
};
const proxy = createProxy(config);
proxy.server.listen(number('PORT', 8787), host, () => console.log(`agy-local-proxy listening on ${host}:${proxy.server.address().port}`));
proxy.server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void proxy.close());
