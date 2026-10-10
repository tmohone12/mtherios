import { z } from 'zod';
const scope = { projectId:z.string().min(1).max(200),gameId:z.string().max(200) };
export const assistantConnectionSchema=z.discriminatedUnion('kind',[
 z.object({...scope,kind:z.literal('chatgpt'),accountKey:z.string().min(1).max(100),epoch:z.number().int().positive(),model:z.string().min(1).max(200)}).strict(),
 z.object({...scope,kind:z.literal('configured'),provider:z.string().min(1).max(100),model:z.string().min(1).max(200),endpoint:z.string().max(1000),settingsHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
export type AssistantConnection=z.infer<typeof assistantConnectionSchema>;
export type AssistantConnectionState={scope:string;connection:AssistantConnection|null;ready:boolean};
