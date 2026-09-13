'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { tryRouteQuickBatchV2Command, parseV2AttestArgs, parseExactFlagArgs } = require('../gsd-core/bin/lib/quick-batch-v2-command-router.cjs');
function route(args, v2 = {}) { let error = null; const calls = []; return tryRouteQuickBatchV2Command({ args, cwd: '/project', error: (message) => { error = message; }, emit: (value) => calls.push(value), v2 }).then((handled) => ({ handled, error, calls })); }
describe('quick-batch V2 command router', () => {
 test('returns false for legacy commands', async () => assert.equal((await route(['quick-batch', 'create'])).handled, false));
 test('strict attest parser accepts coordinates and rejects aliases, duplicates, and evidence argv', () => {
  const base=['quick-batch','v2-attest','--parent-session','ses_parent','--batch','b1','--round','2','--item','260101-abc','--expected-revision','7'];
  assert.deepEqual(parseV2AttestArgs(base),{ok:true,value:{parent:'ses_parent',batch:'b1',round:2,item:'260101-abc',revision:7}});
  for(const bad of [[...base,'--plugin-status','{}'],[...base,'--batch','again'],[...base.slice(0,2),'--batch=b1',...base.slice(4)]]) assert.equal(parseV2AttestArgs(bad).ok,false);
 });
 test('v2-verify forwards coordinates only and rejects unknown fields before domain calls', async () => {
  const args=['quick-batch','v2-verify','--parent-session','ses','--batch','b','--round','1','--item','i','--expected-revision','6']; let received;
  const good=await route(args,{recordVerification:(...values)=>{received=values;return {ok:true,value:{}};}});
  assert.equal(good.handled,true); assert.deepEqual(received,['/project','ses','b',1,'i',6]);
  const bad=await route([...args,'--artifact','forged'],{recordVerification:()=>{throw new Error('must not run');}}); assert.match(bad.error,/requires every allowed flag exactly once|rejects unknown/);
 });
 test('strict generic flag parser rejects positional, duplicate, and equals aliases', () => {
  const base=['quick-batch','v2-close','--parent-session','ses','--batch','b','--round','1','--expected-revision','2'];
  assert.equal(parseExactFlagArgs(base,['--parent-session','--batch','--round','--expected-revision']).ok,true);
  for(const bad of [[...base,'x'],[...base,'--batch','again'],['quick-batch','v2-close','--parent-session=ses',...base.slice(4)]]) assert.equal(parseExactFlagArgs(bad,['--parent-session','--batch','--round','--expected-revision']).ok,false);
 });
});
