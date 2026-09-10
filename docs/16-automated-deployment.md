# 16, Deploying without touching a computer

**In plain terms:** once this is set up, you never download a ZIP or run a
command again. Changes go to GitHub, GitHub builds and publishes them, and the
apps are live on the web. You approve things by clicking buttons on a web page.

Setting it up is about **fifteen minutes of clicking**, once.

---

## 16.1 What runs where

| Piece | Where it lives | Who runs it |
| --- | --- | --- |
| The four apps | GitHub Pages, free | Built and published automatically on every merge to `main` |
| The database's shape | Appwrite Cloud | Provisioned automatically on the same merge, before the apps go out |
| The background jobs | Appwrite Cloud | Deployed automatically on the same merge, after the database |
| Your data | Appwrite Cloud | Never touched by a deploy |

One merge does all three, in that order. Provisioning only ever adds — a new
table, a new column, a changed permission — and never removes or rewrites your
data, which is what makes it safe to run every time. Each of the three can
still be started by hand from the **Actions** tab when you need one on its
own.

---

## 16.2 One-time setup

### Step 1, Tell GitHub about your Appwrite project

In your repository: **Settings → Secrets and variables → Actions**.

On the **Variables** tab, click **New repository variable** four times:

| Name | Value |
| --- | --- |
| `APPWRITE_ENDPOINT` | `https://fra.cloud.appwrite.io/v1` |
| `APPWRITE_PROJECT_ID` | `6a6e308e00234b152989` |
| `DB_ID` | `snpos` |
| `RESTAURANT_NAME` | your restaurant's name |

These are not secret. They identify the project; they grant nothing.

On the **Secrets** tab, click **New repository secret** once:

| Name | Value |
| --- | --- |
| `APPWRITE_API_KEY` | a fresh Appwrite API key |

Create the key in the Appwrite console under **Integrations → API keys →
Create API key**, with the **Databases**, **Teams**, **Storage** and **Users**
scopes. GitHub hides it after you save; nobody can read it back, including you.

This is the right place for it, far better than a file on a laptop.

### Step 2, Turn on GitHub Pages

**Settings → Pages → Build and deployment → Source: GitHub Actions.**

That is the whole step. Do not pick a branch; picking "GitHub Actions" is what
lets the workflow publish.

### Step 3, Let Appwrite accept the new address

Your apps will live at:

```
https://<your-github-username>.github.io/<repository-name>/
```

Appwrite refuses connections from addresses it does not know, so add it:
**Appwrite console → Settings → Platforms → Add platform → Web app**, type
**React**, hostname `<your-github-username>.github.io` (the hostname only, no
`https://`, no path).

Skip this and every app loads to a blank screen with a CORS error. It is the
single most common thing to forget.

### Step 4, Deploy

Go to the **Actions** tab → **Deploy** → **Run workflow**.

It takes two or three minutes. When it finishes, your apps are live.

---

## 16.3 Day-to-day

### Changing the code

Nothing to do. Any change pushed to the branch triggers **Check** (typecheck
and build) and then **Deploy**. If the check fails, nothing is published, a
broken build cannot reach your staff mid-service.

### Changing the database

Nothing to do either. When a merge to `main` changes `scripts/schema.mjs`, the
**Deploy** run provisions the new tables or fields first, then deploys the
background jobs, then publishes the apps. The run's log shows each step.

If you ever need to provision on its own — a database that was set up before
this, or a run that failed part-way — **Actions → Provision Appwrite → Run
workflow**, type `provision` in the confirmation box, click the green button.
The confirmation box is only asked for when you start it by hand. It finishes
by printing the same report `npm run doctor` gives.

### "Database update needed"

Each staff app compares the database against the version it was built for,
and shows a yellow bar across the top when the database is behind. Staff see
that the app still works and that the owner has been told; an admin sees the
step to take. It shows when a provision step failed or was never run, and
goes away on its own once one gets all the way through. The first deploy
after this feature arrived shows it until that deploy's provision step has
finished, which is expected.

### Watching it

The **Actions** tab lists every run with a green tick or a red cross. Click any
run to read what happened. A red cross on **Check** means the code did not
compile and nothing was published.

**Admin → Health** is the other place to look. Every night at two the server
checks for records that do not add up — a shift closed but not on the books,
an order marked paid with no payment, a payout that never reached the maker's
ledger — and for background jobs that have gone quiet, and writes the answers
down. The page shows the last check and checks again when you open it; each
finding has a button to the place it is fixed. If anything needs fixing, the
people who get the daily summary get an email that morning.

---

## 16.4 The QR codes

The deploy tells the admin app where the customer menu lives, so table QR links
point at the real address rather than `localhost`.

**Reprint your table QR codes after the first successful deploy.** Any printed
during local testing point at a laptop that will not be running.

---

## 16.5 What this does not cover

Being straight about the limits:

- **GitHub Pages is public.** Anyone with the address can open the admin
  login page. They cannot get in without an account, and every collection is
  permission-controlled, but the *page* is reachable. That is normal for a web
  app; it is worth knowing rather than assuming otherwise.
- **Custom domain.** `github.io` works, but `order.yourrestaurant.com` on a QR
  code inspires more confidence. Pages supports custom domains under
  **Settings → Pages**; add the domain to Appwrite's platforms too.
- **The kitchen tablet still needs its app installed** (doc 12). Deploying does
  not put software on a tablet.

---

## 16.6 If something goes wrong

| What you see | What it means |
| --- | --- |
| Red cross on **Check** | The code does not compile. Nothing was published; the live apps are untouched. |
| Red cross on **Deploy**, "Pages not enabled" | Step 2 was missed. |
| Apps load but nothing appears, console shows CORS | Step 3 was missed, or the hostname has a typo. |
| Provision fails with "missing scopes" | The API key needs more permissions, recreate it with all four scope groups. |
| Provision fails with "maximum number of…" | An Appwrite plan ceiling, not a fault. The message names what hit the limit. |

Every failed run keeps its full log under the **Actions** tab. Paste it to me
and I can usually tell you the cause from the first few lines.


---

## 16.7 Server-side functions

Three things must happen whether or not anyone has a screen open. They run on
Appwrite as **Functions**, deployed from GitHub like everything else:

| Function | When it runs | What it does |
| --- | --- | --- |
| `preorder-fire` | Every minute | Releases pre-orders to the kitchen at their fire time, re-checking availability first |
| `kitchen-escalate` | Every minute | Raises the alarm level on unacknowledged orders and flags a manager past the top level |
| `notify` | On payment, on shift close, on every spend, payout and write-off, and hourly | Emails the receipt and the shift summary; writes the books from each of those rows; sweeps hourly for anything missed |

The first two exist precisely because a screen cannot be relied on. A tablet
that has crashed, been unplugged, or had its battery optimised into silence is
exactly the moment an order gets forgotten, and it is the moment the kitchen
display is no longer running to notice.

### Deploying them

Every merge to `main` deploys them, after the database and before the apps.
To deploy them on their own: **Actions → Deploy functions → Run workflow**,
type `deploy`. The confirmation is only asked for when started by hand.

**Four is the limit.** Appwrite's free plan allows four functions, and this
project has four. A fifth is accepted by `appwrite.json` and pushed happily by
the CLI; the server rejects it with a single line buried in a wall of
successful build output, so the deploy looks like it worked and one job
silently does not exist. CI now refuses a fifth rather than letting it get
that far.

Anything new that must run on a clock belongs inside `notify`, which already
runs hourly for exactly this reason and is where the knowledge of how to send
an email lives. It tells its two jobs apart by whether a document arrived: an
event brings one, the timer does not.

### Email

Receipts and summaries need an SMTP account. Any provider works, Brevo,
Mailgun, SendGrid, or a Gmail app password for low volume. Add these as
**Secrets** (Settings → Secrets and variables → Actions):

| Secret | Example |
| --- | --- |
| `SMTP_HOST` | `smtp-relay.brevo.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | your SMTP username |
| `SMTP_PASS` | your SMTP password or app password |

Then set the sender name and address in Admin → Settings → Email, and add
recipients for the shift summary under report subscriptions.

#### Brevo, step by step

Brevo's free plan sends 300 emails a day, which is more receipts than most
single restaurants issue. Two things about it trip people up, so they are
called out here rather than left to be discovered.

1. In Brevo, go to **SMTP & API → SMTP**. It shows a **login** and a **master
   password** (Brevo calls it an SMTP key). The login looks like an email
   address ending in `@smtp-brevo.com`; it is *not* the address you signed up
   with, and it is *not* the address your receipts will come from. It is only
   the username for the connection.
2. In Brevo, go to **Senders, Domains & Dedicated IPs → Senders** and add the
   address you want receipts to come *from*, then click the link Brevo emails
   you to verify it. Brevo refuses to send from an address it has not verified,
   so skipping this makes every receipt fail.

Then, in GitHub → your repository → **Settings → Secrets and variables →
Actions → New repository secret**, add four secrets:

| Name | Value |
| --- | --- |
| `SMTP_HOST` | `smtp-relay.brevo.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | the Brevo login, e.g. `8a1b2c001@smtp-brevo.com` |
| `SMTP_PASS` | the Brevo SMTP key |

Finally:

- **Actions → Deploy functions → Run workflow**, type `deploy` (or merge
  anything to `main`, which runs it too). This is what hands the settings to
  the email function; adding the secrets alone does nothing until this runs.
- **Admin → Settings → Email**: set the from-name to the restaurant's name and
  the from-address to the sender you verified in step 2.

Send yourself a test order and check that the receipt arrives. If it does not,
Admin → Reports shows the receipt row with the reason it failed, Brevo's
rejection message is passed straight through rather than swallowed.

Rotating the SMTP key later is the same four secrets and the same **Deploy
functions** run; the workflow overwrites the old values rather than keeping
them.

**Without SMTP configured**, nothing breaks and nothing is silently lost: the
receipt and summary are still written to the database with a status of
`failed` and a reason, so they can be sent later or read in the admin app. A
missing configuration should be visible, not invisible.

### Watching them

Appwrite console → **Functions** → pick one → **Executions**. Every run is
logged with what it did. `preorder-fire` and `kitchen-escalate` run every
minute, so a healthy project shows a steady stream of quick, boring successes.
