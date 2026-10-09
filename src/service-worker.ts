/// <reference lib="webworker" />

import { build, files, prerendered, version } from '$service-worker';

declare const self: ServiceWorkerGlobalScope;

const PRECACHE = `mythengine-precache-${version}`;
const RUNTIME = `mythengine-runtime-${version}`;
const PRECACHE_URLS = ['/', ...build, ...files, ...prerendered];

self.addEventListener('install', (event) => {
	event.waitUntil(caches.open(PRECACHE).then(cache => cache.addAll(PRECACHE_URLS)));
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches.keys()
			.then(keys => Promise.all(keys.filter(key => key.startsWith('mythengine-') && ![PRECACHE, RUNTIME].includes(key)).map(key => caches.delete(key))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener('message', (event) => {
	if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
	const request = event.request;
	if (request.method !== 'GET') return;
	const url = new URL(request.url);
	if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

	if (request.mode === 'navigate') {
		event.respondWith(
			fetch(request).then(response => {
				if (response.ok) void caches.open(RUNTIME).then(cache => cache.put(request, response.clone()));
				return response;
			}).catch(async () => (await caches.match(request)) ?? (await caches.match('/')) ?? Response.error()),
		);
		return;
	}

	event.respondWith(caches.match(request).then(cached => cached ?? fetch(request).then(response => {
		if (response.ok) void caches.open(RUNTIME).then(cache => cache.put(request, response.clone()));
		return response;
	})));
});
