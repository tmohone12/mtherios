import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {randomUUID} from 'node:crypto';
import postgres,{type Sql} from 'postgres';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {runRecoveryOperator,recoveryApprovalTemplate,RECOVERY_SCHEMA_SHA256,type OperatorApproval} from './summaryRecoveryOperator';
import {planSummaryRecovery,recoveryHash,readRecoveryRun,type RecoveryManifest} from './summaryRecovery';
const url=process.env.RECOVERY_OPERATOR_TEST_DATABASE_URL,tests=url?describe:describe.skip;
let db:Sql;let folder:string;
beforeAll(async()=> {
	if(!url)return;const u=new URL(url);
	if(u.hostname!=='127.0.0.1'||u.port!=='5433'||!/^\/mythengine_summary_repair_recovery_\d+_operator$/.test(u.pathname))throw Error('Dedicated disposable operator DB required');
	db=postgres(url,{max:2,prepare:false,onnotice:()=>{}});expect((await db`select current_database() as name`)[0].name).toBe(u.pathname.slice(1));
	folder=fs.mkdtempSync(path.join(os.tmpdir(),'summary-recovery-operator-'));
});
afterAll(async()=>{if(db)await db.end();vi.unstubAllGlobals();});
async function fixture(long=false) {
	const sid=`operator_fixture_${randomUUID()}`,shelf=`shelf_${sid}`,directory=path.join(folder,sid);fs.mkdirSync(directory);
	await db`insert into shelves(id,name,slug) values(${shelf},'Operator fixture',${shelf})`;
	await db`insert into stories(id,shelf_id,title,metadata) values(${sid},${shelf},'Operator fixture','{"campaignState":[{"key":"rumor","status":"uncertain"}]}')`;
	await db`insert into entities(id,story_id,type,name,state) values(${sid+'_npc'},${sid},'character','Envoy','{"identity":"preserved"}')`;
	await db`insert into factions(id,story_id,name,resources) values(${sid+'_faction'},${sid},'Council','{"wealth":12}')`;
	await db`insert into backend_jobs(id,project_id,story_id,type,status) values(${sid+'_queue'},${shelf},${sid},'summarize_chapter','queued')`;
	for(let i=0;i<20;i++) {
		await db`insert into story_entries(id,story_id,type,content,position) values(${sid+'_p'+i},${sid},'user_action',${'I ask the envoy question '+i},${i*2+1})`;
		await db`insert into story_entries(id,story_id,type,content,position,parent_id) values(${sid+'_n'+i},${sid},'narration',${'The envoy reports an uncertain rumor '+i+'. '+(long?'Remembered background. '.repeat(160):'')},${i*2+2},${sid+'_p'+i})`;
	}
	const m=await planSummaryRecovery(db,sid,'chapter'),manifestFile=path.join(directory,'manifest.json');fs.writeFileSync(manifestFile,JSON.stringify(m));
	const reads=vi.fn(()=>`fixture_secret_${sid}`),deps={loadConfig:()=>({databaseUrl:url!}),openDatabase:()=>db,readEnvironment:reads};
	let count=0;
	function args(command:string,approval?:unknown) {
		const out=path.join(directory,`output-${++count}.json`);
		const a=[command,'--config','fixture-config','--out',out];
		if(command==='preview')a.push('--story',sid,'--kind','chapter','--start','1','--end','40');else a.push('--manifest',manifestFile);
		if(approval) {const file=path.join(directory,`approval-${count}.json`);fs.writeFileSync(file,JSON.stringify(approval));a.push('--approval',file);}
		if(command==='generate')a.push('--key-env','FIXTURE_NANOGPT_KEY');return a;
	}
	function approve(operation:OperatorApproval['operation'],draftHash?:string) {
		return {...recoveryApprovalTemplate(m,new URL(url!).pathname.slice(1),operation,draftHash),approvedBy:'Fixture human reviewer',approvedAt:new Date().toISOString(),
			...(operation==='review'?{checks:{quotesChecked:true,uncertaintyChecked:true,chronologyChecked:true}}:{})};
	}
	return {sid,m,directory,manifestFile,deps,reads,args,approve};
}
async function protectedHash() {
	const tables=['stories','story_entries','entities','factions','story_threads','story_events','agreements','backend_jobs','canonical_content','canonical_content_history'];
	const rows:Record<string,unknown>={};for(const t of tables)rows[t]=await db.unsafe(`select ${t==='stories'?"to_jsonb(t)-'server_version' as row":'*'} from ${t} t order by ${t==='stories'?'t.id':'1'}`);return recoveryHash(rows);
}
function provider(m:RecoveryManifest,mode='success') {
	const calls:Record<string,any>[]=[];
	const fetch=vi.fn(async(_url:any,init:any)=> {
		const body=JSON.parse(init.body);calls.push(body);
		if(mode==='timeout')throw Error('Simulated timeout');
		const prompt=body.messages.at(-1).content as string,ids=[...prompt.matchAll(/^SOURCE (.+)$/gm)].map(x=>x[1]);
		const sources=ids.length?m.sources.filter(s=>ids.includes(s.id)):m.sources;
		const accounts=sources.map(s=>({sourceId:s.id,summary:'The envoy reports an uncertain rumor; its truth remains unresolved.',
			evidence:[{sourceId:Object.keys(s.evidence).at(-1)!,quote:Object.values(s.evidence).at(-1)!.slice(0,45),status:'reported',speaker:'Envoy'}]}));
		if(mode==='partial')accounts.pop();
		const text=JSON.stringify({title:'Envoy reports',narrative:'The envoy answers a sequence of questions. Each report remains an attributed rumor with uncertain truth, and no character gains knowledge of another private scene.',accounts});
		return new Response(JSON.stringify({model:m.route.model,choices:[{message:{content:text},finish_reason:mode==='length'?'length':'stop'}],
			usage:{prompt_tokens:Math.ceil(Buffer.byteLength(init.body)/4),completion_tokens:1000,total_tokens:1000+Math.ceil(Buffer.byteLength(init.body)/4),cost:0.0005}}),
			{status:200,headers:{'Content-Type':'application/json','x-request-id':'fixture-request-'+calls.length}});
	});vi.stubGlobal('fetch',fetch);return {fetch,calls};
}
tests('explicit operator production path with mocked HTTP and disposable DB',()=> {
	it('validates and imports an external draft without credentials, preserves separate review/append gates, and refuses replacement or generation',async()=> {
		const f=await fixture(),draft={title:'Externally authored reports',narrative:'The envoy answers each question with an attributed rumor. Its truth remains uncertain and no canonical identity, campaign state, or transcript is changed.',
			accounts:f.m.sources.map(s=>({sourceId:s.id,summary:'The envoy reports an uncertain rumor; its truth is unresolved.',evidence:[{sourceId:s.id,quote:'The envoy reports an uncertain rumor',status:'reported',speaker:'Envoy'}]}))};
		const draftHash=recoveryHash(draft),file=path.join(f.directory,'external.json');fs.writeFileSync(file,JSON.stringify({manifestId:f.m.id,draft}));
		const validateArgs=[...f.args('validate-draft'),'--draft',file],before=await protectedHash();
		const validated=await runRecoveryOperator(validateArgs,f.deps);expect(JSON.parse(fs.readFileSync(validated.out!,'utf8'))).toMatchObject({draftHash,readOnly:true,providerCalls:0});
		await runRecoveryOperator(f.args('install-ledger',f.approve('install-ledger')),f.deps);
		const importArgs=()=>[...f.args('import-draft',f.approve('import-draft',draftHash)),'--draft',file];
		const result=await runRecoveryOperator(importArgs(),f.deps);await runRecoveryOperator(importArgs(),f.deps);
		expect(result.appendPerformed).toBe(false);expect(result.draftHash).toBe(draftHash);expect(f.reads).not.toHaveBeenCalled();
		expect((await readRecoveryRun(db,f.m))!.attempts).toEqual([]);expect(await protectedHash()).toBe(before);
		await expect(runRecoveryOperator(f.args('generate',f.approve('generate')),f.deps)).rejects.toThrow('External draft');
		await expect(runRecoveryOperator(f.args('append',f.approve('append',draftHash)),f.deps)).rejects.toThrow('review');
		const changed={...draft,title:'Different external report'};fs.writeFileSync(file,JSON.stringify({manifestId:f.m.id,draft:changed}));
		await expect(runRecoveryOperator([...f.args('import-draft',f.approve('import-draft',recoveryHash(changed))),'--draft',file],f.deps)).rejects.toThrow('differs');
		await runRecoveryOperator(f.args('review',f.approve('review',draftHash)),f.deps);await runRecoveryOperator(f.args('append',f.approve('append',draftHash)),f.deps);
		expect(await protectedHash()).toBe(before);const saved=await db`select metadata from chapters where story_id=${f.sid}`;expect(saved).toHaveLength(1);
		expect(saved[0].metadata).toMatchObject({summarySource:'external-reviewed-draft',summaryModel:null,summaryOrigin:{kind:'external',approvedBy:'Fixture human reviewer'}});
	});
	it('rejects external draft source tampering, unsupported quotes, missing accounts, hash mismatch and stale input before import',async()=> {
		const f=await fixture();await runRecoveryOperator(f.args('install-ledger',f.approve('install-ledger')),f.deps);
		const draft={title:'External reports',narrative:'Each answer remains a report of a rumor and is kept uncertain. No private information crosses stories, and no character or campaign is rewritten.',accounts:f.m.sources.map(s=>({sourceId:s.id,summary:'The envoy reports a rumor which remains uncertain.',evidence:[{sourceId:s.id,quote:'The envoy reports an uncertain rumor',status:'reported',speaker:'Envoy'}]}))};
		const file=path.join(f.directory,'external.json'),hash=recoveryHash(draft),before=await protectedHash();
		for(const envelope of [{manifestId:'other',draft},{manifestId:f.m.id,draft:{...draft,accounts:draft.accounts.slice(1)}},{manifestId:f.m.id,draft:{...draft,accounts:draft.accounts.map((a,i)=>i? a:{...a,evidence:[{...a.evidence[0],quote:'Invented quotation'}]})}}]) {
			fs.writeFileSync(file,JSON.stringify(envelope));await expect(runRecoveryOperator([...f.args('import-draft',f.approve('import-draft',hash)),'--draft',file],f.deps)).rejects.toThrow();
		}
		fs.writeFileSync(file,JSON.stringify({manifestId:f.m.id,draft}));await expect(runRecoveryOperator([...f.args('import-draft',f.approve('import-draft','different')),'--draft',file],f.deps)).rejects.toThrow('differs');
		expect(await protectedHash()).toBe(before);await db`update story_entries set content=content||' Changed.' where story_id=${f.sid} and position=2`;
		await expect(runRecoveryOperator([...f.args('import-draft',f.approve('import-draft',hash)),'--draft',file],f.deps)).rejects.toThrow('Stale');expect((await readRecoveryRun(db,f.m))!.draft).toBeUndefined();expect(f.reads).not.toHaveBeenCalled();
	});
	it('previews without schema writes or credential access and requires a separate exact schema approval',async()=> {
		const f=await fixture(),before=await protectedHash();
		const result=await runRecoveryOperator(f.args('preview'),f.deps),preview=JSON.parse(fs.readFileSync(result.out!,'utf8'));
		expect(preview.manifest.id).toBe(f.m.id);expect(preview.approvalTemplates.generate.approvedBy).toBe('');expect(f.reads).not.toHaveBeenCalled();
		await expect(runRecoveryOperator(f.args('install-ledger',{...f.approve('install-ledger'),schemaSha256:'different'}),f.deps)).rejects.toThrow('Schema');
		await runRecoveryOperator(f.args('install-ledger',f.approve('install-ledger')),f.deps);
		expect((await db`select name from _mtherios_migrations where name='0052_summary_recovery.sql'`).length).toBe(1);
		expect((await readRecoveryRun(db,f.m))!.operatorApprovals!.map(a=>a.operation)).toEqual(['install-ledger']);
		expect(await protectedHash()).toBe(before);expect(f.reads).not.toHaveBeenCalled();
	});
	it('runs actual transport in draft-only mode; review and append require distinct approvals; reuse and rollback preserve canonical history',async()=> {
		const f=await fixture(true);await runRecoveryOperator(f.args('install-ledger',f.approve('install-ledger')),f.deps);
		const before=await protectedHash(),p=provider(f.m);
		const generated=await runRecoveryOperator(f.args('generate',f.approve('generate')),f.deps);
		expect(generated.appendPerformed).toBe(false);expect(p.calls).toHaveLength(3);expect(await protectedHash()).toBe(before);
		expect((await db`select id from chapters where story_id=${f.sid}`).length).toBe(0);
		const draftHash=generated.draftHash!;
		await expect(runRecoveryOperator(f.args('append',f.approve('append',draftHash)),f.deps)).rejects.toThrow('review');
		await expect(runRecoveryOperator(f.args('review',f.approve('review','wrong')),f.deps)).rejects.toThrow('draft');
		await runRecoveryOperator(f.args('review',f.approve('review',draftHash)),f.deps);
		const reused=await runRecoveryOperator(f.args('generate',f.approve('generate')),f.deps);expect(reused.draftHash).toBe(draftHash);expect(p.calls).toHaveLength(3);
		const approved=f.approve('append',draftHash);
		const append=await runRecoveryOperator(f.args('append',approved),f.deps);await runRecoveryOperator(f.args('append',approved),f.deps);
		expect((await db`select id from chapters where story_id=${f.sid}`).length).toBe(1);expect((await db`select id from memory_nodes where story_id=${f.sid}`).length).toBe(1);
		expect(await protectedHash()).toBe(before);expect(p.calls).toHaveLength(3);
		const receipt=JSON.parse(fs.readFileSync(append.out!,'utf8'));expect(receipt.clientRefresh).toContain('Chapters');
		expect(receipt.writes).toEqual(['chapters','memory_nodes','summary_recovery_runs','story sync counter']);expect(JSON.stringify(receipt)).not.toContain(`fixture_secret_${f.sid}`);
		expect(receipt.run.attempts.every((a:any)=>a.receipt.status==='success'&&a.receipt.usage.providerCostUsd===0.0005)).toBe(true);
		await db`insert into story_entries(id,story_id,type,content,position) values(${f.sid+'_later'},${f.sid},'user_action','Later unrelated action',41)`;
		const later=await protectedHash();await runRecoveryOperator(f.args('rollback',f.approve('rollback',draftHash)),f.deps);
		expect(await protectedHash()).toBe(later);expect((await db`select id from chapters where story_id=${f.sid}`).length).toBe(0);
	});
	it.each(['partial','timeout','length'])('exports retained %s receipts and refuses resume or append',async mode=> {
		const f=await fixture();await runRecoveryOperator(f.args('install-ledger',f.approve('install-ledger')),f.deps);const p=provider(f.m,mode),before=await protectedHash();
		await expect(runRecoveryOperator(f.args('generate',f.approve('generate')),f.deps)).rejects.toThrow();
		await expect(runRecoveryOperator(f.args('generate',f.approve('generate')),f.deps)).rejects.toThrow('blocked or uncertain');expect(p.calls).toHaveLength(1);
		const inspected=await runRecoveryOperator(f.args('inspect'),f.deps),receipt=JSON.parse(fs.readFileSync(inspected.out!,'utf8'));
		expect(receipt.run.attempts[0].status).toBe('blocked');expect(receipt.run.attempts[0].receipt).toBeTruthy();expect(await protectedHash()).toBe(before);
	});
	it('rejects wrong scope, forged limits, extra actions, output collision and stale sources before any provider dispatch',async()=> {
		const f=await fixture(),p=provider(f.m);await runRecoveryOperator(f.args('install-ledger',f.approve('install-ledger')),f.deps);
		for(const change of [{operation:'append'},{storyId:'other'},{start:2},{limitsHash:'different'}]) {
			await expect(runRecoveryOperator(f.args('generate',{...f.approve('generate'),...change}),f.deps)).rejects.toThrow();
		}
		await expect(runRecoveryOperator([...f.args('generate',f.approve('generate')),'--append','true'],f.deps)).rejects.toThrow('unsupported');
		const collision=f.args('generate',f.approve('generate')),out=collision[collision.indexOf('--out')+1];fs.writeFileSync(out,'Keep original');
		await expect(runRecoveryOperator(collision,f.deps)).rejects.toThrow();expect(fs.readFileSync(out,'utf8')).toBe('Keep original');expect(f.reads).not.toHaveBeenCalled();
		await db`update story_entries set content=content||' Changed.' where story_id=${f.sid} and position=2`;
		await expect(runRecoveryOperator(f.args('generate',f.approve('generate')),f.deps)).rejects.toThrow('Stale');expect(p.calls).toHaveLength(0);
	});
	it('executes the compiled CLI subprocess with actual argument/config/credential-reference flow and mocked HTTP only',async()=> {
		const f=await fixture();await runRecoveryOperator(f.args('install-ledger',f.approve('install-ledger')),f.deps);
		const configFile=path.join(f.directory,'config.json'),mockFile=path.join(f.directory,'mock-http.mjs');
		fs.writeFileSync(configFile,JSON.stringify({databaseUrl:url,jobWorker:false,wikiAutoIndexStoryVaults:false}));
		fs.writeFileSync(mockFile,`import fs from 'node:fs';
const m=JSON.parse(fs.readFileSync(process.env.FIXTURE_MANIFEST_PATH,'utf8'));
globalThis.fetch=async(url,init)=> {
 if(url!=='https://api.nano-gpt.com/api/v1/chat/completions')throw Error('Real network forbidden');
 const body=JSON.parse(init.body),p=body.messages.at(-1).content,ids=[...p.matchAll(/^SOURCE (.+)$/gm)].map(x=>x[1]);
 const sources=ids.length?m.sources.filter(s=>ids.includes(s.id)):m.sources;
 const accounts=sources.map(s=>({sourceId:s.id,summary:'The envoy reports a rumor; its truth remains uncertain.',evidence:[{sourceId:Object.keys(s.evidence).at(-1),quote:Object.values(s.evidence).at(-1).slice(0,45),status:'reported',speaker:'Envoy'}]}));
 const text=JSON.stringify({title:'Attributed rumors',narrative:'The envoy answers questions while preserving the uncertainty of the reports. The rumor remains attributed to the envoy rather than accepted as established truth.',accounts});
 return new Response(JSON.stringify({model:m.route.model,choices:[{message:{content:text},finish_reason:'stop'}],usage:{prompt_tokens:Math.ceil(Buffer.byteLength(init.body)/4),completion_tokens:1000,cost:0.0005}}),{status:200,headers:{'Content-Type':'application/json'}});
};`);
		const a=f.args('generate',f.approve('generate'));a[a.indexOf('--config')+1]=configFile;
		const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/KEY|TOKEN|SECRET|CREDENTIAL|PAID|LIVE|RUN_|MYTHENGINE_|MTHERIOS_|DATABASE_URL|SUMMARY_/i.test(key)));
		Object.assign(env,{DATABASE_URL:url!,MYTHENGINE_DATABASE_URL:url!,MTHERIOS_DATABASE_URL:url!,FIXTURE_NANOGPT_KEY:'subprocess-fixture-only',FIXTURE_MANIFEST_PATH:f.manifestFile});
		const child=spawnSync(process.execPath,['--import',pathToFileURL(mockFile).href,path.resolve('tools/summary-recovery.mjs'),...a],{cwd:process.cwd(),env,encoding:'utf8',windowsHide:true});
		expect(child.status,child.stderr).toBe(0);const result=JSON.parse(child.stdout.trim());expect(result.appendPerformed).toBe(false);
		expect((await db`select id from chapters where story_id=${f.sid}`).length).toBe(0);
		const ledger=await readRecoveryRun(db,f.m);expect(ledger!.attempts).toHaveLength(1);expect(ledger!.attempts[0].status).toBe('complete');
		expect(JSON.stringify(ledger)).not.toContain('subprocess-fixture-only');
	});
});
describe('operator help and target validation',()=> {
	it('help is runnable without database or credential access',async()=> {
		const loadConfig=vi.fn(()=>{throw Error('must not load config');});expect((await runRecoveryOperator(['--help'],{loadConfig})).help).toContain('One operation');expect(loadConfig).not.toHaveBeenCalled();
	});
	it('rejects remote databases and broad mutation options',async()=> {
		await expect(runRecoveryOperator(['preview','--config','x','--out','x','--story','x','--kind','chapter','--start','1','--end','40'],
			{loadConfig:()=>({databaseUrl:'postgres://x:x@example.invalid:5433/mythengine'})})).rejects.toThrow('local');
		await expect(runRecoveryOperator(['generate','--all-stories','true'])).rejects.toThrow('Missing');
	});
});
