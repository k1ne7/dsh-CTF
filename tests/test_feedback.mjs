import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionFeedback } from '../plugins/execution-feedback.mjs';
test('success adds no automatic context tax',()=>{
 const f=new ExecutionFeedback(),agent={};f.observe({agent,name:'read',arguments:{file:'a'},callId:'a'},{isError:false});
 assert.equal(f.render(agent),'');
});
test('repeated equivalent arguments detected without exposing arguments',()=>{
 const f=new ExecutionFeedback(),agent={};
 f.observe({agent,name:'read',arguments:{x:1,y:'private-value'},callId:'a'},{});
 f.observe({agent,name:'read',arguments:{y:'private-value',x:1},callId:'b'},{});
 assert.match(f.render(agent),/identical_prior_calls_in_recent_window":1/);assert.ok(!f.render(agent).includes('private-value'));
 assert.equal(f.render({}),'');
});
test('failure feedback disappears after a different successful action',()=>{
 const f=new ExecutionFeedback(),agent={};f.observe({agent,name:'read',arguments:{file:'a'},callId:'a'},{isError:true});
 assert.match(f.render(agent),/failed":true/);
 f.observe({agent,name:'read',arguments:{file:'b'},callId:'b'},{});assert.equal(f.render(agent),'');
});
