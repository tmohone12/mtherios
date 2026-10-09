import { z } from 'zod';
const folder=z.string().min(1).max(500);
export const folderScopeSchema=z.object({projectId:z.string().min(1).max(200),gameId:z.string().min(1).max(200).optional()}).strict();
export const folderCreateSchema=folderScopeSchema.extend({path:folder}).strict();
export const folderMoveSchema=folderScopeSchema.extend({from:folder,to:folder,expectedSnapshot:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
export const folderArchiveSchema=folderScopeSchema.extend({path:folder,expectedSnapshot:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict();
export interface FolderArchiveReceipt { folders:{id:string;revision:number}[];items:{id:string;revision:number}[];canonical:{id:string;revision:number}[] }
export const folderExportSchema=z.object({gameId:z.string().min(1).max(200).nullable(),path:folder,archived:z.boolean().optional(),recovery:z.object({folders:z.array(folder).max(5000),items:z.array(z.string().min(1).max(200)).max(5000),canonical:z.array(z.object({kind:z.enum(['characters','locations','items','factions']),recordId:z.string().min(1).max(200)}).strict()).max(5000)}).strict().optional()}).strict();
export interface ContentFolder {id:string;project_id:string;game_id:string|null;path:string;revision:number;archived_at?:string|null;archive_receipt?:FolderArchiveReceipt|null}
export function inContentFolder(path:string,root:string){return path===root||path.startsWith(root+'/');}
export function relocatedFolder(path:string,from:string,to:string){return to+path.slice(from.length);}
export function folderPaths(paths:string[]){const found=new Set<string>();for(const path of paths){const parts=path.split('/');for(let i=1;i<=parts.length;i++){const value=parts.slice(0,i).join('/');if(value)found.add(value);}}return [...found].sort();}
