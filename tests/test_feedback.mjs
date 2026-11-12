import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionFeedback, registerExecutionFeedback } from '../plugins/execution-feedback.mjs';

test('only a confirmed Lead receives delegation reminders; other feedback stays intact', () => {
 const f=new ExecutionFeedback(),agent={};
 for(let i=0;i<5;i++)f.observe({agent,name:'read',arguments:{i}},{content:[{type:'text',text:'unique'+i}]});
 for(const role of ['teammate',undefined,'unknown'])assert.equal(f.render(agent,role),'');
 assert.match(f.render(agent,'lead'),/CTF coordination checkpoint/);
 const before=structuredClone(f.agents.get(agent));
 for(let i=0;i<5;i++)f.render(agent,'lead');
 assert.deepEqual(f.agents.get(agent),before);
 f.observe({agent,name:'pwsh',arguments:{}},{isError:true});
 for(const role of ['teammate',undefined]){
  const text=f.render(agent,role);
  assert.match(text,/failed":true/);assert.doesNotMatch(text,/CTF coordination checkpoint/);
 }
});

test('host Team membership gates the runtime context, including missing/disposed service', () => {
 let receive,context,dispose;let role='teammate';let broken=false;
 const ctx={inject:(_deps,callback)=>{dispose=callback({agentTeams:{membership:()=>{
  if(broken)throw new Error('not a member');return {role};
 }}})},on:(_event,callback)=>{receive=callback},systemPrompt:{context:row=>{context=row}}};
 registerExecutionFeedback(ctx);const agent={};
 for(let i=0;i<5;i++)receive({agent,name:'read',arguments:{i}},{content:[{type:'text',text:'unique'+i}]});
 assert.equal(context.text({agent}),'');role='lead';
 assert.match(context.text({agent}),/CTF coordination checkpoint/);
 broken=true;assert.equal(context.text({agent}),'');broken=false;
 dispose();assert.equal(context.text({agent}),'');
 const absent={...ctx,inject:()=>{}};registerExecutionFeedback(absent);
 for(let i=0;i<5;i++)receive({agent,name:'read',arguments:{i}},{content:[{type:'text',text:'unique'+i}]});
 assert.equal(context.text({agent}),'');
});

test('different arguments with identical observations trigger a bounded, private stall hint', () => {
 const f=new ExecutionFeedback(), agent={};
 for(let i=0;i<3;i++) f.observe({agent,name:'pwsh',arguments:{command:'private-'+i},callId:String(i)},
  {content:[{type:'text',text:'private identical observation'}]});
 const hint=f.render(agent, 'lead');assert.match(hint,/possible_stall":true/);
 assert.match(hint,/same_result_distinct_arguments":3/);
 assert.ok(!hint.includes('private'));assert.ok(hint.length<1500);
});
test('empty outputs and a pair of equal observations do not trigger a stall', () => {
 const f=new ExecutionFeedback(),agent={};
 f.observe({agent,name:'spawn_teammate',arguments:{}},{});
 for(let i=0;i<4;i++)f.observe({agent,name:'pwsh',arguments:{i}}, {content:[]});
 assert.doesNotMatch(f.render(agent, 'lead'),/possible_stall":true/);
 for(let i=0;i<2;i++)f.observe({agent,name:'read',arguments:{i}}, {content:[{type:'text',text:'same'}]});
 assert.equal(f.render(agent, 'lead'),'');
});
test('coordination, polling and archives neither create nor erase observations', () => {
 const f=new ExecutionFeedback(),agent={};
 f.observe({agent,name:'pwsh',arguments:{i:1}}, {isError:true});
 for(const name of ['ctf_batch','write','send_message','job_output']) f.observe({agent,name,arguments:{}},{});
 assert.match(f.render(agent, 'lead'),/failed":true/);
});
test('new evidence clears the stall; old output expires from recent window', () => {
 const f=new ExecutionFeedback(),agent={};
 f.observe({agent,name:'spawn_teammate',arguments:{}},{});
 for(let i=0;i<3;i++) f.observe({agent,name:'pwsh',arguments:{i}}, {content:[{type:'text',text:'same'}]});
 assert.match(f.render(agent, 'lead'),/possible_stall":true/);
 for(let i=3;i<10;i++) f.observe({agent,name:'pwsh',arguments:{i}}, {content:[{type:'text',text:'new'+i}]});
 assert.equal(f.render(agent, 'lead'),'');
});
test('observations and identical-result hints never leak between agents', () => {
 const f=new ExecutionFeedback(),agent={};
 for(let i=0;i<3;i++) f.observe({agent,name:'read',arguments:{i}}, {content:[{type:'text',text:'same'}]});
 assert.equal(f.render({}),'');
});
test('success adds no automatic context tax',()=>{
 const f=new ExecutionFeedback(),agent={};f.observe({agent,name:'read',arguments:{file:'a'},callId:'a'},{isError:false});
 assert.equal(f.render(agent, 'lead'),'');
});

test('initial evidence checkpoint considers parallel work without enforcing it', () => {
 const f=new ExecutionFeedback(),agent={};
 for(let i=1;i<=5;i++) {
  f.observe({agent,name:'read',arguments:{i}},{content:[{type:'text',text:'unique-'+i}]});
  if(i>=4)assert.match(f.render(agent, 'lead'),/delegation_checkpoint":true/);
  else assert.equal(f.render(agent, 'lead'),'');
 }
});
test('checkpoint survives multiple tool results in one model step without false repetition claim', () => {
 const f=new ExecutionFeedback(),agent={};
 for(let i=0;i<5;i++)f.observe({agent,name:'read',arguments:{i}},{content:[{type:'text',text:'unique'+i}]});
 const prompt=f.render(agent, 'lead');
 assert.match(prompt,/CTF coordination checkpoint \(Lead instruction/);
 assert.match(prompt,/call spawn_teammate now/);
 assert.doesNotMatch(prompt,/Same tool arguments were used before/);
 assert.equal(f.render(agent, 'lead'),prompt);
});
test('successful or failed spawn before any leaf observations does not crash rendering', () => {
 for(const isError of [false,true]) {
  const f=new ExecutionFeedback(),agent={};
  f.observe({agent,name:'spawn_teammate',arguments:{}},{isError});
  assert.equal(f.render(agent, 'lead'),'');
 }
});
test('native teammate attempt suppresses checkpoints even when unavailable', () => {
 for(const failed of [false,true]) {
  const f=new ExecutionFeedback(),agent={};
  f.observe({agent,name:'spawn_teammate',arguments:{}},{isError:failed});
  for(let i=1;i<=12;i++) {
   f.observe({agent,name:'read',arguments:{i}},{content:[{type:'text',text:'unique-'+i}]});
   assert.equal(f.render(agent, 'lead'),'');
  }
 }
});
test('checkpoint persists through preview and later work until a real native spawn attempt', () => {
 const f=new ExecutionFeedback(),agent={};const seen=[];
 for(let i=1;i<=20;i++) {
  f.observe({agent,name:'read',arguments:{i}},{content:[{type:'text',text:'unique-'+i}]});
  if(f.render(agent, 'lead'))seen.push(i);
 }
 assert.deepEqual(seen,Array.from({length:17},(_,i)=>i+4));
 const before=structuredClone(f.agents.get(agent));
 for(let i=0;i<10;i++)assert.match(f.render(agent, 'lead'),/delegation_checkpoint":true/);
 assert.deepEqual(f.agents.get(agent),before);
 f.observe({agent,name:'spawn_teammate',arguments:{}},{});
 assert.equal(f.render(agent, 'lead'),'');
});
test('environment error feedback avoids unchanged retries and permission changes', () => {
 const f=new ExecutionFeedback(),agent={};
 f.observe({agent,name:'pwsh',arguments:{command:'private'}},{isError:true,content:[{type:'text',text:'Error: spawn EPERM'}]});
 assert.match(f.render(agent, 'lead'),/environment_error":true/);
 assert.match(f.render(agent, 'lead'),/Do not change ACLs/);
 assert.ok(!f.render(agent, 'lead').includes('private'));
});
test('diagnostic can be surfaced when host wrapper reports success, without changing verdict', () => {
 const f=new ExecutionFeedback(),agent={};
 f.observe({agent,name:'pwsh',arguments:{}},{isError:false,content:[{type:'text',text:'ParserError: unexpected token'}]});
 assert.match(f.render(agent, 'lead'),/environment_error":true/);
 assert.match(f.render(agent, 'lead'),/failed":false/);
 assert.match(f.render(agent, 'lead'),/rather than quoted input/);
});
test('reading documentation containing error names does not classify an execution error', () => {
 const f=new ExecutionFeedback(),agent={};
 f.observe({agent,name:'read',arguments:{}},{content:[{type:'text',text:'Example: spawn EPERM ParserError'}]});
 assert.equal(f.render(agent, 'lead'),'');
});
test('coordination does not advance checkpoints and agents remain isolated', () => {
 const f=new ExecutionFeedback(),agent={};
 for(let i=0;i<10;i++) f.observe({agent,name:'working_directory',arguments:{}},{});
 assert.equal(f.render(agent, 'lead'),'');assert.equal(f.render({}),'');
});
test('repeated equivalent arguments detected without exposing arguments',()=>{
 const f=new ExecutionFeedback(),agent={};
 f.observe({agent,name:'read',arguments:{x:1,y:'private-value'},callId:'a'},{});
 f.observe({agent,name:'read',arguments:{y:'private-value',x:1},callId:'b'},{});
 assert.match(f.render(agent, 'lead'),/identical_prior_calls_in_recent_window":1/);assert.ok(!f.render(agent, 'lead').includes('private-value'));
 assert.equal(f.render({}),'');
});
test('failure feedback disappears after a different successful action',()=>{
 const f=new ExecutionFeedback(),agent={};f.observe({agent,name:'read',arguments:{file:'a'},callId:'a'},{isError:true});
 assert.match(f.render(agent, 'lead'),/failed":true/);
 f.observe({agent,name:'read',arguments:{file:'b'},callId:'b'},{});assert.equal(f.render(agent, 'lead'),'');
});
