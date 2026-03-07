# Mtherios — Architecture

## Overview
Mtherios is a lightweight AI-powered interactive fiction web app, forked from [Aventuras](https://github.com/AventurasTeam/Aventuras) architecture. It runs as a pure web app (no Tauri/Electron), designed mobile-first for iPhone Safari.

## Stack
- **Frontend:** SvelteKit 5 + TypeScript + Tailwind CSS 4
- **Persistence:** IndexedDB via Dexie.js (replaces Tauri SQLite)
- **AI:** Vercel AI SDK with multi-provider support (OpenRouter, NanoGPT, Anthropic, OpenAI, xAI, Groq, Mistral, Deepseek)
- **Icons:** Lucide Svelte
- **UI Components:** shadcn-svelte (bits-ui)
- **Deploy:** Static site (Vercel, Netlify, or any static host)

## What's IN (from Aventuras)
- Generation Pipeline (Pre → Retrieval → Narrative → Classification → Translation → Image → Post)
- Service Factory pattern (13 specialized AI services)
- Lorebook system (keyword + relevance + LLM-based entry injection)
- World state tracking (characters, locations, items, story beats)
- Chapter memory system (auto-summarization, retrieval)
- Image generation (inline + analyzed modes)
- Template system (genre templates, custom prompts)
- Multi-provider LLM support
- Story import/export
- SillyTavern character card import
- Translation support

## What's OUT
- Tauri 2 / Rust backend
- SQLite (replaced by IndexedDB)
- Harper.js grammar checking
- Device sync / QR pairing
- 27 theme variants (single Mtherios theme)

## Theme
Single dark medieval theme: "Mtherios"
- Palette: void blacks, cold stone grays, cathedral gold accents, crimson highlights
- Typography: Cinzel (display), Cormorant Garamond (body), JetBrains Mono (code)
- Grain texture overlay, cathedral light glow effect
- See `nanogpt-medieval/index.html` for the design scaffolding

## Data Model (IndexedDB via Dexie.js)

### Tables
- `stories` — Story metadata, settings, memory config
- `storyEntries` — Individual story entries (user actions + narrations)
- `characters` — Character entities with visual descriptors, portraits
- `locations` — Location entities with visit tracking
- `items` — Item entities with equipment state
- `storyBeats` — Quest/plot progression tracking
- `chapters` — Chapter summaries and metadata
- `lorebookEntries` — Lorebook entries (universal entry system)
- `embeddedImages` — Generated images linked to story entries
- `checkpoints` — Named save states
- `branches` — Story branching support
- `settings` — App settings (API keys, model preferences, UI settings)

### Schema matches Aventuras types exactly — see `src/lib/types/index.ts`

## AI Services Architecture

```
AIService (orchestrator)
├── NarrativeService — Story generation (streaming)
├── ClassifierService — World state extraction from responses
├── MemoryService — Chapter analysis, summarization, retrieval
├── SuggestionsService — Creative writing direction hints
├── ActionChoicesService — RPG-style multiple choice actions
├── StyleReviewerService — Repetitive phrase detection
├── EntryInjector — 3-tier context injection
├── EntryRetrievalService — Lorebook entry retrieval
├── LoreManagementService — Agentic lorebook updates
├── AgenticRetrievalService — Tool-using chapter search agent
├── TimelineFillService — Static chapter context gathering
├── TranslationService — Multi-language support
├── ImageAnalysisService — Scene detection for images
└── BackgroundImageService — Background scene generation
```

Each service gets a `serviceId` and resolves its model preset via `settings.getServicePresetId()`.

## Generation Pipeline Phases

```
1. PreGenerationPhase — Input processing, visual prose detection
2. RetrievalPhase — Lorebook injection, chapter memory retrieval
3. NarrativePhase — Core LLM story generation (streaming)
4. ClassificationPhase ─┐ (parallel)
5. BackgroundImagePhase ┘
6. TranslationPhase — Optional output translation
7. ImagePhase — Scene image generation
8. PostGenerationPhase — Suggestions, action choices
```

## Project Structure

```
mtherios/
├── src/
│   ├── lib/
│   │   ├── components/       # Svelte components (ported + restyled)
│   │   │   ├── layout/       # AppShell, Header, MobileNav
│   │   │   ├── story/        # StoryView, ActionInput, StoryEntry
│   │   │   ├── lorebook/     # Lorebook management
│   │   │   ├── memory/       # Chapter memory UI
│   │   │   ├── world/        # Character, Location, Inventory panels
│   │   │   ├── settings/     # Settings modal
│   │   │   └── ui/           # shadcn-svelte primitives
│   │   ├── services/         # Business logic (ported from Aventuras)
│   │   │   ├── ai/           # AI services (direct port)
│   │   │   ├── generation/   # Generation pipeline (direct port)
│   │   │   └── database.ts   # NEW: IndexedDB via Dexie.js
│   │   ├── stores/           # Svelte 5 runes stores (ported)
│   │   ├── types/            # TypeScript types (direct port)
│   │   └── utils/            # Utilities
│   ├── routes/               # SvelteKit routes
│   └── app.css               # Mtherios theme
├── static/                   # Static assets
├── package.json
├── svelte.config.js
├── tailwind.config.ts
└── vite.config.js
```

## Phase 1 — Foundation (Current)
1. SvelteKit project scaffold with Tailwind + shadcn-svelte
2. IndexedDB persistence layer (Dexie.js)
3. Port types from Aventuras
4. Port AI core (providers, factory, SDK adapters)
5. Mtherios theme CSS
6. Basic AppShell with responsive mobile layout

## Phase 2 — Core Features
1. Story creation / library view
2. StoryView with streaming narrative
3. ActionInput with mode switching
4. World state panels (characters, locations, items)
5. Lorebook system

## Phase 3 — Advanced
1. Chapter memory system
2. Image generation integration
3. Template system
4. Story import/export
5. SillyTavern card import

## Reference
- Aventuras source: `~/.openclaw/workspace/mtherios-ref/`
- Design scaffolding: `~/.openclaw/workspace/nanogpt-medieval/index.html`
