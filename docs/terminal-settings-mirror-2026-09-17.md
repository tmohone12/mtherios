# Terminal-owned browser settings — 2026-09-17

The browser now reads the server settings on startup and when settings open, with an explicit refresh button. The provider/model, per-service configurations, narrative reasoning and context budget mirror the canonical settings. Server profiles do not download keys; the UI labels them managed on server.

Context, temperature, output and reasoning controls send narrow patches. Ordinary service saves exclude credentials, reasoning and context fields they do not own, and target changed services. Explicit provider saves can replace a secret and reject a secret accidentally entered as its reference. A visible reasoning selector replaces the previously invisible browser-only value.

Verification:

- 15 focused terminal-settings/backend-client-context tests passed, including read-only hydration, no credentials on ordinary saves, explicit secret saves and narrow context patches.
- Svelte/TypeScript: zero errors/warnings. Production build passed with existing chunk warnings; whitespace check passed.
- Restarted the idle production runtime as PID 42800; health succeeded and stderr was empty.
- Live browser displayed `google/gemini-3.8-flash`, reasoning `high`, and `Managed on server`. Settings open and explicit refresh left the canonical narrative settings timestamp unchanged (`2026-09-17T15:56:54.438Z`). No campaign turn or provider generation was submitted.

Limits: existing browser tabs must reload. Refresh occurs at startup/settings open or by button, not continuous push. Explicit service edits remain permitted; this is not a server-side lock against old clients.
