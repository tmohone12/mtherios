<script lang="ts">
	// Welcome page — shown when no story is active
</script>

<div class="flex h-full flex-col items-center justify-center gap-8 px-4 pb-20">
	<!-- Emblem -->
	<div class="relative">
		<svg viewBox="0 0 64 64" fill="none" class="h-20 w-20" style="filter: drop-shadow(0 0 20px rgba(212, 168, 83, 0.3));">
			<path d="M32 6L8 20v24l24 14 24-14V20L32 6z" stroke="url(#goldGrad)" stroke-width="1.5" fill="none"/>
			<path d="M32 6v52M8 20l24 14 24-14M8 44l24-14 24 14" stroke="url(#goldGrad)" stroke-width="0.8" opacity="0.3"/>
			<circle cx="32" cy="32" r="8" fill="url(#goldGrad)" opacity="0.15"/>
			<circle cx="32" cy="32" r="4" fill="url(#goldGrad)" opacity="0.5"/>
			<defs>
				<linearGradient id="goldGrad" x1="0%" y1="0%" x2="100%" y2="100%">
					<stop offset="0%" stop-color="#d4a853"/>
					<stop offset="100%" stop-color="#f0d078"/>
				</linearGradient>
			</defs>
		</svg>
	</div>

	<!-- Title -->
	<h1 class="font-display text-3xl font-normal tracking-wide text-[var(--text-primary)]">
		Mtherios
	</h1>

	<p class="max-w-md text-center text-lg text-[var(--text-muted)]">
		AI-powered interactive fiction.<br/>
		Your stories, your rules, your world.
	</p>

	<!-- Quick actions -->
	<div class="flex flex-wrap justify-center gap-3">
		<button class="flex items-center gap-2 rounded-full border border-[var(--border-primary)] px-5 py-2.5 text-[var(--text-muted)] transition-all hover:border-[var(--color-gold-600)] hover:text-[var(--text-primary)] hover:bg-[rgba(212,168,83,0.05)]">
			<span>📖</span>
			<span class="font-display text-sm tracking-wider uppercase">New Story</span>
		</button>
		<button class="flex items-center gap-2 rounded-full border border-[var(--border-primary)] px-5 py-2.5 text-[var(--text-muted)] transition-all hover:border-[var(--color-gold-600)] hover:text-[var(--text-primary)] hover:bg-[rgba(212,168,83,0.05)]">
			<span>📜</span>
			<span class="font-display text-sm tracking-wider uppercase">Import</span>
		</button>
		<button class="flex items-center gap-2 rounded-full border border-[var(--border-primary)] px-5 py-2.5 text-[var(--text-muted)] transition-all hover:border-[var(--color-gold-600)] hover:text-[var(--text-primary)] hover:bg-[rgba(212,168,83,0.05)]">
			<span>⚙</span>
			<span class="font-display text-sm tracking-wider uppercase">Settings</span>
		</button>
	</div>
</div>
