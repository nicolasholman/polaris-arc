import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {readLinkIntent,saveLinkIntent,type LinkIntent} from '../src/lib/send-link-journal.ts';
// Only unsigned lock metadata: no provider, funding, receipt or successful-chain fixture.
const p:LinkIntent={version:1,chainId:5042002,send:'0x'+'11'.repeat(20) as `0x${string}`,token:'0x'+'22'.repeat(20) as `0x${string}`,linkKey:'0x'+'33'.repeat(20) as `0x${string}`,sender:'0x'+'44'.repeat(20) as `0x${string}`,recipient:'0x'+'55'.repeat(20) as `0x${string}`,kind:'claim',amount:'1',expiresAt:'2',fromBlock:'1',stateBlockHash:'0x'+'aa'.repeat(32) as `0x${string}`};
test('real isolated disk retains the original action after restart and refuses retargeting',()=>{
 const dir=mkdtempSync(join(tmpdir(),'polaris-link-negative-'));const file=join(dir,'journal');const disk={getItem(){return existsSync(file)?readFileSync(file,'utf8'):null},setItem(_k:string,v:string){writeFileSync(file,v)},removeItem(){rmSync(file,{force:true})}};
 try{saveLinkIntent(disk,p);assert.deepEqual(readLinkIntent({...disk},p.chainId,p.send,p.linkKey),{...p,hash:undefined});for(const c of [{recipient:p.sender},{sender:p.recipient},{kind:'cancel' as const},{amount:'2'},{token:p.sender},{fromBlock:'2'}])assert.throws(()=>saveLinkIntent(disk,{...p,...c}),/cannot be replaced/);assert.deepEqual(readLinkIntent(disk,p.chainId,p.send,p.linkKey),{...p,hash:undefined});assert.throws(()=>saveLinkIntent({...disk,setItem(){throw Error('disk unavailable')}},p),/disk unavailable/);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('corrupt or nondurable storage fails closed and secret fields cannot serialize',()=>{
 let raw:string|null=null;const s={getItem(){return raw},setItem(_k:string,v:string){raw=v},removeItem(){raw=null}};
 saveLinkIntent(s,{...p,signature:'not-a-signature',privateKey:'not-a-key'} as LinkIntent);assert.ok(!raw!.includes('signature')&&!raw!.includes('privateKey'));
 const hash=('0x'+'bb'.repeat(32)) as `0x${string}`;saveLinkIntent(s,{...p,hash});assert.throws(()=>saveLinkIntent(s,{...p,hash:('0x'+'cc'.repeat(32)) as `0x${string}`}),/hash cannot be replaced/);
 raw='null';assert.throws(()=>readLinkIntent(s,p.chainId,p.send,p.linkKey),/invalid/);raw='{';assert.throws(()=>readLinkIntent(s,p.chainId,p.send,p.linkKey),/unreadable/);
 raw=null;assert.throws(()=>saveLinkIntent({...s,setItem(){}},p),/durably/);assert.throws(()=>readLinkIntent({...s,getItem(){throw Error('storage denied')}},p.chainId,p.send,p.linkKey),/storage denied/);
});
