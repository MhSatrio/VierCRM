# VierCRM

An Airtable-style CRM inside Chrome for **VierApparatus**: scrape any list (staff directories, company listings, people) into **bases** – spreadsheet-like tables for people, companies or anything – find each person's latest publication automatically (and a *lawful* full-text PDF), and send personalised e-mail through Brevo or Gmail, with the guard rails needed to do that responsibly. Nothing in it is tied to one kind of list: add a base for companies, Apollo exports or LinkedIn contacts, and add research fields to any base that needs them.

* Chrome Extension, Manifest V3 · React + TypeScript · IndexedDB (all data stays in your browser)
* Side panel (scrape while you browse) + full-page app (bases, research, automations, e-mail, analytics)
* Styled like the VierApparatus website (its icon, wordmark, Jost, blue / ink / sky buttons and headers)
* A **separate project** – the LinkedIn job-automation extension (`../linkedin-job-assistant`) was only read for reference and is untouched.

Full technical documentation (architecture, every source file, algorithms, limits): **`docs/VierCRM Technical Documentation.docx`** (rebuild with `npm run docs`).

## Install (5 minutes)

```
cd VierCRM
npm install
npm run build              # → dist/
```

1. Open `chrome://extensions`, switch on **Developer mode**, **Load unpacked** → choose the `dist` folder.
2. Click the VierCRM toolbar icon: the side panel opens. **Open app ↗** (white button, top right) opens the full app.
3. First run: Settings → *Allow VierCRM to read the sites I scrape* (asked once; revocable). Add your e-mail for Unpaywall (open-access PDF search) and, for sending, your Brevo API key.

Requires Chrome 116+ (side panel API) and Node 20+ to build.

## Quick tour

| Where | What |
|---|---|
| **Bases** (left menu) | A base is one list of records. Three are created for you – **Researchers**, **Contacts**, **Companies** – and **＋ Add base** makes more from five templates (Contacts, Companies, **Places**, Researchers, Blank). Each is a spreadsheet: views, filters (AND / OR / NOT), sorts, search, field manager (add / rename / reorder / hide / delete; formula and *research* fields), record panel, CSV import / export. **Manage bases** renames, deletes, switches automatic research and adds the research fields to any base. |
| **Scraper** (side panel or app) | Open a list page in a tab → pick **Save to base** (or **＋ New base…**) → *Preview* → *Start*. Reads every entry (people, companies, anything repeated), opens each detail page in the background, follows pagination (Next links, numbered, URL pattern, Load more, infinite scroll, in-page Next buttons), de-duplicates, never passes a CAPTCHA. A “Label: value” row on a page fills the field of the same name, so a field you add needs no set-up. Pause / Resume / Stop from the panel or the floating control on the page. |
| **Google Maps** (Scraper) | Search on Google Maps (“freight forwarder Surabaya”, “kos putri Malang”), wait for the list, press **Start**. VierCRM scrolls the list to its end, reads every place (name, category, address, phone, website, rating, reviews, hours, Maps link), opens a place’s own page in the background when the card lacks a phone or address, and looks on each business’s **own website** for an e-mail address, WhatsApp number and social links (Maps never shows an e-mail). No Google API, no key – it reads the tab you have open. Saves into a **Places** base (chains’ branches are kept apart; the same place is never duplicated); extra searches (other cities) can be listed in the configuration. Maps shows about 120 places per search. **Not yet run against the live google.com/maps** – press Preview on a real search first; see section 26 of the documentation. |
| **Research Finder** | What it does, in plain words, and a switch per base: **Find research automatically** – every record with a name but no latest publication is looked up (OpenAlex, Crossref, Semantic Scholar, PubMed; about 5 per minute; the records on screen first; details only, no PDF downloads). Same-name candidates are *shown to you*, never guessed. Also a one-off look-up of any person, Google Scholar and ResearchGate through a tab in your own browser. |
| **Automations** | Trigger → conditions → actions, history, retry, test mode, loop and duplicate prevention. New automations are created **off** and in **test mode**. |
| **Email Campaigns / Analytics** | Templates with `{Field}`, `{Field \| fallback: x}` and optional `[[sentences]]`, per-record preview, Brevo or Gmail sender, delivery / open / click / bounce / unsubscribe analytics. |

## What needs credentials

| Feature | You need | Status |
|---|---|---|
| OpenAlex, Crossref, PubMed, Europe PMC, arXiv | nothing | verified against the live services (see *TESTING*) |
| Semantic Scholar | optional API key (keyless use is heavily rate-limited) | adapter tested with fakes; live call hit HTTP 429 without a key |
| Unpaywall (open-access PDFs) | your e-mail address (Settings) | tested with fakes; **not** called live in tests |
| Brevo send + analytics | Brevo API key + a verified sender (e.g. `info@vierapparatus.com`) | tested against a local fake of the documented API; **not** tested with a real key |
| Gmail send / Send As | a Google Cloud OAuth client id (Web application; Gmail API enabled) | message building and rules unit-tested; **not** exercised against a real Google account |
| Webhook (near-real-time analytics) | `node backend/webhook-server.mjs` + a public HTTPS tunnel | server unit-tested; not run behind a real tunnel |

## Responsible use – built in

* **Nothing is e-mailed without explicit activation**: global “Allow sending” switch (off by default) → automation switched on → test mode switched off. Newly scraped contacts are never e-mailed automatically.
* Never writes to anyone who is *Do not contact*, bounced or unsubscribed; one e-mail per template per contact; daily cap and minimum gap; sender verified with Brevo first; opt-out footer on every message.
* **No Sci-Hub, no shadow libraries, no paywall bypass.** Full text comes from open-access copies (Unpaywall, OpenAlex, Europe PMC, arXiv, repositories), PDFs you attach yourself, and – only if you enable it – publisher PDFs your own institutional login already entitles you to. If nothing lawful exists the field says *Full text unavailable* and the publication’s details and links are still saved.
* Scraping stops at a CAPTCHA, login wall or security check. Respect each site’s terms and keep the delays polite. Cold e-mail is regulated (GDPR / ePrivacy, CAN-SPAM, …): you are responsible for a lawful basis, a real sender identity and a working opt-out.

## Samples (all fictional)

`samples/sample-researchers.csv` (Import CSV), `samples/scrape-config-example.json`, `samples/automation-example.json`, `samples/email-template-example.json`. Settings → *Load sample data* inserts four invented researchers.

## Develop and test

```
npm run typecheck     # TypeScript
npm test              # 158 unit tests (Vitest, fake IndexedDB, jsdom, scripted network)
npm run build && npm run e2e   # 104 browser checks: the real built extension in Chromium vs a fictional site + fake APIs
npm run bench         # 20 000 records in the real extension: open, search, sort, change propagation (BENCH_N=50000 for more)
npm run icons         # re-render the icons from assets/icon.svg (a copy of the website's icon); the PNGs are committed
npm run docs          # rebuild the Word documentation
npx tsx scripts/live-check.ts  # read-only check of the public research APIs
```

The browser test uses Playwright's Chromium (`%LOCALAPPDATA%\ms-playwright`); set `CHROMIUM` to use another binary, `HEADED=1` to watch.

## Layout

```
src/core        data model, IndexedDB, store, formulas, templates, filters, dedupe, CSV, dependencies, settings
src/scrape      directory detection, profile extraction, pagination, page crawler, selector picker
src/research    HTTP + matching, sources, full-text finder, lookup engine
src/automation  trigger / condition / action engine
src/email       Brevo, Gmail, send service with guard rails, analytics
src/background  service worker (message router, scrape run, schedule)
src/content     injected content script (page crawl, floating control, element picker)
src/ui          React app + side panel (lazy pages, table view, add-base dialog)
assets/         icon.svg (copy of the website icon) · public/brand/ wordmark
backend         optional Brevo webhook receiver
tests           unit tests, browser test, fictional fixture site and fake APIs
```
