# ReferralMax Website

Static marketing site for **ReferralMax** — the referral and affiliate platform for small and mid-sized businesses. *Refer. Earn. Succeed.*

## Preview

Open `index.html` in any browser. No build step, no dependencies.

## Structure

- `index.html` — single-page marketing site (hero, features, how it works, use cases, pricing, testimonials, CTA, footer)
- `assets/` — brand logo and other imagery
- `ReferralMax_Website_Plan.md` — full marketing plan, content library, and build brief

## Deploy

Drop the contents of this repo onto any static host:

- **Vercel** — `vercel --prod` from the repo root
- **Netlify** — drag the folder into the Netlify dashboard, or connect this repo
- **GitHub Pages** — enable Pages in repo settings, deploy from `main` branch root
- **Cloudflare Pages** — connect this repo, framework preset: "None"

## Editing

All content lives in `index.html`. Colors are defined as CSS variables at the top of the `<style>` block:

```css
--blue:  #1E5BA8;
--green: #2EB84C;
--orange:#F58220;
--navy:  #0E2A47;
```

## License

© 2026 ReferralMax, Inc. All rights reserved.
