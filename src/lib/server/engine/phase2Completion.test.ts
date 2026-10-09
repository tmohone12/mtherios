import {beforeEach,describe,expect,it,vi} from 'vitest';
import {extensionDefinition,extensionValues} from './canonicalExtensions';
import {saveCanonicalType} from './canonicalTypes';
import {defaultCanonicalType} from '$lib/contracts/canonicalTypes';
import {gameMigrationSchema,migrateGame} from './gameMigration';
import {folderExportSchema} from '$lib/contracts/contentFolders';
const mocks=vi.hoisted(()=>({getDb:vi.fn()}));
vi.mock('$lib/server/db/client',()=>({getDb:mocks.getDb}));
beforeEach(()=>vi.clearAllMocks());
const definition={...defaultCanonicalType('characters'),fields:{stats:{kind:'object' as const,required:true,fields:{hp:{kind:'number' as const,required:true},armor:{kind:'number' as const}}}},defaults:{stats:{hp:10,armor:2}}};
describe('Phase 2 completion boundaries',()=>{
  it('fills only missing nested defaults and retains authored values',()=>{expect(extensionValues(definition,{contentFields:{stats:{hp:18}}},true)).toEqual({stats:{hp:18,armor:2}});});
  it('rejects invalid existing data rather than replacing it with defaults',()=>{expect(()=>extensionValues(definition,{contentFields:{stats:{hp:'bad'}}},true)).toThrow();expect(()=>extensionValues(definition,{contentFields:null})).toThrow();});
  it('bounds schemas and rejects undeclared fields, identity references and malformed defaults',()=>{
    expect(()=>extensionDefinition({...definition,defaults:{stats:{hp:'bad'}}})).toThrow();
    expect(()=>extensionDefinition({fields:{target:{kind:'reference'}}})).toThrow();
    expect(()=>extensionValues(definition,{contentFields:{story_id:'another'}})).toThrow();
  });
  it('reports a required-field migration conflict without writing',async()=>{
    const execute=vi.fn().mockResolvedValueOnce([{id:'p'}]).mockResolvedValueOnce([]).mockResolvedValueOnce([{id:'c',name:'NPC',server_version:1,metadata:{}}]).mockResolvedValueOnce([{total:0,inherited:0,pinned:0,partial:0,estimated_chars:0}]);mocks.getDb.mockReturnValue({transaction:(fn:(tx:{execute:typeof execute})=>unknown)=>fn({execute})});
    const result=await saveCanonicalType({projectId:'p',kind:'characters',expectedRevision:0,definition},true);expect(result).toMatchObject({compatible:false,migrationCount:0,conflicts:[{id:'c',name:'NPC'}]});expect(execute).toHaveBeenCalledTimes(4);
  });
  it('requires a fresh reviewed schema migration token before any write',async()=>{
    const execute=vi.fn().mockResolvedValueOnce([{id:'p'}]).mockResolvedValueOnce([]).mockResolvedValueOnce([{id:'c',name:'NPC',server_version:2,metadata:{}}]);mocks.getDb.mockReturnValue({transaction:(fn:(tx:{execute:typeof execute})=>unknown)=>fn({execute})});
    await expect(saveCanonicalType({projectId:'p',kind:'characters',expectedRevision:0,definition,migrateDefaults:true,expectedSnapshot:'a'.repeat(64)})).rejects.toMatchObject({code:'REVISION_CONFLICT'});expect(execute).toHaveBeenCalledTimes(3);
  });
  it('accepts bounded portable receipts without caller-authored archive revisions',()=>{
    const folder={gameId:null,path:'Rules',archived:true,recovery:{folders:['Rules/Core'],items:['doc'],canonical:[]}};expect(folderExportSchema.safeParse(folder).success).toBe(true);expect(folderExportSchema.safeParse({...folder,recovery:{...folder.recovery,expectedRevision:1}}).success).toBe(false);
  });
  it('rejects caller authority and same-project moves before reading data',async()=>{
    expect(gameMigrationSchema.safeParse({projectId:'p',gameId:'g',destinationProjectId:'q',role:'admin'}).success).toBe(false);
    await expect(migrateGame({projectId:'p',gameId:'g',destinationProjectId:'p'},true)).rejects.toMatchObject({code:'INVALID_CONTENT'});expect(mocks.getDb).not.toHaveBeenCalled();
  });
});
