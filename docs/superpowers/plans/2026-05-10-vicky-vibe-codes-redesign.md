# Vicki Website Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the approved Purple Balloon Archive direction to Vicki's family recipe website.

**Architecture:** Keep Astro content and recipe data unchanged. Centralize the visual system in `src/styles/global.css` with CSS custom properties, use a local hot-air-balloon photograph in `public/images`, and adjust page markup only where needed for the new hierarchy.

**Tech Stack:** Astro, TypeScript content collections, CSS custom properties, local static image assets, Fontsource Atkinson Hyperlegible.

---

### Task 1: Visual Tokens And Asset

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/styles/global.css`
- Create: `public/images/vicki-hot-air-balloons.jpg`

- [x] Add Atkinson Hyperlegible as the body font.
- [x] Download the approved hot-air-balloon photograph as a local static asset.
- [x] Replace hardcoded styling with named CSS variables in `:root`.
- [x] Remove gradient backgrounds from the stylesheet.

### Task 2: Page Hierarchy

**Files:**
- Modify: `src/pages/index.astro`
- Modify: `src/pages/recipes/index.astro`
- Modify: `src/pages/recipes/[slug].astro`
- Modify: `src/components/RecipeExplorer.astro`
- Modify: `src/components/RecipeCard.astro`

- [x] Rename the public interface to Vicki's Website.
- [x] Use the balloon photo as the main visual signal on the home and recipe archive pages.
- [x] Keep search and browsing actions near the top on mobile.
- [x] Preserve existing recipe data, routes, search, filters, and scan links.

### Task 3: Verification

**Files:**
- Verify: `src/styles/global.css`
- Verify: `dist/`

- [x] Run tests, Astro check, and production build.
- [x] Verify there are no `gradient` declarations in source styles.
- [x] Preview mobile and desktop layouts in the browser.
- [ ] Commit and push only the redesign branch changes.
