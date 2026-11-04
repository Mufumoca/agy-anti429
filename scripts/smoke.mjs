import assert from 'node:assert/strict';

const base = process.env.PROXY_BASE_URL || 'http://127.0.0.1:8787';
const headers = { 'content-type': 'application/json', authorization: `Bearer ${process.env.PROXY_API_KEY || ''}` };
const model = process.env.SMOKE_MODEL || 'default';
const nonce = `LOCAL_${Date.now()}`;
async function post(path, body) {
  const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(240000) });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return body.stream ? text : JSON.parse(text);
}
const models = await fetch(`${base}/v1/models`, { headers });
assert.equal(models.status, 200);
console.log('Models:', (await models.json()).data.map((entry) => entry.id).join(', '));
for (const format of ['openai', 'anthropic']) {
  const path = format === 'openai' ? '/v1/chat/completions' : '/v1/messages';
  const tool = { name: 'lookup_value', description: 'Look up the requested value. Only the API caller knows the result.', schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } };
  const body = {
    model, messages: [{ role: 'user', content: 'Call lookup_value for key demo. After its result arrives, repeat that exact value.' }],
    ...(format === 'openai'
      ? { tools: [{ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.schema } }] }
      : { max_tokens: 256, tools: [{ name: tool.name, description: tool.description, input_schema: tool.schema }] }),
  };
  const first = await post(path, body);
  if (format === 'openai') {
    assert.equal(first.choices[0].finish_reason, 'tool_calls');
    const assistant = first.choices[0].message;
    assert.equal(assistant.tool_calls[0].function.name, tool.name);
    body.messages.push(assistant, { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: nonce });
  } else {
    assert.equal(first.stop_reason, 'tool_use');
    const call = first.content.find((block) => block.type === 'tool_use');
    assert.equal(call.name, tool.name);
    body.messages.push({ role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: call.id, content: nonce }] });
  }
  body.stream = true;
  const stream = await post(path, body);
  const events = stream.split('\n').filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]').map((line) => JSON.parse(line.slice(6)));
  assert(events.every((event) => !event.error));
  const text = events.map((event) => format === 'openai' ? event.choices?.[0]?.delta?.content || '' : event.delta?.text || '').join('');
  assert(text.includes(nonce), 'Official session did not return the client-supplied tool result');
  assert(stream.includes(format === 'openai' ? '[DONE]' : 'event: message_stop'));
  console.log(`${format}: real tool round trip and streaming completion passed`);
}
