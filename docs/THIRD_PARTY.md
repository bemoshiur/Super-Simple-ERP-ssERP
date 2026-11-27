# Third-party components and licenses

## UI shell: ssERP's own (theme-derived code removed 2026-11-28)

Up to version 0.1.0-pre, ssERP's admin shell (styles, layouts, navigation, a few wrappers and images) was adapted from the
**UBold** admin template by **Coderthemes** (a commercial ThemeForest product). That material could not be redistributed
under the MIT License, so it was **removed on 2026-11-28 (Task 16)** and replaced by an original shell written for ssERP:

- styles: a small Sass layer in `src/assets/scss/` (`_tokens`, `_base`, `_layout`, `_components`, `_tables`, `_forms`,
  `_auth`, `_print`) on top of **upstream Bootstrap 5** imported from `node_modules/bootstrap/scss`, configured only
  through Bootstrap's own Sass variables (no fork, no theme skins, no customizer);
- layout: `src/layouts/` (navigation column with collapsible groups and an icon-rail mode, off-canvas drawer on phones, top
  bar, footer), `src/components/AuthShell.tsx`, page header, data table, pager and chart wrappers, all rewritten;
- brand: the logo mark and wordmark are drawn in code (`src/components/Wordmark.tsx`, `src/app/icon.svg`); there are no
  image assets left in `src/assets/images/`.

The local copy of the theme package (a git-ignored `<Name>_v<version>/` folder) is never committed. `npm run check:theme`
proves the result: it fails when a file the next commit would contain mentions the theme or vendor name (outside this file
and the changelog), and, when the local theme package is present, when any such file is byte-identical to a theme file or
shares 70 % or more of its significant lines, 50 % or more of its 8-token shingles, or a run of 8 or more identical
consecutive lines with one (`scripts/theme-inventory.mjs`; CI runs the name check, which also covers the marketplace names).

### Removed theme-derived files

Inventory taken on 2026-11-28 by `scripts/theme-inventory.mjs` against the theme package's `NextJS/Admin` and
`NextJS/StarterKit` folders: **184 tracked files byte-identical** to theme files and **34 modified copies** (70 %+ shared
lines); all of them are deleted or rewritten from scratch. A further 15 files shared 30-70 % of their lines with theme
files; 12 were rewritten too, and the remaining three share only generic lines (`package.json` dependency names, the
root layout's font setup, the icon wrapper's import) and stay below 45 %.

| Path | Files | Kind |
| --- | --- | --- |
| `src/assets/scss/bootstrap/` | 92 | the theme's forked copy of Bootstrap's Sass sources |
| `src/assets/scss/components/`, `structure/`, `pages/`, `plugins/` | 31 | theme component, layout, page and plugin styles |
| `src/assets/scss/config/` (`_root` + 10 `_theme-*` skins) | 11 | theme skins and root variables |
| `src/assets/scss/` `app.scss`, `_variables.scss`, `_variables-dark.scss`, `framework-custom.scss` | 4 | theme entry point and settings |
| `src/assets/images/` (incl. `layouts/` previews) | 41 | theme images (auth backgrounds, customizer previews, patterns) |
| `src/layouts/components/Customizer/` | 11 | the theme customizer |
| `src/layouts/components/` `TopBar/`, `Sidenav/`, `HorizontalNav/`, `ResponsiveNav/`, `Footer/` | 13 | shell components |
| `src/layouts/` `VerticalLayout.tsx`, `HorizontalLayout.tsx`, `MainLayout.tsx` | 3 | layouts |
| `src/components/` `PageBreadcrumb`, `table/DataTable`, `table/TablePagination`, `wrappers/AppProvidersWrapper`, `wrappers/ChartJs`, `wrappers/SimpleBar`, `AppLogo`, `AuthLogo` | 8 | wrappers |
| `src/context/` `useLayoutContext`, `useNotificationContext`; `src/hooks/useScrollEvent`; `src/utils/` `helpers`, `layout`; `src/types/index.ts` | 6 | layout state and helpers |
| `src/app/` sign-in, 403, 404, error, database-unavailable and installer page shells; `tsconfig.json`, `eslint.config.mjs` | 9 | page markup and scaffold configuration |

## Remaining third-party UI components

| Component | Version | License | Used for |
| --- | --- | --- | --- |
| Bootstrap (Sass sources, imported from npm) | 5.3.9 | MIT | base styles, grid, utilities |
| React-Bootstrap | 2.10.10 | MIT | dropdowns, dialogs, off-canvas drawer, tabs, forms |
| Lucide icons (via `@iconify-json/lucide`, bundled subset) | 1.2.160 | ISC | icons |
| `@iconify/react` (offline mode) | 6.0.4 | MIT | icon component |
| Chart.js / react-chartjs-2 | 4.6.2 / 5.3.1 | MIT | dashboard charts |
| Nunito, Noto Sans Bengali (self-hosted) | variable fonts | OFL-1.1 | typography |

## Fonts

Both fonts are bundled locally (no request to Google Fonts at runtime) under the SIL Open Font License 1.1. The license texts are
next to the files in `src/assets/fonts/`.

| Font | License | Source |
| --- | --- | --- |
| Nunito | OFL-1.1 | <https://github.com/googlefonts/nunito> |
| Noto Sans Bengali | OFL-1.1 | <https://github.com/notofonts/bengali> |

## Direct npm dependencies

Licenses as declared in each package's `package.json` for the versions installed when this file was written. Run
`npm ls` and check `node_modules/<name>/package.json` for the current state; transitive dependencies are not listed.

### Runtime

| Package | Declared range | License |
| --- | --- | --- |
| @hookform/resolvers | ^7.0.9 | MIT |
| @iconify/react | ^6.0.2 | MIT |
| @neondatabase/serverless | ^1.2.1 | MIT |
| @zxing/browser | 0.2.1 (exact) | MIT |
| @zxing/library | 0.23.0 (exact) | Apache-2.0 |
| @tanstack/react-table | ^8.21.3 | MIT |
| bcryptjs | ^3.0.3 | BSD-3-Clause |
| bootstrap | ^5.3.8 | MIT |
| chart.js | ^4.5.1 | MIT |
| clsx | ^2.1.1 | MIT |
| drizzle-orm | ^0.45.4 | Apache-2.0 |
| jose | ^6.2.18 | MIT |
| jsbarcode | 3.12.3 (exact) | MIT |
| lodash | ^4.17.21 | MIT |
| next | 16.4.6 (exact) | MIT |
| pg | ^8.23.1 | MIT |
| qrcode-generator | 2.0.4 (exact) | MIT |
| react | ^19.2.5 | MIT |
| react-bootstrap | ^2.10.10 | MIT |
| react-chartjs-2 | ^5.3.1 | MIT |
| react-dom | ^19.2.5 | MIT |
| react-hook-form | ^7.92.0 | MIT |
| usehooks-ts | ^3.1.1 | MIT |
| ws | ^8.23.0 | MIT |
| zod | ^4.6.7 | MIT |

### Development only

| Package | Declared range | License |
| --- | --- | --- |
| @types/lodash, @types/node, @types/pg, @types/react, @types/react-dom, @types/ws | various | MIT |
| drizzle-kit | ^0.31.11 | MIT |
| eslint | ^9.39.4 | MIT |
| eslint-config-next | 16.4.6 | MIT |
| @playwright/test | 1.65.1 (exact) | Apache-2.0 |
| @axe-core/playwright | 4.14.1 (exact) | MPL-2.0 (axe-core, used unmodified, only in tests) |
| @iconify-json/lucide | 1.2.160 (exact) | ISC (Lucide icons; source of the bundled subset, see below) |
| prettier | ^3.6.2 | MIT |
| sass | 1.77.6 | MIT |
| tsx | ^4.23.15 | MIT |
| typescript | ^6.0.2 | Apache-2.0 |
| vitest | ^4.1.12 | MIT |

Icons are rendered with `@iconify/react` (MIT) in its **offline** mode: the app never contacts Iconify's API. The icons used
by the app are copied by `npm run icons` (the result is committed) from `@iconify-json/lucide` into `src/assets/icons/lucide.json` and
shipped in the client bundle. They are **Lucide** icons, (c) Lucide Contributors (and Feather, (c) Cole Bemis, for icons
derived from it), licensed **ISC**: <https://github.com/lucide-icons/lucide/blob/main/LICENSE>. The ISC license requires
keeping the copyright and permission notice with copies: the full ISC text, with the MIT notice for the Feather-derived
portions, ships next to the bundle in `src/assets/icons/LICENSE-lucide.txt`, and the bundle itself keeps Iconify's `info`
block (set name, author, licence and its URL).

The test-only tools `@playwright/test` (Apache-2.0) and `@axe-core/playwright` / `axe-core` (MPL-2.0) are never shipped
with the app; axe-core is used unmodified, so MPL-2.0's file-level copyleft places no obligation on ssERP's own code.

The four packages marked exact were added for scanning and labels: `@zxing/browser` + `@zxing/library` (camera decoding, loaded only on demand), `qrcode-generator` (QR labels) and `jsbarcode` (Code 128 encoding; used without a DOM). All are permissive licenses.
