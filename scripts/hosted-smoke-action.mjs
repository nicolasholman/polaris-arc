// A real 0.10 USDC send-and-claim through the hosted testnet relayer.
// Source DEPLOYER_PRIVATE_KEY inside the command; never persist it here.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(new URL('../apps/business/package.json', import.meta.url));
const v = require('viem');
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
const base = process.env.HOSTED_API_URL || 'https://business-production-9696.up.railway.app';
const api = async (path, body) => {
 const r = await fetch(base + path, body ? {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)} : {});
 const j=await r.json(); if(!r.ok) throw new Error(`HTTP ${r.status} ${path}: ${j.error?.code} ${j.error?.message}`); return j.data;
};
const net=await api('/api/public/network');
if(Number(net.chainId ?? net.chain?.id ?? net.id)!==5042002) throw new Error('Arc testnet required');
const sender=privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY);
const link=privateKeyToAccount(generatePrivateKey());
const amount=100000n, expiresAt=BigInt(Math.floor(Date.now()/1000)+3600), validBefore=expiresAt;
const domain=net.domains.stablecoin, sendDomain=net.domains.send;
const nonce=v.keccak256(v.encodeAbiParameters([{type:'address'},{type:'uint64'}],[link.address,expiresAt]));
const signature=await sender.signTypedData({domain,primaryType:'ReceiveWithAuthorization',types:{ReceiveWithAuthorization:[{name:'from',type:'address'},{name:'to',type:'address'},{name:'value',type:'uint256'},{name:'validAfter',type:'uint256'},{name:'validBefore',type:'uint256'},{name:'nonce',type:'bytes32'}]},message:{from:sender.address,to:sendDomain.verifyingContract,value:amount,validAfter:0n,validBefore,nonce}});
const linkSignature=await link.signTypedData({domain:sendDomain,primaryType:'Open',types:{Open:[{name:'sender',type:'address'},{name:'amount',type:'uint256'},{name:'expiresAt',type:'uint64'}]},message:{sender:sender.address,amount,expiresAt}});
const send=await api('/api/relay',{type:'send',currency:'USD',sender:sender.address,linkKey:link.address,amount:String(amount),expiresAt:String(expiresAt),validAfter:'0',validBefore:String(validBefore),signature,linkSignature});
if(send.status!=='confirmed')throw new Error('Send not confirmed');
const deadline=expiresAt;
const claimSignature=await link.signTypedData({domain:sendDomain,primaryType:'Claim',types:{Claim:[{name:'to',type:'address'},{name:'deadline',type:'uint256'}]},message:{to:sender.address,deadline}});
const claim=await api('/api/relay',{type:'claim',currency:'USD',linkKey:link.address,to:sender.address,deadline:String(deadline),signature:claimSignature});
if(claim.status!=='confirmed')throw new Error('Claim not confirmed');
const evidence={checkedAt:new Date().toISOString(),chainId:5042002,amountUSDC:'0.10',returnedTo:sender.address,send,claim};
writeFileSync(new URL('../docs/screens/hosted/action.json',import.meta.url),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence));
