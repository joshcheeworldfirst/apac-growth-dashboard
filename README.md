# APAC Growth Dashboard — demo

A single-page dashboard for tracking market health across an acquisition funnel:
registration → submit → L3 → first trade, alongside CPA, revenue, CAC payback and LTV.

**Live: https://joshcheeworldfirst.github.io/apac-growth-dashboard/**

> ### Every number in this repository is invented
> This is a demonstration of the tool, not a report. The figures are produced by a
> deterministic generator purely so the layout has something to render. They are not
> anyone's real revenue, spend or conversion rates, and nothing here should be read as
> a statement about any business.

## What it does

- **Map** — every market shaded by a health band, with a framed reference-market inset.
  Click a market to focus it across the whole page; Escape clears.
- **Funnel** — the four stages per market, with each step's conversion rate and how it
  compares to the reference market.
- **Unit economics** — CAC payback against net LTV:CAC, bubble area by revenue.
- **Trends** — per-market sparklines for any metric, month by month.
- **Table** — every figure, sortable, downloadable as CSV.
- **Paste panel** — load your own numbers straight from a spreadsheet. Tab- or
  comma-separated, tolerant of `$`, `,`, `%` and of month formats like `Aug-26`,
  `August 2026` or `2026-08`. Only the columns present in the paste are updated, so a
  spend-only block tops up CPA without disturbing the funnel.

Pasted data stays in your browser. Nothing is uploaded anywhere.

## The formulas

```
REG→Submit  = Submit / REG              Submit→L3 = L3 / Submit
L3→NFC      = NFC / L3                  REG→NFC   = NFC / REG

CPA             = Marketing spend / NFC
Revenue per NFC = New total revenue / NFC
NFC growth      = NFC this month / NFC last month − 1
```

Every figure is one division of two reported numbers. There is no margin, retention rate,
customer-base estimate or horizon behind any of them.

**Everything is scoped to one acquisition channel, and to new customers.** Revenue is what
the customers acquired in the period brought in, reported as a total and its transaction-fee
component; the remainder is FX spread and other fees, so a falling transaction share means
the market is monetising through spread rather than volume. Revenue, NFC and CPA all describe
the same customers, so they can be divided by one another without mixing populations. Both
revenue lines sum over the selected period, and every aggregate on the page names its period.

**Benchmarking is tier-local.** The reference market is the yardstick for *mature* markets
only, like for like — measuring a young market against a mature one reports its age, not
its health. Growth and emerging markets are scored against the **best achievement YTD** in
their own tier, a target rather than a like-for-like read, held year-to-date so the bar does
not move every time you change the month. An explicit per-market target overrides both.

**Health score** is a weighted 0–100 blend: REG→NFC conversion 35%, CPA 30%, NFC growth
20%, revenue growth 15%. Components with no data are dropped and the remaining weights
renormalised, so a market is never marked down for a gap in reporting — and both the rank
list and the tooltip say how many of the four inputs a score actually rests on. Growth
components are skipped for partial periods rather than comparing a part month to a full
one.

## Running it

No build step, no dependencies, no network calls — plain HTML, CSS and JavaScript with
the map geometry pre-projected into SVG paths.

```bash
python3 -m http.server 8000
```

Or open `index.html` straight off disk.

## Publishing

Settings → Pages → Source: **Deploy from a branch**, branch `main`, folder **`/ (root)`**.
That is the whole setup; every push to `main` republishes.

There is no deploy workflow on purpose. `actions/configure-pages` cannot switch Pages on
for this repository — the workflow token is refused by the create-Pages-site API — and
because that step ran under `continue-on-error`, the run reported success while silently
skipping its own deploy. Serving from the branch removes the step that could lie.

## Layout

```
index.html            the page
assets/styles.css     tokens and layout, light and dark
assets/metrics.js     every formula, computed in the browser
assets/app.js         rendering and interaction
assets/map-paths.js   pre-projected country outlines
data/data.js          the demo dataset the page loads
data/demo.js          the same data as pasteable TSV
```

## Credits

Map geometry from [Natural Earth](https://www.naturalearthdata.com/) (public domain) via
the npm `world-atlas` package. Colour palette validated for contrast and colour-vision
deficiency in both light and dark modes.
