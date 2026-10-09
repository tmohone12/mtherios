import {beforeEach,describe,expect,it,vi} from 'vitest';
import {archiveFolder,moveFolder} from './content';
import {folderArchiveSchema} from '$lib/contracts/contentFolders';
const mocks=vi.hoisted(()=>({getDb:vi.fn()}));
vi.mock('$lib/server/db/client',()=>({getDb:mocks.getDb}));
beforeEach(()=>vi.clearAllMocks());
function database(folders:Record<string,unknown>[]=[],items:Record<string,unknown>[]=[],others:Record<string,unknown>[]=[]){
  const tx={execute:vi.fn().mockResolvedValueOnce([{id:'p'}]).mockResolvedValueOnce(folders).mockResolvedValueOnce(items).mockResolvedValueOnce(others)};
  mocks.getDb.mockReturnValue({transaction:(fn:(t:typeof tx)=>unknown)=>fn(tx)});return tx;
}
const doc={id:'doc',title:'Document',folder:'Root/Docs',revision:1,type_revision:1,deleted_at:null};
describe('folder archive and recovery',()=>{
  it('rejects paths outside the logical namespace and caller-supplied recovery members',async()=>{
    expect(folderArchiveSchema.safeParse({projectId:'p',path:'Root',receipt:{items:[]}}).success).toBe(false);
    await expect(archiveFolder({projectId:'p',path:'../Root'},true)).rejects.toMatchObject({code:'INVALID_CONTENT'});
    expect(mocks.getDb).not.toHaveBeenCalled();
  });
  it('excludes pre-existing archives and entire separately archived subtrees',async()=>{
    const tx=database([{id:'nested',path:'Root/Old',archived_at:'date',revision:2}],[doc,{...doc,id:'old',folder:'Root/Old',deleted_at:null},{...doc,id:'archived',deleted_at:'date'}]);
    const preview=await archiveFolder({projectId:'p',path:'Root'},true);
    expect(preview.counts).toEqual({folders:1,documents:1,canonical:0});expect(tx.execute).toHaveBeenCalledTimes(4);
  });
  it('blocks incoming references from outside the selected subtree',async()=>{
    const tx=database([],[doc],[{id:'outside',data:{link:{itemId:'doc'}},definition:{fields:{link:{kind:'reference'}},defaults:{},layout:[],gmContextMode:'searchable'}}]);
    await expect(archiveFolder({projectId:'p',path:'Root'},true)).rejects.toMatchObject({code:'REFERENCE_CONFLICT'});expect(tx.execute).toHaveBeenCalledTimes(4);
  });
  it('rejects a stale archive token before any writes',async()=>{
    database([],[doc]);const first=await archiveFolder({projectId:'p',path:'Root'},true);
    const tx=database([],[{...doc,revision:2}]);await expect(archiveFolder({projectId:'p',path:'Root',expectedSnapshot:first.expectedSnapshot})).rejects.toMatchObject({code:'REVISION_CONFLICT'});expect(tx.execute).toHaveBeenCalledTimes(4);
  });
  it('previews changed recovery members as skipped instead of overwriting them',async()=>{
    const root={id:'root',path:'Root',revision:2,archived_at:'date',archive_receipt:{folders:[],items:[{id:'doc',revision:2}],canonical:[]}};
    const tx=database([root],[{...doc,revision:3,deleted_at:'date'}]);const review=await archiveFolder({projectId:'p',path:'Root'},true,'restore');
    expect(review.counts).toEqual({folders:1,documents:0,canonical:0});expect(review.skipped).toEqual([expect.objectContaining({id:'doc',kind:'document'})]);expect(tx.execute).toHaveBeenCalledTimes(3);
  });
  it('makes imported folder-only recovery explicit and does not resurrect documents',async()=>{
    database([{id:'root',path:'Root',revision:1,archived_at:'date',archive_receipt:null}],[{...doc,deleted_at:'date'}]);
    const review=await archiveFolder({projectId:'p',path:'Root'},true,'restore');expect(review.importedRecovery).toBe(true);expect(review.counts.documents).toBe(0);
  });
  it('blocks moves containing archived subtrees before mutations',async()=>{
    const tx=database([{id:'root',path:'Root',revision:2,archived_at:'date'}]);await expect(moveFolder({projectId:'p',from:'Root',to:'New'},true)).rejects.toMatchObject({code:'CONTENT_ARCHIVED'});expect(tx.execute).toHaveBeenCalledTimes(3);
  });
});
