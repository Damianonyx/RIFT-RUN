# Rift Run

Three-lane endless runner. Switch lanes, jump crates, collect rift light. Speed ramps as you go.

## Play

- **A / D** or arrow keys — change lane
- **Space** or Arrow Up — jump
- Phone: **Start run**, then swipe left / right / up, or use the on-screen buttons
- Score = distance + orbs. Best score is saved in the browser.

## Stack

- TanStack Start (React 19) + Vite 8
- Three.js (WebGL, no external models or textures)
- Tailwind CSS v4
- Nitro preset: **Vercel** (Node 22)

This is an SSR app, not a static site. **GitHub Pages will not host it.** Deploy via GitHub → Vercel.

## Scripts

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Dev server |
| `npm run build` | Production build (Vercel output under `.vercel/output`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run preview` | Serve the production build locally |

Node **22**.

## Deploy on GitHub + Vercel

1. Create a GitHub repo and push this project (`main`).
2. On [Vercel](https://vercel.com), **Add New → Project** and import that repo.
3. Framework: Vite / Other. Build command: `npm run build`. Output is Nitro’s Vercel preset (no extra config needed if `vite.config.ts` is unchanged).
4. Environment: none required for the game. Auth and Postgres are off. High score uses `localStorage`.
5. Deploy. Each push to `main` rebuilds.

### GitHub Actions (optional)

```yaml
name: build
on:
  push:
    branches: [main]
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "22"
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run build
