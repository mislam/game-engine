<script lang="ts">
	import { onMount } from "svelte"
	import { runGame } from "engine-client-pixi"
	import { tagtag } from "tagtag"

	let container = $state<HTMLDivElement | null>(null)

	onMount(() => {
		if (tagtag.title) document.title = tagtag.title

		if (!container) return
		return runGame(container, tagtag)
	})
</script>

<div bind:this={container} class="game"></div>

<style>
	.game {
		width: 100vw;
		height: 100vh;
	}

	.game :global(canvas) {
		display: block;
	}
</style>
