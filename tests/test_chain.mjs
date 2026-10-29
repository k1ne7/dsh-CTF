import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeChain } from '../plugins/chain.mjs';
test('shortest candidate and unknown validation conditions',()=>{
 const x=analyzeChain({entry:'a',goal:'c',edges:[{from:'a',to:'b'},{from:'b',to:'c',condition:'type constraint'}]});
 assert.equal(x.candidate_path.length,2);assert.equal(x.validation_needed.length,2);
});
test('cycle terminates and unreachable goal reported',()=>{
 const x=analyzeChain({entry:'a',goal:'z',edges:[{from:'a',to:'b'},{from:'b',to:'a'}]});
 assert.equal(x.reachable,false);assert.equal(x.visited_nodes,2);
});
test('only evidenced refutation removes an edge',()=>{
 assert.throws(()=>analyzeChain({entry:'a',goal:'b',edges:[{from:'a',to:'b',status:'refuted'}]}));
 const x=analyzeChain({entry:'a',goal:'b',edges:[{from:'a',to:'b',status:'refuted',evidence:['trace.txt']}]});
 assert.equal(x.reachable,false);assert.equal(x.excluded.length,1);
});
test('supported edge with a condition still needs validation',()=>{
 const x=analyzeChain({entry:'a',goal:'b',edges:[{from:'a',to:'b',status:'supported',condition:'same runtime'}]});
 assert.equal(x.validation_needed.length,1);
});
