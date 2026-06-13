# Shelves Lore Character Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app open on a shelf-style story library, add a story Lore workspace, move player-character prompt authority to the World Drawer protagonist record, and add canonical character creation controls.

**Architecture:** Keep the terminal backend/Postgres database as canon and the browser as a control surface. This slice does not introduce a separate global-lore table; it presents the current terminal world database as the shared shelf lore workspace and keeps story-specific canon writes routed through existing record/character APIs.

**Tech Stack:** Svelte 5, SvelteKit, TypeScript, Postgres/Drizzle terminal APIs, existing engine command gateway.

---

### Task 1: Shelf Library Surface

**Files:**
- Modify: `src/lib/components/layout/AppShell.svelte`
- Modify: `src/lib/components/library/LibraryPanel.svelte`

- [ ] Rename the top-level Library label to Shelves.
- [ ] Present the library page as a shelf dashboard with one default shared lore shelf containing all stories.
- [ ] Keep existing create/import/export/delete story behavior intact.
- [ ] Keep opening a story through `app.openStory(storyId)`.

### Task 2: Story Lore Workspace

**Files:**
- Modify: `src/lib/components/story/StoryView.svelte`
- Modify: `src/lib/components/database/WorldExplorer.svelte`

- [ ] Add a Story workspace tab state: `play` and `lore`.
- [ ] Add a Lore button in the story header and tray menu.
- [ ] Render `WorldExplorer` inside the story when the Lore tab is active.
- [ ] Let `WorldExplorer` accept an optional `storyId` prop so story-local Lore opens on the active story instead of asking the user to choose a story.
- [ ] Keep the existing system Database Viewer unchanged when no story id prop is passed.

### Task 3: Protagonist Prompt Authority

**Files:**
- Modify: `src/lib/types/index.ts`
- Modify: `src/lib/stores/story.svelte.ts`
- Modify: `src/lib/components/story/WorldDrawer.svelte`
- Modify: `src/lib/server/turn/promptPacket.ts`

- [ ] Store protagonist prompt under the protagonist character/entity metadata or state, not `stories.headerPrompt`.
- [ ] Keep story `headerPrompt` for broad story tone/rules only.
- [ ] Update World Drawer player tab to load/save protagonist prompt from the protagonist record.
- [ ] Update server prompt packet to render a distinct Player Character section using protagonist name, description, assets, prompt, and player reputation.
- [ ] Keep older stories compatible by falling back to empty protagonist prompt when no metadata exists.

### Task 4: Create Character Tab

**Files:**
- Modify: `src/lib/components/story/WorldDrawer.svelte`
- Modify: `src/lib/stores/story.svelte.ts`

- [ ] Add a World Drawer `Characters` tab.
- [ ] Provide fields for name, description, status, visibility note, aliases, traits, appearance, voice, mannerisms, personality, current location, faction, rank, and role.
- [ ] Create characters through existing canonical character APIs so records project into `entities` and lorebook views.
- [ ] Show created characters in the story/lore list without requiring a reload.

### Task 5: Verification

**Commands:**
- `npm.cmd run check`
- Focused Vitest tests if touched testable prompt/store helpers exist.
- Browser reload at `http://127.0.0.1:5173/`.

- [ ] Verify the main page says Shelves and still opens stories.
- [ ] Verify story Lore opens the current story database view.
- [ ] Verify saving player prompt no longer changes story `headerPrompt`.
- [ ] Verify the prompt audit/server debug view shows player-character prompt in its own section.
- [ ] Verify a new character can be created and appears in the character list.
