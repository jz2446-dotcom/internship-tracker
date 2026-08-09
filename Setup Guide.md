# Setup Guide — Cloudflare Deployment

## Step 1: Install wrangler

```bash
npm install -g wrangler
wrangler login
```

## Step 2: Create KV namespace

```bash
cd "Internship Tracker/cloudflare-worker"
wrangler kv:namespace create INTERNSHIP_KV
```

Copy the `id` it prints, paste into `wrangler.toml` replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

## Step 3: Set the update secret

```bash
wrangler secret put UPDATE_SECRET
# (type any strong secret string)
```

## Step 4: Seed the data

```bash
node seed-kv.js
```

## Step 5: Deploy the Worker

```bash
wrangler deploy
```

Your dashboard is now live at `https://internship-tracker.<your-subdomain>.workers.dev`

## Step 6: Make it private (Cloudflare Access)

1. Go to Cloudflare Zero Trust → Access → Applications → Add an Application
2. Type: Self-hosted
3. Domain: your worker URL
4. Policy: Allow → Emails → `jz2446@cornell.edu`
5. Save — now only your email can log in

## Live site

Deployed at: **https://internship-tracker.jz-tracker.workers.dev**

## Weekly Updates (current flow — data bundled into the Worker)

Data is bundled into the Worker from `data/agentN_results.json` (the remote KV write
fails under the current OAuth token, so we bundle instead — KV remains a fallback/override).

To refresh after new research:
```bash
cd "Internship Tracker/cloudflare-worker"
node build-data.js   # regenerates src/data.json from all agentN_results.json
wrangler deploy      # publishes the updated site
```

The Cloudflare cron (every Monday 9am UTC) is wired up; to make it re-run the agents
automatically you'd add a scheduled job that regenerates the data — for now updates are
the two commands above.

## Make it private (your email only)

Cloudflare Zero Trust → Access → Applications → Add (Self-hosted) → domain =
`internship-tracker.jz-tracker.workers.dev` → Policy: Allow → Emails → `jz2446@cornell.edu`.
