import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import { scanToken } from "../src/services/simulator.js";
import { scanSolanaToken, SolanaScanError } from "../src/services/solana_scan.js";
import { simulateBuySell } from "../src/services/swap_simulation.js";
import { offlineSolanaTransaction, offlineBaseAuthorization } from "./offline_fixtures.js";
import { authenticateSolanaTransaction } from "../src/middleware/solana_authorization.js";
import { tokenScreener, liquidityLockEvidence } from "../src/services/evidence.js";
const OFFLINE_TRANSACTIONS: string[] = Array.from({length:5},(_,index)=>offlineSolanaTransaction(index).transaction);
const canonicalBuyer = authenticateSolanaTransaction(OFFLINE_TRANSACTIONS[0]).payer;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const MINT = { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { type: "mint", info: { decimals: 6, supply: "100000000", mintAuthority: null, freezeAuthority: null, isInitialized: true } } } };
const json = (body: any, status=200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function rpcFetch(accountResponses: any[]): typeof fetch {
  return (async (url: any, options: any) => {
    if (String(url).includes("dexscreener")) return json({ pairs: [] });
    const method = JSON.parse(options.body).method;
    if (method === "getGenesisHash") return json({ result: GENESIS });
    const result = accountResponses.shift();
    return result instanceof Response ? result : json(result);
  }) as typeof fetch;
}
const metadataClient = (calls: any[] = []) => ({ getChainId: async()=>8453, getBlockNumber: async()=>100n, getBytecode: async(x: any)=>{ calls.push(x); return "0x1234"; }, readContract: async(x: any)=> { calls.push(x); return ({ name:"USD Coin", symbol:"USDC", decimals:6, totalSupply:1000000n } as any)[x.functionName]; } } as any);

test("Solana buyer signature and canonical message identity survive sponsor co-signing and padding aliases",()=>{
  const fixture=offlineSolanaTransaction(20,true);const full=fixture.transaction;const raw=Buffer.from(full,"base64");assert.equal(raw[0],2);
  const partial=Buffer.from(raw);partial.fill(0,1,65);
  const original=authenticateSolanaTransaction(full,fixture.feePayer);
  assert.equal(authenticateSolanaTransaction(partial.toString("base64"),fixture.feePayer).id,original.id);
  assert.equal(authenticateSolanaTransaction(full.replace(/=+$/,"" ),fixture.feePayer).id,original.id);
  const forged=Buffer.from(raw);forged[66]^=1;assert.throws(()=>authenticateSolanaTransaction(forged.toString("base64"),fixture.feePayer),/buyer signature/);
  const changed=Buffer.from(raw);changed[changed.length-1]^=1;assert.throws(()=>authenticateSolanaTransaction(changed.toString("base64"),fixture.feePayer),/signature/);
});
test("Base rejects malformed input, wrong chain and non-contract without fabricating honeypot taxes", async()=>{
  await assert.rejects(scanToken({token_address:"invalid"}), /Invalid token/);
  await assert.rejects(scanToken({token_address:USDC,chain_id:1}), /Only Base/);
  await assert.rejects(scanToken({token_address:USDC}, {client:{...metadataClient(), getBytecode:async()=>"0x"}}), /NO_CONTRACT/);
});
test("Base uses one block and acquired matching liquidity; known USDC never bypasses missing simulation", async()=>{
  const calls:any[]=[];
  const pair={chainId:"base",pairAddress:"pool",baseToken:{address:USDC},liquidity:{usd:1234}};
  const result=await scanToken({token_address:USDC,simulate_sell:true},{client:metadataClient(calls),fetch:(async()=>json({pairs:[pair,pair,{...pair,chainId:"ethereum",pairAddress:"other"}]})) as any, simulate:async()=>({status:"inconclusive",reason:"RPC_FAILURE",buy_tax_bps:null,sell_tax_bps:null,evidence:{}})});
  assert.equal(result.liquidity_usd,1234); assert.equal(result.is_honeypot,null); assert.equal(result.sell_tax_bps,null); assert.notEqual(result.recommendation,"SAFE_TO_SWAP"); assert.equal(result.attestation,null);
  assert.ok(calls.every(x=>x.blockNumber===100n));
});
test("Opting out of simulation does not execute simulator or manufacture zero tax", async()=>{
  const result=await scanToken({token_address:USDC,simulate_sell:false},{client:metadataClient(),fetch:(async()=>json({},503)) as any,simulate:async()=>{throw Error("must not execute")}});
  assert.equal(result.simulation_status,"not_requested"); assert.equal(result.liquidity_usd,null); assert.equal(result.buy_tax_bps,null);
});
test("Solana rate limits and JSON-RPC errors fail over to a valid parsed mint", async()=>{
  for(const failure of [json({error:"rate limit"},429),{error:{code:-32005,message:"overloaded"}}]){
    const result=await scanSolanaToken(SOL_USDC,{rpcUrls:["https://one.test","https://two.test"],fetch:rpcFetch([failure,{result:{context:{slot:123},value:MINT}}])});
    assert.equal(result.decimals,6);assert.equal(result.is_honeypot,null);assert.equal(result.simulation_status,"not_performed");assert.equal(result.evidence.mint.slot,123);
  }
});
test("Solana distinguishes RPC errors, malformed results and one uncertain null from confirmed absence", async()=>{
  for(const failures of [[{error:{code:-1}},{error:{code:-1}}],[{result:{context:{slot:1},value:null}},{error:{code:-1}}],[{result:{value:MINT}},{result:{context:{slot:2},value:{}}}]]) {
    await assert.rejects(scanSolanaToken(SOL_USDC,{rpcUrls:["https://one.test","https://two.test"],fetch:rpcFetch(failures)}),(e:any)=>e instanceof SolanaScanError&&e.code==="RPC_UNAVAILABLE"&&e.httpStatus===503);
  }
  await assert.rejects(scanSolanaToken(SOL_USDC,{rpcUrls:["https://one.test","https://two.test"],fetch:rpcFetch([{result:{context:{slot:1},value:null}},{result:{context:{slot:2},value:null}}])}),(e:any)=>e.code==="MINT_NOT_FOUND"&&e.httpStatus===404);
});
test("Solana non-mainnet provider cannot contribute false evidence",async()=>{
  await assert.rejects(scanSolanaToken(SOL_USDC,{rpcUrls:["https://devnet.test"],fetch:(async()=>json({result:"devnet-genesis"})) as any}),(e:any)=>e.code==="RPC_UNAVAILABLE");
});
test("LP evidence reads actual burn balances at one block without inventing locks or unlock time",async()=>{
  const calls:any[]=[];const client:any={getChainId:async()=>8453,getBlockNumber:async()=>100n,readContract:async(x:any)=>{calls.push(x);if(x.functionName==="getPair")return "0x2222222222222222222222222222222222222222";if(x.functionName==="totalSupply")return 1000n;return x.args[0].endsWith("dEaD")?100n:10n;}};
  const result=await liquidityLockEvidence(USDC,client);assert.equal(result.burn_address_lp_pct,11);assert.equal(result.lp_locked_pct,null);assert.equal(result.is_rug_proof,null);assert.equal(result.unlock_timestamp,null);assert.ok(calls.every(x=>x.blockNumber===100n));
});
test("Token screener binds chain and queried base token without fixed smart-money claims",async()=>{
  const pair={chainId:"base",pairAddress:"pair",baseToken:{address:USDC,symbol:"USDC"},liquidity:{usd:123},volume:{h24:456},priceUsd:"1"};
  const result=await tokenScreener(USDC,(async()=>json({pairs:[pair,pair,{...pair,chainId:"solana",pairAddress:"wrong"},{...pair,pairAddress:"other",baseToken:{address:"other"}}]})) as any);
  assert.equal(result.pools.length,1); assert.equal(result.pools[0].smart_money_inflow_usd,null); assert.equal(result.fulfillment_complete,false);
});

const TRADER="0x1111111111111111111111111111111111111111";
const ROUTER="0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24";
const uint=(n:bigint)=>({status:"0x1",returnData:encodeAbiParameters(parseAbiParameters("uint256"),[n]),logs:[]});
const quote=(n:bigint)=>({status:"0x1",returnData:encodeAbiParameters(parseAbiParameters("uint256[]"),[[1n,n]]),logs:[]});
const ok=()=>({status:"0x1",returnData:"0x",logs:[]});
function simulationClient(){ return { getChainId:async()=>8453,readContract:async(x:any)=>x.functionName==="factory"?"0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6":x.functionName==="WETH"?"0x4200000000000000000000000000000000000006":"0x2222222222222222222222222222222222222222",getBlock:async()=>({number:100n,timestamp:1000n,hash:"0x"+"a".repeat(64)}) } as any; }
function simulatedResults(sellFail=false,missingTransfer=false){const sold=ok(); if(sellFail)sold.status="0x0";if(!missingTransfer)sold.logs=[{address:"0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",topics:["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef","0x"+ROUTER.slice(2).padStart(64,"0"),"0x"+TRADER.slice(2).padStart(64,"0")],data:uint(900n).returnData}] as any;
 return [{hash:"0x"+"b".repeat(64),parentHash:"0x"+"a".repeat(64),number:"0x65",timestamp:"0x3f4",calls:[uint(0n),quote(1000n),ok(),uint(900n),ok(),quote(1000n),sold,uint(0n)]}];}
test("Stateful V2 simulation measures both balance deltas and genuine simulated ETH proceeds",async()=>{
  const payloads:any[]=[];const result=await simulateBuySell(USDC,100n,{client:simulationClient(),trader:TRADER,request:async(payload)=>{payloads.push(payload);return payload.blockStateCalls[0].calls.length===4?[{hash:"0x"+"b".repeat(64),parentHash:"0x"+"a".repeat(64),number:"0x65",timestamp:"0x3f4",calls:[uint(0n),quote(1000n),ok(),uint(900n)]}]:simulatedResults();}});
  assert.equal(result.status,"passed");assert.equal(result.buy_tax_bps,1000);assert.equal(result.sell_tax_bps,1000);
  assert.equal(payloads.length,2);assert.equal(payloads[1].blockStateCalls[0].calls.length,8);assert.deepEqual(Object.keys(payloads[1].blockStateCalls[0].stateOverrides[TRADER]).sort(),["balance","nonce"]);
});
test("Failed sell, missing proceeds and RPC unsupported remain inconclusive",async()=>{
 for(const mode of ["failed","missing","unsupported"]){
  const result=await simulateBuySell(USDC,100n,{client:simulationClient(),trader:TRADER,request:async(payload)=>{if(mode==="unsupported")throw Error("method unsupported");return payload.blockStateCalls[0].calls.length===4?[{hash:"0x"+"b".repeat(64),parentHash:"0x"+"a".repeat(64),number:"0x65",timestamp:"0x3f4",calls:[uint(0n),quote(1000n),ok(),uint(900n)]}]:simulatedResults(mode==="failed",mode==="missing");}});
  assert.equal(result.status,"inconclusive");assert.equal(result.sell_tax_bps,null);
 }
});

test("Stateful simulation rejects unbound parent blocks and missing envelopes",async()=>{
 for(const envelope of [{calls:[]},{hash:"0x"+"b".repeat(64),parentHash:"0x"+"c".repeat(64),number:"0x65",timestamp:"0x3f4",calls:[]}]) {
  const result=await simulateBuySell(USDC,100n,{client:simulationClient(),trader:TRADER,request:async()=>[envelope]});
  assert.equal(result.status,"inconclusive");assert.equal(result.reason,"SIMULATION_BLOCK_ENVELOPE_MISMATCH");
 }
});

test("Paid pipeline acquires before settlement, retains purchased result and blocks changed input/unknown retries", async()=>{
 const directory=mkdtempSync(join(tmpdir(),"rug-payments-")); process.env.X402_FULFILLMENT_DIR=directory;
 const originalFetch=globalThis.fetch;
 try {
  const {Hono}=await import("hono"); const {x402Middleware}=await import("../src/middleware/x402.js");
  const app=new Hono();app.use("*",x402Middleware);
  let executions=0,settlements=0;let failure=false;let unknown=false;
  app.post("/v1/scan",c=>{executions++;return failure?c.json({status:"error",error:"RPC_UNAVAILABLE"},503):c.json({status:"success",unique:executions,simulation_status:"passed"});});
  globalThis.fetch=(async(url:any)=>{if(String(url).endsWith("/verify"))return json({isValid:true,payer:canonicalBuyer});settlements++;assert.equal(executions>0,true);if(unknown)throw Error("timeout");return json({success:true,payer:canonicalBuyer,transaction:"2".repeat(88),network:"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"});}) as any;
  const request=(id:string,token=SOL_USDC)=>app.request("http://localhost/v1/scan",{method:"POST",headers:{"content-type":"application/json","payment-signature":Buffer.from(JSON.stringify({accepted:{network:"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"},payload:{transaction:OFFLINE_TRANSACTIONS[({"failed-route":0,"settled-result":0,"uncertain":1,"actual-sol-metadata":2,"actual-sol-sim-required":3,"paid-mcp-sol-metadata":4} as any)[id] ?? 3]}})).toString("base64")},body:JSON.stringify({token_address:token,chain:"solana",simulate_sell:true})});
  failure=true;let response=await request("failed-route");assert.equal(response.status,503);assert.equal(settlements,0);
  failure=false;response=await request("settled-result");assert.equal(response.status,200);const result=await response.json();const receipt=JSON.parse(Buffer.from(response.headers.get("payment-response")!,"base64").toString());assert.equal(receipt.success,true);assert.equal(settlements,1);
  response=await request("settled-result");assert.equal(response.status,200);assert.deepEqual(await response.json(),result);assert.equal(settlements,1);assert.equal(executions,2);
  response=await request("settled-result","So11111111111111111111111111111111111111112");assert.equal(response.status,409);assert.equal(settlements,1);
  unknown=true;response=await request("uncertain");assert.equal(response.status,503);assert.equal(settlements,2);
  response=await request("uncertain");assert.equal(response.status,503);assert.equal((await response.json() as any).error,"SETTLEMENT_PENDING_RECONCILIATION");assert.equal(settlements,2);

  // An existing Base receipt is private to the authenticated signer, even though payer+nonce are public.
  const offlineBase=await offlineBaseAuthorization();
  const {fulfillmentStore,paymentId,requestFingerprint}=await import("../src/middleware/fulfillment.js");
  const baseBody=JSON.stringify({token_address:USDC,chain:"base",simulate_sell:true});
  const baseId=paymentId(`base:${offlineBase.authorization.from.toLowerCase()}:${offlineBase.authorization.nonce.toLowerCase()}`);
  const baseRaw=new Request("http://localhost/v1/scan",{method:"POST",body:baseBody});
  const baseFingerprint=await requestFingerprint({req:{method:"POST",url:baseRaw.url,raw:baseRaw}});
  fulfillmentStore.reserve(baseId,baseFingerprint,{status:200,body:JSON.stringify({status:"success",private_result:"recovered expired authorized request"}),headers:[["content-type","application/json"]]});
  fulfillmentStore.complete(baseId,{success:true,payer:offlineBase.authorization.from,transaction:offlineBase.transaction,amount:"10000",network:"eip155:8453",resource:"http://localhost:4020/v1/scan"});
  const baseRequest=(signature:string,accepted:any={network:"eip155:8453"})=>app.request("http://localhost/v1/scan",{method:"POST",headers:{"content-type":"application/json","payment-signature":Buffer.from(JSON.stringify({accepted,payload:{authorization:offlineBase.authorization,signature}})).toString("base64")},body:baseBody});
  response=await baseRequest("0x"+"00".repeat(65));assert.equal(response.status,402);assert.notEqual((await response.json() as any).private_result,"recovered expired authorized request");
  response=await baseRequest(offlineBase.signature);assert.equal(response.status,200);assert.equal((await response.json() as any).private_result,"recovered expired authorized request");assert.equal(settlements,2);
  response=await baseRequest(offlineBase.signature,{network:"eip155:8453",amount:"1"});assert.equal(response.status,402);assert.equal(settlements,2);

  // Test the real HTTP/MCP application without reading its production dotenv files or starting a server.
  process.env.RUGSHIELD_NO_LISTEN="1";process.env.RUGSHIELD_DISABLE_DELIVERY_LOGGING="1";process.env.RUGSHIELD_DELIVERY_LOG=join(directory,"test-deliveries.jsonl");process.env.DOTENV_CONFIG_PATH=join(directory,"empty.env");writeFileSync(process.env.DOTENV_CONFIG_PATH,"");
  const {default:service}=await import("../src/index.js");
  const verRes=await service.request("http://localhost/version");assert.equal(verRes.status,200);const verBody:any=await verRes.json();assert.equal(verBody.service,"rugshield-402");assert.equal(typeof verBody.revision,"string");
  const {ENDPOINT_SPECS}=await import("../src/config.js");
  globalThis.fetch=(async(url:any,options:any)=>{
    if(String(url).endsWith("/verify"))return json({isValid:true});
    if(String(url).endsWith("/settle")){settlements++;return json({success:true,payer:canonicalBuyer,transaction:"3".repeat(88)});}
    if(String(url).includes("dexscreener"))return json({pairs:[]});
    const method=JSON.parse(options.body).method;
    if(method==="getGenesisHash")return json({result:GENESIS});
    if(method==="getAccountInfo")return json({result:{context:{slot:456},value:MINT}});
    if(method==="getTokenSupply")return json({result:{context:{slot:456},value:{amount:"1000"}}});
    if(method==="getBalance")return json({result:{context:{slot:456},value:100}});
    return json({result:{context:{slot:456},value:[]}});
  }) as any;
  const headers=(id:string)=>({"content-type":"application/json","user-agent":"mcp-regression-test","payment-signature":Buffer.from(JSON.stringify({accepted:{network:"solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"},payload:{transaction:OFFLINE_TRANSACTIONS[({"failed-route":0,"settled-result":0,"uncertain":1,"actual-sol-metadata":2,"actual-sol-sim-required":3,"paid-mcp-sol-metadata":4} as any)[id] ?? 3]}})).toString("base64")});
  response=await service.request("http://localhost/v1/scan",{method:"POST",headers:headers("actual-sol-metadata"),body:JSON.stringify({token_address:SOL_USDC,chain:"solana",simulate_sell:false})});
  assert.equal(response.status,200);assert.equal((await response.json() as any).evidence.mint.slot,456);assert.equal(settlements,3);
  response=await service.request("http://localhost/v1/scan",{method:"POST",headers:headers("actual-sol-sim-required"),body:JSON.stringify({token_address:SOL_USDC,chain:"solana",simulate_sell:true})});
  assert.equal(response.status,503);assert.equal((await response.json() as any).error,"SWAP_SIMULATION_UNAVAILABLE");assert.equal(settlements,3);
  for(const spec of ENDPOINT_SPECS.filter(x=>x.path!=="/v1/scan")){
    response=await service.request(`http://localhost${spec.path}`,{method:"POST",headers:headers(`incomplete-${spec.path}`),body:JSON.stringify({token_address:SOL_USDC,chain:"solana"})});
    assert.equal(response.status,503,spec.path);assert.equal(settlements,3,spec.path+" must not settle");
  }
  response=await service.request("http://localhost/mcp",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"rugshield_pre_swap_scan",arguments:{token_address:SOL_USDC,simulate_sell:false}}})});
  assert.equal(response.status,402);const mcp:any=await response.json();assert.equal(mcp.result.isError,true);assert.equal(mcp.result.structuredContent.error,"payment_required");
  response=await service.request("http://localhost/mcp",{method:"POST",headers:headers("paid-mcp-sol-metadata"),body:JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"rugshield_pre_swap_scan",arguments:{token_address:SOL_USDC,chain:"solana",simulate_sell:false}}})});
  assert.equal(response.status,200);assert.equal((await response.json() as any).result.structuredContent.evidence.mint.slot,456);assert.ok(response.headers.get("payment-response"));assert.equal(settlements,4);
 } finally {globalThis.fetch=originalFetch;rmSync(directory,{recursive:true,force:true});}
});

function browserHarness(price="10000") {
 const html=readFileSync(new URL("../public/index.html",import.meta.url),"utf8");
 const script=[...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].find(x=>!x[1].includes("application/ld+json")&&x[2].includes("unlockWithBase"))![2];
 const elements=new Map<string,any>();const storage=new Map<string,string>();const requests:any[]=[];const walletCalls:any[]=[];let paidAttempts=0;
 const element=(id:string)=>{if(!elements.has(id))elements.set(id,{value:"",innerText:"",textContent:"",style:{},classList:{add(){},remove(){}}});return elements.get(id);};
 element("targetInput").value=USDC;
 const payer="0x1111111111111111111111111111111111111111";
 const quote={x402Version:2,resource:{url:"https://rug.test/v1/scan"},accepts:[{scheme:"exact",network:"eip155:8453",amount:price,asset:USDC,payTo:"0x73279fa4BadA7CAC888c62CDa4f5c8104765f6f1"}]};
 const context:any={console,Uint8Array,Date,URLSearchParams,location:{origin:"https://rug.test"},document:{getElementById:element},sessionStorage:{getItem:(k:string)=>storage.get(k)||null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)},crypto:{getRandomValues:(bytes:Uint8Array)=>{bytes.fill(7);return bytes;}},atob:(x:string)=>Buffer.from(x,"base64").toString("binary"),btoa:(x:string)=>Buffer.from(x,"binary").toString("base64"),fetch:async(url:string,init:any)=>{requests.push({url,init});if(!init)return new Response("",{status:402,headers:{"PAYMENT-REQUIRED":Buffer.from(JSON.stringify(quote)).toString("base64")}});paidAttempts++;const data={status:"success",buy_tax_bps:null,sell_tax_bps:null,is_honeypot:null,recommendation:"INCONCLUSIVE"};if(paidAttempts===1)return json({error:"SETTLEMENT_PENDING_RECONCILIATION",message:"timeout"},503);return new Response(JSON.stringify(data),{status:200,headers:{"content-type":"application/json","PAYMENT-RESPONSE":Buffer.from(JSON.stringify({success:true,payer,transaction:"0x"+"ab".repeat(32),amount:"10000",network:"eip155:8453",resource:"https://rug.test/v1/scan"})).toString("base64")}});}};
 context.window={location:{hostname:"rug.test",origin:"https://rug.test"},addEventListener(){},ethereum:{request:async(call:any)=>{walletCalls.push(call);if(call.method==="eth_requestAccounts")return[payer];if(call.method==="eth_signTypedData_v4")return"0xOFFLINE_WALLET_STUB";return null;}}};
 vm.createContext(context);vm.runInContext(script,context);
 return {context,requests,walletCalls,storage,element};
}

test("Browser validates actual quote and retains the same authorization through uncertain payment recovery",async()=>{
 const b=browserHarness();await vm.runInContext("unlockWithBase()",b.context);
 assert.equal(b.walletCalls.filter(x=>x.method==="eth_signTypedData_v4").length,1);assert.equal(b.requests.length,2);assert.equal(b.storage.size,1);
 const typed=JSON.parse(b.walletCalls.find(x=>x.method==="eth_signTypedData_v4").params[1]);assert.equal(typed.message.value,"10000");assert.ok(Number(typed.message.validBefore)<=Math.floor(Date.now()/1000)+61);
 const firstHeader=b.requests[1].init.headers["PAYMENT-SIGNATURE"];
 await vm.runInContext("unlockWithBase()",b.context);assert.equal(b.walletCalls.filter(x=>x.method==="eth_signTypedData_v4").length,1);assert.equal(b.requests[2].init.headers["PAYMENT-SIGNATURE"],firstHeader);assert.equal(b.storage.size,0);
 assert.match(b.element("uSim").innerText,/Unknown/);assert.match(b.element("uClusters").innerText,/Unknown/);assert.match(b.element("uNetflow").innerText,/Unknown/);
});
test("Browser rejects changed quote price and requests no Solana full-simulation payment",async()=>{
 const b=browserHarness("20000");await vm.runInContext("unlockWithBase()",b.context);assert.equal(b.walletCalls.length,0);assert.equal(b.storage.size,0);
 await vm.runInContext("unlockWithSolana()",b.context);assert.equal(b.walletCalls.length,0);assert.match(b.element("paymentStatus").textContent,/will not request payment/);
});
