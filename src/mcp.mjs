import { connect } from 'node:net';
import { createInterface } from 'node:readline';

const socket = connect({ host: '127.0.0.1', port: Number(process.env.AGY_BRIDGE_PORT) });
const pending = new Map();
let sequence = 0;
let tools;
let ready;
const initialized = new Promise((resolve) => { ready = resolve; });
socket.on('connect', () => socket.write(`${JSON.stringify({ token: process.env.AGY_BRIDGE_TOKEN })}\n`));
socket.on('error', () => process.exit(1));
socket.on('close', () => process.exit(0));
createInterface({ input: socket, crlfDelay: Infinity }).on('line', (line) => {
  try {
    const message = JSON.parse(line);
    if (message.tools) { tools = message.tools; ready(); }
    else if (pending.has(message.id)) { pending.get(message.id)(message.result); pending.delete(message.id); }
  } catch { process.exit(1); }
});
const output = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', async (line) => {
  let message;
  try {
    message = JSON.parse(line);
    if (message.id === undefined) return;
    await initialized;
    let result;
    if (message.method === 'initialize') result = { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'agy-api-tool-bridge', version: '0.1.0' } };
    else if (message.method === 'ping') result = {};
    else if (message.method === 'tools/list') result = { tools };
    else if (message.method === 'tools/call') {
      if (!tools.some((tool) => tool.name === message.params?.name)) throw new Error('Unknown tool');
      const id = ++sequence;
      result = await new Promise((resolve) => {
        pending.set(id, resolve);
        socket.write(`${JSON.stringify({ id, name: message.params.name, arguments: message.params.arguments || {} })}\n`);
      });
    } else {
      output({ id: message.id, error: { code: -32601, message: 'Method not found' } });
      return;
    }
    output({ id: message.id, result });
  } catch {
    output({ id: message?.id ?? null, error: { code: -32602, message: 'Invalid MCP request' } });
  }
});
process.stdin.on('end', () => socket.end());
