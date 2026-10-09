import { beforeEach,describe,expect,it,vi } from 'vitest';
import { canonicalLayoutValue,canonicalTypeSaveSchema,defaultCanonicalType,validateCanonicalType } from '$lib/contracts/canonicalTypes';
import { readCanonicalType,saveCanonicalType } from './canonicalTypes';
const mocks=vi.hoisted(()=>({getDb:vi.fn()}));
vi.mock('$lib/server/db/client',()=>({getDb:mocks.getDb}));
beforeEach(()=>vi.clearAllMocks());
describe('built-in type settings',()=>{
  it('validates finite roots, safe paths, duplicate fields and bounded layouts',()=>{
    const definition={gmContextMode:'partial',layout:[{title:'Stats',fields:[{path:'state.stats.hp',label:'HP'}]}]};
    expect(validateCanonicalType('characters',definition)).toEqual(definition);
    for(const path of ['story_id','state.__proto__.secret','metadata.constructor','name.value','state..hp'])expect(()=>validateCanonicalType('characters',{...definition,layout:[{title:'Bad',fields:[{path,label:'Bad'}]}]})).toThrow();
    expect(()=>validateCanonicalType('factions',definition)).toThrow();
    expect(()=>validateCanonicalType('characters',{...definition,layout:[...definition.layout,...definition.layout]})).toThrow();
    expect(canonicalTypeSaveSchema.safeParse({projectId:'p',kind:'characters',expectedRevision:0,definition,role:'human'}).success).toBe(false);
  });
  it('reads only own properties and renders scalar, missing and structured fields',()=>{
    const record={state:{stats:{hp:9},tags:['ally']}};
    expect(canonicalLayoutValue(record,'state.stats.hp')).toBe(9);
    expect(canonicalLayoutValue(record,'state.tags')).toEqual(['ally']);
    expect(canonicalLayoutValue(record,'state.missing')).toBeUndefined();
    expect(canonicalLayoutValue(record,'constructor')).toBeUndefined();
  });
  it('returns immutable defaults without creating database records',async()=>{
    const execute=vi.fn().mockResolvedValueOnce([{id:'p'}]).mockResolvedValueOnce([]);mocks.getDb.mockReturnValue({execute});
    const result=await readCanonicalType({projectId:'p',kind:'characters'});
    expect(result.revision).toBe(0);result.definition.layout[0].title='Changed';
    expect(defaultCanonicalType('characters').layout[0].title).toBe('Overview');expect(execute).toHaveBeenCalledTimes(2);
  });
  it('rejects foreign projects before reading type definitions',async()=>{
    const execute=vi.fn().mockResolvedValue([]);mocks.getDb.mockReturnValue({execute});
    await expect(readCanonicalType({projectId:'missing',kind:'items'})).rejects.toMatchObject({code:'SCOPE_DENIED'});expect(execute).toHaveBeenCalledTimes(1);
  });
  it('rejects stale save and stale clear confirmation without mutation',async()=>{
    const execute=vi.fn().mockResolvedValueOnce([{id:'p'}]).mockResolvedValueOnce([{revision:2,definition:defaultCanonicalType('items')}]);
    mocks.getDb.mockReturnValue({transaction:(fn:(tx:{execute:typeof execute})=>unknown)=>fn({execute})});
    await expect(saveCanonicalType({projectId:'p',kind:'items',expectedRevision:1,definition:{gmContextMode:'partial',layout:[]},confirmedClear:true})).rejects.toMatchObject({code:'REVISION_CONFLICT'});expect(execute).toHaveBeenCalledTimes(2);
  });
  it('previews clearing without a write, then requires explicit confirmation to save',async()=>{
    const execute=vi.fn().mockResolvedValueOnce([{id:'p'}]).mockResolvedValueOnce([]).mockResolvedValueOnce([{total:0,inherited:0,pinned:0,partial:0,estimated_chars:0}]).mockResolvedValueOnce([{id:'p'}]).mockResolvedValueOnce([]);
    mocks.getDb.mockReturnValue({transaction:(fn:(tx:{execute:typeof execute})=>unknown)=>fn({execute})});
    const request={projectId:'p',kind:'items',expectedRevision:0,definition:{gmContextMode:'searchable',layout:[]}};
    expect(await saveCanonicalType(request,true)).toMatchObject({requiresClearConfirmation:true,revision:0});
    await expect(saveCanonicalType(request)).rejects.toMatchObject({code:'CONFIRMATION_REQUIRED'});expect(execute).toHaveBeenCalledTimes(5);
  });
  it('propagates history failures so the transaction rolls back',async()=>{
    const execute=vi.fn().mockResolvedValueOnce([{id:'p'}]).mockResolvedValueOnce([{revision:1,definition:defaultCanonicalType('items')}]).mockResolvedValueOnce([{revision:2}]).mockRejectedValueOnce(new Error('history failed'));
    mocks.getDb.mockReturnValue({transaction:(fn:(tx:{execute:typeof execute})=>unknown)=>fn({execute})});
    await expect(saveCanonicalType({projectId:'p',kind:'items',expectedRevision:1,definition:{...defaultCanonicalType('items'),gmContextMode:'partial'}})).rejects.toThrow('history failed');expect(execute).toHaveBeenCalledTimes(4);
  });
});
