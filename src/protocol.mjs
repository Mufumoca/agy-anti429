import { randomUUID } from 'node:crypto';
import { invalid } from './errors.mjs';

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function argumentsObject(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { throw invalid('Tool arguments must be valid JSON'); } }
  if (!object(value)) throw invalid('Tool arguments must be a JSON object');
  return value;
}

function toolId(value) {
  if (typeof value !== 'string' || !value) throw invalid('Tool call ID is required');
  return value;
}

function toolDefinitions(body, format) {
  if (body.tools === undefined) return [];
  if (!Array.isArray(body.tools) || body.tools.length > 64) throw invalid('tools must be an array with at most 64 entries');
  const tools = body.tools.map((entry) => {
    let tool = entry;
    if (format === 'openai') {
      fields(entry, ['type', 'function'], 'tool');
      if (entry.type !== 'function') throw invalid('Only function tools are supported');
      tool = entry.function;
      fields(tool, ['name', 'description', 'parameters', 'strict'], 'function');
      if (tool.strict !== undefined && tool.strict !== false) throw invalid('Strict tool schema enforcement is not available through ACP');
    } else {
      fields(tool, ['name', 'description', 'input_schema', 'cache_control'], 'tool');
      cacheHint(tool.cache_control);
    }
    if (typeof tool.name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(tool.name)) throw invalid('Invalid tool name');
    if (tool.description !== undefined && typeof tool.description !== 'string') throw invalid('Tool description must be text');
    const schema = (format === 'openai' ? tool.parameters : tool.input_schema) ?? { type: 'object', properties: {} };
    if (!object(schema) || schema.type !== 'object') throw invalid('Tool schema must have type object');
    return { name: tool.name, description: tool.description || '', schema };
  });
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) throw invalid('Duplicate tool names');
  return tools;
}

function toolChoice(body, format, tools) {
  let choice = body.tool_choice ?? 'auto';
  if (format === 'anthropic' && object(choice)) {
    fields(choice, ['type', 'name', 'disable_parallel_tool_use'], 'tool_choice');
    if (choice.disable_parallel_tool_use !== undefined && typeof choice.disable_parallel_tool_use !== 'boolean') throw invalid('disable_parallel_tool_use must be boolean');
    if (choice.type === 'tool') choice = { name: choice.name };
    else choice = choice.type === 'any' ? 'required' : choice.type;
  } else if (format === 'openai' && object(choice)) {
    fields(choice, ['type', 'function'], 'tool_choice');
    if (choice.type !== 'function') throw invalid('Invalid tool_choice');
    fields(choice.function, ['name'], 'tool_choice.function');
    choice = { name: choice.function.name };
  }
  if (object(choice)) {
    if (!tools.some((tool) => tool.name === choice.name)) throw invalid('Selected tool is not defined');
  } else if (!['auto', 'none', 'required'].includes(choice) || (choice === 'required' && !tools.length)) throw invalid('Invalid tool_choice');
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') throw invalid('parallel_tool_calls must be boolean');
  return choice;
}

function fields(value, allowed, label) {
  if (!object(value)) throw invalid(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw invalid(`${label}.${key} is not supported`);
}

function cacheHint(value) {
  if (value === undefined) return;
  fields(value, ['type', 'ttl', 'scope'], 'cache_control');
  if (value.type !== 'ephemeral') throw invalid('Only ephemeral cache hints are accepted; caching is not guaranteed');
}

function textContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) throw invalid('Only text content is supported');
  return content.map((block) => {
    fields(block, ['type', 'text', 'cache_control'], 'content block');
    cacheHint(block.cache_control);
    if (block.type !== 'text' || typeof block.text !== 'string') throw invalid('Only text content is supported');
    return block.text;
  }).join('');
}

export function normalize(body, format) {
  fields(body, format === 'openai'
    ? ['model', 'messages', 'stream', 'tools', 'tool_choice', 'parallel_tool_calls', 'stream_options', 'max_tokens', 'max_completion_tokens']
    : ['model', 'messages', 'system', 'max_tokens', 'stream', 'tools', 'tool_choice', 'metadata', 'output_config'], 'request');
  if (body.metadata !== undefined && !object(body.metadata)) throw invalid('metadata must be an object');
  if (body.output_config !== undefined) {
    fields(body.output_config, ['effort'], 'output_config');
    if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(body.output_config.effort)) throw invalid('Unsupported effort hint');
  }
  if (typeof body.model !== 'string' || !body.model) throw invalid('model is required');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw invalid('stream must be boolean');
  if (body.stream_options !== undefined) {
    fields(body.stream_options, ['include_usage'], 'stream_options');
    if (body.stream_options.include_usage !== false) throw invalid('Token usage is unavailable through this ACP adapter');
  }
  if (format === 'anthropic' && (!Number.isSafeInteger(body.max_tokens) || body.max_tokens <= 0)) throw invalid('max_tokens must be a positive integer (ACP cannot enforce this limit)');
  for (const key of ['max_tokens', 'max_completion_tokens']) if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || body[key] <= 0)) throw invalid(`${key} must be a positive integer (ACP cannot enforce this limit)`);
  if (!Array.isArray(body.messages) || !body.messages.length) throw invalid('messages must be a non-empty array');
  const tools = toolDefinitions(body, format);
  const choice = toolChoice(body, format, tools);
  const history = [];
  let system = body.system === undefined ? '' : textContent(body.system);
  for (const message of body.messages) {
    fields(message, format === 'openai' ? ['role', 'content', 'tool_calls', 'tool_call_id'] : ['role', 'content'], 'message');
    if (!['user', 'assistant', ...(format === 'openai' ? ['system', 'developer', 'tool'] : [])].includes(message.role)) throw invalid('Unsupported message role');
    if (format === 'openai' && message.role === 'tool') {
      if (message.tool_calls !== undefined) throw invalid('tool_calls only valid on assistant messages');
      history.push({ role: 'tool', id: toolId(message.tool_call_id), text: textContent(message.content), isError: false });
      continue;
    }
    let text = '';
    const calls = [];
    if (format === 'anthropic' && Array.isArray(message.content)) {
      const results = [];
      for (const block of message.content) {
        if (!object(block)) throw invalid('Content blocks must be objects');
        if (block.type === 'text') text += textContent([block]);
        else if (block.type === 'tool_use' && message.role === 'assistant') {
          fields(block, ['type', 'id', 'name', 'input'], 'tool_use');
          if (typeof block.name !== 'string') throw invalid('Tool name is required');
          calls.push({ id: toolId(block.id), name: block.name, arguments: argumentsObject(block.input) });
        } else if (block.type === 'tool_result' && message.role === 'user') {
          fields(block, ['type', 'tool_use_id', 'content', 'is_error'], 'tool_result');
          if (block.is_error !== undefined && typeof block.is_error !== 'boolean') throw invalid('is_error must be boolean');
          results.push({ role: 'tool', id: toolId(block.tool_use_id), text: textContent(block.content ?? ''), isError: block.is_error === true });
        } else throw invalid('Unsupported Anthropic content block');
      }
      if (results.length) {
        if (text || calls.length) throw invalid('Do not mix tool results with other content in a single message');
        history.push(...results);
        continue;
      }
    } else text = (message.content === null || message.content === undefined) && message.role === 'assistant' && message.tool_calls?.length ? '' : textContent(message.content);
    if (format === 'openai' && message.tool_calls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) throw invalid('tool_calls requires a non-empty assistant tool call array');
      for (const call of message.tool_calls) {
        fields(call, ['id', 'type', 'function'], 'tool_call');
        fields(call.function, ['name', 'arguments'], 'tool_call.function');
        if (call.type !== 'function' || typeof call.function.name !== 'string') throw invalid('Invalid tool call');
        calls.push({ id: toolId(call.id), name: call.function.name, arguments: argumentsObject(call.function.arguments) });
      }
    }
    if (message.tool_call_id !== undefined) throw invalid('tool_call_id only valid on tool messages');
    if (message.role === 'system' || message.role === 'developer') system += `\n[${message.role}]\n${text}`;
    else history.push({ role: message.role, text, ...(calls.length ? { calls } : {}) });
  }
  if (!history.length || !['user', 'tool'].includes(history.at(-1).role)) throw invalid('The last message must be user content or a tool result');
  const results = [];
  for (let index = history.length - 1; index >= 0 && history[index].role === 'tool'; index--) results.unshift(history[index]);
  const outstanding = new Set();
  for (const entry of history) {
    if (entry.role === 'tool') {
      if (!outstanding.delete(entry.id)) throw invalid('Tool result has no matching outstanding call');
    } else {
      if (outstanding.size) throw invalid('All preceding tool calls require results');
      for (const call of entry.calls || []) {
        if (outstanding.has(call.id)) throw invalid('Duplicate tool call ID');
        outstanding.add(call.id);
      }
    }
  }
  if (outstanding.size) throw invalid('Missing tool results');
  return { model: body.model, history, system, stream: body.stream === true, tools, choice, results, format };
}

export class Output {
  constructor(response, request, model) {
    this.response = response;
    this.request = request;
    this.model = model;
    this.id = `${request.format === 'openai' ? 'chatcmpl' : 'msg'}_${randomUUID().replaceAll('-', '')}`;
    this.created = Math.floor(Date.now() / 1000);
    this.textStarted = false;
    this.index = 0;
  }

  event(type, value) {
    if (this.response.destroyed) throw invalid('Client disconnected');
    this.response.write(`${type ? `event: ${type}\n` : ''}data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`);
    if (this.response.writableLength > 1024 * 1024) throw invalid('Client is consuming the stream too slowly');
  }

  chunk(delta, finish_reason = null) {
    return { id: this.id, object: 'chat.completion.chunk', created: this.created, model: this.model, choices: [{ index: 0, delta, finish_reason }] };
  }

  start() {
    if (!this.request.stream) return;
    this.response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no', 'x-agy-usage': 'unavailable', 'x-agy-token-limit': 'not-enforced' });
    if (this.request.format === 'openai') this.event(null, this.chunk({ role: 'assistant', content: '' }));
    else this.event('message_start', { type: 'message_start', message: { id: this.id, type: 'message', role: 'assistant', model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  }

  text(text) {
    if (!this.request.stream || !text) return;
    if (this.request.format === 'openai') this.event(null, this.chunk({ content: text }));
    else {
      if (!this.textStarted) {
        this.event('content_block_start', { type: 'content_block_start', index: this.index, content_block: { type: 'text', text: '' } });
        this.textStarted = true;
      }
      this.event('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'text_delta', text } });
    }
  }

  finish(result) {
    const anthropicReason = result.calls.length ? 'tool_use' : result.reason === 'length' ? 'max_tokens' : 'end_turn';
    const openaiCalls = result.calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
    const anthropicCalls = result.calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments }));
    if (this.request.stream) {
      if (this.request.format === 'openai') {
        for (const [index, call] of openaiCalls.entries()) this.event(null, this.chunk({ tool_calls: [{ index, ...call }] }));
        this.event(null, this.chunk({}, result.reason));
        this.event(null, '[DONE]');
      } else {
        if (this.textStarted) { this.event('content_block_stop', { type: 'content_block_stop', index: this.index }); this.index++; }
        for (const call of anthropicCalls) {
          this.event('content_block_start', { type: 'content_block_start', index: this.index, content_block: { ...call, input: {} } });
          this.event('content_block_delta', { type: 'content_block_delta', index: this.index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } });
          this.event('content_block_stop', { type: 'content_block_stop', index: this.index });
          this.index++;
        }
        this.event('message_delta', { type: 'message_delta', delta: { stop_reason: anthropicReason, stop_sequence: null }, usage: { output_tokens: 0 } });
        this.event('message_stop', { type: 'message_stop' });
      }
      this.response.end();
      return;
    }
    const body = this.request.format === 'openai'
      ? { id: this.id, object: 'chat.completion', created: this.created, model: this.model, choices: [{ index: 0, message: { role: 'assistant', content: result.text || (result.calls.length ? null : ''), ...(result.calls.length ? { tool_calls: openaiCalls } : {}) }, finish_reason: result.reason }], usage: null }
      : { id: this.id, type: 'message', role: 'assistant', model: this.model, content: [...(result.text ? [{ type: 'text', text: result.text }] : []), ...anthropicCalls], stop_reason: anthropicReason, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } };
    this.response.writeHead(200, { 'content-type': 'application/json', 'x-agy-usage': 'unavailable', 'x-agy-token-limit': 'not-enforced' });
    this.response.end(JSON.stringify(body));
  }
}
