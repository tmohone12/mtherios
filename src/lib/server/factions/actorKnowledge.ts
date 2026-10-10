import {and,desc,eq,inArray,sql} from 'drizzle-orm';
import {getDb} from '$lib/server/db/client';
import {npcBeliefs,npcEventLinks,storyEvents} from '$lib/server/db/schema';
import {objectiveWords} from './decisionContext';
/** Bounded actor-first reads: rival recency cannot evict an older personally known objective or promise. */
export async function loadFactionKnowledge(storyId:string,actorIds:string[],goals:Record<string,unknown>[],projects:unknown) {
 if(!actorIds.length)return {beliefs:[],links:[],events:[]};
 const words=objectiveWords(goals,projects), pattern=words.length?words.join('|'):'(?!)';
 const ids=sql`array[${sql.join(actorIds.map(id=>sql`${id}`),sql`, `)}]::text[]`;
 const claims=sql`jsonb_array_elements(case when jsonb_typeof(${storyEvents.metadata}->'actorClaims')='array' then ${storyEvents.metadata}->'actorClaims' else '[]'::jsonb end)`;
 const known=sql`c->>'kind' in ('learned','witnessed','shared') and c->'knownBy' ?| ${ids}`;
 const scopedText=sql`(select string_agg(c->>'text',' ') from ${claims} c where ${known})`;
 const knownSource=sql`(${storyEvents.metadata}->>'negotiationId' is not null or exists(select 1 from ${npcEventLinks} l where l.story_id=${storyId} and l.event_id=${storyEvents.id} and l.npc_entity_id=any(${ids}) and l.role in ('actor','witness','knower','witnessed','learned','shared')))`;
 const commitmentId=sql`${storyEvents.metadata}->'currentAgreement'->>'id'`;
 const latestCommitments=getDb().selectDistinctOn([commitmentId]).from(storyEvents).where(and(eq(storyEvents.storyId,storyId),eq(storyEvents.status,'committed'),knownSource,sql`${commitmentId} is not null`,sql`exists(select 1 from ${claims} c where ${known})`))
  .orderBy(commitmentId,desc(storyEvents.createdTurn),desc(storyEvents.createdAt),desc(storyEvents.serverVersion),storyEvents.id).as('known_commitments');
 const [beliefs,relevantEvents,commitmentEvents]=await Promise.all([
  getDb().select().from(npcBeliefs).where(and(eq(npcBeliefs.storyId,storyId),inArray(npcBeliefs.believerEntityId,actorIds)))
   .orderBy(sql`case when ${npcBeliefs.belief} ~* ${pattern} then 0 else 1 end`,desc(npcBeliefs.updatedAt),npcBeliefs.id).limit(64),
  getDb().select().from(storyEvents).where(and(eq(storyEvents.storyId,storyId),eq(storyEvents.status,'committed'),knownSource,sql`exists(select 1 from ${claims} c where ${known})`,
   // An older active snapshot must not resurrect a known fulfilled promise when the bounded commitment page is full.
   sql`(${commitmentId} is null or ${storyEvents.id} in (${getDb().select({id:latestCommitments.id}).from(latestCommitments)}))`))
   .orderBy(sql`case when ${scopedText} ~* ${pattern} then 0 when ${storyEvents.metadata} ? 'currentAgreement' then 1 else 2 end`,desc(storyEvents.createdTurn),desc(storyEvents.createdAt),storyEvents.id).limit(64),
  getDb().select().from(latestCommitments)
   .orderBy(sql`case when ${latestCommitments.metadata}->'currentAgreement'->>'status' in ('active','pending','conditional') then 0 else 1 end`,desc(latestCommitments.createdTurn),desc(latestCommitments.createdAt),latestCommitments.id).limit(16),
 ]);
 const events=[...new Map([...relevantEvents,...commitmentEvents].map(e=>[e.id,e])).values()];
 const links=events.length?await getDb().select().from(npcEventLinks).where(and(eq(npcEventLinks.storyId,storyId),inArray(npcEventLinks.npcEntityId,actorIds),inArray(npcEventLinks.eventId,events.map(e=>e.id)),inArray(npcEventLinks.role,['actor','witness','knower','witnessed','learned','shared']))):[];
 return {beliefs,links,events};
}
