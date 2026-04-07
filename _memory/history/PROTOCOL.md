# Session History Protocol

Copy of the Context OS history protocol. See `../Context OS/_memory/history/PROTOCOL.md` for the canonical version.

## How It Works

- Keep up to 5 session files in history/ at a time
- When adding a 6th, delete the LEAST RELEVANT (not the oldest)
- Before deleting: absorb its key knowledge into identity.md or decisions.md
- The deleted session's synthesis moves to "Faded Sessions" in SESSION-INDEX.md

## Writing a Session Record

After every session, create a file named `YYYY-MM-DD-[a|b|c].md` with:
- What the user asked for
- What was done (files created/modified, decisions made)
- Key outcomes and open threads
- Any corrections AD made

Then add a summary entry to SESSION-INDEX.md under "Active Sessions".

## Weight System

Each session entry has a weight (1-3):
- 3 = highly relevant to current work (recent, related to active tasks)
- 2 = moderately relevant (older but still useful context)
- 1 = low relevance (superseded by newer decisions, faded context)

Adjust weights each session. Delete entries when weight drops to 0.
