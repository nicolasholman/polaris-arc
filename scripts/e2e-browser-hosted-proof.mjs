/** Hosted proof visibility + sign-in initialization. No login completion or chain writes. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
const name=path.basename(process.cwd()).replace(/-arc$/,'');
const {chromium}=createRequire(path.resolve('../thenar-arc/package.json'))('playwright');
const out='docs/screens/mainnet/proof';mkdirSync(out,{recursive:true});
process.env.TMPDIR=path.resolve('.vercel/browser-mainnet-tmp');mkdirSync(process.env.TMPDIR,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const results=[];
const json=async(url)=>{const r=await fetch(url,{cache:'no-store'});assert(r.ok,`${r.status} ${url}`);return r.json()};
try{
 const c=await browser.newContext({viewport:{width:1440,height:1000}}),p=await c.newPage();
 const errors=[],failed=[];p.on('console',m=>{if(m.type()==='error')errors.push(m.text())});p.on('pageerror',e=>errors.push(e.message));
 p.on('response',r=>{if(/privy/.test(r.url())&&r.status()>=400)failed.push({url:r.url().split('?')[0],status:r.status()});});
 if(name==='thenar'){
  const base='https://thenar-arc.vercel.app';assert.equal((await json(base+'/api/health')).ok,true);
  for(const hash of ['0x47540d473e3a6b21a8894c46a8f89a64ea7c29dade6f4d991cd467436656cb3f','0xee6c747e85c7fd889ff67ccdf962134f15d033b717128c87266413d9adc8283b']){
   const r=await json(base+'/api/trajectory/'+hash);assert.equal(r.chainId,5042);assert.equal(r.integrity.matches,true);
   await p.goto(base+'/run/'+hash);await p.getByText('Integrity verified',{exact:false}).first().waitFor({timeout:45000});await p.screenshot({path:out+'/'+hash+'.jpg'});results.push({run:hash,integrity:true});
  }
  await p.getByRole('button',{name:'Sign in',exact:true}).first().click();
  await p.locator('input[type="email"], input[type="tel"]').first().waitFor({timeout:30000});await p.waitForTimeout(3000);
  results.push({privyModal:true,originErrors:errors.filter(e=>/origin|unauthorized|not allowed/i.test(e)),failedPrivyRequests:failed});
 }else if(name==='polaris'){
  const api='https://polaris-arc-business.vercel.app';
  const health=(await json(api+'/api/health')).data;assert.equal(health.productionReady,true);
  const merchant=(await json(api+'/api/public/merchants/mer_iJTpxXevy67xHSJR')).data;assert.equal(merchant.name,'Northstar Studio');
  const book=(await json(api+'/api/public/buyers/0x9Fe6FA5ca59E8858Ff29286e1cB296135f40E2e5')).data;
  assert(book.payments.length>0);assert(book.plans.length>0);assert(book.subscriptions.length>0);results.push({merchant:true,payments:book.payments.length,plans:book.plans.length,subscriptions:book.subscriptions.length,moves:book.moves.length});
  await p.goto('https://polaris-arc-lemon.vercel.app/onboard');await p.getByRole('button',{name:'Continue with email',exact:true}).first().click();
  await p.locator('input[type="email"]').first().waitFor({timeout:30000});await p.waitForTimeout(3000);await p.screenshot({path:out+'/app-sign-in.jpg'});
  results.push({appEmailModal:true,originErrors:errors.filter(e=>/origin|unauthorized|not allowed/i.test(e)),failedPrivyRequests:[...failed]});
  await p.goto(api+'/login');await p.getByRole('button',{name:'Continue',exact:true}).click();
  await p.locator('input[type="email"], input[type="tel"]').first().waitFor({timeout:30000});await p.waitForTimeout(3000);
  results.push({businessPrivyModal:true,originErrors:errors.filter(e=>/origin|unauthorized|not allowed/i.test(e)),failedPrivyRequests:failed});
 }else if(name==='juno'){
  const api='https://juno-arc-api.vercel.app',token='0x82a82fA14e0a15C62901081E8d188220E1A4bC5C';
  const feed=await json(api+'/api/juno/pools');const pool=feed.pools.find(r=>r.token===token);assert(pool);
  const media=await fetch(pool.mediaUrl);assert(media.ok);assert.match(media.headers.get('content-type'),/image/);
  await p.goto('https://juno-arc.vercel.app/coin/'+token);await p.getByText('Own the moment',{exact:false}).first().waitFor({timeout:45000});results.push({videoCoin:true,mediaStatus:media.status});
 }else if(name==='koma'){
  const base='https://koma-arc.vercel.app';
  const comics=await json(base+'/api/comics?owner=0xA4837f3d663943EF2dc6B2f03B18b8118cc551c3');assert(comics.comics.some(c=>c.id==='arc-beacon-2'));
  const series=await json(base+'/api/series');const s=series.series.find(s=>s.id===1);assert(s);assert(s.sheetUrl);
  await p.goto(base+'/c/arc-beacon-2');await p.getByText('Beacon & Boat',{exact:false}).first().waitFor({timeout:45000});
  const broken=await p.locator('img').evaluateAll(imgs=>imgs.filter(i=>i.complete&&!i.naturalWidth).map(i=>i.src));assert.deepEqual(broken,[]);
  results.push({comic:true,series:s.id,episodes:s.episodes,brokenImages:broken});
 }
 await p.screenshot({path:out+'/proof.jpg'});
 assert.equal(failed.length,0,JSON.stringify(failed));assert.equal(errors.filter(e=>/origin.*(allow|invalid|error)|not.*allowed.*origin/i.test(e)).length,0);
 results.push({consoleErrors:errors,ok:true});await c.close();console.log('PASS',name,JSON.stringify(results));
}finally{await browser.close();writeFileSync(out+'/results.json',JSON.stringify({at:new Date().toISOString(),results},null,2)+'\n');}
