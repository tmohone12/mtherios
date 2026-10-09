import {beforeEach,describe,expect,it,vi} from 'vitest';
import {copyFolder,listFolders,moveFolder} from './content';
import {folderPaths,inContentFolder,relocatedFolder,folderMoveSchema} from '$lib/contracts/contentFolders';
const mocks=vi.hoisted(()=>({getDb:vi.fn()}));
vi.mock('$lib/server/db/client',()=>({getDb:mocks.getDb}));
beforeEach(()=>vi.clearAllMocks());
function database(revision=2,extra=false){
  const rows=[{id:'doc',title:'Archived',folder:'Rules/Core',revision,type_revision:1},...(extra?[{id:'new',title:'New',folder:'Rules/New',revision:1,type_revision:1}]:[])];
  const tx={execute:vi.fn().mockResolvedValueOnce([{id:'p'}]).mockResolvedValueOnce([{id:'empty',path:'Rules/Empty',revision:1}]).mockResolvedValueOnce(rows)};
  mocks.getDb.mockReturnValue({transaction:(fn:(t:typeof tx)=>unknown)=>fn(tx)});return tx;
}
describe('content folders',()=>{
  it('uses segment boundaries and retains nested suffixes',()=>{
    expect(inContentFolder('Rules/Core','Rules')).toBe(true);expect(inContentFolder('Ruleset','Rules')).toBe(false);
    expect(relocatedFolder('Rules/Core/Sub','Rules','Archive')).toBe('Archive/Core/Sub');
    expect(folderPaths(['','Rules/Core','Rules/Empty'])).toEqual(['Rules','Rules/Core','Rules/Empty']);
    expect(folderMoveSchema.safeParse({projectId:'p',from:'Rules',to:'Archive',targetGameId:'other'}).success).toBe(false);
  });
  it('lists empty folders and implicit parents without writing',async()=>{
    const tx=database();expect((await listFolders({projectId:'p'})).paths).toEqual(['Rules','Rules/Core','Rules/Empty']);expect(tx.execute).toHaveBeenCalledTimes(3);
  });
  it('previews all subtree rows without committing',async()=>{
    const tx=database();const preview=await moveFolder({projectId:'p',from:'Rules',to:'Archive'},true);
    expect(preview.counts).toEqual({folders:1,documents:1,canonical:0});expect(preview.items[0]).toMatchObject({id:'doc',to:'Archive/Core'});expect(tx.execute).toHaveBeenCalledTimes(3);
  });
  it.each(['revision','new child'])('rejects a stale preview after %s changes before writing',async change=>{
    database();const preview=await moveFolder({projectId:'p',from:'Rules',to:'Archive'},true);
    const tx=database(change==='revision'?3:2,change==='new child');
    await expect(moveFolder({projectId:'p',from:'Rules',to:'Archive',expectedSnapshot:preview.expectedSnapshot})).rejects.toMatchObject({code:'REVISION_CONFLICT'});expect(tx.execute).toHaveBeenCalledTimes(3);
  });
  it('rejects a move without a reviewed snapshot',async()=>{database();await expect(moveFolder({projectId:'p',from:'Rules',to:'Archive'})).rejects.toMatchObject({code:'REVISION_CONFLICT'});});
  it('rejects moving into itself or descendants before querying',async()=>{await expect(moveFolder({projectId:'p',from:'Rules',to:'Rules/Core'},true)).rejects.toMatchObject({code:'INVALID_CONTENT'});expect(mocks.getDb).not.toHaveBeenCalled();});
  it('rejects destination merging',async()=>{database();await expect(moveFolder({projectId:'p',from:'Rules/Core',to:'Rules/Empty'},true)).rejects.toMatchObject({code:'CONTENT_EXISTS'});});
  it('binds the reviewed snapshot to copy versus move',async()=>{
    database();const move=await moveFolder({projectId:'p',from:'Rules',to:'Archive'},true);
    database();const copy=await copyFolder({projectId:'p',from:'Rules',to:'Archive'},true);
    expect(copy.expectedSnapshot).not.toBe(move.expectedSnapshot);
    const tx=database();await expect(copyFolder({projectId:'p',from:'Rules',to:'Archive',expectedSnapshot:move.expectedSnapshot})).rejects.toMatchObject({code:'REVISION_CONFLICT'});expect(tx.execute).toHaveBeenCalledTimes(3);
  });
  it('rejects copying a changed subtree before creating any identities',async()=>{
    database();const preview=await copyFolder({projectId:'p',from:'Rules',to:'Archive'},true);
    const tx=database(3);await expect(copyFolder({projectId:'p',from:'Rules',to:'Archive',expectedSnapshot:preview.expectedSnapshot})).rejects.toMatchObject({code:'REVISION_CONFLICT'});expect(tx.execute).toHaveBeenCalledTimes(3);
  });
});
