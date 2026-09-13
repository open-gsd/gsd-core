'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const receipt = require('../gsd-core/bin/lib/opencode-v2-verification-receipt.cjs');
function fixture(status='passed') { const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'v2-receipt-')); const item='260101-abc', batch='batch-a', dir=path.join(cwd,'.planning','quick',`${item}-fixture`); fs.mkdirSync(dir,{recursive:true}); fs.writeFileSync(path.join(dir,`${item}-VERIFICATION.md`),`---\nstatus: ${status}\n---\n`); return {cwd,item,batch,dir, quickBatch:{loadBatch:()=>({ok:true,value:{items:[{quick_id:item,directory:null}]}})}}; }
test('mints and revalidates only the exact canonical V2 verification receipt', () => { const f=fixture(); const artifact=receipt.verificationArtifact(f.quickBatch,f.cwd,f.batch,f.item); const minted={version:1,...artifact,checked_at:Date.now()}; assert.equal(receipt.receiptAuthorizesVerification(f.quickBatch,f.cwd,f.batch,f.item,minted,'passed'),true); fs.appendFileSync(artifact.path,'changed'); assert.equal(receipt.receiptAuthorizesVerification(f.quickBatch,f.cwd,f.batch,f.item,minted,'passed'),false); });
test('rejects a symlinked canonical receipt artifact', (t) => { const f=fixture(); const artifact=path.join(f.dir,`${f.item}-VERIFICATION.md`), target=path.join(f.dir,'target.md'); fs.renameSync(artifact,target); try { fs.symlinkSync(target,artifact); } catch { t.skip('symlinks unavailable'); return; } assert.throws(()=>receipt.verificationArtifact(f.quickBatch,f.cwd,f.batch,f.item),/canonical|symlink/); });
