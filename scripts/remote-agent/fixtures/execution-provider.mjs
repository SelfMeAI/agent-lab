// Container-local deterministic provider for native execution/stop integration.
// Never used by the application or production provider configuration.
import http from 'node:http';
const calls = new Map();
http.createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer execution-fixture' || !req.url.endsWith('/chat/completions')) { res.writeHead(401); res.end(); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw), messages = body.messages ?? [];
  const history = JSON.stringify(messages);
  const stopTest = history.includes('STOP_TEST');
  const denyTest = history.includes('INLINE_DENY_TEST');
  const inlineTest = !denyTest && history.includes('INLINE_EXEC_TEST');
  const scenario = stopTest ? 'stop' : denyTest ? 'deny' : inlineTest ? 'inline' : 'exec';
  const count = (calls.get(scenario) ?? 0) + 1; calls.set(scenario, count);
  const complete = count > 1;
  const command = stopTest ? "printf 'NATIVE_STOP_BEGIN\\n'; sleep 60; printf 'NATIVE_STOP_END\\n'"
    : inlineTest || denyTest ? `python3 -c "from pathlib import Path; Path('${denyTest ? 'denied-proof' : 'inline-approval-proof'}.txt').write_text('NATIVE_INLINE_FILE_OK'); print('NATIVE_INLINE_FILE_OK')"`
    : "printf 'NATIVE_EXEC_BEGIN\\n'; sleep 6; printf 'NATIVE_EXEC_END\\n'";
  const args = JSON.stringify({ command, yieldMs: 10000 });
  const frame = (delta, finish_reason = null) => ({ id: 'execution-proof', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'execution-fixture', choices: [{ index: 0, delta, finish_reason }] });
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const send = value => res.write('data: ' + JSON.stringify(value) + '\n\n');
  if (complete) { send(frame({ role: 'assistant', content: 'NATIVE_EXEC_DONE' })); send(frame({}, 'stop')); }
  else { send(frame({ role: 'assistant', tool_calls: [{ index: 0, id: 'native-exec-' + Date.now(), type: 'function', function: { name: 'exec', arguments: '' } }] })); send(frame({ tool_calls: [{ index: 0, function: { arguments: args } }] })); send(frame({}, 'tool_calls')); }
  res.end('data: [DONE]\n\n');
}).listen(8944, '127.0.0.1');
