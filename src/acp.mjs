import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { upstream } from './errors.mjs';

export class Acp extends EventEmitter {
  constructor(binary, cwd) {
    super();
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = '';
    this.closed = false;
    this.child = spawn(binary, ['acp', '--stdio', '--sandbox', '--include-default-customizations=false'], {
      cwd, stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32',
    });
    this.child.stdin.on('error', () => this.fail(upstream('Official agy input pipe closed')));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.consume(chunk));
    this.child.on('error', () => this.fail(upstream('Cannot start official agy; check AGY_BIN and installation')));
    this.child.on('exit', () => this.fail(upstream('Official agy process exited')));
  }

  send(message) {
    if (this.closed) throw upstream('Official agy connection closed');
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      try { this.send({ id, method, params }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  consume(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 4 * 1024 * 1024) {
      this.fail(upstream('Official agy frame exceeds size limit'));
      return;
    }
    let boundary;
    while ((boundary = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 1);
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line);
        if (message.method) this.emit('message', message);
        else if (this.pending.has(message.id)) {
          const waiter = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) {
            const code = message.error.code;
            waiter.reject(upstream(`Official agy rejected RPC (${code}); check local login, model availability and CLI version`));
          } else waiter.resolve(message.result);
        }
      } catch {
        this.fail(upstream('Invalid official agy ACP message'));
        return;
      }
    }
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.emit('failure', error);
  }

  async close() {
    this.fail(upstream('Official agy session closed'));
    const child = this.child;
    const kill = (signal) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {}
    };
    kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 300);
      timer.unref();
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timer); resolve(); }
    });
    kill('SIGKILL');
  }
}
