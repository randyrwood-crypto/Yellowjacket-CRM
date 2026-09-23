# Yellowjacket Sales CRM

A real, multi-user version of the Sales CRM: everyone signs in with their own
name and password, all data lives in a real database, and there's no
"invite each person as an Editor" step — you add someone once on the Team
page and they can sign in and save from anywhere, immediately.

- **Admin** — sees and edits every lead and lost opportunity, manages the
  team (add/remove people, reset passwords), can reassign a lead to a
  different salesman.
- **Salesman** — sees and can add/edit only their own leads; can log lost
  opportunities; cannot delete anything or see anyone else's accounts.

Built with Node.js + Express and a Postgres database, meant to be hosted on
[Render](https://render.com) with the code in a [GitHub](https://github.com)
repository.

---

## Part 1 — Push the code to GitHub

1. Go to [github.com/new](https://github.com/new) and create a new repository.
   Name it something like `yellowjacket-sales-crm`. Leave it empty — don't
   check "Add a README" (this project already has one).
2. On your own computer (not this chat), open a terminal in this project
   folder — the one you downloaded and unzipped — and run:
   ```bash
   git init
   git add .
   git commit -m "Yellowjacket Sales CRM"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/yellowjacket-sales-crm.git
   git push -u origin main
   ```
   Replace `YOUR-USERNAME` with your GitHub username, and the repo name if
   you chose a different one. GitHub will prompt you to sign in the first
   time you push.

   If this folder already has a git history and a commit prepared, `git
   init`/`git add`/`git commit` may say "nothing to commit" or similar —
   that's fine, just continue with the `remote add` and `push` steps.

Your code is now on GitHub. Everything from here happens on Render's
website — you won't need the terminal again unless you want to make code
changes later.

---

## Part 2 — Create the database on Render

1. Log in to [dashboard.render.com](https://dashboard.render.com).
2. Click **New +** → **PostgreSQL**.
3. Name it `yjcrm-db` (or anything — you'll pick it by name in the next
   part). Choose the **Free** plan. Click **Create Database**.
4. Wait for it to show **Available** (about a minute).

---

## Part 3 — Create the web service on Render

**Option A — one click, using the included blueprint (recommended)**

1. In the Render dashboard, click **New +** → **Blueprint**.
2. Connect your GitHub account if you haven't already, and select the
   `yellowjacket-sales-crm` repository you just pushed.
3. Render reads the included `render.yaml` file and shows you a plan: one
   web service and one Postgres database, with `DATABASE_URL` and
   `SESSION_SECRET` filled in automatically. Click **Apply**.
4. Render builds and deploys the app. This takes 2–5 minutes the first
   time. You can watch progress in the **Logs** tab.

If you already created the database in Part 2 separately, you can skip
that — the blueprint will create its own `yjcrm-db`. Either is fine; just
don't end up with two you don't need.

**Option B — manual setup (if you'd rather not use the blueprint)**

1. Click **New +** → **Web Service**, connect your GitHub account, and
   select the `yellowjacket-sales-crm` repository.
2. Fill in:
   - **Name**: `yellowjacket-sales-crm`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm run migrate && npm start`
   - **Plan**: Free
3. Under **Environment Variables**, add:
   - `NODE_ENV` = `production`
   - `SESSION_SECRET` = a long random string. Render can generate one for
     you (there's a "Generate" button next to the value field), or you can
     make one yourself — it just needs to be long and random.
   - `DATABASE_URL` — click **Add from Database**, choose the `yjcrm-db`
     database from Part 2, and pick its **Internal Connection String**.
4. Click **Create Web Service**.

Either way, once the deploy finishes, Render gives you a URL like
`https://yellowjacket-sales-crm.onrender.com` — that's the live site.

---

## Part 4 — Create the first admin login

The app starts with no logins at all — you need to create one admin
account. There are two ways to do this, depending on your Render plan.

**If you're on Render's Free plan (Shell access is a paid-plan feature):**

1. Open your web service in the Render dashboard → **Environment** tab.
2. Add two environment variables:
   - `ADMIN_NAME` = your real name (this becomes your login name)
   - `ADMIN_PASSWORD` = a real password only you know (8+ characters)
3. Go to **Settings** → **Start Command** and set it to:
   ```
   npm run migrate && npm run seed-admin-env && npm start
   ```
4. Save — this triggers a redeploy. Check the **Logs** tab; you should see
   a line like `Admin ready: { id: 1, name: 'Your Name', role: 'admin' }`.
5. Open the site URL, click the **Admin** tab, and sign in with the name
   and password you set in step 2.

   Optional cleanup: once you've confirmed you can log in, you can remove
   the `ADMIN_PASSWORD` environment variable (or just leave it — it will
   simply reset that one account's password to the same value on every
   future deploy, which is harmless but worth knowing).

**If you're on a paid Render plan (Shell is available):**

1. Open your web service → **Shell** tab (a terminal running inside your
   live app).
2. Run:
   ```bash
   npm run seed-admin -- "Randy Wood" "choose-a-real-password"
   ```
   You can run this again later (with the same name) to reset that
   password if you forget it.

Either way, once you're logged in as admin, go to the **Team** page to
add your salesmen (Jerrett, etc.) — each with their own temporary
password.

---

## Updating the site later

Whenever you want to change something:

1. Edit the code in this project folder.
2. Run `git add .`, then `git commit -m "describe what changed"`, then
   `git push`.
3. Render automatically redeploys within a minute or two of the push — no
   extra steps on Render's side.

---

## Local testing (optional)

If you want to run this on your own computer before deploying:

1. Install [Node.js](https://nodejs.org) (18 or newer) and
   [PostgreSQL](https://www.postgresql.org/download/) if you don't have
   them.
2. Create a database: `createdb yjcrm`
3. Copy `.env.example` to `.env` and fill in a `DATABASE_URL` pointing at
   that database and any `SESSION_SECRET` value.
4. Run:
   ```bash
   npm install
   npm run migrate
   npm run seed-admin -- "Your Name" "a-password"
   npm start
   ```
5. Open `http://localhost:3000`.

---

## What's different from the old artifact-based CRM

- Real accounts: everyone signs in with their own name and password —
  there's no separate "invite this email as an Editor" step, and no risk
  of someone entering data into a different copy of the page by mistake.
- Every save goes straight to a real, single, shared database — what one
  person saves, everyone else sees immediately.
- A salesman can now add **and edit** their own leads (not just add them);
  they still can't see, edit, or delete anyone else's, and can't delete
  their own — that stays admin-only, same as before.
- Passwords are stored properly hashed (bcrypt), sessions are stored in
  the database (so logins survive a redeploy), and the admin-only actions
  are enforced on the server, not just hidden in the interface.
