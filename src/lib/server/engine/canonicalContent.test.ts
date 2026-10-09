import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalCreateSchema, canonicalCopySchema, canonicalEditSchema } from '$lib/contracts/canonicalContent';
import { canonicalCopyFields, copyCanonicalFolder, createCanonicalWorkspace, copyCanonicalWorkspace, editCanonicalWorkspace, readCanonicalWorkspace } from './canonicalContent';
const mocks=vi.hoisted(()=>({getDb:vi.fn()}));
vi.mock('$lib/server/db/client',()=>({getDb:mocks.getDb}));
beforeEach(()=>vi.clearAllMocks());
describe('canonical content boundary',()=>{
  it('requires a composite revision and rejects caller authority or arbitrary adapters',()=>{
    const base={projectId:'p',gameId:'g',kind:'characters',id:'c',expected:{metadataRevision:2,recordVersion:4,adapterVersion:1},updates:{name:'New'}};
    expect(canonicalEditSchema.safeParse(base).success).toBe(true);
    expect(canonicalEditSchema.safeParse({...base,role:'human'}).success).toBe(false);
    expect(canonicalEditSchema.safeParse({...base,kind:'stories'}).success).toBe(false);
    expect(canonicalEditSchema.safeParse({...base,expected:{recordVersion:4}}).success).toBe(false);
  });
  it('rejects a mismatched project before reading canonical payloads',async()=>{
    const tx={execute:vi.fn().mockResolvedValue([])};mocks.getDb.mockReturnValue({transaction:(fn:(t:typeof tx)=>unknown)=>fn(tx)});
    await expect(readCanonicalWorkspace({projectId:'foreign',gameId:'g',kind:'characters',id:'c'})).rejects.toMatchObject({code:'SCOPE_DENIED'});
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });
  it('rejects stale metadata even when the canonical record version matches',async()=>{
    const tx={execute:vi.fn().mockResolvedValueOnce([{id:'p'}]).mockResolvedValueOnce([{id:'g'}]).mockResolvedValueOnce([{id:'c',server_version:4}]).mockResolvedValueOnce([{id:'e',revision:3,adapter_version:1,source_deleted:false}])};
    mocks.getDb.mockReturnValue({transaction:(fn:(t:typeof tx)=>unknown)=>fn(tx)});
    await expect(editCanonicalWorkspace({projectId:'p',gameId:'g',kind:'characters',id:'c',expected:{metadataRevision:2,recordVersion:4,adapterVersion:1},metadata:{folder:'Cast'}})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
    expect(tx.execute).toHaveBeenCalledTimes(4);
  });
  it('reads the canonical payload and metadata in one repeatable-read snapshot',async()=>{
    const tx={execute:vi.fn().mockResolvedValueOnce([{id:'g'}]).mockResolvedValueOnce([{id:'c',server_version:4,name:'Mira'}]).mockResolvedValueOnce([{id:'e',revision:3,adapter_version:1}])};
    const transaction=vi.fn((fn:(t:typeof tx)=>unknown)=>fn(tx));mocks.getDb.mockReturnValue({transaction});
    const result=await readCanonicalWorkspace({projectId:'p',gameId:'g',kind:'characters',id:'c'});
    expect(result).toMatchObject({record:{name:'Mira'},revision:{metadataRevision:3,recordVersion:4,adapterVersion:1}});
    expect(transaction).toHaveBeenCalledWith(expect.any(Function),{isolationLevel:'repeatable read',accessMode:'read only'});
  });
});

describe('explicit canonical authoring',()=>{
  it.each(['deleted','player','stale'])('rejects a %s folder copy source without writing',async mode=>{
    const source=mode==='deleted'?[]:[{id:'c',server_version:1,name:'Mira',state:mode==='player'?{isProtagonist:true}:{}}];
    const tx={execute:vi.fn().mockResolvedValueOnce(source).mockResolvedValueOnce([{id:'e',slug:'mira',revision:mode==='stale'?2:1,adapter_version:1,source_deleted:mode==='deleted'}])};
    await expect(copyCanonicalFolder(tx as unknown as Parameters<typeof copyCanonicalFolder>[0],{projectId:'p',gameId:'g',kind:'characters',id:'c'},1,'Copy',true)).rejects.toMatchObject({code:mode==='stale'?'REVISION_CONFLICT':'INVALID_CONTENT'});
    expect(tx.execute).toHaveBeenCalledTimes(2);
  });
  it('keeps new identity and copy destination server controlled',()=>{
    const base={projectId:'p',gameId:'g',kind:'characters',fields:{name:'Mira'}};
    expect(canonicalCreateSchema.safeParse(base).success).toBe(true);
    expect(canonicalCreateSchema.safeParse({...base,id:'existing'}).success).toBe(false);
    expect(canonicalCreateSchema.safeParse({...base,role:'human'}).success).toBe(false);
    const copy={projectId:'p',gameId:'g',kind:'characters',id:'c',expected:{metadataRevision:1,recordVersion:1,adapterVersion:1},name:'Mira copy',metadata:{folder:'Cast',slug:'mira-copy'}};
    expect(canonicalCopySchema.safeParse(copy).success).toBe(true);
    expect(canonicalCopySchema.safeParse({...copy,targetGameId:'other'}).success).toBe(false);
    expect(canonicalCopySchema.safeParse({...copy,expected:undefined}).success).toBe(false);
  });
  it('preserves authored fields without copying source identity or evidence authority',()=>{
    const record={id:'c',story_id:'g',server_version:4,name:'Mira',state:{bio:'Biography',stats:{hp:9,ac:16}},metadata:{entityResolver:{entityId:'c'},originalMetadata:{bio:'Legacy biography',originalId:'old'},custom:'Keep'},source_entry_ids:['old-evidence']};
    const fields=canonicalCopyFields('characters',record,'New Mira');
    expect(fields).toEqual({name:'New Mira',state:record.state,metadata:{originalMetadata:{bio:'Legacy biography'},custom:'Keep'}});
    (fields.state as {stats:{hp:number}}).stats.hp=1;
    expect(record.state.stats.hp).toBe(9);
    expect(record.metadata.entityResolver.entityId).toBe('c');
  });
  it.each([{state:{relationship:'self'}},{state:{isProtagonist:true}},{metadata:{originalMetadata:{playerCharacter:true}}}])('rejects player identity copies %#',record=>{
    expect(()=>canonicalCopyFields('characters',record,'Copy')).toThrow('Player characters cannot be copied');
  });
  it('does not reuse a faction backing entity identity',()=>{
    expect(canonicalCopyFields('factions',{entity_id:'identity',name:'Guild',metadata:{},member_entity_ids:['member'],goals:['Trade']},'New guild')).toEqual({name:'New guild',metadata:{},memberEntityIds:['member'],goals:['Trade']});
  });
  it('rejects creation in a foreign project before any write',async()=>{
    const tx={execute:vi.fn().mockResolvedValue([])};mocks.getDb.mockReturnValue({transaction:(fn:(t:typeof tx)=>unknown)=>fn(tx)});
    await expect(createCanonicalWorkspace({projectId:'foreign',gameId:'g',kind:'items',fields:{name:'Sword'}})).rejects.toMatchObject({code:'SCOPE_DENIED'});
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });
  it('rejects stale copy sources before allocating a new row',async()=>{
    const tx={execute:vi.fn().mockResolvedValueOnce([{id:'p'}]).mockResolvedValueOnce([{id:'g'}]).mockResolvedValueOnce([{id:'c',server_version:4}]).mockResolvedValueOnce([{id:'e',revision:3,adapter_version:1,source_deleted:false}])};
    mocks.getDb.mockReturnValue({transaction:(fn:(t:typeof tx)=>unknown)=>fn(tx)});
    await expect(copyCanonicalWorkspace({projectId:'p',gameId:'g',kind:'characters',id:'c',expected:{metadataRevision:2,recordVersion:4,adapterVersion:1},name:'New',metadata:{folder:'',slug:'new'}})).rejects.toMatchObject({code:'REVISION_CONFLICT'});
    expect(tx.execute).toHaveBeenCalledTimes(4);
  });
});
