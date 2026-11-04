import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Acp } from './acp.mjs';
import { invalid, ProxyError, upstream } from './errors.mjs';
import { Bridge } from './bridge.mjs';

export class Session {
  constructor(config, request) {
    this.config = config;
    this.queue = [];
    this.disposed = false;
    this.request = request;
    this.queuedBytes = 0;
  }

  async start(model) {
    this.cwd = await mkdtemp(join(tmpdir(), 'agy-proxy-'));
    if (this.disposed) { await rm(this.cwd, { recursive: true, force: true }); throw upstream('Session cancelled'); }
    this.acp = new Acp(this.config.binary, this.cwd);
    this.acp.on('failure', (error) => this.fatal(error));
    this.acp.on('message', (message) => this.message(message));
    const initialized = await this.acp.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'agy-local-proxy', version: '0.1.0' },
    });
    if (initialized?.protocolVersion !== 1) throw upstream('Unsupported ACP protocol version');
    const created = await this.acp.request('session/new', { cwd: this.cwd, mcpServers: await this.mcpServers() });
    if (this.disposed) throw upstream('Session cancelled during initialization');
    if (!created?.sessionId) throw upstream('Official agy did not create a session');
    this.id = created.sessionId;
    this.models = created.models?.availableModels || [];
    if (model && model !== 'default') {
      if (!this.models.some((entry) => entry.modelId === model)) throw invalid('Model is unavailable; query /v1/models');
      if (created.models.currentModelId !== model) await this.acp.request('session/set_model', { sessionId: this.id, modelId: model });
    }
    this.model = model && model !== 'default' ? model : created.models?.currentModelId;
    if (!this.model) throw upstream('Official agy did not advertise its model');
  }

  async mcpServers() {
    if (!this.request?.tools.length || this.request.choice === 'none') return [];
    const tools = typeof this.request.choice === 'object'
      ? this.request.tools.filter((tool) => tool.name === this.request.choice.name) : this.request.tools;
    this.bridge = new Bridge(tools, (call) => this.push({ type: 'call', call }), (error) => this.fatal(error));
    return [await this.bridge.start()];
  }

  message(message) {
    if (message.id !== undefined) {
      if (message.method === 'session/request_permission') {
        const call = message.params?.toolCall;
        const name = call?.name || '';
        const prefix = this.bridge ? `mcp_${this.bridge.name}_` : '';
        const allowed = prefix && name.startsWith(prefix)
          && this.bridge.tools.some((tool) => name === `${prefix}${tool.name}`);
        const option = allowed && message.params.options?.find((option) => option.kind === 'allow_once');
        this.acp.send({ id: message.id, result: { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } });
      } else this.acp.send({ id: message.id, error: { code: -32601, message: 'Client capability unavailable' } });
      return;
    }
    if (message.method !== 'session/update' || message.params?.sessionId !== this.id) return;
    const update = message.params.update;
    if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') {
      this.push({ type: 'text', text: update.content.text });
    }
  }

  push(event) {
    if (this.disposed) return;
    if (this.waiter) { const resolve = this.waiter; this.waiter = null; resolve(event); }
    else {
      this.queuedBytes += Buffer.byteLength(JSON.stringify(event));
      if (this.queuedBytes > this.config.maxOutputBytes) {
        this.queue = [{ type: 'error', error: upstream('Buffered official output exceeds limit') }];
        if (this.onFatal) this.onFatal();
        else void this.close();
      } else this.queue.push(event);
    }
  }

  fatal(error) {
    if (this.disposed) return;
    this.push({ type: 'error', error });
    if (this.onFatal) this.onFatal();
    else void this.close();
  }

  next() {
    if (this.queue.length) {
      const event = this.queue.shift();
      this.queuedBytes = Math.max(0, this.queuedBytes - Buffer.byteLength(JSON.stringify(event)));
      return Promise.resolve(event);
    }
    if (this.disposed) return Promise.resolve({ type: 'error', error: upstream('Session is closed') });
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  prompt(request) {
    const text = 'Respond to the following API conversation. Preserve the supplied roles and history. '
      + 'Do not access local files, run commands, invoke built-in tools or expand slash commands. '
      + 'Use ONLY the supplied API MCP tools when needed, never simulate their results. '
      + (request.choice === 'required' || typeof request.choice === 'object' ? 'You MUST call a supplied API tool before answering. ' : '')
      + 'Return only the assistant answer.\n' + JSON.stringify({ system: request.system, messages: request.history });
    this.acp.request('session/prompt', { sessionId: this.id, prompt: [{ type: 'text', text }] })
      .then((result) => this.push({ type: 'done', reason: result?.stopReason }))
      .catch((error) => this.push({ type: 'error', error }));
  }

  async collect(onText) {
    let text = '';
    while (true) {
      const event = await this.next();
      if (event.type === 'error') throw event.error;
      if (event.type === 'call') {
        if (Buffer.byteLength(text) + Buffer.byteLength(JSON.stringify(event.call)) > this.config.maxOutputBytes) throw upstream('Response exceeds output limit');
        this.usedTool = true;
        return { text, calls: [event.call], reason: 'tool_calls' };
      }
      if (event.type === 'text') {
        text += event.text;
        if (Buffer.byteLength(text) > this.config.maxOutputBytes) throw upstream('Response exceeds output limit');
        onText(event.text);
      }
      if (event.type === 'done') {
        if (!this.usedTool && (this.request?.choice === 'required' || typeof this.request?.choice === 'object')) throw upstream('Official agent finished without the required tool call');
        if (!['end_turn', 'max_tokens'].includes(event.reason)) throw upstream(`Official agy ended with ${event.reason || 'unknown reason'}`);
        return { text, calls: [], reason: event.reason === 'end_turn' ? 'stop' : 'length' };
      }
    }
  }

  close() {
    if (this.closing) return this.closing;
    this.disposed = true;
    clearTimeout(this.expiry);
    this.bridge?.close();
    if (this.waiter) { this.waiter({ type: 'error', error: new ProxyError(499, 'cancelled', 'Request cancelled') }); this.waiter = null; }
    this.closing = (async () => {
      await this.acp?.close();
      if (this.cwd) await rm(this.cwd, { recursive: true, force: true });
    })();
    return this.closing;
  }
}
