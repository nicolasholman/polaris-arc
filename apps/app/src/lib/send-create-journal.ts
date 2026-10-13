import {isAddress,isHex,type Address,type Hex} from 'viem';
export type CreateIntent={version:1;chainId:number;sender:Address;send:Address;token:Address;linkKey:Address;amount:string;expiresAt:string;validBefore:string;hash?:Hex};
type Store=Pick<Storage,'getItem'|'setItem'>;
const key=(chainId:number,sender:Address)=>`polaris:send-create:v1:${chainId}:${sender.toLowerCase()}`;
export function readCreateIntent(s:Store,chainId:number,sender:Address):CreateIntent|null{
 const raw=s.getItem(key(chainId,sender));if(raw===null)return null;let p:CreateIntent;
 try{p=JSON.parse(raw);}catch{throw Error('The original send journal is unreadable. No new signature was requested.');}
 if(!p||p.version!==1||p.chainId!==chainId||typeof p.sender!=='string'||p.sender.toLowerCase()!==sender.toLowerCase()||![p.sender,p.send,p.token,p.linkKey].every(a=>typeof a==='string'&&isAddress(a))||![p.amount,p.expiresAt,p.validBefore].every(n=>typeof n==='string'&&/^\d+$/.test(n))||BigInt(p.amount)<=0n||(p.hash!==undefined&&(!isHex(p.hash)||p.hash.length!==66)))throw Error('The original send journal is invalid. No new signature was requested.');
 return {version:1,chainId:p.chainId,sender:p.sender,send:p.send,token:p.token,linkKey:p.linkKey,amount:p.amount,expiresAt:p.expiresAt,validBefore:p.validBefore,hash:p.hash};
}
export function saveCreateIntent(s:Store,p:CreateIntent){
 const old=readCreateIntent(s,p.chainId,p.sender);if(old)for(const f of ['chainId','sender','send','token','linkKey','amount','expiresAt','validBefore'] as const)if(old[f]!==p[f])throw Error('The original send cannot be replaced. Check its original receipt.');
 if(old?.hash&&old.hash!==p.hash)throw Error('The original send hash cannot be replaced.');
 const safe=readCreateIntent({getItem:()=>JSON.stringify(p),setItem(){}},p.chainId,p.sender)!;const raw=JSON.stringify(safe);s.setItem(key(p.chainId,p.sender),raw);if(s.getItem(key(p.chainId,p.sender))!==raw)throw Error('The original send could not be saved durably. Submission is blocked.');
}
// Clearing is allowed only after genuine funding proof and a shareable in-memory bearer link exist.
export function clearCreateIntent(s:Store & Pick<Storage,'removeItem'>,p:CreateIntent){const old=readCreateIntent(s,p.chainId,p.sender);if(!old||JSON.stringify(old)!==JSON.stringify({...p,hash:p.hash}))throw Error('The original send journal changed.');s.removeItem(key(p.chainId,p.sender));if(readCreateIntent(s,p.chainId,p.sender))throw Error('The original send journal could not be cleared.');}
