# Duty Don Scheduler

A web app that schedules residence duty dons fairly. Instead of shifts going to whoever replies first, every don ranks the days they'd like, marks the days they can't work, and a scheduling algorithm builds the whole month at once while meeting every requirement.


## Why

Manual first-come-first-served scheduling is slow, and leaves room for favouritism. This app replaces it with:

- **One fair pass:** everyone's preferences are considered together, so submission order doesn't matter.
- **Hard guarantees:** nobody is scheduled on a day they marked "can't work", and nobody goes over their shift limits.
- **Transparency:** the rules are in code, every generated schedule is saved as a version with its random seed, and the admin sees exactly which trade-offs were made.

## Features

**For dons (mobile-first)**
- Claim your name from a list (no account needed; anonymous sign-in under the hood)
- See your requirements: shifts and Fri/Sat shifts still needed this term
- Rank up to 4 preferred days and mark up to 3 days you can't work on a glassmorphism calendar
- Volunteer for an extra shift if one is needed
- See the published schedule, with your shifts highlighted and changes marked after a republish

**For the admin**
- Email login, protected by Row Level Security in the database
- Live view of who has joined and submitted (Supabase Realtime)
- Pre-generation checks that flag anything that could break the schedule, including a whole-schedule feasibility check
- One-click generation, then manual edits, pins, regeneration around pins, versions and publishing
- Conflict list and stats (% of shifts on a #1 pick, unranked placements, per-don totals)

## Tech stack

- **Frontend:** React (Vite) + Tailwind CSS
- **Backend:** Supabase (Postgres, Auth, Row Level Security, RPC functions, Realtime)
- **Scheduler:** plain JavaScript, running in the admin's browser (no server needed)

## Getting started

### 1. Supabase

1. Create a Supabase project.
2. Open **SQL Editor** and run the schema script (tables, triggers, views, RPC functions, RLS policies, Realtime setup).
3. Under **Authentication → Sign In / Providers**, enable **Anonymous sign-ins**.
4. Under **Authentication → Users**, create your admin account, then make it an admin:
   ```sql
   insert into public.admins (user_id) values ('YOUR-USER-UUID');
   ```
5. Create a session and add the dons (Table Editor or SQL). You only enter `name`, `house` (`BH`, `EH` or `CMH`), `current_total` and `current_weekend`; the database computes each don's min/max.
6. Check the numbers per duty group:
   ```sql
   select * from public.house_summary;
   ```

### 2. App

```bash
npm install
npm run dev
```

Create a `.env` file with your Supabase project URL and anon key, matching the variable names used in `src/lib/supabase.js`, e.g.:

```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
```

- Don view: `http://localhost:5173/`
- Admin panel: `http://localhost:5173/admin`

Use separate browsers (or a private window) for the don and admin sides. Signing in as admin replaces any anonymous don session in the same browser.

## How a round works

The admin moves the session through five stages; dons' screens follow automatically.

| Stage | Admin | Dons |
|---|---|---|
| 1 | Watch names being claimed; unclaim mistakes | Pick and claim their name |
| 2 | See who has joined | See their requirements |
| 3 | Live pre-generation checks; view or edit any don's preferences | Rank days, mark "can't work", save |
| 4 | Stats and **Generate** | Same as stage 3 |
| 5 | Review, edit, pin, regenerate, publish | See the published schedule |

Separately, the session's **status** (`setup`, `open`, `closed`, `published`) controls what the database allows: dons can only claim and submit while it's `open`. Dons only see sessions that are past `setup`.

## Scheduling rules

**Per don** (derived from shifts already done this term):

| | CMH | BH / EH |
|---|---|---|
| Term total | 10 (one don does 11) | 9 (three dons do 10) |
| Fri/Sat shifts | at least 2, at most 3 | at least 2, at most 3 |

**Hard rules** (never broken by the solver):
- Never on a "can't work" day
- Never over a don's max total or max Fri/Sat shifts
- Exactly one don per duty group per day
- Pinned slots never change

**Soft rules** (scored; lower is better):

| Rule | Penalty |
|---|---|
| Unfilled day, missed minimum, missed weekend minimum | 100,000 each |
| More than 3 shifts this month | 5,000 per shift |
| Back-to-back shifts | 1,000 per pair |
| Shifts 2–4 days apart | 90 / 40 / 10 |
| Extra shift given to a non-volunteer | 40 (20 for an extra Fri/Sat) |
| Preference: #1 / #2 / #3 / #4 / #5+ / unranked | 0 / 1 / 3 / 6 / 10 / 15 |

Preference costs grow faster than the ranks, so two people getting their #2 beats one getting #1 and the other #4.

## How the scheduler works

`src/solver.js` solves each duty group separately with **local search and restarts**:

1. **Start:** fill the hardest days first (fewest available dons), preferring dons still below their minimum and their best-ranked days.
2. **Improve:** 20,000 times, make a random valid move (give a day to another don, or swap two dons' days) and keep it if the score doesn't get worse.
3. **Restart:** repeat from 20 different random starts and keep the best schedule.

Both groups take about 0.3 seconds. Runs are reproducible: the seed is stored with each version.

Before generating, `src/preflightChecks.js` also runs a **max-flow feasibility check**: it asks whether *any* schedule could meet every hard rule and minimum. That catches problems a day-by-day check misses, such as two weekend days that only the same don can work.

All weights live in `WEIGHTS` at the top of `src/solver.js`.

## Project structure

```
src/
  App.jsx               Routing (/ vs /admin) and the don screens
  Admin.jsx             Admin panel: login, stages 1–5
  DutyCalendar.jsx      Rank / "can't work" calendar (dons and admin)
  calendarLogic.js      Pure calendar rules: limits, toggling, renumbering
  preflightChecks.js    Pre-generation checks + feasibility (max flow)
  PreflightPanel.jsx    Stage 3 checks list
  GeneratePanel.jsx     Stage 4 stats + Generate
  solver.js             Scheduler + schedule review (conflicts, stats)
  ScheduleEditor.jsx    Stage 5: versions, edits, pins, regenerate, publish
  PublishedSchedule.jsx Don-side published schedule
  useSessionData.js     Live admin data (dons, preferences, submissions)
  lib/supabase.js       Supabase client + ensureSession()
```

### Database RPC functions

| Function | Who | What |
|---|---|---|
| `claim_don(p_don_id)` | Don | Links a name to this browser's anonymous user |
| `submit_preferences(p_don_id, p_prefs, p_volunteer)` | Don / admin | Replaces a don's preferences; enforces limits for dons |
| `save_schedule(...)` | Admin | Saves a schedule as a new version |
| `publish_schedule(p_schedule_id)` | Admin | Makes a version live (published versions are frozen) |

## Deployment

Any static host works (Vercel, Netlify). Because `/admin` is a client-side route, send every path to `index.html`:

- **Vercel**, `vercel.json`:
  ```json
  { "rewrites": [{ "source": "/(.*)", "destination": "/" }] }
  ```
- **Netlify**, `public/_redirects`:
  ```
  /* /index.html 200
  ```

Supabase free projects pause after a week of inactivity, so open the dashboard before a round starts.

## Roadmap

- Shift swap requests between dons
- CSV import of the don list
- Per-session term targets (currently built into the database's generated columns, for this term's final round)
- Fairness carried across months (history of who got which days)
- Pairing rules (e.g. never two first-year dons together)
