import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
		host: '0.0.0.0',
		allowedHosts: ['raijinai.taile6cbff.ts.net'],
		proxy: {
			'/api/anthropic': {
				target: 'https://api.anthropic.com',
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/api\/anthropic/, ''),
			},
			// Kimi Code (Moonshot) — API returns no Access-Control-Allow-Origin
			// header, so browsers block direct calls. This dev-server proxy
			// strips the /api/kimi-code prefix and forwards to the real host.
			// Production deployments need their own proxy (or a Tauri/Electron
			// wrapper); the pure-static build can't reach this endpoint directly.
			'/api/kimi-code': {
				target: 'https://api.kimi.com',
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/api\/kimi-code/, '/coding/v1'),
			},
			// Claude Code Bridge (cc-bridge) — local Anthropic-shaped proxy
			// running on Zo at :8787 that routes through the Claude CLI
			// subscription. This dev-server proxy strips /api/cc-bridge so
			// the SDK can call /v1/messages directly.
			'/api/cc-bridge': {
				target: 'http://localhost:8787',
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/api\/cc-bridge/, ''),
			},
		},
	},
});
