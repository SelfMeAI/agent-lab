// Deterministic provider: hold LLM I/O to prove real native Steer/Queue boundaries.
// Container-local, fixture credentials only; never a production model provider.
import http from 'node:http';
const scenarios = new Map();
const finish = (res, body, message) => {
  if (body.stream) {
    res.writeHead(200, {'Content-Type':'text/event-stream'});
    const frame = (delta, finish_reason=null) => ({id:'inputs-proof',object:'chat.completion.chunk',created:Math.floor(Date.now()/1000),model:'inputs-fixture',choices:[{index:0,delta,finish_reason}]});
    const delta = message.tool_calls ? {role:'assistant',tool_calls:message.tool_calls.map((tool,index)=>({index,...tool}))} : {role:'assistant',content:message.content};
    res.write('data: '+JSON.stringify(frame(delta))+'\n\n');
    res.write('data: '+JSON.stringify(frame({},message.tool_calls?'tool_calls':'stop'))+'\n\n');
    res.end('data: [DONE]\n\n');
  } else {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({id:'inputs-proof',object:'chat.completion',created:Math.floor(Date.now()/1000),model:'inputs-fixture',choices:[{index:0,message,finish_reason:message.tool_calls?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:10,total_tokens:110}}));
  }
};
http.createServer(async (req,res) => {
  let raw=''; for await(const chunk of req) raw+=chunk;
  if(req.url === '/proof') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify(Object.fromEntries([...scenarios].map(([key,value])=>[key,{calls:value.calls,waiting:!!value.release}])))); return;
  }
  if(req.url === '/release') {
    const state=scenarios.get(JSON.parse(raw).scenario); state?.release?.(); if(state)state.release=undefined;
    res.end('ok'); return;
  }
  if(req.headers.authorization !== 'Bearer inputs-fixture' || !req.url.endsWith('/chat/completions')) {res.writeHead(401);res.end();return;}
  const body=JSON.parse(raw), history=JSON.stringify(body.messages??[]), tag=history.match(/INPUTS_(QUEUE|CLOSE|APPROVAL|STOP|ERROR)_[a-f0-9-]{36}/)?.[0];
  if(!tag) {finish(res,body,{role:'assistant',content:'FIXTURE_UNKNOWN'});return;}
  let state=scenarios.get(tag); if(!state)scenarios.set(tag,state={calls:[]});
  const count=state.calls.length+1;
  state.calls.push({steer:history.includes('MID_TURN_STEER'),first:history.includes('AFTER_TURN_ONE'),second:history.includes('AFTER_TURN_TWO')});
  if(count===1 && !tag.includes('_APPROVAL_') && !history.includes('AFTER_TURN_ONE')) await new Promise(resolve=>{state.release=resolve;});
  if(count===1 && tag.includes('_ERROR_')) {res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Fixture provider error',type:'invalid_request_error',code:'inputs_fixture'}}));return;}
  if(count===1 && (tag.includes('_QUEUE_') || tag.includes('_APPROVAL_'))) {
    const nativeTerminal=(body.tools??[]).some(tool=>tool.function?.name==='terminal');
    const command=tag.includes('_APPROVAL_') ? `python3 -c "from pathlib import Path; Path('should-not-exist.txt').write_text('UNAPPROVED')"` : "printf 'NATIVE_TOOL_BOUNDARY\\n'";
    const tool={id:'inputs-tool-'+count,type:'function',function:{name:nativeTerminal?'terminal':'exec',arguments:JSON.stringify(nativeTerminal?{command}:{command,yieldMs:1000})}};
    finish(res,body,{role:'assistant',content:null,tool_calls:[tool]});
  } else finish(res,body,{role:'assistant',content:state.calls.at(-1).first?'QUEUED_BATCH_DONE':'ORIGINAL_TURN_DONE'});
}).listen(8945,'127.0.0.1');
