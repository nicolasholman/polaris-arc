import {isAddress,isHex,type Address,type Hex} from 'viem';
export type LinkIntent={version:1;chainId:number;send:Address;token:Address;linkKey:Address;sender:Address;recipient:Address;kind:'claim'|'cancel';amount:string;expiresAt:string;fromBlock:string;stateBlockHash:Hex;hash?:Hex};
type StorageLike=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
const key=(chainId:number,send:string,linkKey:string)=>`polaris:send-terminal:v1:${chainId}:${send.toLowerCase()}:${linkKey.toLowerCase()}`;
export function readLinkIntent(storage:StorageLike,chainId:number,send:Address,linkKey:Address):LinkIntent|null{
 const raw=storage.getItem(key(chainId,send,linkKey));if(raw===null)return null;
 let p:LinkIntent;try{p=JSON.parse(raw);}catch{throw Error('The unresolved link action journal is unreadable. No new signature will be requested.');}
 if(!p||p.version!==1||p.chainId!==chainId||typeof p.send!=='string'||typeof p.linkKey!=='string'||p.send.toLowerCase()!==send.toLowerCase()||p.linkKey?.toLowerCase()!==linkKey.toLowerCase()||![p.send,p.token,p.linkKey,p.sender,p.recipient].every(a=>typeof a==='string'&&isAddress(a))||!['claim','cancel'].includes(p.kind)||![p.amount,p.expiresAt,p.fromBlock].every(n=>typeof n==='string'&&/^\d+$/.test(n))||!isHex(p.stateBlockHash)||p.stateBlockHash.length!==66||BigInt(p.amount)<=0n||(p.hash!==undefined&&(!isHex(p.hash)||p.hash.length!==66)))throw Error('The unresolved link action journal is invalid. No new signature will be requested.');
 return {version:1,chainId:p.chainId,send:p.send,token:p.token,linkKey:p.linkKey,sender:p.sender,recipient:p.recipient,kind:p.kind,amount:p.amount,expiresAt:p.expiresAt,fromBlock:p.fromBlock,stateBlockHash:p.stateBlockHash,hash:p.hash};
}
export function saveLinkIntent(storage:StorageLike,p:LinkIntent){
 const existing=readLinkIntent(storage,p.chainId,p.send,p.linkKey);
 if(existing)for(const field of ['chainId','send','token','linkKey','sender','recipient','kind','amount','expiresAt','fromBlock','stateBlockHash'] as const)if(existing[field]!==p[field])throw Error('The original unresolved link action cannot be replaced. Restore its recipient and check its receipt.');
 if(existing?.hash&&existing.hash!==p.hash)throw Error('The original transaction hash cannot be replaced.');
 const safe=readLinkIntent({getItem:()=>JSON.stringify(p),setItem(){},removeItem(){}},p.chainId,p.send,p.linkKey)!;
 const raw=JSON.stringify(safe);storage.setItem(key(p.chainId,p.send,p.linkKey),raw);if(storage.getItem(key(p.chainId,p.send,p.linkKey))!==raw)throw Error('Could not durably save the original link action. Submission is blocked.');
}
export function clearLinkIntent(storage:StorageLike,p:LinkIntent){const current=readLinkIntent(storage,p.chainId,p.send,p.linkKey);if(!current||JSON.stringify(current)!==JSON.stringify(p))throw Error('The unresolved link action changed.');storage.removeItem(key(p.chainId,p.send,p.linkKey));if(readLinkIntent(storage,p.chainId,p.send,p.linkKey)!==null)throw Error('Could not clear the resolved link action journal.');}
