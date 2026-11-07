# Smart Cursor

## Agent changes

- Fix the capability or the decision rule behind a failed run. Use individual apps, sites, and prompts as regression cases. Keep their names and aliases out of runtime routing and prompts that define tool behavior.
- Choose tools by the requested outcome. Use web search for public information, browser navigation for an explicitly requested destination, and screen input for interaction with an observed interface.
- Treat a change of active app as a new observation boundary. Check which app received input and verify the result on a fresh screen before continuing.
- Record timings and tool decisions without recording queries, typed content, or screenshots.
