import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import type {Story} from '$lib/types';
const mocks=vi.hoisted(()=>({projection:vi.fn(),chapters:vi.fn(),put:vi.fn(),push:vi.fn()}));
vi.mock('$lib/services/serverStories',async original=>({...await original<typeof import('$lib/services/serverStories')>(),fetchBackendStoryProjection:mocks.projection}));
vi.mock('$lib/services/database',async original=>({...await original<typeof import('$lib/services/database')>(),getChapters:mocks.chapters,putChapter:mocks.put}));
vi.mock('$lib/services/backendMemory',async original=>({...await original<typeof import('$lib/services/backendMemory')>(),pushPendingBackendOps:mocks.push}));
import {story} from './story.svelte';
beforeEach(()=>{story.clear();vi.clearAllMocks();story.currentStory={id:'local',serverStoryId:'server',serverVersion:7973,syncStatus:'pending',title:'Local unsynced title'} as unknown as Story;
 mocks.chapters.mockResolvedValue([{id:'existing',summary:'Unsynced chapter edit'},{id:'local-only',summary:'Pending local record'}]);
 mocks.projection.mockResolvedValue({story:{title:'Server title',serverVersion:8000},entities:[{id:'canon',name:'Server edit'}],chapters:[{id:'existing',number:86,title:'Server replacement',sceneOutcome:'Old server prose'},{id:'new',number:87,title:'New summary',sceneOutcome:'Source-linked new prose'}]});});
afterEach(()=>{story.clear();vi.restoreAllMocks();});
it('adds only missing chapter IDs while preserving unsynced summaries, world state, outbox and cursor',async()=>{
 const prior={...story.currentStory};await story.refreshNewChapters();expect(mocks.put).toHaveBeenCalledTimes(1);expect(mocks.put.mock.calls[0][0]).toMatchObject({id:'new',storyId:'local',number:87});
 expect(story.currentStory).toEqual(prior);expect(story.characters).toEqual([]);expect(mocks.push).not.toHaveBeenCalled();
});
it('ignores a late response after changing stories',async()=>{
 let release!:(value:unknown)=>void;mocks.projection.mockImplementation(()=>new Promise(r=>{release=r;}));const loading=story.refreshNewChapters();
 story.currentStory={id:'other',serverStoryId:'other-server'} as Story;release({chapters:[{id:'new',number:87}]});await loading;expect(mocks.put).not.toHaveBeenCalled();
});
it('checks story ownership again after awaiting local records',async()=>{
 let release!:(value:unknown)=>void;mocks.chapters.mockImplementation(()=>new Promise(r=>{release=r;}));const loading=story.refreshNewChapters();
 await vi.waitFor(()=>expect(release).toBeDefined());story.currentStory={id:'other',serverStoryId:'other-server'} as Story;release([]);await loading;expect(mocks.put).not.toHaveBeenCalled();
});
