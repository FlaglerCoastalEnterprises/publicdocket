# PublicDocket

Search engine for Flagler County, FL public meetings and agendas.
Owned by Flagler Coastal Enterprises LLC.

- `public/` is the website. Every push to `main` is deployed by Cloudflare automatically.
- `wrangler.jsonc` tells Cloudflare how to publish `public/`.
- Archive: after any change to the data in `public/index.html`, commit it, then run `node scripts/build-archive.mjs` and commit the regenerated `public/archive/` and `public/data/` files. The script rebuilds the archive from every committed version of the page, so past meetings are kept even after they drop off the homepage.
