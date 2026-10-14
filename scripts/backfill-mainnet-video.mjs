/** Restore the original video ledger to Atlas. Chain reads + DB writes only.
 * No keys, webhooks, relays or workers are loaded; no resource provisioning.
 */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
const {createPublicClient,http}=createRequire(new URL('../apps/business/package.json',import.meta.url))('viem');
const {MongoClient}=createRequire(new URL('../packages/db/package.json',import.meta.url))('mongodb');
const env=parseEnv(readFileSync('apps/business/.env.local','utf8'));
const client=createPublicClient({transport:http('https://rpc.mainnet.arc.io')});
assert.equal(await client.getChainId(),5042);
const receipts=JSON.parse(readFileSync('../video/out/polaris.json','utf8')).transactions;
assert(receipts.length>0);
const verified=new Set();
for(const t of receipts){const r=await client.getTransactionReceipt({hash:t.hash});assert.equal(r.status,'success');verified.add(t.hash.toLowerCase());}
const sql=new DatabaseSync('../video/.tmp/polaris.db',{readOnly:true});
// Exclude API keys, sessions, webhooks, signatures and relayer jobs.
const names=['merchants','payments','plans','subscriptions','subscription_plans','wallet_moves'];
const batches=[];
for(const name of names){
 for(const r of sql.prepare(`SELECT * FROM c_${name}`).all()){
  const doc=JSON.parse(r.doc);
  for(const [k,v]of Object.entries(doc))if(/txhash$/i.test(k)&&typeof v==='string'){ if(!verified.has(v.toLowerCase())) { const receipt=await client.getTransactionReceipt({hash:v}); assert.equal(receipt.status,'success',`${name}: unsuccessful transaction`); verified.add(v.toLowerCase()); } }
  if(name==='merchants'){doc.email=null;doc.walletId=null;doc.autoPayouts=false;assert.equal(doc.sample,false);}
  const indexes=Object.fromEntries(Object.entries(r).filter(([k])=>k.startsWith('ix_')).map(([k,v])=>[k.slice(3),v]));
  batches.push({name,row:{_id:r.id,version:1,json:JSON.stringify(doc),indexes}});
 }
}
sql.close();
const mongo=new MongoClient(env.POLARIS_DB_URL,{serverSelectionTimeoutMS:10000});
const summary={at:new Date().toISOString(),chainId:5042,verifiedReceipts:verified.size,collections:{}};
try{
 const db=mongo.db('arc_polaris_mainnet');
 for(const {name,row}of batches){
  await db.collection(name).updateOne({_id:row._id},{$setOnInsert:row},{upsert:true});
  const saved=await db.collection(name).findOne({_id:row._id});assert(saved);assert.equal(JSON.parse(saved.json).id,row._id);
  summary.collections[name]=(summary.collections[name]||0)+1;
 }
}finally{await mongo.close();}
mkdirSync('docs/proof',{recursive:true});writeFileSync('docs/proof/mainnet-video-backfill.json',JSON.stringify(summary,null,2)+'\n');console.log(JSON.stringify(summary));
