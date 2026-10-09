Agent Tools
Your Game Master and assistant (Orbit) can each use a handful of actions while they reply. Knowing what those actions are helps you understand what they can do — and what might happen when they’re working.

Shared Tools
Both the Game Master and Orbit can use these.

You can turn the Game Master’s roll, question, name generator, and research tools on or off in Game Master settings. Orbit uses its own tools and isn’t controlled by those switches.

New projects and games start with the Game Master’s roll, name generator, and research tools on. The Game Master’s question tool starts off, and you can turn it on when you want the GM to pause play for multiple-choice questions.

read
Looks at what’s saved in your project: open a single item, peek at a folder’s contents, or pull in several things at once so the agent doesn’t have to ask one by one.

This is how they find your files, settings, and the rest of your game’s material.

write
Creates something new or replaces what’s already there — new files, edits to existing ones, or changes to settings.

When they add a file and your project has automatic cover images turned on, a cover image is created for that file.

update
Changes only part of an entry instead of redoing the whole file. Think of tweaking one line on a character sheet or the title on a file while leaving everything else alone.

They use this when a small fix is enough, instead of a full rewrite ( write).

bash
A general-purpose way to search, organize, and manage your files — for example:

Search for text across files
Move files between folders
Delete or copy files
Create new file types (kinds of content your game uses)
map
Draws and edits maps on your location files — adding regions, pins, and tokens, or linking shapes to other locations. This is the tool behind requests like “sketch the kingdom’s borders on the world map.” See Map Tools and Location Systems for how maps work.

askUserQuestion
Puts a multiple-choice question (or a few) in front of you and waits until you answer, so the agent can proceed with your choice. You can pick from short labeled options or type your own answer when that’s clearer.

Orbit can use this tool by default. The Game Master can use it only when the question tool is turned on in Game Master settings.

generateImage
Creates an image from a prompt, following your project’s style instructions. Both agents have this tool only while image generation is turned on for the chat.

Game Master Only
generateNames
Comes up with character and place names with a sense of style and rhythm. The Game Master can lean on presets (fantasy, sci-fi, horror, noir) or blend flavors (Norse, Japanese, Arabic, and more). Available when the name generator is turned on in Game Master settings.

generateFileImage
Makes or remakes a cover image for a file. During normal file creation, covers are usually added automatically; this is for when you’ve specifically asked for an image.

askPlayerToRoll
When the roll tool is on, this is how the Game Master asks you to roll dice — your checks, saves, attacks, dice pools, and challenge-dice rolls. It shows a roller with why the roll matters, the dice, and sometimes a skill name. Play waits until you roll. Under the hood the call looks like this:

askPlayerToRoll({
  reason: "Check if you notice the hidden door",
  diceExpression: "1d20+3[WIS]",
  skillName: "Perception",      // optional, shown on the roller
  targetCharacterSlug: "mira",  // optional, which character is rolling
})
The diceExpression is where your game’s dice mechanics live. It accepts standard dice notation plus a few extras:

2d6+3 — dice with flat modifiers
4d6kh3, 2d20kl1 — keep the highest or lowest N dice
6d6[Pool] — label a dice group so it can be read on its own
1d6[Action]+2d10[Challenge]+3[Wits] — several labeled groups and modifiers in one roll
4dF+2 — Fate/Fudge dice (each die lands -1, 0, or +1)
1d20-1d6 — subtract one group from another
The roll comes back as raw dice data — each die face, which dice were kept, labeled modifiers, per-group subtotals, and a sum total. The Game Master interprets the faces by your game’s rules (counting successes in a pool, comparing action dice to challenge dice), then calls the outcome. The total is just a convenience sum; pool and challenge-dice systems ignore it.

Building your own system? The Game Master is instructed not to default to d20 — it rolls whatever expressions your rules call for. Spell your core roll out in your GM instructions (for example “resolve checks with 1d6[Action]+2d10[Challenge] plus a stat modifier”) and the roller will match your mechanics.

gmRollDice
The Game Master’s own dice. Where askPlayerToRoll hands you the dice and waits, gmRollDice rolls immediately and keeps the turn moving — NPC attacks and saves, damage, random encounters, loot tables. The result shows up as a roll card in the chat. It’s always available to the Game Master; the roll toggle only controls player rolls.

gmRollDice({
  reason: "Goblin attacks with shortbow",
  diceExpression: "1d20+4",
  fileName: "Goblin.monster",  // optional, shows the NPC's portrait on the card
})
It takes the same dice notation as askPlayerToRoll and returns the same breakdown of die faces, groups, and totals for the Game Master to read by your game’s rules.

research
Sends a short-lived helper to answer focused questions — like “what’s this character’s AC?” or “did the party already meet this NPC?” — while the main reply keeps its place. The helper searches your project’s files and the game’s message history and reports back just the facts, so the Game Master doesn’t fill its memory with whole files.

That helper only reads; it can’t edit or delete anything. A run generally costs around 0.5–1 credit but usually saves energy overall. See The Research Tool for the full story.

Orbit (Assistant) Only
revert
Rolls a file — or a file type's schema, layout, and settings — back to an earlier version from its history. Useful when an edit went wrong — ask Orbit to undo it rather than reconstructing the old content by hand. Reverting always asks for your approval first, and so does clearing a file type's layout. See Version History and Retention for how versions work.

subagent
Spawns parallel helper agents for wide, repetitive jobs — updating dozens of files at once instead of one at a time. See Assistant Subagents for the full story.

Inside a game, Orbit also sees the recent chat: the latest game messages are available to its read tool, so it can answer questions about what just happened. For digging deeper into a long transcript, the Game Master’s research helper is the tool that searches full game history.
The Research Tool
Research is a helper the Game Master can send off to look things up for it. Instead of reading whole character sheets, lore entries, and chat transcripts into the middle of a reply, the Game Master hands a few focused questions to a fast research helper. The helper searches your project’s files and your game’s message history, then hands back a short, cited answer — just the facts the Game Master actually needs.

What it’s used for
“Tell me about X” — who a character is, what an item does, the key facts about a faction or place.

Rules and stats — a character’s AC, how a spell works, what your custom rules say about a situation.

Places and distances — where something is, and how locations relate to each other.

“Did this happen already?” — the helper can search the full game transcript, so the agent can check past events, plans, and decisions that have long scrolled out of view.

Why it exists
Every fact an agent reads stays in its context for the rest of the reply — and big, cluttered context makes AI slower, more expensive, and more forgetful (see Context Rot). Research keeps the main agent’s context lean: it gets a two-line answer instead of a two-thousand word file. That means:

Lower cost overall. A research run generally costs around 0.5–1 credit, but it usually saves more than it costs. Without it, the agent reads entire files into its context, and pays to re-read them on every following message in the conversation.

Better memory. With less clutter in its context, the agent keeps a clearer grip on your story — and the transcript search gives it a way to recall things that happened many sessions ago.

Faster answers. The helper runs on a fast model and works in a couple of quick passes, while the main agent keeps its place.

The helper only reads. It can’t edit, move, or delete anything in your project.

Turning it on or off
Research is on by default. To change it, open Game Master settings and flip the Research switch.

With research off, the Game Master falls back to reading files directly with its own tools — everything still works, it just spends more energy on long lookups and keeps more raw material in its context.
Assistant Subagents
Subagents let Orbit hand big jobs to a team of smaller helpers. When you ask for a change that touches many files at once, Orbit works out the plan, then spawns subagents that make the edits in parallel. Big batch jobs finish faster, cost less, and leave your conversation much cleaner afterward.

When Orbit uses them
Subagents shine on wide, repetitive work. Requests like these:

“Add a materials field to every gear item and fill it in.”

“Give all of my military units a little more detail.”

“Check every character and make sure they have a description.”

Without subagents, Orbit reads every file and edits them one at a time. All of those files then sit in the conversation for the rest of the chat, which makes every message after the job slower and more expensive.

See Context Rot for why that matters.

How it works
Orbit does the thinking, and the subagents do the busywork:

Orbit makes a plan. It samples a few of your files, checks the file type, and decides exactly what the change should look like.

The job gets split into batches. Each subagent receives the plan plus its own list of files to handle.

Subagents work in parallel. Each one reads only its own files, makes the edits, and reports back with what it changed.

Orbit wraps up. It spot-checks a couple of results and gives you a summary.

While the job runs, a panel appears under Orbit’s message with one row per subagent. You can watch each one work in real time, and expand a row to see everything it did and its final report.

Faster, cheaper, cleaner
Here’s a real example. We asked Orbit to add a new field to 97 gear files and fill in a value for each one.

Without subagents: 13.3 credits and about 3 minutes. Every gear file ended up in the conversation, so every message after the job cost more too.

With subagents: 4.3 credits and about 90 seconds. That’s roughly 68% cheaper and twice as fast. The conversation stayed small, so follow-up messages cost a fraction of what they would have.

What subagents can do
Subagents keep a small set of simple tools. They can read, search, create, and update the files in your project. That’s it. They can’t delete files, change your settings, or generate images. They also can’t see your conversation with Orbit. Each one only knows the instructions Orbit gave it.

Subagent work is billed like normal assistant usage. Open the cost breakdown on a message and you’ll see a Subagents line showing what the helpers spent.

Changing the model or turning subagents off
Subagents are on by default. In Orbit’s settings panel you can turn them off, or pick which model they run on. Smaller, faster models like Hy3 or DeepSeek V4 Flash 0731 are a great fit. Subagent tasks are focused enough that they don’t need a big model.
Context Visibility
Diagram comparing clean context with a good output versus noisy context where the output quality degrades
Every file in your project has a context visibility setting that controls how your Game Master uses it. This is one of the most powerful tools you have for shaping your Game Master's behavior.

These settings affect the Game Master only. Orbit uses its own context and is not controlled by file context visibility.

Think of it this way: a human GM can't memorize your entire world. They keep some notes right in front of them, skim the headers of others, and leave the rest in a binder they can flip to when needed. Context visibility lets you set up that same system for your AI.

The Three Visibility Levels
Pinned
Pinned files are loaded in full every time the GM responds. The GM reads the entire file before every message.

Use this for things the GM should always know. A few good examples:

Core rules the GM must follow every time (like "always ask what the player wants to do next")
The GM's personality and tone instructions
Memory and note-taking instructions
Be selective. Every pinned file takes up space in the AI's working memory. Pin too much and the important stuff gets buried. Think of pinning like taping a note to the GM's screen: it only works if there are just a few notes up there.

Partial
Partial files load only the title and description into context. The GM sees a summary of what the file is about, but doesn't read the full content unless it decides to look it up.

This is the sweet spot for most of your important content:

Frequently used + Situational instructions or rules. Skill checks = frequently used and situational. Death saves = infrequently used and situational. I would set instructions about handling skill checks to pinned, but death saves as searchable.
Key NPCs you want to keep referenced
Situational Meta/system instructions, like what the game master should do after you've completed a quest objective
The GM sees something like "Thornwall Compact: a merchant alliance of six city-states dealing in trade disputes and political intrigue" and knows it can pull up the full details when the conversation turns that direction.

Searchable
Searchable files aren't loaded into context at all. The GM doesn't see them up front, but it can search for and find them when it needs to.

This is the default, and it's the right choice for most content:

Lore
Most Rules
Pretty much anything else
The GM won't know these exist until it goes looking, but it can search across all your files whenever it needs to. If a player asks about an obscure historical event, the GM will search your world's content and find the answer.

Setting Visibility
You can set context visibility at two levels:

On a file type. This sets the default for every file of that type. For example, you might set your "Core Rules" file type to Pinned and your "Lore" file type to Searchable. Edit a file type and choose the visibility in the settings.

On an individual file. This overrides the file type default. Maybe your Lore type is set to Searchable, but there's one critical lore entry you want the GM to always have a summary of. Set that specific file to Partial.

The override order is: file setting > file type setting > searchable (the default).

You'll see a small icon next to each file in your project tree showing its current visibility. Hover over it to change it.

The Recommended Split
As a rule of thumb, aim for roughly:

1-3 of your files Pinned — just the essentials the GM must follow every time
1-15 of your files Partial — key references the GM should know exist
Everything else Searchable — the vast majority of your content
If you find yourself pinning more than a handful of files, you're probably overloading the GM's working memory. The more you pin, the less attention each pinned file gets. This is the main driver of context rot — that slow drift where the GM starts forgetting rules and giving generic responses. Keeping your pinned and partial counts low is the single best thing you can do to keep your GM sharp.

Tips for Setting Up Visibility
Pin sparingly. Aim for just a handful of pinned files. These are your "GM's cheat sheet" items that should be followed in every single response.
Use Partial for your world's key elements. Characters, locations, and factions the GM should know about but doesn't need to recite from memory.
Leave most content as Searchable. Your deep lore, supplementary material, and reference tables work great here. The GM can find them when relevant.
Write good titles and descriptions. For Partial files, the title and description are all the GM sees by default. Make them clear and descriptive so the GM knows when to look up the full content.
Keep pinned files short. Since these load in full every time, keep them focused. A pinned file with 200 words hits harder than one with 2,000.
Your Game Master can only hold so much in its head at once. Progressive disclosure is the idea that the AI should start with a small, focused set of information and pull in more detail only when it needs it.

These visibility layers apply to the Game Master only. Orbit uses its own context and is not controlled by file context visibility.

This might sound like a technical concept, but you already understand it intuitively. When you prep for a tabletop session, you don't memorize every NPC's backstory, every room in the dungeon, and every rule in the book. You keep your key notes handy, skim your prep, and look things up when the moment calls for it. That's progressive disclosure.

Flow diagram showing how the GM pulls in information step by step: starting with core context, then retrieving a character file when a player asks about them, combat rules when a fight starts, and location details when players explore a ruin
Why It Matters
When an AI has too much information loaded at once, a few things go wrong:

Important details get lost. Imagine reading a 50-page document and then being asked a question about page 23. The more you're holding in your head, the harder it is to focus on what matters right now.
Responses slow down. More loaded content means longer processing time for every message.
Instructions compete. If you've loaded 20 files of rules, some of them will inevitably contradict each other in edge cases. The AI ends up hedging instead of making confident calls.
The solution isn't to give the AI less content. It's to give it the right content at the right time.

The Three Layers
Craft's context visibility system is built around three layers of progressive disclosure.

Pyramid diagram showing three layers of progressive disclosure: Pinned (1-3 files, always loaded) at the top, Partial (up to 15 files, summaries loaded) in the middle, and Searchable (hundreds of files, found when needed) at the base
Layer 1: The Cheat Sheet (Pinned)
This is what the GM has taped to their screen. A few critical files that apply to every single moment of the game: the GM's personality, core rules, the current situation. These are always loaded, so they need to be lightweight and high-signal.

Think of this layer as a directory. It should remind the GM who it is, what matters most, and where to look for everything else. A well-written pinned file might be only a paragraph or two, but it orients the entire session.

Layer 2: The Prep Notes (Partial)
This is the GM's session prep binder, open on the table. The GM can see the tabs and titles. They know what's there, and they can flip to any file in a moment.

In Craft, Partial files load their title and description into context. The AI knows "there's an NPC named Captain Reva who commands the harbor guard" without having her full backstory and stat block taking up space. When a player walks up to Captain Reva, the GM pulls up her full file.

This is where most of your key content should live. The AI knows your world has these elements, and it knows where to find the details.

Layer 3: The Library (Searchable)
This is everything else: the full bookshelf behind the GM's chair. Deep lore, historical records, detailed stat blocks, supplementary material. The GM doesn't know exactly what's on every shelf, but they know they can search through it all.

Searchable content isn't in the AI's working memory at all, but it's fully searchable. When a player asks "what happened during the War of Silver Thorns?" the GM searches your world's content and finds the answer.

Getting the Balance Right
The goal is a pyramid: very little at the top (Pinned), a moderate amount in the middle (Partial), and the bulk of your content at the base (Searchable).

A common mistake is pinning too much. If you pin 30 files of rules, you've basically handed the GM a novel and asked them to keep it all in mind while running a conversation. The important stuff drowns.

A better approach:

Pin 1-3 files max. These should be short, focused instructions and the most critical rules.
Set up to 15 key files to Partial. Characters, locations, factions, major plot points. The AI sees the summaries and fetches details on demand.
Leave everything else Searchable. Hundreds of files of lore, encounters, items, and reference material can live here without hurting performance.
Writing for Each Layer
The way you write content should match how the AI uses it.

For Pinned files, write concisely. Every sentence should earn its place. Use bullet points, keep paragraphs short, and focus on actionable instructions. This isn't the place for flavor text or backstory.

For Partial files, invest in your titles and descriptions. These are the only parts the AI sees by default. A description like "A city" tells the GM nothing. A description like "The largest port city in the Ironcoast, known for its black market and corrupt harbor guild" gives the GM enough to reference it naturally in conversation and know when to look up more.

For Searchable files, write as much as you want. Go deep on lore, history, and detail. This content only gets loaded when the AI searches for it, so length isn't a concern. The richer your searchable content, the better the GM's answers will be when players dig into specifics.

Examples
Content	Visibility	Why
GM personality and tone	Pinned	Applied to every response
"Write a scene log when you finish a scene"	Pinned	A short, always-on instruction
Core combat rules	Partial	Referenced often, but only during combat — GM can pull up the full rules when a fight starts
Major NPCs (key characters)	Partial	GM knows they exist, fetches details when they appear
Everything Else	Searchable	Most files should be searchable, so they don't bloat your context
Notice only two files are pinned — both short, both applicable to every single response. The combat rules are important, but they're situational, so Partial is the right fit. The GM sees a summary of the combat rules and loads them in full when a fight breaks out.

The GM starts every conversation knowing its personality, its key instructions, and a light overview of the characters and places. As the session unfolds and players interact with specific parts of your world, the GM pulls in exactly what it needs.

That's progressive disclosure: the right information, at the right time, in the right amount.