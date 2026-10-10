import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
const root=process.cwd(),sql=fs.readFileSync(path.join(root,'drizzle/0052_summary_recovery.sql'),'utf8');
const result=await build({entryPoints:[path.join(root,'src/lib/server/jobs/summaryRecoveryCli.ts')],outfile:'tools/summary-recovery.mjs',bundle:true,metafile:true,
 platform:'node',format:'esm',target:'node24',packages:'external',sourcemap:false,
 alias:{$lib:path.join(root,'src/lib'),'$env/dynamic/private':path.join(root,'scripts/recovery-private-env.mjs')},
 define:{__SUMMARY_RECOVERY_SQL__:JSON.stringify(sql)}});
const sha=createHash('sha256').update(fs.readFileSync('tools/summary-recovery.mjs')).digest('hex');
const files=[...new Set([...Object.keys(result.metafile.inputs),'drizzle/0052_summary_recovery.sql','scripts/build-summary-recovery.mjs','package-lock.json'])].sort();
const source=createHash('sha256');for(const file of files){source.update(file);source.update('\0');source.update(createHash('sha256').update(fs.readFileSync(file)).digest());}
fs.writeFileSync('tools/summary-recovery.build.json',JSON.stringify({builtAt:new Date().toISOString(),operatorSha256:sha,
 operatorSourceSha256:source.digest('hex'),sourceFiles:files,
 schemaSha256:createHash('sha256').update(sql).digest('hex')},null,2)+'\n');console.log('Operator built: '+sha);
