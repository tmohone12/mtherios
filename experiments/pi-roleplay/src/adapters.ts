import {worldStateUpdateSchema} from '$lib/services/ai/tools/schemas';
import {resolveLocationLore,renderLocationLore} from '$lib/server/memory/locationLore';
import {parseTurnMemoryEnvelope,mergeTurnMemoryUpdates} from '$lib/server/turn/turnMemoryEnvelope';
import {parseTurnUpdate} from '$lib/server/turn/patchValidator';
import {buildServerTurnPrompt} from '$lib/server/turn/promptPacket';
import type {TurnContext} from '$lib/server/turn/context';
import type {RetrievedMemoryPacket} from '$lib/contracts/memory';
import type {Attempt,actorPacket} from '$lib/server/factions/intentions';
import {assistantMessage} from './runtime';
import {syntheticModel} from './scriptedStream';
import type {Adapters,Proposal,Snapshot} from './runtime';

/** Pure adapters over a prepared canonical snapshot. Real canonical apply is intentionally not provided. */
export function mythPrototypeAdapters(input:{ctx:TurnContext;actorId:string;playerId:string;packet:()=>ReturnType<typeof actorPacket>;attempt:Attempt;playerAction:string}){
 const {ctx,actorId,playerId,packet,attempt,playerAction}=input;
 const retrieved={storyId:ctx.story.id,query:playerAction,packet:'',nodes:[],tokenEstimate:0,retrievalDebug:[],retrievalTrace:[]} as RetrievedMemoryPacket;
 const gm=buildServerTurnPrompt(ctx,retrieved,'pi_prototype_synthetic',{playerAction,presentNpcIds:[actorId]});
 const snapshot:Snapshot={storyId:ctx.story.id,version:ctx.story.serverVersion,sceneId:ctx.story.currentLocationId??'',playerId,allowedActorIds:[actorId],system:gm.system+'\n'+gm.stableContext,dynamicTail:gm.dynamicPrompt,
  history:gm.messages.map(message=>message.role==='assistant'?assistantMessage(syntheticModel,[{type:'text',text:message.content}]):{role:'user',content:message.content,timestamp:Date.now()})};
 const parseProposal=(proposal:Proposal)=>{
  const update=worldStateUpdateSchema.strict().parse(JSON.parse(proposal.updateJson));
  // This architectural spike demonstrates sourced conversation drafts only. Broader writes remain at canonical owners.
  for(const [key,value] of Object.entries(update))if(key!=='conversations'&&value!=null&&(!Array.isArray(value)||value.length))throw Error('Prototype supports conversation drafts only.');
  if(update.conversations.length!==1||update.conversations[0].npcName!==ctx.entities.find(row=>row.id===actorId)?.name||update.conversations[0].npcLearned.length||update.conversations[0].playerRevealed.length)throw Error('Unsupported actor/knowledge draft.');
  return update;
 };
 const adapters:Adapters={
  lore:async query=>{
   const lore=ctx.locationLore??resolveLocationLore({storyId:ctx.story.id,locationId:ctx.story.currentLocationId,atTurn:ctx.story.currentTurn,places:ctx.entities,relationships:[],facts:ctx.facts});
   const rendered=renderLocationLore(lore,query,500);
   return {data:{scope:'GM scene lore; this does not grant NPC knowledge',text:rendered.text,incomplete:rendered.incomplete},sourceIds:rendered.records.map(record=>record.id)};
  },
  npcKnowledge:async id=>{if(id!==actorId)throw Error('Actor denied.');const projected=packet();return {data:{scope:{actorId:id},packet:projected},sourceIds:projected.sourceIds};},
  decisionResult:async id=>{
   if(id!==actorId||!attempt.actorEntityIds.includes(id))throw Error('Decision scope denied.');
   return {data:{status:attempt.status,intention:attempt.intention,decision:attempt.decision,outcomeEstablished:false},sourceIds:attempt.decision?.sourceIds??attempt.intention?.basis??[]};
  },
  validateProposal:async proposal=>{parseProposal(proposal);return {status:'staged',canonical:false};},
  validateNarratedProposals:async(narration,proposals)=>{
   if(!proposals.length)return [];
   const changes=proposals.map(proposal=>({kind:proposal.kind,quote:proposal.quote,visibility:'player_known' as const,update:parseProposal(proposal)}));
   const parsed=parseTurnMemoryEnvelope(narration+'\n<turn_memory_update>'+JSON.stringify({version:1,changes})+'</turn_memory_update>');
   if(!parsed.envelope||parsed.error)throw Error('Unquoted world draft.');
   const checked=parseTurnUpdate({update:mergeTurnMemoryUpdates(parsed.envelope)});
   if(checked.warnings.length)throw Error('Invalid canonical contract draft.');
   return proposals.map((proposal,index)=>({status:'validated_draft',canonical:false,basisIds:proposal.basisIds,quote:proposal.quote,update:parsed.envelope!.changes[index].update}));
  },
 };
 return {snapshot,adapters,gm};
}
