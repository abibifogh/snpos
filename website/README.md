# niceoperation.com

The public site for the NiceOps suite. One file, `index.html`, with the styles
inside it — no build step, nothing to install, nothing to compile. Open it in a
browser to see it exactly as it will look live.

## Changing it

Edit `index.html` and commit. If it is connected to Cloudflare Pages, the live
site updates by itself a minute or so later.

The things most likely to need changing:

| What | Where to look for it |
| --- | --- |
| The contact address | `mailto:hello@niceoperation.com` — appears once |
| A tool's description | Inside the `<div class="entry-body">` for that tool |
| A tool's address | The `href` on that tool's `<a class="entry">` |
| Adding a fifth tool | Copy a whole `<a class="entry">…</a>` block and edit it |

## Publishing

Hosted separately from the POS. GitHub Pages serves one site per repository and
that one is already `pos.niceoperation.com`, so the marketing site is published
from this folder by **Cloudflare**, connected to this repository:

- Project name: `niceops-site`
- Build command: *(leave empty)*
- Deploy command: `npx wrangler deploy`
- Custom domains: `niceoperation.com` and `www.niceoperation.com`

The settings live in `wrangler.jsonc` at the top of the repository, which says
the site is the files in `website/` and nothing else. That is why there is no
"build output directory" to fill in — the file already answers that question.

If Cloudflare ever offers the older **Pages** flow instead (Workers & Pages →
Create → Pages → Connect to Git), it works just as well: leave the build
command empty and set the build output directory to `website`.

## What is deliberately not here

No analytics, no cookie banner, no fonts fetched from anywhere else, no
tracking. The page loads from one request and works on a bad connection —
which is the same standard the tools it describes are held to.

There are also no claims that cannot be backed up: no customer counts, no
testimonials, no logos. Add those when they are real.
