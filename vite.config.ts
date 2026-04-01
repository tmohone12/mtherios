import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
	plugins: [tailwindcss(), sveltekit()],
	server: {
		host: '0.0.0.0',
		proxy: {
			'/api/anthropic': {
				target: 'https://api.anthropic.com',
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/api\/anthropic/, ''),
			},
		},
	},
});
