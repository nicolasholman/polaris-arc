import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { MongoStore } from '../packages/db/src/store/mongo.ts';
const require=createRequire(new URL('../packages/db/package.json',import.meta.url));const {MongoClient}=require('mongodb');
const env=parseEnv(readFileSync('apps/business/.env.local','utf8'));
process.env.POLARIS_MONGO_DB=`arc_polaris_check_${Date.now()}`;
const store=new MongoStore(env.POLARIS_DB_URL);
const collection=store.collection({name:'checks',id:d=>d.id,indexes:{value:d=>d.value,note:d=>d.note}});
try{
 await collection.insert({id:'one',value:0,note:null});
 await assert.rejects(collection.insert({id:'one',value:0,note:null}),{name:'DuplicateKeyError'});
 await Promise.all(Array.from({length:8},()=>collection.update('one',d=>({...d,value:d.value+1}))));
 assert.equal((await collection.get('one')).value,8);
 assert.equal(await collection.count({note:{ne:'text'}}),0);
 assert.equal((await collection.find({value:{gte:8}})).length,1);
 await assert.rejects(collection.update('one',d=>({...d,id:'changed'})),/must not change/);
 console.log('PASS: durable Atlas document store, duplicate protection, 8 concurrent updates, null/range queries, immutable ids');
}finally{store.close();const c=new MongoClient(env.POLARIS_DB_URL);try{await c.db(process.env.POLARIS_MONGO_DB).dropDatabase();}finally{await c.close();}}
