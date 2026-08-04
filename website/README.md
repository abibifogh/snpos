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
from this folder by **Cloudflare Pages**:

- Build command: *(leave empty)*
- Build output directory: `website`
- Custom domain: `niceoperation.com`

Cloudflare Pages is not the same thing as Cloudflare Workers. Pages serves
files; Workers runs code. This is files.

## What is deliberately not here

No analytics, no cookie banner, no fonts fetched from anywhere else, no
tracking. The page loads from one request and works on a bad connection —
which is the same standard the tools it describes are held to.

There are also no claims that cannot be backed up: no customer counts, no
testimonials, no logos. Add those when they are real.
