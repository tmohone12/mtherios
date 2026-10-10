import {pathToFileURL} from 'node:url';
import {runRecoveryOperator} from './summaryRecoveryOperator';
export {authorizeChapterReplacement,reconcileCommittedChapterRunner} from './chapterSummaryRunner';
export {sourceEvidenceCatalog,materializeReferenceSelection,referenceSelectionPrompt,EVIDENCE_REFERENCE_PROTOCOL} from './summaryEvidenceReferences';
export {recoveryHash,proposeRecoveryEvidenceRepair,reviewRetainedRecoveryStage,reviewRetainedRecoveryCompletion,validateRecoveryDraft,planSummaryRecovery,previewRecoveryCalls,reviewRecoveryDraft,commitRecoveryDraft} from './summaryRecovery';
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
	try {console.log(JSON.stringify(await runRecoveryOperator(process.argv.slice(2))));}
	catch {console.error(JSON.stringify({ok:false,error:'Operator stopped. Inspect the output receipt; no automatic retry or append.'}));process.exitCode=1;}
}
