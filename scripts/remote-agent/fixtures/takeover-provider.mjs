// Deterministic provider for disposable native integration containers ONLY.
// It never contacts a paid API or loads application credentials.
import http from 'node:http';
const turns = new Map();
const server = http.createServer(async (req, res) => {
  if (req.url === '/health') { res.end('ready'); return; }
  if (req.url === '/stats') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify([...turns])); return; }
  if (req.headers.authorization !== 'Bearer takeover-fixture' || !req.url.endsWith('/chat/completions')) { res.writeHead(401); res.end(); return; }
  let input = ''; for await (const part of req) input += part;
  const body = JSON.parse(input);
  const scenario = JSON.stringify(body.messages).includes('fixture:force') ? 'force' : 'soft';
  const count = (turns.get(scenario) ?? 0) + 1; turns.set(scenario, count);
  const available = body.tools?.map(tool => tool.function?.name) ?? [];
  if (!available.includes('exec')) { res.writeHead(400); res.end(JSON.stringify({ error: { message: 'Fixture requires native exec, got: ' + available.join(',') } })); return; }
  const command = count === 1
    ? `printf STARTED > current-started.txt; sleep ${scenario === 'force' ? 45 : 6}; printf FINISHED > current-finished.txt`
    : 'printf NEXT_DONE >> next-finished.txt';
  const tool = count <= 2 && scenario === 'soft' || count === 1;
  const args = JSON.stringify({ command, yieldMs: 10000, timeoutSeconds: 60 });
  const chunk = (delta, finish_reason = null) => ({ id: `chatcmpl-${scenario}-${count}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'takeover-fixture', choices: [{ index: 0, delta, finish_reason }] });
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('data: ' + JSON.stringify(chunk({ role: 'assistant', content: '' })) + '\n\n');
    res.write('data: ' + JSON.stringify(chunk(tool ? { tool_calls: [{ index: 0, id: `call-${scenario}-${count}`, type: 'function', function: { name: 'exec', arguments: args } }] } : { content: 'NATIVE_TAKEOVER_FINISHED' })) + '\n\n');
    res.write('data: ' + JSON.stringify(chunk({}, tool ? 'tool_calls' : 'stop')) + '\n\n');
    res.end('data: [DONE]\n\n');
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: `chatcmpl-${scenario}-${count}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'takeover-fixture', choices: [{ index: 0, message: { role: 'assistant', content: tool ? null : 'NATIVE_TAKEOVER_FINISHED', ...(tool ? { tool_calls: [{ id: `call-${scenario}-${count}`, type: 'function', function: { name: 'exec', arguments: args } }] } : {}) }, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
  }
});
server.listen(8944, '127.0.0.1');
