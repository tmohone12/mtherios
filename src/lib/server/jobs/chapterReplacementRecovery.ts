/** Local operator recovery for one held chapter-only attempt. Never exposed as a
 * browser action or worker job; no provider request is sent here. */
import type {Sql} from 'postgres';
import {chapterRunnerAllowed,getChapterRunnerStatus,lockedChapterRunnerState,saveChapterRunnerState,type ChapterRunnerGate} from './chapterSummaryRunner';
import {planSummaryRecovery,readRecoveryRun,readReplacementPrior,recoveryHash,type RecoveryManifest} from './summaryRecovery';
import {HELD_CHAPTER_REPLACEMENT_AGGREGATE,HELD_CHAPTER_REPLACEMENT_ALLOCATION,HELD_CHAPTER_REPLACEMENT_LIMITS,type HeldChapterReplacementLimits} from './summaryRecoveryIncidents';

export type ChapterReplacementApproval={priorManifestId:string;priorDocumentHash:string;approvedBy:string;approvedAt:string;number:number;start:number;end:number}&HeldChapterReplacementLimits;

export async function authorizeChapterReplacement(db:Sql,sid:string,gate:ChapterRunnerGate,a:ChapterReplacementApproval,now=new Date()) {
 if(!chapterRunnerAllowed(sid,gate)||!a.approvedBy.trim()||!Number.isFinite(Date.parse(a.approvedAt))||Date.parse(a.approvedAt)>now.getTime()
  ||recoveryHash({calls:a.calls,inputTokens:a.inputTokens,outputTokens:a.outputTokens,usd:a.usd})!==recoveryHash(HELD_CHAPTER_REPLACEMENT_LIMITS))throw Error('Exact one-time replacement approval required');
 await lockedChapterRunnerState(db,sid,async(tx,d)=>{
  if(!d?.active||d.phase!=='held'||d.enabled||d.active.manifest.replacement||d.active.manifest.id!==a.priorManifestId)throw Error('Held original attempt required; replacement cannot repeat');
  if(Date.parse(d.approval.expiresAt)<=now.getTime()||d.approval.totalUsd!==HELD_CHAPTER_REPLACEMENT_AGGREGATE.totalUsd||d.approval.maxChapters!==HELD_CHAPTER_REPLACEMENT_AGGREGATE.maxChapters
   ||d.approval.minIntervalMinutes!==HELD_CHAPTER_REPLACEMENT_AGGREGATE.minIntervalMinutes)throw Error('Existing aggregate approval differs or expired');
  const prior=await readRecoveryRun(tx,d.active.manifest);if(!prior||recoveryHash(prior)!==a.priorDocumentHash)throw Error('Prior uncertain document differs');
  const fresh=await planSummaryRecovery(tx,sid,'chapter');
  if(fresh.number!==a.number||fresh.startPosition!==a.start||fresh.endPosition!==a.end)throw Error('Replacement source range differs');
  const {id:_,...body}=fresh;body.replacement={priorManifestId:a.priorManifestId,priorDocumentHash:a.priorDocumentHash,approvedBy:a.approvedBy,approvedAt:a.approvedAt,limits:{calls:a.calls,inputTokens:a.inputTokens,outputTokens:a.outputTokens,usd:a.usd}};
  const m:RecoveryManifest={id:`summary_recovery_${recoveryHash(body)}`,...body};await readReplacementPrior(tx,m);
  const old=d.allocations.find(r=>r.manifestId===a.priorManifestId&&!r.incrementOf);
  if(!old||old.usd!==HELD_CHAPTER_REPLACEMENT_ALLOCATION.originalUsd||d.allocations.some(r=>r.incrementOf===a.priorManifestId)||d.reservations.filter(r=>r.manifestId===a.priorManifestId).length!==1
   ||d.reservations.length+3>30||d.allocations.reduce((n,r)=>n+r.usd,0)+HELD_CHAPTER_REPLACEMENT_ALLOCATION.incrementUsd>d.approval.totalUsd)throw Error('Budget replacement reservation cannot fit');
  d.allocations.push({manifestId:m.id,usd:HELD_CHAPTER_REPLACEMENT_ALLOCATION.incrementUsd,incrementOf:a.priorManifestId});
  d.active={manifest:m,owner:'explicit-replacement-not-yet-dispatched',leaseUntil:new Date(0).toISOString()};
  d.enabled=true;d.phase='generating';d.message='Approved one-time replacement; original uncertain execution and allocation remain counted.';await saveChapterRunnerState(tx,sid,d);
 });
 return getChapterRunnerStatus(db,sid,gate);
}
