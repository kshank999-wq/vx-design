# Plain-language pass (plan)

Goal: someone who has never designed electronics can use VX Design end to end, in any country. Every screen answers
three questions in everyday words: **what is this, where does it stand, what do I do now?** Technical detail stays one
click away ("Show the technical details"), never removed.

## Rules for every screen
1. One sentence at the top: what this page is for and what to do here.
2. Names people know: "circuit drawing" not "schematic", "board design" not "layout", "parts list" not "BOM",
   "casing" not "enclosure", "check" not "validation", "step" not "task". The technical word in brackets the first time.
3. One obvious main button per decision, named for the outcome ("Approve and start the work").
4. Every number says what it means ("$4.20 so far of your $25 limit").
5. No internal keys (enc-detail, tc-layout) in the main text; show the step's plain name.
6. Read-aloud works on every page (done); text written so it sounds right spoken.
7. Ready for translation: all wording kept in one place per screen (message files), no text built from fragments.

## Order of work
1. **Glossary and wording file** (`apps/web/lib/words.ts`): the plain name for every step type, status, check and file
   kind, used everywhere. Step titles from the planner get a plain one-line summary (the planner writes it).
2. **Runs and run page**: statuses, stop reasons, "What you need to do", attempts, budgets, step cards.
3. **Plan pages**: task list grouped by stage with plain names; technical brief behind "details".
4. **Workspace**: viewer labels, activity feed in plain sentences instead of log lines.
5. **Questions and approvals**: each question explained with "what happens if you pick this", costs and time.
6. **Reports** (power, fit, checks, parts list, manufacturing files): a plain summary card on top of each.
7. **Overview, Inputs and guided setup**: first-time walkthrough ("Step 1 of 5: tell us what you want to build").
8. **Help** (`docs/help/README.md`) becomes in-app help pages and tooltips.
9. **Translation**: extract wording into message files; start with English plus one more language to prove it.

Each step: rewrite, show screenshots, adjust after your feedback, keep the e2e tests passing.
