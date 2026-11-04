import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Session } from './session.mjs';
import { normalize, Output, canonical } from './protocol.mjs';
import { invalid, ProxyError } from './errors.mjs';

function authorized(request, key) {
  const supplied = request.headers.authorization?.replace(/^Bearer /, '') || request.headers['x-api-key'] || '';
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(key);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readBody(request, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new ProxyError(413, 'invalid_request_error', 'Request body exceeds size limit');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw invalid('Invalid JSON body'); }
}

export function createProxy(config) {
  const sessions = new Set();
  const continuations = new Map();
  async function dispose(session) {
    for (const [id, owner] of continuations) if (owner === session) continuations.delete(id);
    await session.close();
    sessions.delete(session);
  }
  const server = createServer(async (request, response) => {
    const path = request.url?.split('?')[0];
    const format = path === '/v1/messages' ? 'anthropic' : 'openai';
    let session;
    let timer;
    let retained = false;
    const disconnected = () => { if (!response.writableEnded) void session?.close(); };
    response.on('close', disconnected);
    try {
      if (request.method === 'GET' && path === '/healthz') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok', transport: 'official-agy-acp' }));
        return;
      }
      if (!authorized(request, config.apiKey)) throw new ProxyError(401, 'authentication_error', 'Invalid proxy API key');
      const models = request.method === 'GET' && path === '/v1/models';
      if (!models && !(request.method === 'POST' && ['/v1/chat/completions', '/v1/messages'].includes(path))) throw new ProxyError(404, 'not_found_error', 'Unsupported endpoint');
      const body = models ? null : normalize(await readBody(request, config.maxBodyBytes), format);
      if (response.destroyed) return;
      if (body?.results.length) {
        const candidate = continuations.get(body.results[0].id);
        if (!candidate || candidate.disposed) throw new ProxyError(409, 'session_expired', 'Tool continuation expired or unknown; start a new conversation');
        if (candidate.busy) throw new ProxyError(409, 'session_busy', 'Tool continuation is already being processed');
        if (body.results.length !== candidate.delivered.length || body.results.some((entry) => !candidate.delivered.includes(entry.id))) throw invalid('Submit exactly the tool results returned by the previous response');
        const prefix = body.history.slice(0, -body.results.length);
        if (canonical(prefix) !== canonical(candidate.expectedHistory) || body.system !== candidate.request.system
            || canonical(body.tools) !== canonical(candidate.request.tools) || body.model !== candidate.request.model
            || canonical(body.choice) !== canonical(candidate.request.choice) || body.format !== candidate.request.format) throw invalid('Tool continuation must preserve conversation history, system, model, tool definitions and tool_choice');
        session = candidate;
        session.busy = true;
        clearTimeout(session.expiry);
        for (const id of session.delivered) continuations.delete(id);
      } else {
        if (sessions.size >= config.maxSessions) throw new ProxyError(429, 'rate_limit_error', 'Local agy process limit reached');
        session = new Session(config, body);
        session.onFatal = () => { void dispose(session); };
        sessions.add(session);
      }
      const work = async () => {
        if (!session.id) await session.start(body?.model);
        if (models) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ object: 'list', data: session.models.map((model) => ({ id: model.modelId, object: 'model', created: 0, owned_by: 'antigravity', display_name: model.name })) }));
          return;
        }
        const output = new Output(response, body, session.model);
        if (session.disposed || response.destroyed) throw new ProxyError(499, 'cancelled', 'Request cancelled');
        output.start();
        if (body.results.length) {
          for (const result of body.results) session.bridge.resolve(result);
        } else session.prompt(body);
        const result = await session.collect((text) => output.text(text));
        if (result.calls.length) {
          session.expectedHistory = [...body.history, { role: 'assistant', text: result.text, calls: result.calls }];
          session.delivered = result.calls.map((call) => call.id);
          for (const id of session.delivered) continuations.set(id, session);
          session.busy = false;
          session.expiry = setTimeout(() => void dispose(session), config.toolTtlMs);
          session.expiry.unref();
        }
        output.finish(result);
        retained = result.calls.length > 0;
      };
      await Promise.race([work(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new ProxyError(504, 'timeout_error', 'Official agy request timed out')), config.timeoutMs);
      })]);
    } catch (error) {
      const status = error.status || 502;
      const type = error.code || 'upstream_error';
      const message = error.status ? error.message : 'Local adapter failure';
      if (!response.destroyed && !response.writableEnded) {
        const payload = format === 'anthropic' ? { type: 'error', error: { type, message } } : { error: { type, code: type, message } };
        if (response.headersSent) response.end(`${format === 'anthropic' ? 'event: error\n' : ''}data: ${JSON.stringify(payload)}\n\n`);
        else { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(payload)); }
      }
    } finally {
      clearTimeout(timer);
      response.off('close', disconnected);
      if (session && !retained) await dispose(session);
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return { server, async close() {
    server.close();
    await Promise.all([...sessions].map(dispose));
    server.closeAllConnections();
  } };
}
