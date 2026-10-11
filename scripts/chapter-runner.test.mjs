import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startChapterRunner} from './mtheriosd.mjs';
import {resolveRuntimeOptions,buildRuntimeEnv} from './runtime-config.mjs';
test('chapter-only gate defaults off, requires one story, and roundtrips independently of turn jobs',()=>{
 const base=resolveRuntimeOptions([],{env:{}});assert.equal(base.chapterRunnerEnabled,false);
 assert.throws(()=>resolveRuntimeOptions(['--chapter-runner'],{env:{}}),/story ID/);
 const options=resolveRuntimeOptions(['--chapter-runner','--chapter-runner-story','fixture'],{env:{}});
 const env=buildRuntimeEnv(options,{});assert.equal(env.MTHERIOS_TURN_JOBS,'true');assert.equal(env.MTHERIOS_CHAPTER_RUNNER,'true');
 assert.equal(resolveRuntimeOptions([],{env}).chapterRunnerStoryId,'fixture');
});
test('separate timer only sends one configured chapter tick; pause gate schedules nothing',async()=>{
 const timers=[],requests=[];const deps={setTimer:(fn,ms)=>{timers.push({fn,ms});return {unref(){}};},request:async(url,init)=>{requests.push({url,body:JSON.parse(init.body)});return {ok:true};}};
 startChapterRunner({chapterRunnerEnabled:false},deps);assert.equal(timers.length,0);
 const stop=startChapterRunner({chapterRunnerEnabled:true,chapterRunnerStoryId:'fixture',host:'127.0.0.1',port:9999},deps);
 assert.equal(timers[0].ms,60000);await timers[0].fn();assert.equal(requests.length,1);
 assert.deepEqual(requests[0],{url:'http://127.0.0.1:9999/api/app/chapters',body:{action:'tick',storyId:'fixture'}});
 stop();await timers[1].fn();assert.equal(requests.length,1);
});
