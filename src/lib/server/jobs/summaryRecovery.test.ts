import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { randomUUID,createHash } from 'node:crypto';
import fs from 'node:fs';
import { planSummaryRecovery,previewRecoveryCalls,recoveryHash,generateRecoveryDraft,reviewRecoveryDraft,
	commitRecoveryDraft,rollbackRecoveryCommit,validateRecoveryDraft,importRecoveryDraft,validateRecoveryManifest,proposeRecoveryEvidenceRepair,reviewRetainedRecoveryStage,reviewRetainedRecoveryCompletion,LEGACY_RECOVERY_ROUTE,LEGACY_RECOVERY_LIMITS,RECOVERY_PROVIDER,type RecoveryManifest } from './summaryRecovery';
import type { ServerGenerationOptions,ServerGenerationResult } from '$lib/server/turn/provider';
const url=process.env.RECOVERY_TEST_DATABASE_URL;
const integration=url?describe:describe.skip;
// Optional historical fixture stays outside version control; synthetic cases run without it.
const retainedSourceFixture=process.env.RECOVERY_RETAINED_SOURCE_FIXTURE;
let db:Sql;
beforeAll(async()=> {
	if(!url)return;
	const u=new URL(url);
	if(u.hostname!=='127.0.0.1'||u.port!=='5433'||!/^\/mythengine_summary_repair_recovery_\d+$/.test(u.pathname))throw Error('Strict disposable database required');
	db=postgres(url,{max:4,prepare:false,onnotice:()=>{}});
	expect((await db`select current_database() as name`)[0].name).toBe(u.pathname.slice(1));
	vi.stubGlobal('fetch',()=>{throw Error('Network forbidden in recovery tests');});
});
afterAll(async()=> {if(db)await db.end();vi.unstubAllGlobals();});
const profile={providerType:'nanogpt',baseUrl:'https://api.nano-gpt.com/api/v1',apiKey:'fixture-not-a-key'} as ServerGenerationOptions['profile'];
const approval=(m:RecoveryManifest)=>({manifestId:m.id,routeHash:recoveryHash(m.route),limitsHash:recoveryHash(m.limits)});
async function fixture(long=false) {
	const sid=`recovery_test_${randomUUID()}`,shelf=`shelf_${sid}`;
	await db`insert into shelves(id,name,slug) values(${shelf},'Recovery test',${shelf})`;
	await db`insert into stories(id,shelf_id,title,metadata) values(${sid},${shelf},'Recovery test','{"campaignState":[{"key":"rumor","status":"uncertain"}]}')`;
	await db`insert into entities(id,story_id,type,name,state) values(${sid+'_npc'},${sid},'character','Envoy','{"identity":"preserved"}')`;
	await db`insert into factions(id,story_id,name,resources) values(${sid+'_faction'},${sid},'Council','{"wealth":12}')`;
	await db`insert into backend_jobs(id,project_id,story_id,type,status) values(${sid+'_job'},${shelf},${sid},'summarize_chapter','queued')`;
	for(let i=0;i<20;i++) {
		await db`insert into story_entries(id,story_id,type,content,position) values(${sid+'_p'+i},${sid},'user_action',${'I ask the envoy question '+i},${i*2+1})`;
		await db`insert into story_entries(id,story_id,type,content,position,parent_id) values(${sid+'_n'+i},${sid},'narration',${'The envoy reports an uncertain rumor '+i+'. '+(long?'Background recollection. '.repeat(160):'')},${i*2+2},${sid+'_p'+i})`;
	}
	return {sid,m:await planSummaryRecovery(db,sid,'chapter')};
}
function draft(sources:RecoveryManifest['sources']) {
	return {title:'Reports from the envoy',narrative:'The envoy answers a sequence of questions. The accounts preserve each uncertain report as an attributed rumor rather than an established fact.',
		accounts:sources.map(s=>({sourceId:s.id,summary:'The envoy reports an uncertain rumor; its truth remains unresolved.',evidence:[{sourceId:Object.keys(s.evidence).at(-1)!,quote:Object.values(s.evidence).at(-1)!.slice(0,50),status:'reported',speaker:'Envoy'}]}))};
}
function mock(m:RecoveryManifest,mode='success',inputTokens=1000) {
	let dispatches=0;
	const fn=vi.fn(async(options:ServerGenerationOptions):Promise<ServerGenerationResult>=> {
		const body={model:m.route.model,max_tokens:12000,include_usage:true,provider:structuredClone(RECOVERY_PROVIDER)},serializedBody=JSON.stringify(body);
		await options.onBeforeRequest!({body,serializedBody,inputTokens,reservedOutputTokens:12000,contextWindowTokens:128000});
		dispatches++;
		if(mode==='timeout')throw Error('Simulated timeout after dispatch');
		const sourceIds=[...options.prompt.matchAll(/^SOURCE (.+)$/gm)].map(x=>x[1]);
		const sources=sourceIds.length?m.sources.filter(s=>sourceIds.includes(s.id)):m.sources;
		const value=draft(sources);
		if(mode==='partial')value.accounts.pop();
		if(mode==='badquote')value.accounts[0].evidence[0].quote='Invented quotation absent from source';
		const text=mode==='badjson'?'{partial':JSON.stringify(value);
		const usage={inputTokens,outputTokens:mode==='outputlimit'?12001:500,providerCostUsd:mode==='costlimit'?1:0.00028,requestTokens:inputTokens,responseTokens:500,totalTokens:inputTokens+500,cachedInputTokens:0,cacheWriteTokens:0,reasoningTokens:0,estimatedCostUsd:0.00028};
		const receipt={attemptId:'fixture_'+randomUUID(),providerRequestId:null,requestHash:createHash('sha256').update(serializedBody).digest('hex'),attempt:0,startedAt:new Date().toISOString(),
			model:m.route.model,endpoint:'https://api.nano-gpt.com/api/v1/chat/completions',status:'success' as const,statusCode:200,durationMs:1,promptChars:options.prompt.length,responseChars:text.length,finishReason:mode==='length'?'length':'stop',usage,error:null};
		await options.onAttempt!(receipt);
		return {text,model:m.route.model,endpoint:receipt.endpoint,finishReason:receipt.finishReason,durationMs:1,promptChars:receipt.promptChars,responseChars:text.length,usage,attempts:[receipt]};
	});
	return {fn,get dispatches(){return dispatches;}};
}
async function protectedHash(sid:string) {
	const tables=['stories','story_entries','entities','factions','backend_jobs','story_threads','agreements','story_events','canonical_content','canonical_content_history'];
	const result:Record<string,unknown>={};
	for(const table of tables)result[table]=await db.unsafe(`select ${table==='stories'?"to_jsonb(t)-'server_version' as row":'*'} from ${table} t order by ${table==='stories'?'t.id':'1'}`);
	return recoveryHash(result);
}
async function generateReviewed(m:RecoveryManifest) {
	const g=mock(m);const result=await generateRecoveryDraft(db,m,approval(m),profile,g.fn);
	await reviewRecoveryDraft(db,m,result.draftHash,'fixture reviewer',{quotesChecked:true,uncertaintyChecked:true,chronologyChecked:true});
	return {g,result};
}
integration('summary-only recovery in disposable PostgreSQL',()=> {
	it('imports a large explicit backfill without provider calls, records true cadence, and appends an arc of six chapters',async()=> {
		const {sid}=await fixture();
		for(let i=20;i<73;i++) {
			await db`insert into story_entries(id,story_id,type,content,position) values(${sid+'_p'+i},${sid},'user_action',${'Question '+i},${i*2+1})`;
			await db`insert into story_entries(id,story_id,type,content,position,parent_id) values(${sid+'_n'+i},${sid},'narration',${'Reported answer '+i},${i*2+2},${sid+'_p'+i})`;
		}
		const scope={snapshotEndPosition:146,canonEntityIds:[sid+'_npc']};
		const m=await planSummaryRecovery(db,sid,'chapter',{start:0,end:146},scope),g=mock(m);
		expect(m.sources).toHaveLength(73);expect(m.coverage?.completedTurns).toBe(73);expect(previewRecoveryCalls(m).maxCalls).toBe(0);
		await expect(generateRecoveryDraft(db,m,approval(m),profile,g.fn)).rejects.toThrow('forbidden');expect(g.dispatches).toBe(0);
		const d=draft(m.sources),hash=recoveryHash(d);await importRecoveryDraft(db,m,d,hash,'Fixture delegated source reviewer');
		await reviewRecoveryDraft(db,m,hash,'Fixture delegated source reviewer',{quotesChecked:true,uncertaintyChecked:true,chronologyChecked:true});
		const c=await commitRecoveryDraft(db,m,hash);expect(c.projection.metadata.turnCount).toBe(73);
		for(let n=2;n<=6;n++)await db`insert into chapters(id,story_id,number,scene_outcome,metadata) values(${sid+'_c'+n},${sid},${n},${'Chapter '+n+' describes a reported answer and pending request.'},${db.json({startPosition:147+(n-2)*2,endPosition:148+(n-2)*2,turnCount:1})})`;
		const a=await planSummaryRecovery(db,sid,'arc',{start:0,end:156},{...scope,snapshotEndPosition:156});
		expect(a.sources).toHaveLength(6);const ad=draft(a.sources),ah=recoveryHash(ad);await importRecoveryDraft(db,a,ad,ah,'Fixture reviewer');
		await reviewRecoveryDraft(db,a,ah,'Fixture reviewer',{quotesChecked:true,uncertaintyChecked:true,chronologyChecked:true});
		await commitRecoveryDraft(db,a,ah);expect((await db`select chapter_ids from arcs where story_id=${sid}`)[0].chapter_ids).toHaveLength(6);
	});
	it('rejects explicit drafts after canonical identity or story version changes and refuses foreign identity scope',async()=> {
		const {sid}=await fixture(),scope={snapshotEndPosition:40,canonEntityIds:[sid+'_npc']};
		const m=await planSummaryRecovery(db,sid,'chapter',{start:0,end:40},scope),d=draft(m.sources);
		await db`update entities set state='{"identity":"changed"}' where id=${sid+'_npc'}`;
		await expect(importRecoveryDraft(db,m,d,recoveryHash(d),'Fixture reviewer')).rejects.toThrow('Stale');
		const fresh=await planSummaryRecovery(db,sid,'chapter',{start:0,end:40},scope);
		await db`update stories set server_version=server_version+1 where id=${sid}`;
		await expect(importRecoveryDraft(db,fresh,d,recoveryHash(d),'Fixture reviewer')).rejects.toThrow('Stale');
		await expect(planSummaryRecovery(db,sid,'chapter',{start:0,end:40},{...scope,canonEntityIds:['absent']})).rejects.toThrow('identity');
	});
	it('requires exact spend approval and rejects altered manifests, routes and arbitrary ranges before dispatch',async()=> {
		const {sid,m}=await fixture();const g=mock(m);
		await expect(generateRecoveryDraft(db,m,{...approval(m),manifestId:'different'},profile,g.fn)).rejects.toThrow('approval');
		await expect(planSummaryRecovery(db,sid,'chapter',{start:2,end:40})).rejects.toThrow('Range');
		await expect(generateRecoveryDraft(db,{...m,endPosition:39},approval(m),profile,g.fn)).rejects.toThrow('Manifest');
		await expect(generateRecoveryDraft(db,m,approval(m),{...profile,baseUrl:'https://example.invalid'},g.fn)).rejects.toThrow('transport');
		expect(g.dispatches).toBe(0);
	});
	it('appends exactly once under concurrent commits; review and rollback preserve all canonical and queue rows',async()=> {
		const {sid,m}=await fixture(),before=await protectedHash(sid);
		const [old]=await db`select server_version from stories where id=${sid}`;
		const {g,result}=await generateReviewed(m);
		await Promise.all([commitRecoveryDraft(db,m,result.draftHash),commitRecoveryDraft(db,m,result.draftHash)]);
		const [current]=await db`select server_version from stories where id=${sid}`;
		expect(current.server_version).toBe(old.server_version+1);
		expect((await db`select server_version from chapters where story_id=${sid}`)[0].server_version).toBe(current.server_version);
		expect((await db`select server_version from memory_nodes where story_id=${sid}`)[0].server_version).toBe(current.server_version);
		expect((await db`select id from chapters where story_id=${sid} and server_version>${old.server_version}`)).toHaveLength(1);
		await commitRecoveryDraft(db,m,result.draftHash);
		expect((await db`select server_version from stories where id=${sid}`)[0].server_version).toBe(current.server_version);
		expect(g.dispatches).toBe(1);expect((await db`select id from chapters where story_id=${sid}`).length).toBe(1);
		expect((await db`select id from memory_nodes where story_id=${sid}`).length).toBe(1);
		expect(await protectedHash(sid)).toBe(before);
		await db`insert into story_entries(id,story_id,type,content,position) values(${sid+'_later'},${sid},'user_action','A later unrelated action',41)`;
		const later=await protectedHash(sid);
		await rollbackRecoveryCommit(db,m);await rollbackRecoveryCommit(db,m);
		expect(await protectedHash(sid)).toBe(later);
		expect((await db`select id from chapters where story_id=${sid}`).length).toBe(0);
		const [row]=await db`select document from summary_recovery_runs where id=${m.id}`;
		expect(row.document.attempts[0].reservedInput).toBe(1000);expect(row.document.attempts[0].receipt).toBeTruthy();expect(row.document.rollback).toBeTruthy();
	});
	it('requires exact reviewed draft hash before any append',async()=> {
		const {sid,m}=await fixture(),g=mock(m);const r=await generateRecoveryDraft(db,m,approval(m),profile,g.fn);
		await expect(commitRecoveryDraft(db,m,r.draftHash)).rejects.toThrow('review');
		await expect(reviewRecoveryDraft(db,m,'changed','Reviewer',{quotesChecked:true,uncertaintyChecked:true,chronologyChecked:true})).rejects.toThrow('differs');
		expect((await db`select id from chapters where story_id=${sid}`).length).toBe(0);
	});
	it.each(['partial','badquote','badjson','length','timeout','outputlimit','costlimit'])('retains a paid %s failure and refuses automatic replay',async mode=> {
		const {sid,m}=await fixture(),g=mock(m,mode),before=await protectedHash(sid);
		await expect(generateRecoveryDraft(db,m,approval(m),profile,g.fn)).rejects.toThrow();
		await expect(generateRecoveryDraft(db,m,approval(m),profile,g.fn)).rejects.toThrow('blocked or uncertain');
		expect(g.dispatches).toBe(1);expect(await protectedHash(sid)).toBe(before);
		const [row]=await db`select document from summary_recovery_runs where id=${m.id}`;
		expect(row.document.attempts[0].status).toBe('blocked');expect(row.document.attempts[0].reservedInput).toBe(1000);
		expect((await db`select id from chapters where story_id=${sid}`).length).toBe(0);
	});
	it('rejects per-request input overflow before dispatch',async()=> {
		const {m}=await fixture(),g=mock(m,'success',50001);
		await expect(generateRecoveryDraft(db,m,approval(m),profile,g.fn)).rejects.toThrow('ceiling');expect(g.dispatches).toBe(0);
	});
	it('stops the third dispatch when aggregate reservations would exceed 120,000 input tokens',async()=> {
		const {m}=await fixture(true),g=mock(m,'success',50000);
		await expect(generateRecoveryDraft(db,m,approval(m),profile,g.fn)).rejects.toThrow('ceiling');
		expect(g.dispatches).toBe(2);
		const [row]=await db`select document from summary_recovery_runs where id=${m.id}`;
		expect(row.document.attempts.filter((a:any)=>a.status==='complete')).toHaveLength(2);
		await expect(generateRecoveryDraft(db,m,approval(m),profile,g.fn)).rejects.toThrow('blocked or uncertain');expect(g.dispatches).toBe(2);
	});
	it('prevents concurrent duplicate generation',async()=> {
		const {m}=await fixture(),g=mock(m);
		const results=await Promise.allSettled([generateRecoveryDraft(db,m,approval(m),profile,g.fn),generateRecoveryDraft(db,m,approval(m),profile,g.fn)]);
		expect(results.some(r=>r.status==='fulfilled')).toBe(true);expect(g.dispatches).toBe(1);
	});
	it('splits a large chapter into three bounded calls and resumes completed checkpoints without spending again',async()=> {
		const {m}=await fixture(true),g=mock(m);expect(previewRecoveryCalls(m).maxCalls).toBe(3);
		const first=await generateRecoveryDraft(db,m,approval(m),profile,g.fn),second=await generateRecoveryDraft(db,m,approval(m),profile,g.fn);
		expect(first.draftHash).toBe(second.draftHash);expect(g.dispatches).toBe(3);
		const [row]=await db`select document from summary_recovery_runs where id=${m.id}`;
		expect(row.document.attempts.every((a:any)=>a.status==='complete')).toBe(true);
		expect(row.document.attempts.reduce((n:number,a:any)=>n+a.reservedOutput,0)).toBe(36000);
	});
	it('refuses stale content, eligibility or coverage changes before commit',async()=> {
		for(const change of ['content','metadata','coverage']) {
			const {sid,m}=await fixture();const {result}=await generateReviewed(m);
			if(change==='content')await db`update story_entries set content=content||' Changed.' where story_id=${sid} and position=2`;
			else if(change==='metadata')await db`update story_entries set metadata='{"nonCanon":true}' where story_id=${sid} and position=2`;
			else await db`insert into chapters(id,story_id,number,scene_outcome,metadata) values(${sid+'_other'},${sid},1,'Another summary','{"endPosition":40}')`;
			await expect(commitRecoveryDraft(db,m,result.draftHash)).rejects.toThrow();
			expect((await db`select id from memory_nodes where story_id=${sid}`).length).toBe(0);
		}
	});
	it('rolls back the whole append when the memory-node insert fails',async()=> {
		const {sid,m}=await fixture(),{result}=await generateReviewed(m);
		const [before]=await db`select server_version from stories where id=${sid}`;
		await db`insert into memory_nodes(id,story_id,type,title,content) values(${'memory_chapter_recovery_'+m.id.slice(-64)},${sid},'episodic','Collision','Pre-existing row')`;
		await expect(commitRecoveryDraft(db,m,result.draftHash)).rejects.toThrow();
		expect((await db`select server_version from stories where id=${sid}`)[0].server_version).toBe(before.server_version);
		expect((await db`select id from chapters where story_id=${sid}`).length).toBe(0);
		const [row]=await db`select document from summary_recovery_runs where id=${m.id}`;expect(row.document.commit).toBeUndefined();
	});
	it('refuses rollback of edited rows or a summary with dependent history',async()=> {
		const {sid,m}=await fixture(),{result}=await generateReviewed(m),c=await commitRecoveryDraft(db,m,result.draftHash);
		await db`insert into arcs(id,story_id,number,title,summary,chapter_ids) values(${sid+'_dependent'},${sid},1,'Dependent arc','A later arc',${db.json([c.projection.id])})`;
		await expect(rollbackRecoveryCommit(db,m)).rejects.toThrow('dependent');
		expect((await db`select id from chapters where story_id=${sid}`).length).toBe(1);
	});
	it('appends one arc from ten chapters without modifying its chapters or canonical state',async()=> {
		const {sid}=await fixture();
		for(let i=1;i<=10;i++)await db`insert into chapters(id,story_id,number,scene_outcome,metadata) values(${sid+'_chapter'+i},${sid},${i},${'Chapter '+i+' describes an attributed uncertain report, without changing established truth.'},${db.json({startPosition:(i-1)*40+1,endPosition:i*40})})`;
		const m=await planSummaryRecovery(db,sid,'arc'),before=await protectedHash(sid),chaptersBefore=recoveryHash(await db`select * from chapters where story_id=${sid} order by number`);
		const {result}=await generateReviewed(m);await commitRecoveryDraft(db,m,result.draftHash);
		expect(await protectedHash(sid)).toBe(before);expect(recoveryHash(await db`select * from chapters where story_id=${sid} order by number`)).toBe(chaptersBefore);
		expect((await db`select id from arcs where story_id=${sid}`).length).toBe(1);
	});
	it.skipIf(!retainedSourceFixture)('plans the exact retained chapter-82 pilot, keeping all 81 chapters and eight arcs byte-for-byte',async()=> {
		const f=JSON.parse(fs.readFileSync(retainedSourceFixture!,'utf8'));
		const sid=f.storyId;
		// Strict fixture guard above makes this isolated rerun cleanup safe.
		await db`delete from stories where id=${sid}`;
		await db`insert into stories(id,title) values(${sid},'Veil isolated fixture')`;
		for(const table of ['story_entries','chapters','arcs']) {
			const columns=await db`select column_name,data_type from information_schema.columns where table_schema='public' and table_name=${table} and is_generated='NEVER'`;
			const rows=table==='story_entries'?f.entries:table==='chapters'?f.chapters:f.arcs;
			for(const row of rows) {
				const values=Object.fromEntries(columns.filter(c=>c.column_name in row).map(c=>[c.column_name,c.data_type==='jsonb'?db.json(row[c.column_name]):c.data_type.startsWith('timestamp')?new Date(row[c.column_name]):row[c.column_name]]));
				await db`insert into ${db(table)} ${db(values)}`;
			}
		}
		const before=recoveryHash([await db`select * from chapters where story_id=${sid} order by number`,await db`select * from arcs where story_id=${sid} order by number`]);
		const m=await planSummaryRecovery(db,sid,'chapter',{start:3301,end:3341}),preview=previewRecoveryCalls(m);
		expect(m.number).toBe(82);expect(m.sourceIds).toHaveLength(40);expect(m.sources).toHaveLength(20);expect(preview.maxCalls).toBe(3);
		expect(preview.stages.every(s=>s.estimatedInputTokens<40000)).toBe(true);
		// Retained pre-backfill fixture, not today's production boundary. No live DB is needed.
		const actual=await db.begin('isolation level repeatable read read only',tx=>planSummaryRecovery(tx as unknown as Sql,sid,'chapter',{start:3301,end:3341}));
		expect(actual.id).toBe(m.id);
		const {result}=await generateReviewed(m);await commitRecoveryDraft(db,m,result.draftHash);
		expect(recoveryHash([await db`select * from chapters where story_id=${sid} and number<=81 order by number`,await db`select * from arcs where story_id=${sid} order by number`])).toBe(before);
		await rollbackRecoveryCommit(db,m);
	});
});
integration('historical recovery route preservation',()=>{
 it('reuses historical external drafts and commits idempotently without allowing a legacy paid dispatch',async()=>{
  const {m}=await fixture();const {id:_,...body}=m;
  body.route={...LEGACY_RECOVERY_ROUTE};body.limits={...LEGACY_RECOVERY_LIMITS};
  const legacy={...body,id:`summary_recovery_${recoveryHash(body)}`};expect(()=>validateRecoveryManifest(legacy)).not.toThrow();
  const calls=vi.fn();await expect(generateRecoveryDraft(db,legacy,approval(legacy),profile,calls)).rejects.toThrow('Historical route');expect(calls).not.toHaveBeenCalled();
  const supplied=draft(legacy.sources),hash=recoveryHash(supplied);await importRecoveryDraft(db,legacy,supplied,hash,'Fixture prior approved external draft');
  await reviewRecoveryDraft(db,legacy,hash,'Fixture review',{quotesChecked:true,uncertaintyChecked:true,chronologyChecked:true});
  await commitRecoveryDraft(db,legacy,hash);const [before]=await db`select server_version from stories where id=${m.storyId}`;
  await commitRecoveryDraft(db,legacy,hash);expect((await db`select server_version from stories where id=${m.storyId}`)[0]).toEqual(before);
 });
});
describe('evidence review validation',()=> {
	it.each([
		["The King's peace.",'The King’s peace.'],
		['The guilds are your servants, Your Grace.','The guilds are your servants, Your Grace,'],
		["The King's peace, Your Grace.",'The King’s peace, Your Grace,']
	])('proposes exact source punctuation for %s without changing claims or marking them reviewed',(quote,text)=>{
		const sources=[{id:'n',text,evidence:{n:text}}],raw=draft(sources);raw.accounts[0].evidence[0].quote=quote;
		const proposal=proposeRecoveryEvidenceRepair(raw,sources);expect(proposal.semanticReviewRequired).toBe(true);expect(proposal.kind).toBe('review-proposal');
		expect(proposal.correctedDraft.accounts[0].evidence[0].quote).toBe(text);expect(proposal.correctedDraft.narrative).toBe(raw.narrative);expect(proposal.correctedDraft.accounts[0].summary).toBe(raw.accounts[0].summary);expect(raw.accounts[0].evidence[0].quote).toBe(quote);
		expect(validateRecoveryDraft(proposal.correctedDraft,sources)).toEqual(proposal.correctedDraft);
	});
	it.each([
		["The King's peace.",'The King’s peace. The King’s peace.'],
		["The King's war.",'The King’s peace.'],
		["the King's peace.",'The King’s peace.'],
		["The King's peace.",'The King’s  peace.']
	])('rejects ambiguous, paraphrased, invented or whitespace-altered evidence %s',(quote,text)=>{
		const sources=[{id:'n',text,evidence:{n:text}}],raw=draft(sources);raw.accounts[0].evidence[0].quote=quote;expect(()=>proposeRecoveryEvidenceRepair(raw,sources)).toThrow('unique');
	});
	it('never searches another account or changes the evidence source ID',()=>{
		const sources=[{id:'n',text:'The king spoke.',evidence:{n:'The king spoke.'}}],raw=draft(sources);raw.accounts[0].evidence[0].sourceId='other';expect(()=>proposeRecoveryEvidenceRepair(raw,sources)).toThrow('another source');
	});
	it('requires exact references and attribution while leaving semantic certainty for explicit human review',()=> {
		const sources=[{id:'n',text:'The envoy reports a rumor.',evidence:{n:'The envoy reports a rumor.'}}];
		const d=draft(sources);expect(validateRecoveryDraft(d,sources)).toEqual(d);
		delete (d.accounts[0].evidence[0] as any).speaker;
		expect(()=>validateRecoveryDraft(d,sources)).toThrow('attribution');
	});
});
integration('explicit retained-stage checkpoint review',()=>{
	it.each(['success','stale-review','unreviewed','partial'])('preserves paid receipts and runner hold during %s review',async mode=>{
		const {sid,m}=await fixture(),original=draft(m.sources),corrected=structuredClone(original),raw=JSON.stringify(original),receipt={status:'success',statusCode:200,finishReason:'stop',requestHash:'fixture-hash',model:m.route.model,usage:{inputTokens:1000,outputTokens:500,providerCostUsd:0},billingRequestId:'billing-fixture',completionId:'completion-fixture'};
		corrected.narrative+=' This local clarification was explicitly reviewed against the supplied source records.';
		const document={manifest:m,attempts:[{stage:'sources-1',status:'blocked',reservedInput:1000,reservedOutput:12000,reservedUsd:0.004,requestHash:'fixture-hash',raw,receipt}]};
		if(mode==='partial'){document.attempts[0].raw=JSON.stringify({...original,accounts:original.accounts.slice(0,-1)});}
		await db`insert into summary_recovery_runs(id,story_id,document) values(${m.id},${sid},${db.json(document)})`;
		const held={enabled:false,phase:'held',allocations:[{manifestId:m.id,usd:0.033}],reservations:[{manifestId:m.id,stage:'sources-1',requestHash:'fixture-hash'}]};
		await db`insert into chapter_summary_runners(story_id,document) values(${sid},${db.json(held)})`;
		const approval={documentHash:recoveryHash(document),rawSha256:createHash('sha256').update(document.attempts[0].raw).digest('hex'),receiptHash:recoveryHash(receipt),sourceHash:recoveryHash(m.sources),draftHash:recoveryHash(corrected),approvedBy:'Fixture reviewer',approvedAt:new Date().toISOString(),checks:{claimsSupported:true as const,attributionChecked:true as const,uncertaintyChecked:true as const,chronologyChecked:true as const}};
		if(mode==='stale-review')approval.documentHash='stale';if(mode==='unreviewed')approval.approvedBy='';
		const before=await protectedHash(sid);
		if(mode==='success'){
			const result=await reviewRetainedRecoveryStage(db,m,'sources-1',corrected,approval);expect(result.providerCalls).toBe(0);expect(result.runnerResumed).toBe(false);
			const [saved]=await db`select document from summary_recovery_runs where id=${m.id}`;expect(saved.document.attempts[0].raw).toBe(raw);expect(saved.document.attempts[0].receipt).toEqual(receipt);expect(saved.document.attempts[0].status).toBe('complete');expect(saved.document.attempts[0].checkpointReview.previousStatus).toBe('blocked');
		}else await expect(reviewRetainedRecoveryStage(db,m,'sources-1',corrected,approval)).rejects.toThrow();
		expect((await db`select document from chapter_summary_runners where story_id=${sid}`)[0].document).toEqual(held);expect(await protectedHash(sid)).toBe(before);expect((await db`select id from chapters where story_id=${sid}`)).toHaveLength(0);
	});
});
integration('retained response with offline completion',()=>{
	it.each(['success','changed-first-half','stale-review','unreviewed','runner-enabled','partial'])('preserves attempts, charges and held state during %s completion',async mode=>{
		const {sid,m}=await fixture(true),first=draft(m.sources.slice(0,10)),raw=JSON.stringify(first),receipt={status:'success',statusCode:200,finishReason:'stop',requestHash:'offline-fixture',model:m.route.model,usage:{inputTokens:1000,outputTokens:500,providerCostUsd:0}};
		const document={manifest:m,attempts:[{stage:'sources-1',status:'complete',reservedInput:1000,reservedOutput:12000,reservedUsd:0.004,requestHash:'offline-fixture',raw,receipt,draft:first,checkpointReview:{draftHash:recoveryHash(first),rawSha256:createHash('sha256').update(raw).digest('hex'),receiptHash:recoveryHash(receipt)}}]};
		await db`insert into summary_recovery_runs(id,story_id,document) values(${m.id},${sid},${db.json(document)})`;
		const held={enabled:mode==='runner-enabled',phase:'held',allocations:[{manifestId:m.id,usd:0.033}],reservations:[{manifestId:m.id,stage:'sources-1',requestHash:'offline-fixture'}]};
		await db`insert into chapter_summary_runners(story_id,document) values(${sid},${db.json(held)})`;
		const full={...first,accounts:[...first.accounts,...draft(m.sources.slice(10)).accounts]};if(mode==='changed-first-half')full.accounts[0].summary+=' Unreviewed change.';if(mode==='partial')full.accounts.pop();
		const approval={documentHash:mode==='stale-review'?'stale':recoveryHash(document),sourceHash:recoveryHash(m.sources),draftHash:recoveryHash(full),approvedBy:mode==='unreviewed'?'':'Fixture reviewer',approvedAt:new Date().toISOString(),checks:{claimsSupported:true as const,attributionChecked:true as const,uncertaintyChecked:true as const,chronologyChecked:true as const}};
		const before=await protectedHash(sid);
		if(mode==='success'){
			const result=await reviewRetainedRecoveryCompletion(db,m,full,approval);expect(result.providerCalls).toBe(0);expect(result.runnerResumed).toBe(false);
			await reviewRetainedRecoveryCompletion(db,m,full,approval);
			const [saved]=await db`select document from summary_recovery_runs where id=${m.id}`;expect(saved.document.attempts).toEqual(document.attempts);expect(saved.document.draftOrigin.kind).toBe('external');expect(saved.document.completionReview.kind).toBe('retained-first-stage-with-offline-completion');
			const dispatch=vi.fn();await expect(generateRecoveryDraft(db,m,{manifestId:m.id,routeHash:recoveryHash(m.route),limitsHash:recoveryHash(m.limits)},profile,dispatch)).rejects.toThrow('External draft');expect(dispatch).not.toHaveBeenCalled();
		}else await expect(reviewRetainedRecoveryCompletion(db,m,full,approval)).rejects.toThrow();
		expect((await db`select document from chapter_summary_runners where story_id=${sid}`)[0].document).toEqual(held);expect(await protectedHash(sid)).toBe(before);expect((await db`select id from chapters where story_id=${sid}`)).toHaveLength(0);
	});
});
