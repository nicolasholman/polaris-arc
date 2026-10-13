import { decodeFunctionData, getAddress, parseAbi, parseEventLogs, type Address, type Hex, type PublicClient } from 'viem';
export const linkEvidenceAbi = parseAbi([
 'function stablecoin() view returns (address)',
 'function linkOf(address linkKey) view returns ((address sender,uint128 amount,uint64 expiresAt))',
 'function send(address sender,address linkKey,uint256 amount,uint64 expiresAt,uint256 validAfter,uint256 validBefore,uint8 v,bytes32 r,bytes32 s,uint8 keyV,bytes32 keyR,bytes32 keyS)',
 'function claim(address linkKey,address to,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
 'function cancel(address linkKey,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
 'function refund(address linkKey)',
 'event Sent(address indexed linkKey,address indexed sender,uint256 amount,uint64 expiresAt)',
 'event Claimed(address indexed linkKey,address indexed to,uint256 amount)',
 'event Cancelled(address indexed linkKey,address indexed sender,uint256 amount)',
 'event Refunded(address indexed linkKey,address indexed sender,uint256 amount)',
]);
const transferAbi=parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)']);
const same=(a:string|undefined|null,b:string)=>a?.toLowerCase()===b.toLowerCase();
export type LinkProof={chainId:number;send:Address;token:Address;linkKey:Address;sender:Address;amount:bigint;expiresAt:bigint;fromBlock:bigint;stateBlockHash?:Hex};
export type LinkOutcome={status:'claimed'|'cancelled'|'refunded';recipient:Address;amount:bigint;hash:Hex;at:number};
async function receiptProof(client:PublicClient,hash:Hex,p:Pick<LinkProof,'chainId'|'send'|'token'>){
 if(await client.getChainId()!==p.chainId)throw Error('The receipt RPC is on a different network.');
 const [r,tx,final]=await Promise.all([client.getTransactionReceipt({hash}),client.getTransaction({hash}),client.getBlock({blockTag:'finalized'})]);
 if(r.status!=='success'||!same(r.transactionHash,hash)||!same(tx.hash,hash)||!same(tx.to,p.send)||!same(r.to,p.send)||!same(tx.from,r.from)||tx.blockHash!==r.blockHash||final.number===null||final.number<r.blockNumber)throw Error('The original receipt is not a finalized matching transaction.');
 const [block,token,code]=await Promise.all([client.getBlock({blockNumber:r.blockNumber}),client.readContract({address:p.send,abi:linkEvidenceAbi,functionName:'stablecoin',blockNumber:r.blockNumber}),client.getCode({address:p.send,blockNumber:r.blockNumber})]);
 if(block.hash!==r.blockHash||!same(token,p.token)||!code||code==='0x')throw Error('The receipt contract or canonical block could not be verified.');
 return {r,tx,block};
}
export async function sentLinkProof(client:PublicClient,p:Pick<LinkProof,'chainId'|'send'|'token'|'linkKey'>,hash:Hex):Promise<LinkProof>{
 const {r,tx}=await receiptProof(client,hash,p);const call=decodeFunctionData({abi:linkEvidenceAbi,data:tx.input});
 if(call.functionName!=='send'||!same(call.args[1],p.linkKey))throw Error('The original send receipt is for a different link.');
 const [sender,,amount,expiresAt]=call.args;
 const sent=parseEventLogs({abi:linkEvidenceAbi,eventName:'Sent',logs:r.logs}).filter(l=>!l.removed&&l.transactionHash===r.transactionHash&&l.blockHash===r.blockHash&&same(l.address,p.send)&&same(l.args.linkKey,p.linkKey)&&same(l.args.sender,sender)&&l.args.amount===amount&&l.args.expiresAt===expiresAt);
 const paid=parseEventLogs({abi:transferAbi,logs:r.logs}).some(l=>!l.removed&&l.transactionHash===r.transactionHash&&l.blockHash===r.blockHash&&same(l.address,p.token)&&same(l.args.from,sender)&&same(l.args.to,p.send)&&l.args.value===amount);
 if(sent.length!==1||!paid)throw Error('The send receipt has no exact escrow funding evidence.');
 return {...p,sender:getAddress(sender),amount,expiresAt,fromBlock:r.blockNumber};
}
export async function terminalLinkProof(client:PublicClient,p:LinkProof,hash?:Hex):Promise<LinkOutcome|null>{
 let hashes:Hex[]=[];
 if(p.stateBlockHash){const original=await client.getBlock({blockNumber:p.fromBlock});if(original.hash!==p.stateBlockHash)throw Error('The frozen finalized link state is no longer canonical.');}
 if(hash)hashes=[hash];else{
  if(await client.getChainId()!==p.chainId)throw Error('The link history RPC is on a different network.');
  const final=await client.getBlock({blockTag:'finalized'});if(final.number===null||final.number<p.fromBlock)return null;
  // Archive/range failures remain unknown; never substitute a guessed outcome.
  for(const event of linkEvidenceAbi.filter(e=>e.type==='event'&&e.name!=='Sent')){
   const logs=await client.getLogs({address:p.send,event,args:{linkKey:p.linkKey},fromBlock:p.fromBlock,toBlock:final.number,strict:true});
   hashes.push(...logs.filter(l=>!l.removed&&l.transactionHash).map(l=>l.transactionHash!));
  }
  hashes=[...new Set(hashes)];if(hashes.length>1)throw Error('Conflicting terminal link history; no outcome was inferred.');
 }
 if(!hashes.length)return null;
 const {r,tx,block}=await receiptProof(client,hashes[0]!,p);if(r.blockNumber<p.fromBlock)throw Error('The terminal receipt predates the frozen link evidence.');const call=decodeFunctionData({abi:linkEvidenceAbi,data:tx.input});
 if(!['claim','cancel','refund'].includes(call.functionName)||!same(call.args?.[0] as string,p.linkKey))throw Error('Terminal calldata is for a different operation or link.');
 const events=parseEventLogs({abi:linkEvidenceAbi,logs:r.logs}).filter(l=>!l.removed&&l.transactionHash===r.transactionHash&&l.blockHash===r.blockHash&&same(l.address,p.send)&&same(l.args.linkKey,p.linkKey)&&l.eventName!=='Sent');
 if(events.length!==1)throw Error('No unique terminal link event was verified.');
 const event=events[0]!;let recipient:Address;let status:LinkOutcome['status'];
 if(event.eventName==='Claimed'){
  if(call.functionName!=='claim'||!same(call.args[1] as string,event.args.to)||block.timestamp>call.args[2]||block.timestamp>=p.expiresAt)throw Error('Claim recipient does not match the transaction.');
  recipient=event.args.to;status='claimed';
 }else if(event.eventName==='Cancelled'||event.eventName==='Refunded'){
  if(call.functionName!==(event.eventName==='Cancelled'?'cancel':'refund')||!same(event.args.sender,p.sender))throw Error('Return does not match the original sender.');
  if(event.eventName==='Cancelled'&&call.functionName==='cancel'&&block.timestamp>call.args[1])throw Error('Cancellation signature was expired at inclusion.');
  if(event.eventName==='Refunded'&&block.timestamp<p.expiresAt)throw Error('Refund predates the claim expiry.');
  recipient=p.sender;status=event.eventName==='Cancelled'?'cancelled':'refunded';
 }else throw Error('Unrecognized terminal event.');
 const paid=parseEventLogs({abi:transferAbi,logs:r.logs}).some(l=>!l.removed&&l.transactionHash===r.transactionHash&&l.blockHash===r.blockHash&&same(l.address,p.token)&&same(l.args.from,p.send)&&same(l.args.to,recipient)&&l.args.value===p.amount);
 if(event.args.amount!==p.amount||!paid)throw Error('The terminal receipt has no matching token payout.');
 return {status,recipient:getAddress(recipient),amount:p.amount,hash:hashes[0]!,at:Number(block.timestamp)*1000};
}
