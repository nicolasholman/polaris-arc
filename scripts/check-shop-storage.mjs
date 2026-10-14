import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
const require=createRequire(new URL('../apps/shop/package.json',import.meta.url));const {MongoClient}=require('mongodb');
Object.assign(process.env,parseEnv(readFileSync('apps/shop/.env.local','utf8')));
process.env.SHOP_MONGO_DB=`arc_polaris_shop_check_${Date.now()}`;
const {createMongoOrderStore}=await import('../apps/shop/src/lib/orders/mongo-store.ts');
const store=createMongoOrderStore();let code=0;
try{
 await store.update(d=>{d.idempotency.counter={orderId:'0',fingerprint:'test',createdAt:new Date().toISOString()}});
 await Promise.all(Array.from({length:8},()=>store.update(d=>{d.idempotency.counter.orderId=String(Number(d.idempotency.counter.orderId)+1)})));
 assert.equal((await createMongoOrderStore().read()).idempotency.counter.orderId,'8');
 console.log('PASS: 8 concurrent shop updates preserved and visible through a fresh store');
}catch(e){console.error(e.name);code=1;}
finally{const c=new MongoClient(process.env.MONGODB_URI);try{await c.db(process.env.SHOP_MONGO_DB).dropDatabase();}finally{await c.close();}process.exit(code);}
