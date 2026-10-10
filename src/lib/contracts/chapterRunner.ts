import {z} from 'zod';
export const RECOVERY_ROUTE = Object.freeze({providerType:'nanogpt' as const,baseUrl:'https://api.nano-gpt.com/api/v1',model:'xiaomi/mimo-v2.6-flash',endpoint:'xiaomi',inputUsdPerMillion:0.147000001,outputUsdPerMillion:0.294000001,requestUsd:0,feeMultiplier:1.134});
export const LEGACY_NANO_RECOVERY_ROUTE=Object.freeze({...RECOVERY_ROUTE,baseUrl:'https://nano-gpt.com/api/v1'});
export const RECOVERY_TRANSPORT=Object.freeze({perCallMs:180000,chapterMs:540000});
export const RECOVERY_LIMITS = Object.freeze({calls:3,inputTokens:120000,outputTokens:36000,inputPerCall:50000,outputPerCall:12000,usd:0.033});
export const RECOVERY_PROVIDER = Object.freeze({only:['xiaomi'],order:['xiaomi'],quantizations:['fp8'],allow_fallbacks:false as const,require_parameters:true as const,max_price:{prompt:0.147000001,completion:0.294000001}});
export const chapterRunnerApprovalSchema=z.object({confirmed:z.literal(true),model:z.literal(RECOVERY_ROUTE.model),endpoint:z.literal(RECOVERY_ROUTE.endpoint),
 afterPosition:z.number().int().min(-1),maxChapters:z.number().int().min(1).max(100),totalUsd:z.number().positive().max(3.1),
 minIntervalMinutes:z.number().int().min(1).max(10080),expiresAt:z.string().datetime()}).strict();
export type ChapterRunnerApproval=z.infer<typeof chapterRunnerApprovalSchema>;
export const chapterRunnerActionSchema=z.discriminatedUnion('action',[
 z.object({action:z.literal('enable'),storyId:z.string().min(1),approval:chapterRunnerApprovalSchema}).strict(),
 z.object({action:z.literal('disable'),storyId:z.string().min(1)}).strict(),
 z.object({action:z.literal('tick'),storyId:z.string().min(1)}).strict(),
]);
export type ChapterRunnerStatus={storyId:string;available:boolean;enabled:boolean;phase:'paused'|'waiting'|'generating'|'held'|'complete';
 message:string;boundary:{number:number;endPosition:number};completedTurns:number;nextRange:null|{number:number;start:number;end:number;sourceIds:string[]};
 nextDueAt:string|null;approval:ChapterRunnerApproval|null;completedChapters:number;reservedUsd:number;reservedCalls:number;
 activeManifestId:string|null;attempts:Array<{stage:string;status:string;reservedUsd:number|null;providerRequestId:string|null;statusCode:number|null}>;
 limits:{[K in keyof typeof RECOVERY_LIMITS]:number};route:typeof RECOVERY_ROUTE};
