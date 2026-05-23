# The Yard Lab Publishing Group — Website

Static site for theyardlab.com built with **Eleventy** and managed via **Decap CMS**.

## What's here

```
yardlab-site/
├── src/
│   ├── index.njk              ← Homepage template
│   ├── _includes/base.njk     ← Header + footer layout
│   ├── _data/                 ← All editable content (JSON)
│   ├── books/                 ← Editorial book pages
│   │   ├── play.njk
│   │   └── francis-keene.njk
│   ├── play/index.html        ← Standalone immersive Play site
│   ├── francis-keene/index.html ← Standalone immersive Francis Keene site
│   ├── admin/                 ← Decap CMS (loaded at /admin)
│   ├── assets/                ← Images, logo, fonts
│   └── styles.css             ← Shared design system
├── eleventy.config.js         ← Build config
├── package.json
└── vercel.json                ← Deployment config
```

## URLs (in production)

- `theyardlab.com` — homepage
- `theyardlab.com/books/play/` — Play (editorial page)
- `theyardlab.com/books/francis-keene/` — Francis Keene (editorial page)
- `theyardlab.com/play/` — Play (immersive marketing site)
- `theyardlab.com/francis-keene/` — Francis Keene (immersive marketing site)
- `theyardlab.com/admin/` — Content management

## Local development (optional)

You can edit content through the CMS without running this locally. But if you want to preview changes on your computer:

```bash
npm install
npm run serve
```

Then open `http://localhost:8080`. Changes auto-reload.

## Deployment to Vercel (one-time setup)

### 1. Create GitHub repo
- Go to github.com → New repository → name it `yardlab-site`
- Upload all files **except** `node_modules/` and `_site/` (the `.gitignore` excludes these)

### 2. Connect to Vercel
- Go to vercel.com/new
- Click "Import Git Repository" → choose `yardlab-site`
- Build settings auto-detect from `vercel.json` — leave defaults
- Click **Deploy**

You'll get a preview URL like `yardlab-site-xyz.vercel.app` in about 60 seconds.

### 3. Set up Decap CMS authentication

Decap needs GitHub OAuth to let you log in at `/admin`. Two options:

**Easy: Use the free hosted OAuth proxy**
- Open `src/admin/config.yml` and replace `YOUR_GITHUB_USERNAME` with your GitHub username
- That's it — you can already log in at `/admin` with your GitHub account

**Better long-term: Self-hosted OAuth**
- Follow Decap's docs for setting up a GitHub OAuth App
- More secure and you don't depend on the public proxy
- Takes ~15 minutes

### 4. Custom domain (when ready)
- Vercel project → Settings → Domains → Add `theyardlab.com`
- Add the DNS records Vercel shows you at your domain registrar
- Wait 5–30 minutes for DNS propagation

## How to update content

After setup, all updates go through `theyardlab.com/admin`:

1. Log in with GitHub
2. Pick what to edit from the sidebar (Homepage, Catalog, Articles, etc.)
3. Fill in the form
4. Click **Publish**
5. Wait ~60 seconds — Vercel auto-rebuilds and deploys

For images: drag-and-drop directly into image fields in the CMS.

## Adding a new book

1. Go to `/admin` → Catalog → "New Catalog"
2. Fill in fields (title, author, description, etc.)
3. For a full editorial page, also create a new `.njk` template under `src/books/` (or ask Claude to add one)

## Tech stack

- **Eleventy 3.x** — static site generator
- **Decap CMS 3.x** — content management
- **Vercel** — hosting + deploys
- **GitHub** — version control + CMS backend

## Notes

- All editable content lives in `src/_data/*.json`. The `.njk` template files contain layout/styling.
- The two standalone marketing sites (`src/play/` and `src/francis-keene/`) are self-contained HTML files — they're not CMS-managed currently. Edit them by editing the HTML directly if needed.
- The shared styles for the publisher site live in `src/styles.css`. Both immersive standalone sites have their styles inlined.
