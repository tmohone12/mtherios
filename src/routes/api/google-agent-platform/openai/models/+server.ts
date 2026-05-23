import { json, type RequestHandler } from '@sveltejs/kit';
import {
	GOOGLE_AGENT_PLATFORM_MODELS,
	getGoogleAgentPlatformAccessToken,
	getGoogleAgentPlatformBaseUrl,
	googleAgentPlatformJsonError,
} from '$lib/server/ai/googleAgentPlatform';

export const GET: RequestHandler = async () => {
	try {
		// Verify project resolution and ADC even though model discovery is static.
		await getGoogleAgentPlatformBaseUrl();
		await getGoogleAgentPlatformAccessToken();
		return json({
			object: 'list',
			data: GOOGLE_AGENT_PLATFORM_MODELS.map((id) => ({
				id,
				object: 'model',
				owned_by: 'google',
			})),
		});
	} catch (error) {
		return googleAgentPlatformJsonError(error, 503);
	}
};
