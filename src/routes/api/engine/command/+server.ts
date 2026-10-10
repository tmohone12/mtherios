import { json, type RequestHandler } from '@sveltejs/kit';
import { engineCommandRequestSchema } from '$lib/contracts/engine';
import { executeEngineCommand } from '$lib/server/engine/command';
import { apiError, readJson } from '$lib/server/memory/http';
import { browserOwnerContext,ownerHash } from '$lib/server/chatgpt/session';
import { localBrowserOwner,ownerCookie } from '$lib/server/chatgpt/http';
import {assistantConnectionCommands,assistantConnectionContext,parseAssistantConnection,assertAssistantConnection} from '$lib/server/engine/assistantConnection';

export const POST: RequestHandler = async (event) => {
	try {
		const command = await readJson(event, engineCommandRequestSchema);
		const cookie=event.cookies.get(ownerCookie);
		let owner=cookie?ownerHash(cookie):undefined;
		if(command.command.startsWith('assistant.'))owner=localBrowserOwner(event,!['assistant.conversation.list','assistant.conversation.read'].includes(command.command));
		if(assistantConnectionCommands.has(command.command)){
			const {connection,...args}=command.args;
			const selected=parseAssistantConnection(connection,args.projectId,args.gameId);
			return json(await browserOwnerContext.run(owner!,()=>assistantConnectionContext.run(selected,async()=>{
				await assertAssistantConnection(selected.projectId,selected.gameId);
				return executeEngineCommand({...command,args});
			})));
		}
		return json(await browserOwnerContext.run(owner!,()=>executeEngineCommand(command)));
	} catch (error) {
		return apiError(error);
	}
};
