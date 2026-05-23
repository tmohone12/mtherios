import { env } from '$env/dynamic/private';
import { GoogleAuth } from 'google-auth-library';

const GOOGLE_CLOUD_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const DEFAULT_LOCATION = 'global';
const DEFAULT_API_VERSION = 'v1';

export const GOOGLE_AGENT_PLATFORM_MODELS = [
	'google/gemini-2.5-flash',
	'google/gemini-2.5-pro',
	'google/gemini-2.5-flash-lite',
	'google/gemini-2.0-flash',
] as const;

let auth: GoogleAuth | null = null;

function getAuth(): GoogleAuth {
	auth ??= new GoogleAuth({ scopes: [GOOGLE_CLOUD_SCOPE] });
	return auth;
}

function cleanSegment(value: string): string {
	return value.replace(/^\/+|\/+$/g, '');
}

function envFirst(...names: string[]): string {
	for (const name of names) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	return '';
}

function getLocation(): string {
	return envFirst(
		'GOOGLE_AGENT_PLATFORM_LOCATION',
		'GOOGLE_VERTEX_LOCATION',
		'VERTEX_AI_LOCATION',
		'GOOGLE_CLOUD_LOCATION',
		'GOOGLE_CLOUD_REGION',
	) || DEFAULT_LOCATION;
}

function getApiVersion(): string {
	return envFirst('GOOGLE_AGENT_PLATFORM_API_VERSION', 'GOOGLE_VERTEX_API_VERSION') || DEFAULT_API_VERSION;
}

function getHost(location: string): string {
	const explicitHost = envFirst('GOOGLE_AGENT_PLATFORM_HOST', 'GOOGLE_VERTEX_HOST');
	if (explicitHost) return explicitHost.replace(/^https?:\/\//, '').replace(/\/+$/g, '');
	return location === 'global' ? 'aiplatform.googleapis.com' : `${location}-aiplatform.googleapis.com`;
}

async function getProjectId(): Promise<string> {
	const explicitProject = envFirst(
		'GOOGLE_AGENT_PLATFORM_PROJECT',
		'GOOGLE_CLOUD_PROJECT',
		'GCLOUD_PROJECT',
		'GCP_PROJECT',
	);
	if (explicitProject) return explicitProject;

	try {
		return await getAuth().getProjectId();
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Google Agent Platform needs a Google Cloud project. Set GOOGLE_CLOUD_PROJECT or GOOGLE_AGENT_PLATFORM_PROJECT. ${detail}`,
		);
	}
}

export async function getGoogleAgentPlatformBaseUrl(): Promise<string> {
	const projectId = await getProjectId();
	const location = getLocation();
	const host = getHost(location);
	const version = getApiVersion();
	return `https://${host}/${version}/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/endpoints/openapi`;
}

export async function getGoogleAgentPlatformEndpoint(path: string): Promise<string> {
	return `${await getGoogleAgentPlatformBaseUrl()}/${cleanSegment(path)}`;
}

export async function getGoogleAgentPlatformAccessToken(): Promise<string> {
	const client = await getAuth().getClient();
	const response = await client.getAccessToken();
	const token = typeof response === 'string' ? response : response?.token;
	if (!token) {
		throw new Error('Google Application Default Credentials did not return an access token.');
	}
	return token;
}

export async function getGoogleAgentPlatformHeaders(): Promise<Record<string, string>> {
	return {
		Authorization: `Bearer ${await getGoogleAgentPlatformAccessToken()}`,
	};
}

export function googleAgentPlatformJsonError(error: unknown, fallbackStatus = 500): Response {
	const message = error instanceof Error ? error.message : String(error);
	return new Response(JSON.stringify({ error: { message, type: 'google_agent_platform_error' } }), {
		status: fallbackStatus,
		headers: { 'Content-Type': 'application/json' },
	});
}

