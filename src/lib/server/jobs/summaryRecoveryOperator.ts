/** Explicit local operator only. No listener, worker registration, queue dispatch,
 * credential discovery, or automatic migration/generation/append.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { z } from 'zod';
import { resolveRuntimeOptions } from '../../../../scripts/runtime-config.mjs';
import { generateServerTextWithMetrics } from '$lib/server/turn/provider';
import { commitRecoveryDraft, generateRecoveryDraft, importRecoveryDraft, validateRecoveryDraft, planSummaryRecovery, previewRecoveryCalls, readRecoveryRun,
	RECOVERY_LIMITS, RECOVERY_ROUTE, recordRecoveryOperatorApproval, recoveryHash, reviewRecoveryDraft,
	rollbackRecoveryCommit, validateRecoveryManifest, type RecoveryManifest } from './summaryRecovery';
declare const __SUMMARY_RECOVERY_SQL__: string;
export const RECOVERY_LEDGER_SQL = __SUMMARY_RECOVERY_SQL__;
export const RECOVERY_SCHEMA_SHA256 = createHash('sha256').update(RECOVERY_LEDGER_SQL).digest('hex');
const operations = ['install-ledger','generate','import-draft','review','append','rollback'] as const;
type Operation = typeof operations[number];
const approvalSchema = z.object({ operation:z.enum(operations),database:z.string().min(1),manifestId:z.string(),
	storyId:z.string().min(1),kind:z.enum(['chapter','arc']),number:z.number().int().positive(),start:z.number().int().nonnegative(),end:z.number().int().nonnegative(),
	routeHash:z.string(),limitsHash:z.string(),approvedBy:z.string().trim().min(1),approvedAt:z.string().datetime({offset:true}),
	acknowledgement:z.literal('I authorize only this operation and scope.'),schemaSha256:z.string().optional(),draftHash:z.string().optional(),
	checks:z.object({quotesChecked:z.literal(true),uncertaintyChecked:z.literal(true),chronologyChecked:z.literal(true)}).strict().optional() }).strict();
export type OperatorApproval = z.infer<typeof approvalSchema>;
export function recoveryApprovalTemplate(m:RecoveryManifest,database:string,operation:Operation,draftHash?:string) {
	validateRecoveryManifest(m);
	return {operation,database,manifestId:m.id,storyId:m.storyId,kind:m.kind,number:m.number,start:m.startPosition,end:m.endPosition,
		routeHash:recoveryHash(m.route),limitsHash:recoveryHash(m.limits),
		...(operation==='install-ledger'?{schemaSha256:RECOVERY_SCHEMA_SHA256}:{}),...(draftHash?{draftHash}:{}),
		approvedBy:'',approvedAt:'',acknowledgement:'I authorize only this operation and scope.',
		...(operation==='review'?{checks:{quotesChecked:false,uncertaintyChecked:false,chronologyChecked:false}}:{})};
}
type Dependencies = { loadConfig?:(file:string)=>{databaseUrl:string};openDatabase?:(url:string)=>Sql;
	readEnvironment?:(name:string)=>string|undefined;generate?:typeof generateServerTextWithMetrics };
export type RecoveryOperatorResult = {ok:true;help?:string;operation?:string;manifestId?:string;out?:string;draftHash?:string;appendPerformed?:boolean};
const HELP = 'node tools/summary-recovery.mjs <preview|inspect|validate-draft|install-ledger|generate|import-draft|review|append|rollback> --config FILE --out FILE; preview also requires --story ID --kind chapter|arc --start N --end N; optional --snapshot-end N --canon-ids ID,ID enables explicit larger external-only backfill (both required, provider calls forbidden). Other operations require --manifest FILE; writes require --approval FILE; generate requires --key-env NAME; import-draft and read-only validate-draft require --draft FILE containing {manifestId,draft}, no credentials. One operation per invocation. No implicit writes or retries.';
function readJson(file:string) {
	if(fs.statSync(file).size>16*1024*1024)throw Error('Input too large');
	return JSON.parse(fs.readFileSync(file,'utf8'));
}
function options(argv:string[]) {
	if(!argv.length||argv[0]==='--help'||argv[0]==='help')return {command:'help',flags:{} as Record<string,string>};
	const [command,...rest]=argv;const flags:Record<string,string>={};
	if(!['preview','inspect','validate-draft',...operations].includes(command))throw Error('Unknown operator command');
	for(let i=0;i<rest.length;i+=2) {
		const flag=rest[i],value=rest[i+1];
		if(!/^--[a-z-]+$/.test(flag)||!value||value.startsWith('--')||flag in flags)throw Error('Invalid or repeated flag');
		flags[flag]=value;
	}
	const allowed=command==='preview'?['--config','--out','--story','--kind','--start','--end']:
		['--config','--out','--manifest',...(['inspect','validate-draft'].includes(command)?[]:['--approval']),...(command==='generate'?['--key-env']:[]),...(['import-draft','validate-draft'].includes(command)?['--draft']:[])];
	const optional=command==='preview'?['--snapshot-end','--canon-ids']:[];
	if(Object.keys(flags).some(k=>![...allowed,...optional].includes(k))||allowed.some(k=>!flags[k]))throw Error('Missing or unsupported operator flag');
	if(command==='preview'&&(flags['--snapshot-end']||flags['--canon-ids'])&&(!flags['--snapshot-end']||!flags['--canon-ids']))throw Error('Explicit snapshot and identity IDs required together');
	return {command,flags};
}
function databaseTarget(url:string) {
	const u=new URL(url),name=decodeURIComponent(u.pathname.slice(1));
	if(!['postgres:','postgresql:'].includes(u.protocol)||u.hostname!=='127.0.0.1'||u.port!=='5433'||u.search||u.hash
		||(name!=='mythengine'&&!/^mythengine_summary_repair_recovery_\d+(?:_operator)?$/.test(name)))throw Error('Approved local database target required');
	return {host:u.hostname,port:5433,database:name};
}
function validateApproval(raw:unknown,m:RecoveryManifest,database:string,operation:Operation) {
	const a=approvalSchema.parse(raw);
	if(a.operation!==operation||a.database!==database||a.manifestId!==m.id||a.storyId!==m.storyId||a.kind!==m.kind||a.number!==m.number
		||a.start!==m.startPosition||a.end!==m.endPosition||a.routeHash!==recoveryHash(m.route)||a.limitsHash!==recoveryHash(m.limits))throw Error('Approval differs from exact operation and scope');
	if(operation==='install-ledger'&&a.schemaSha256!==RECOVERY_SCHEMA_SHA256)throw Error('Schema approval differs');
	if(['import-draft','review','append','rollback'].includes(operation)&&!a.draftHash)throw Error('Exact draft approval required');
	if(operation==='review'&&!a.checks)throw Error('Review checks required');
	return a;
}
async function installLedger(db:Sql) {
	return db.begin(async tx=> {
		await tx.unsafe("select pg_advisory_xact_lock(hashtextextended('summary-recovery-schema-v1',0))");
		const [existing]=await tx.unsafe("select to_regclass('public.summary_recovery_runs') as name");
		if(!existing.name)await tx.unsafe(RECOVERY_LEDGER_SQL);
		const cols=await tx.unsafe("select column_name,data_type,is_nullable from information_schema.columns where table_schema='public' and table_name='summary_recovery_runs' order by ordinal_position");
		const expected=[['id','text','NO'],['story_id','text','NO'],['document','jsonb','NO'],['created_at','timestamp with time zone','NO'],['updated_at','timestamp with time zone','NO']];
		if(recoveryHash(cols.map(c=>[c.column_name,c.data_type,c.is_nullable]))!==recoveryHash(expected))throw Error('Existing ledger schema differs');
		const constraints=await tx.unsafe("select contype,pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='public.summary_recovery_runs'::regclass");
		if(!constraints.some(c=>c.contype==='p'&&c.definition==='PRIMARY KEY (id)')
			||!constraints.some(c=>c.contype==='f'&&c.definition==='FOREIGN KEY (story_id) REFERENCES stories(id) ON DELETE CASCADE'))throw Error('Ledger constraints differ');
		await tx.unsafe("insert into _mtherios_migrations(name) values('0052_summary_recovery.sql') on conflict(name) do nothing");
		return {created:!existing.name,schemaSha256:RECOVERY_SCHEMA_SHA256};
	});
}
/** This is the production CLI path; tests replace transport/config inputs only.
 * Approval files are trusted local human instructions, not remote authorization.
 */
export async function runRecoveryOperator(argv:string[],dependencies:Dependencies={}):Promise<RecoveryOperatorResult> {
	const {command,flags}=options(argv);if(command==='help')return {ok:true,help:HELP};
	const config=(dependencies.loadConfig??(file=>resolveRuntimeOptions(['--config',path.resolve(file),'--allow-shared-runtime'])))(flags['--config']);
	const target=databaseTarget(config.databaseUrl);
	let manifest:RecoveryManifest|undefined,approval:OperatorApproval|undefined;
	if(command!=='preview') {
		const input=readJson(flags['--manifest']);
		manifest=(input.manifest??input) as RecoveryManifest;validateRecoveryManifest(manifest);
		if(!['inspect','validate-draft'].includes(command))approval=validateApproval(readJson(flags['--approval']),manifest,target.database,command as Operation);
	}
	if(command==='generate'&&!/^[A-Z][A-Z0-9_]{2,100}$/.test(flags['--key-env']))throw Error('Explicit credential reference required');
	if(command==='generate'&&manifest!.coverage)throw Error('Explicit backfill cannot call a provider');
	let externalDraft:unknown;
	if(['import-draft','validate-draft'].includes(command)) {
		const input=z.object({manifestId:z.literal(manifest!.id),draft:z.unknown()}).strict().parse(readJson(flags['--draft']));
		externalDraft=validateRecoveryDraft(input.draft,manifest!.sources);
		if(command==='import-draft'&&recoveryHash(externalDraft)!==approval!.draftHash)throw Error('Approved external draft differs');
	}
	const out=path.resolve(flags['--out']);fs.mkdirSync(path.dirname(out),{recursive:true});
	// Exclusive output reservation happens before credential access or provider dispatch.
	const fd=fs.openSync(out,'wx');let db:Sql|undefined;
	try {
		db=(dependencies.openDatabase??(url=>postgres(url,{max:2,prepare:false,onnotice:()=>{},connection:{application_name:'summary-recovery-operator',search_path:'public'}})))(config.databaseUrl);
		const [actual]=await db.unsafe('select current_database() as name');if(actual.name!==target.database)throw Error('Connected database differs');
		let result:unknown;
		if(command==='preview') {
			const kind=z.enum(['chapter','arc']).parse(flags['--kind']);
			const start=z.number().int().nonnegative().parse(Number(flags['--start'])),end=z.number().int().nonnegative().parse(Number(flags['--end']));
			const explicit=flags['--snapshot-end']?{snapshotEndPosition:z.number().int().nonnegative().parse(Number(flags['--snapshot-end'])),canonEntityIds:flags['--canon-ids'].split(',').filter(Boolean)}:undefined;
			manifest=await db.begin('isolation level repeatable read read only',tx=>planSummaryRecovery(tx as unknown as Sql,flags['--story'],kind,{start,end},explicit));
			result={manifest,preview:previewRecoveryCalls(manifest),target,schemaSha256:RECOVERY_SCHEMA_SHA256,
				approvalTemplates:{install:recoveryApprovalTemplate(manifest,target.database,'install-ledger'),generate:recoveryApprovalTemplate(manifest,target.database,'generate')}};
		} else if(command==='validate-draft') {
			const fresh=await db.begin('isolation level repeatable read read only',tx=>planSummaryRecovery(tx as unknown as Sql,manifest!.storyId,manifest!.kind,{start:manifest!.startPosition,end:manifest!.endPosition},manifest!.coverage&&{snapshotEndPosition:manifest!.coverage.snapshotEndPosition,canonEntityIds:manifest!.coverage.canonEntityIds}));
			if(fresh.id!==manifest!.id)throw Error('Stale source or summary coverage');
			result={target,manifestId:manifest!.id,draftHash:recoveryHash(externalDraft),sourceAccounts:manifest!.sources.length,sourceEntries:manifest!.sourceIds.length,
				readOnly:true,providerCalls:0,appendPerformed:false,humanReviewRequired:true,
				importApprovalTemplate:recoveryApprovalTemplate(manifest!,target.database,'import-draft',recoveryHash(externalDraft))};
		} else if(command==='inspect') {
			result=await db.begin('isolation level repeatable read read only',async tx=> {
				const [installed]=await tx.unsafe("select to_regclass('public.summary_recovery_runs') as name");
				return {target,manifestId:manifest!.id,installed:!!installed.name,run:installed.name?await readRecoveryRun(tx as unknown as Sql,manifest!):undefined};
			});
		} else {
			if(command==='install-ledger')result=await installLedger(db);
			else if(!(await db.unsafe("select to_regclass('public.summary_recovery_runs') as name"))[0].name)throw Error('Explicit approved ledger installation required');
			if(command!=='install-ledger'&&['review','append','rollback'].includes(command)) {
				const existing=await readRecoveryRun(db,manifest!);
				if(!existing?.draft||existing.draftHash!==approval!.draftHash||recoveryHash(existing.draft)!==approval!.draftHash)throw Error('Approved draft differs');
			}
			await recordRecoveryOperatorApproval(db,manifest!,approval!);
			if(command==='generate') {
				const key=(dependencies.readEnvironment??(name=>process.env[name]))(flags['--key-env']);
				if(!key?.trim())throw Error('Explicit credential reference unavailable; no discovery or setup');
				result=await generateRecoveryDraft(db,manifest!,{manifestId:manifest!.id,routeHash:approval!.routeHash,limitsHash:approval!.limitsHash},
					{providerType:RECOVERY_ROUTE.providerType,baseUrl:RECOVERY_ROUTE.baseUrl,apiKey:key,
						customModels:[],fetchedModels:[],reasoningModels:[],hiddenModels:[],favoriteModels:[]},dependencies.generate);
			} else if(command==='import-draft')result=await importRecoveryDraft(db,manifest!,externalDraft,approval!.draftHash!,approval!.approvedBy);
			else if(command==='review')result=await reviewRecoveryDraft(db,manifest!,approval!.draftHash!,approval!.approvedBy,approval!.checks!);
			else if(command==='append')result=await commitRecoveryDraft(db,manifest!,approval!.draftHash!);
			else if(command==='rollback')result=await rollbackRecoveryCommit(db,manifest!);
			result={result,run:await readRecoveryRun(db,manifest!),target,
				...(command==='append'||command==='rollback'?{clientRefresh:'After preserving open edits, open the story Chapters tab (Story then Chapters if already open). Projection reconciliation refreshes stored summaries without reset or reimport.',
					writes:command==='append'?[manifest!.kind==='chapter'?'chapters':'arcs','memory_nodes','summary_recovery_runs','story sync counter']:['owned projection row','owned memory row','summary_recovery_runs']}:{}),
				...(['generate','import-draft'].includes(command)?{appendPerformed:false,next:'Inspect and review actual draft; append requires a separate exact draft-hash approval.'}:{}),
				limits:RECOVERY_LIMITS,route:RECOVERY_ROUTE};
		}
		fs.writeFileSync(fd,JSON.stringify(result,null,2)+'\n');
		return {ok:true,operation:command,manifestId:manifest!.id,out,...(['generate','import-draft'].includes(command)?{draftHash:(result as any).run?.draftHash,appendPerformed:false}:{})};
	} catch(error) {
		// Never echo credential objects, provider response errors, or configuration URLs.
		fs.writeFileSync(fd,JSON.stringify({ok:false,operation:command,manifestId:manifest?.id,error:'Operation stopped. Inspect durable receipts; no automatic retry.'})+'\n');
		throw error;
	} finally {fs.closeSync(fd);if(db&&!dependencies.openDatabase)await db.end({timeout:1});}
}
