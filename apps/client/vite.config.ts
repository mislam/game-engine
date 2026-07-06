import { defineConfig } from "vite"
import { svelte } from "@sveltejs/vite-plugin-svelte"

// https://vite.dev/config/
export default defineConfig({
	plugins: [svelte()],
	server: {
		host: true, // expose on LAN (use host machine IP from other devices)
		port: 5173,
	},
})
