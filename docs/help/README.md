# VX Design help (draft content)

Plain-language help for people using VX Design. Each section is written to become a help page or a tooltip as-is.
Add to it whenever a screen or a word needs explaining; keep the wording for someone who has never designed a board.

---

## Runs and steps

### What a run is
A **run** works through an approved plan, step by step (requirements, schematics, parts, board layouts, enclosure,
manufacturing files...). Runs are numbered in the order they started: Run 1, Run 2, and so on. Only one run of a plan
works at a time. If you restart an older run while another is working, the other one is **replaced**: its finished
work is kept and the steps it was in the middle of move over to the run you restarted.

Colours: **green** = working now, **amber** = stopped or paused and waiting for you, **gray** = replaced by a later
run, **red** = canceled or failed, **blue** = completed.

### What "attempts" means
An **attempt** is one complete try at a step, from the start. For a board layout, one attempt is:

1. the AI places all the parts on the board;
2. the router connects them with copper wires;
3. if something is left unconnected, the AI rearranges and tries again, up to 4 rounds;
4. if it still is not fully connected after the 4th round, that attempt has failed.

The number counts **every** try for that step over its whole life, across all runs and restarts. It goes up when:

- a run gives a failed step its automatic retry (each run allows a couple of retries per step);
- you press **Try again**, a green **suggested fix**, or **Bring back and do it now**;
- the step is restarted after the run was stopped.

Interruptions do **not** add to it. When a worker is updated or restarted, the step is handed back and carries on as
the same attempt.

**Is a high number good or bad?** A few attempts is normal: the AI learns from what went wrong in the last one. A high
number with the same failure each time (for example "40 connections left unrouted", again and again) means the step is
going in circles. More tries will not help. Each attempt costs money, so stop and change something instead:

- press a green **suggested fix** (for example "Make the board bigger" or "Put +3V3 on an inner plane");
- **Give guidance** in your own words;
- **Put on hold and move on**, so the rest of the work continues without it;
- or ask us to look at it. A failed layout keeps its last board so it can be checked or finished by hand.

### The progress bar
Each step being worked on shows an **estimated** progress bar, with time left. It is worked out from:

- how long finished steps of the same kind usually take in your project, and
- for steps that work in rounds (layouts, schematics, enclosures, power, analysis), which round it is on.

It never shows 100% until the step is really done. It turns **amber** and says "taking longer than usual" when a step
runs well past its normal time. The estimate gets better as more steps finish.

### What you need to do
The orange box on a run lists what needs you:

- **Could not finish**: a step failed. Read "The problem", then press a green suggested fix, **Try again**, **Give
  guidance**, or **Put on hold and move on**.
- **On hold**: steps you chose to skip for now. The work after them carried on without their result. Press **Do it
  now** when they can be done.
- **Saved for later**: steps set aside without being skipped. Press **Bring back and do it now** to run them.
- **Waiting for you**: results to approve.
- **Questions**: questions the design work raised. The work does not wait for them, but your answers guide later
  steps. Each question has **"I have a question about this"** if you need it explained before answering.

### Why a run stops
A run stops when nothing more can happen without you: a step failed, something needs approval, or a budget was
reached. Each run has its own **AI budget** and **compute budget**. The account's plan may also set a monthly
allowance; when it is used up, runs stop until the 1st or until an administrator moves the account to another plan
(Admin, then Accounts and plans). The stop reason at the top of the run says which one it was.

### The badges on "Runs"
Above **Runs** in the project menu: **running** (green) = a run is working; **N to approve** (amber) = results waiting
for your approval; **N problems** (red) = steps that could not finish.

### Talking to the design agent
The chat is on every project page: on the run page it is the left column; elsewhere press **Ask the design agent**
in the bottom-right corner (it remembers whether you left it open). Use it to ask what something means, or to make a
comment the design work should follow. On the run page, pick a step under **About** to give that step guidance: its
next attempt follows it, and the step shows **Following your guidance** while it works.

### What a working step is doing
Under each step being worked on, **What it is doing** says what the step was asked to produce, and **Following your
guidance** shows the latest guidance it is using. If either looks wrong (for example a frame material you changed),
say so in the chat with that step selected, or press **Pause**.

### Pausing and giving new orders
**⏸ Pause** and **▶ Resume** are next to the run's status at the top of the run page. While a run is paused (or stopped),
the panel still says what it was doing and what it carries on with next, with each step's brief.

To give new orders, write them in the chat. When your message carries new information or a decision (for example "the frame
is injection molded now, not aluminium"), the agent:
1. pauses the work, so nothing more is built on the old plan;
2. compares it with every step's brief, the requirements, the concepts and the mock-ups, and lists the **differences found**;
3. proposes the **updated plan** and asks "Is this correct?".
Press **Yes, update the plan** to draft the new plan version (review and approve it on the plan page), or **No, carry on** to
resume as before.

### Plans are checked against the concepts and mock-ups
The first time a plan is submitted for approval, the design agent reads every step's brief against the frozen concept look,
the design freeze, the requirements and the mock-ups. If anything disagrees (a material, a construction method, a part, a
shape or a size), the plan is not submitted yet: the differences and a proposed plan update appear in the chat with **Yes,
update the plan**. Settle them, or submit again to go ahead as it is.

---

## Enclosures

### A casing built around the screen
When the product has a screen, the enclosure step designs the casing around it, not just around one board:

- the **front bezel** (the lid) has an opening over the screen's active area, and a small gap behind it for a gasket that
  holds the screen in place;
- the **back shell** (the base) holds the main board on standoffs, with the other boards placed beside it;
- the outline covers the screen and every board, with rounded corners, and the walls are drafted when the casing will be
  injection molded, so the printed prototype already has the molded shape.

The fit check measures every part, every board and the screen against both halves. If something collides, the step
names it and tries again. Sizes come from the display's datasheet or the step's brief; check them on the enclosure page,
and say in the chat if the screen or a board should sit somewhere else.

---

## Listening instead of reading
Every screen has a **speaker button** at the top right. It reads the page aloud, one block at a time, and highlights the
block being read. You can pause, go back one, skip ahead and change the speed. To hear just one part, select that text
first, then press the button. It uses your browser's own voice, so it is free and nothing leaves your computer.

## Approving a plan
Before **Submit for approval** and **Approve as baseline**, the plan page shows **What you are approving**: the steps
that changed (what they were and what they are now), the steps added or removed compared with the plan in use, and which
steps a run will do again. Unchanged finished steps are reused, not paid for twice. Submitting does not start any work:
after approval, start a run from the same page.

## Proposed plan updates
When the design agent suggests changing the plan (from something you said in the chat, or from comparing the plan with your
concepts and mock-ups), the suggestion appears in the chat **and** in its own **Proposed plan updates** section at the top of
the Workspace and on the Questions page. It is one decision wherever you make it:
- **Yes, update the plan** makes a new draft plan version; nothing changes until you approve it;
- **Not needed** (or **No, carry on** when the work was paused for it) closes it;
- once a plan is approved after a suggestion was made, the suggestion is **out of date** and leaves the section (the chat
  keeps a one-line note), so an old idea can never undo a newer decision.

## Long text
Long descriptions (what a step is doing, your guidance, summaries) show the first few lines with **Read more** to open
the rest in place.

## Your mock-up is the concept
A mock-up added on Inputs is used as the concept: the plan and the casing are checked against it. To record it as the
decided look, open Concepts and press **Freeze REF-n as the concept**. AI concept variations are optional.

## The design viewer (Workspace)
The middle of the Workspace is a viewer with tabs, like a CAD tool:
- **Files**: everything the steps made, grouped by step;
- **Schematic**: each board's circuit drawing (zoom with + and −, drag to move);
- **Layout**: each routed board from the top and the bottom;
- **3D view**: each board with its parts, plus the **casing put together** (see-through lid, so you can see how the screen,
  the boards and the parts fit) and the **casing laid open**;
- **Concepts**: your mock-up and any concept rounds.
Pick the board with the buttons under the tabs. Work in progress shows too, labelled "work in progress, not checked yet",
so you can watch a board or the casing take shape; "accepted" means its checks passed and it was approved.

## Badges and alerts
The project menu shows what needs you: **plan vN: submit / approve** on Overview, **N plan updates** on Workspace,
**running / paused / stopped / N to approve / N problems** on Runs, and the number of open questions on Questions.
When something new comes up while you are on the site (a run stops, a result waits for approval, a new question), a note
appears in the bottom-right corner. Press **🔔 Turn on alerts** once to also get desktop notifications.

## Out-of-date plan drafts
A draft made before a newer plan was approved is marked **Out of date: do not approve this draft**, because approving it
would undo the newer plan's changes. Press **Archive this draft** to move it to the plan archive (it is kept for reference, never deleted). The Overview shows the **plan in use**.

## Who approves a plan, and how
**You do. The design agent never approves anything; it only proposes.** On a draft plan you see **What you are approving**
(what changes, and which steps will run again), then one decision:
- **✓ Approve and start the run**: the plan becomes the one in use, the run on the old plan stops, and a new run starts
  with your last run's budget and settings. Unchanged finished steps are reused.
- **Approve only**: approve now, start the run later from the same page.

The first time, the agent compares the plan with your concepts and mock-ups. If it finds differences they appear at the
top of the plan page: choose **Approve anyway, as it is**, or **Yes, update the plan** to make one new version with the
fixes. That new version is not checked again, so you approve it directly: no going in circles. An engineer (not the
owner) sees **Submit to the owner for approval** instead.

## Changing the plan without starting over
When something changes (new information, a decision, a fix), the plan is **updated, not rebuilt**. Before you approve, the
plan page says in plain words **What changes if you approve**:
- **Taken out**, **Changed** (what it was and what it says now) and **New** steps;
- **Then the work continues in this order**: only the steps that must be done (again), in the order they depend on each
  other, each with the reason;
- **Already done and still valid**: steps that build on a change but are not affected by it. The design agent checks each
  one (for example, a new casing material does not change a circuit board), so their finished work is kept. Tick any you
  want redone anyway;
- the estimated AI cost of the steps to do, from what they cost last time.

Then press **Approve and start the run**: the work carries on from there.

## The Plan page
**Plan** in the project menu (after Inputs) shows the latest plan: the new version waiting for you, or the one in use.
- **✓ Approve this plan** (green, top right) approves it and starts the work again; only affected steps are redone.
- Each step is **highlighted in the colour of the plan version that last changed it** (v2 pink, v3 beige, v4 green, v5
  blue, and so on; the first plan has no colour).
- The **Changes** list on the right shows every change, newest first, in the same colours. Click one to jump to the step.
- **Earlier versions** lists every plan with what it changed.

The menu is in the order you work: Overview, Inputs, Plan, Questions, Runs, Workspace, AI usage.
