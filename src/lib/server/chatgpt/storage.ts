import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export interface ChatgptAccount {
 key: string; owner: string; clientId: string; subject: string; email: string; epoch: number;
 accessToken?: string; refreshToken?: string; idToken?: string; scopes: string[];
 expiresAt: number; earliestRefreshAt?: number; savedAt: number;
 state: 'connected' | 'consent_missing' | 'disconnected' | 'revoked';
 lastError?: 'limit' | 'unsupported' | 'network' | 'revocation_unconfirmed';
}
export interface ChatgptSelection { accountKey: string; model: string }
export interface ChatgptRecords { version: 1; hostId?: string; accounts: ChatgptAccount[]; selections: Record<string, ChatgptSelection> }
export interface ChatgptStore { supported: boolean; read(): Promise<ChatgptRecords>; change<T>(work: (records: ChatgptRecords) => Promise<T> | T): Promise<T> }
export interface CredentialProtection { protect(bytes: Buffer): Promise<Buffer>; unprotect(bytes: Buffer): Promise<Buffer>; secureDirectory?(directory:string):Promise<void> }

// Constant command; credentials travel through stdin, never shell text, arguments or env.
export function windowsCredentialProtection(): CredentialProtection {
 const invoke = (mode: 'Protect' | 'Unprotect', bytes: Buffer) => new Promise<Buffer>((resolve,reject) => {
  const script = `[void][Reflection.Assembly]::LoadWithPartialName('System.Security'); try { $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $entropy=[Text.Encoding]::UTF8.GetBytes('MythEngine.SIWC.v1'); $result=[Security.Cryptography.ProtectedData]::${mode}($bytes,$entropy,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result)) } catch { exit 1 }`;
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{stdio:['pipe','pipe','ignore'],windowsHide:true});
  let output=''; const timer=setTimeout(()=>{child.kill();reject(Error('Protected credential storage timed out.'));},15000);
  child.stdout.on('data',chunk=>{output+=chunk; if(output.length>2000000)child.kill();});
  child.on('error',()=>{clearTimeout(timer);reject(Error('Windows protected credential storage is unavailable.'));});
  child.on('close',code=>{clearTimeout(timer); if(code!==0||!/^[A-Za-z0-9+/=]+$/.test(output))reject(Error('Unable to access protected ChatGPT credentials.'));else resolve(Buffer.from(output,'base64'));});
  child.stdin.on('error',()=>{});child.stdin.end(bytes.toString('base64'));
 });
 const secureDirectory=(directory:string)=>new Promise<void>((resolve,reject)=>{
  const script="try { $path=[Console]::In.ReadToEnd(); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[IO.Directory]::GetAccessControl($path,[Security.AccessControl.AccessControlSections]::Access); foreach($entry in @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))){[void]$acl.RemoveAccessRuleSpecific($entry)}; $acl.SetAccessRuleProtection($true,$false); $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl($path,$acl) } catch { exit 1 }";
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{stdio:['pipe','ignore','ignore'],windowsHide:true});
  const timer=setTimeout(()=>{child.kill();reject(Error('Credential directory protection timed out.'));},15000);
  child.on('error',()=>{clearTimeout(timer);reject(Error('Credential directory protection unavailable.'));});child.on('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error('Unable to protect credential directory.'));});child.stdin.on('error',()=>{});child.stdin.end(directory);
 });
 return {protect:bytes=>invoke('Protect',bytes),unprotect:bytes=>invoke('Unprotect',bytes),secureDirectory};
}

export function createChatgptFileStore(directory: string, protection?: CredentialProtection): ChatgptStore {
 const supported=Boolean(protection), file=path.join(directory,'session.dpapi'), lock=path.join(directory,'session.lock');
 let queue: Promise<unknown>=Promise.resolve();let cached:{hash:string;records:ChatgptRecords}|undefined;
 const empty=(): ChatgptRecords=>({version:1,accounts:[],selections:{}});
 async function read() {
  try {
   const stat=await fs.lstat(file); if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1000000)throw Error('Invalid protected credential file.');
   if(!protection)throw Error('Protected credential storage is unsupported on this platform.');
   const encrypted=await fs.readFile(file),hash=createHash('sha256').update(encrypted).digest('hex');
   if(cached?.hash===hash)return structuredClone(cached.records);
   const records=JSON.parse((await protection.unprotect(encrypted)).toString('utf8')) as ChatgptRecords;
   if(records.version!==1||!Array.isArray(records.accounts)||!records.selections)throw Error('Invalid protected credential record.');
   cached={hash,records:structuredClone(records)};return records;
  } catch(error) { if((error as NodeJS.ErrnoException).code==='ENOENT')return empty(); throw Error('Unable to read protected ChatGPT credentials.'); }
 }
 function change<T>(work: (records: ChatgptRecords)=>Promise<T>|T): Promise<T> {
  const operation=queue.then(async()=>{
   if(!protection)throw Error('Windows protected credential storage is required for this integration.');
   await fs.mkdir(directory,{recursive:true,mode:0o700});
   const dirStat=await fs.lstat(directory);if(!dirStat.isDirectory()||dirStat.isSymbolicLink())throw Error('Invalid protected credential directory.');
   await protection.secureDirectory?.(directory);
   // Exclusive file lock serializes rotating refreshes across processes, as well as this queue.
   let handle;const deadline=Date.now()+10000;
   while(!handle) {
    try {handle=await fs.open(lock,'wx',0o600);} catch(error) {
     if((error as NodeJS.ErrnoException).code!=='EEXIST'||Date.now()>=deadline)throw Error('ChatGPT credential storage is busy. Retry after the other process exits.');
     await new Promise(resolve=>setTimeout(resolve,50));
    }
   }
   const temporary=path.join(directory,'session-'+randomUUID()+'.tmp');
   try {
    const records=await read(),result=await work(records);
    const encrypted=await protection.protect(Buffer.from(JSON.stringify(records)));
    const output=await fs.open(temporary,'wx',0o600);try {await output.writeFile(encrypted);await output.sync();} finally {await output.close();}
    await fs.rename(temporary,file);
    cached={hash:createHash('sha256').update(encrypted).digest('hex'),records:structuredClone(records)};
    return result;
   } finally {
    await fs.unlink(temporary).catch(()=>{});await handle.close();await fs.unlink(lock);
   }
  });
  queue=operation.catch(()=>{});return operation;
 }
 return {supported,read,change};
}
