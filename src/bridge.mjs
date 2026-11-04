import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { upstream } from './errors.mjs';

export class Bridge {
  constructor(tools, onCall, onFailure) {
    this.tools = tools;
    this.onCall = onCall;
    this.onFailure = onFailure;
    this.token = randomBytes(32).toString('hex');
    this.name = `apibridge_${randomBytes(8).toString('hex')}`;
    this.pending = new Map();
    this.sockets = new Set();
    this.closed = false;
  }

  async start() {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      let buffer = '';
      let authenticated = false;
      const timer = setTimeout(() => socket.destroy(), 5000);
      socket.setEncoding('utf8');
      socket.on('error', () => {});
      socket.on('close', () => {
        clearTimeout(timer);
        this.sockets.delete(socket);
        if (authenticated && !this.closed) this.onFailure(upstream('Local MCP bridge disconnected'));
      });
      socket.on('data', (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 1024 * 1024) { socket.destroy(); return; }
        let boundary;
        while ((boundary = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 1);
          try {
            const message = JSON.parse(line);
            if (!authenticated) {
              if (message.token !== this.token || this.connected) { socket.destroy(); return; }
              authenticated = true;
              this.connected = true;
              clearTimeout(timer);
              socket.write(`${JSON.stringify({ tools: this.tools.map(({ name, description, schema }) => ({ name, description, inputSchema: schema })) })}\n`);
              continue;
            }
            if (!this.tools.some((tool) => tool.name === message.name) || !Number.isSafeInteger(message.id)
                || !message.arguments || typeof message.arguments !== 'object' || Array.isArray(message.arguments)) throw new Error();
            if (this.pending.size >= 64) throw new Error();
            const call = { id: `call_${randomUUID().replaceAll('-', '')}`, name: message.name, arguments: message.arguments };
            this.pending.set(call.id, { socket, id: message.id });
            this.onCall(call);
          } catch { socket.destroy(); return; }
        }
      });
    });
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    return {
      name: this.name, command: process.execPath, args: [fileURLToPath(new URL('./mcp.mjs', import.meta.url))],
      env: [{ name: 'AGY_BRIDGE_PORT', value: String(this.server.address().port) }, { name: 'AGY_BRIDGE_TOKEN', value: this.token }],
    };
  }

  resolve(result) {
    const pending = this.pending.get(result.id);
    if (!pending || pending.socket.destroyed) throw upstream('Pending tool call is no longer available');
    pending.socket.write(`${JSON.stringify({ id: pending.id, result: { content: [{ type: 'text', text: result.text }], isError: result.isError } })}\n`);
    this.pending.delete(result.id);
  }

  close() {
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.server?.close();
    this.pending.clear();
  }
}
