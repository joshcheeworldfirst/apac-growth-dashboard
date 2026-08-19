/* APAC dashboard - metric definitions.
 *
 * Every derived number on the page is computed here, from the raw columns in
 * data/monthly.csv plus the per-market inputs in data/assumptions.csv. Nothing
 * is pre-computed at build time, so pasting fresh data into the page gives the
 * same answers as committing a CSV and rebuilding.
 *
 * See DATA_DICTIONARY.md for the definition of every input column and every
 * formula below.
 */
(function (global) {
  "use strict";

  var STAGES = ["reg", "submit", "l3", "nfc"];
  var STAGE_LABELS = { reg: "REG", submit: "Submit", l3: "L3", nfc: "NFC" };
  var NUMERIC_COLS = STAGES.concat([
    "new_reg_nfc",
    "new_total_revenue",
    "marketing_spend",
  ]);

  /* ---------------------------------------------------------------- utils */

  function ratio(a, b) {
    // Guard every division: a missing input must read as "no data", never 0 or Infinity.
    if (a === null || a === undefined || b === null || b === undefined) return null;
    if (!isFinite(a) || !isFinite(b) || b === 0) return null;
    return a / b;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function parseNumber(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return isFinite(value) ? value : null;
    var s = String(value).trim();
    if (!s || s === "-" || /^(n\/a|na|#n\/a|#div\/0!|null)$/i.test(s)) return null;
    var negative = /^\(.*\)$/.test(s);
    if (negative) s = s.slice(1, -1);
    s = s.replace(/[,\s]/g, "").replace(/[£$€฿₫]|RM|S\$|A\$|NZ\$|USD/gi, "").replace(/%$/, "");
    var n = Number(s);
    if (!isFinite(n)) return null;
    return negative ? -n : n;
  }

  /* ------------------------------------------------------------ row maths */

  /**
   * Derive every per-market, per-month metric.
   *
   * Everything here is a division of two reported numbers - no horizon, no
   * margin, no retention curve. That is deliberate: CAC payback and LTV were
   * removed because they rest on inputs (gross margin, an active-customer
   * count, an 18-month horizon) that are not formally agreed, and a number
   * built on an unagreed assumption reads as fact once it is on a dashboard.
   * Reinstate them here when Finance has signed those inputs off.
   */
  function deriveRow(row, market) {
    var m = { month: row.month, market: row.market };
    STAGES.forEach(function (s) {
      m[s] = row[s] === undefined ? null : row[s];
    });

    m.new_reg_nfc = row.new_reg_nfc === undefined ? null : row.new_reg_nfc;
    m.is_partial = !!row.is_partial;
    m.period_label = row.period_label || null;
    m.spend_basis = row.spend_basis || null;
    /* TOTAL NEW REVENUE: everything the clients acquired during 2026 have
     * billed. A month's figure is what all of those cohorts booked in that
     * month, so summing across a period gives the year-to-date total - which
     * is the figure the business actually asks for. It is not the market's
     * whole book, and it is not one cohort's first month.
     *
     * It grows through the year as earlier cohorts keep trading, so a single
     * month's value is a contribution to the total rather than a thing to
     * compare against that month's acquisitions. */
    m.rev_total = row.new_total_revenue === undefined ? null : row.new_total_revenue;
    m.spend = row.marketing_spend;


    // Funnel step conversion + end-to-end.
    m.cvr_reg_submit = ratio(m.submit, m.reg);
    m.cvr_submit_l3 = ratio(m.l3, m.submit);
    m.cvr_l3_nfc = ratio(m.nfc, m.l3);
    m.cvr_reg_nfc = ratio(m.nfc, m.reg);

    /* CPA divides spend by the NFC of the months that HAVE spend, not by every
     * month's NFC - see sumRows(). On a single raw row the two are the same,
     * and a row with no spend yields no CPA either way. */
    m.nfc_for_cpa = row.nfc_for_cpa === undefined || row.nfc_for_cpa === null
      ? m.nfc : row.nfc_for_cpa;
    m.cpa_excluded_months = row.cpa_excluded_months || null;
    m.cpa = ratio(m.spend, m.nfc_for_cpa);
    // Revenue to date per client acquired. Both sides cover the clients
    // acquired in the period, so over a year-to-date window this is what one
    // 2026 client has actually been worth so far - no assumptions in it.
    m.arpa = ratio(m.rev_total, m.nfc);

    return m;
  }

  /**
   * Sum the raw columns across rows into one pseudo-row.
   *
   * Every rolled-up figure on the page goes through here - the APAC totals, a
   * market's year to date, and the tier benchmarks - so the CPA rule below
   * cannot apply in one place and not another.
   *
   * CPA gets its own denominator. Summing spend and NFC independently would
   * divide the months that HAVE spend by the NFC of ALL months: August has no
   * spend booked anywhere but did acquire clients, so its clients would arrive
   * in the denominator with no cost attached and drag CPA down - roughly 10%
   * across APAC. `nfc_for_cpa` counts only the months that carry spend, and
   * `cpa_excluded_months` records what was left out so the page can say so.
   */
  function sumRows(rows, month, label) {
    var totals = { month: month, market: label };
    NUMERIC_COLS.forEach(function (c) {
      var vals = rows.map(function (r) { return r[c]; }).filter(function (v) {
        return v !== null && v !== undefined;
      });
      totals[c] = vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) : null;
    });

    var nfcForCpa = null;
    var excluded = [];
    rows.forEach(function (r) {
      var spend = r.marketing_spend;
      if (spend !== null && spend !== undefined) {
        if (r.nfc !== null && r.nfc !== undefined) nfcForCpa = (nfcForCpa || 0) + r.nfc;
      } else if (r.nfc) {
        if (r.month && excluded.indexOf(r.month) < 0) excluded.push(r.month);
      }
    });
    totals.nfc_for_cpa = nfcForCpa;
    totals.cpa_excluded_months = excluded.sort();
    return totals;
  }

  /** Sum the raw columns across rows, then derive once from the totals. */
  function aggregate(rows, month, label) {
    var totals = sumRows(rows, month, label);
    // Every remaining metric is a ratio of two summed columns, so deriving
    // once from the totals gives the correctly NFC-weighted answer for free -
    // no per-market rate inputs left to blend.
    var agg = deriveRow(totals, null);
    agg.is_aggregate = true;
    agg.member_count = rows.length;
    agg.is_partial = rows.some(function (r) { return r.is_partial; });
    return agg;
  }

  /* ---------------------------------------------------------------- health */

  /* Weights sum to 1 when every component is present; when an input is missing
   * the component is dropped and the rest are renormalised, so a market is
   * never penalised for data you have not supplied yet. */
  var HEALTH_COMPONENTS = [
    { key: "funnel", label: "REG→NFC conversion", weight: 0.35, higherIsBetter: true },
    { key: "cpa", label: "CPA vs benchmark", weight: 0.30, higherIsBetter: false },
    { key: "nfc", label: "NFC growth", weight: 0.20, higherIsBetter: true },
    { key: "revenue", label: "Revenue growth", weight: 0.15, higherIsBetter: true },
  ];

  var BANDS = [
    { key: "healthy", label: "Healthy", min: 85 },
    { key: "watch", label: "Watch", min: 70 },
    { key: "serious", label: "Under-performing", min: 50 },
    { key: "critical", label: "At risk", min: -Infinity },
  ];

  function bandFor(score) {
    if (score === null || score === undefined || !isFinite(score)) {
      return { key: "nodata", label: "No data" };
    }
    for (var i = 0; i < BANDS.length; i++) {
      if (score >= BANDS[i].min) return BANDS[i];
    }
    return BANDS[BANDS.length - 1];
  }

  /** Score = percentage of the benchmark achieved, capped at 100.
   *
   * The cap matters: without it, one metric running far ahead of target (a
   * cheap CPA in a young market) arithmetically cancels a badly broken funnel
   * and the market reads "healthy". Capping makes the score "how much of every
   * target am I hitting", where 100 means all of them and nothing above. */
  function scoreAgainst(actual, benchmark, higherIsBetter) {
    if (actual === null || benchmark === null || !benchmark || !isFinite(actual)) return null;
    var r = higherIsBetter ? actual / benchmark : benchmark / actual;
    if (!isFinite(r) || r < 0) return null;
    return clamp(r * 100, 0, 100);
  }

  /**
   * Score a market for one month.
   *
   * `benchmarks` supplies the yardstick per component, resolved by the caller:
   * an explicit target from assumptions.csv where one is set, otherwise the
   * market's own tier reference. UK is the yardstick for mature markets only -
   * measuring an emerging market against a mature one reports its age, not its
   * health.
   */
  function scoreHealth(current, previous, market, benchmarks) {
    var parts = {};

    parts.funnel = {
      actual: current.cvr_reg_nfc,
      benchmark: benchmarks.cvr_reg_nfc,
      score: scoreAgainst(current.cvr_reg_nfc, benchmarks.cvr_reg_nfc, true),
    };
    parts.cpa = {
      actual: current.cpa,
      benchmark: benchmarks.cpa,
      score: scoreAgainst(current.cpa, benchmarks.cpa, false),
    };
    // Growth on a common curve: flat reads 80, +12.5% or better reads 100,
    // -50% reads 0. Comparing a part month against a full one would show a
    // collapse that never happened, so partial periods score null and the
    // component drops out rather than dragging the market down.
    function growth(key) {
      if (!previous || current.is_partial || previous.is_partial) return null;
      var a = current[key];
      var b = previous[key];
      if (a === null || a === undefined || !b || !isFinite(a) || !isFinite(b)) return null;
      return a / b - 1;
    }

    var nfcGrowth = growth("nfc");
    parts.nfc = {
      actual: nfcGrowth,
      benchmark: 0,
      score: nfcGrowth === null ? null : clamp(80 + nfcGrowth * 160, 0, 100),
    };

    var revKey = "rev_total";
    var revGrowth = growth(revKey);
    parts.revenue = {
      actual: revGrowth,
      benchmark: 0,
      basis: "new total revenue",
      score: revGrowth === null ? null : clamp(80 + revGrowth * 160, 0, 100),
    };

    var total = 0;
    var weight = 0;
    var scored = 0;
    HEALTH_COMPONENTS.forEach(function (c) {
      var p = parts[c.key];
      p.label = c.label;
      p.weight = c.weight;
      if (p.score !== null) {
        total += p.score * c.weight;
        weight += c.weight;
        scored++;
      }
    });

    var score = weight > 0 ? clamp(total / weight, 0, 100) : null;
    return {
      score: score,
      band: bandFor(score),
      coverage: weight,          // 1.0 = every component had data
      scored: scored,            // how many of the four actually contributed
      total_components: HEALTH_COMPONENTS.length,
      parts: parts,
    };
  }

  /* --------------------------------------------------------------- parsing */

  /** Parse pasted spreadsheet text (TSV or CSV) into monthly rows. */
  function parsePaste(text, knownMarkets) {
    var lines = String(text)
      .split(/\r?\n/)
      .filter(function (l) { return l.trim() && !l.trim().startsWith("#"); });
    if (!lines.length) return { rows: [], errors: ["Nothing to import."] };

    var delim = lines[0].indexOf("\t") >= 0 ? "\t" : ",";
    var split = function (line) {
      if (delim === "\t") return line.split("\t");
      // minimal CSV: respect double-quoted fields
      var out = [];
      var cur = "";
      var q = false;
      for (var i = 0; i < line.length; i++) {
        var ch = line[i];
        if (ch === '"') {
          if (q && line[i + 1] === '"') { cur += '"'; i++; } else { q = !q; }
        } else if (ch === "," && !q) { out.push(cur); cur = ""; } else { cur += ch; }
      }
      out.push(cur);
      return out;
    };

    var header = split(lines[0]).map(function (h) {
      return h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    });
    var ALIASES = {
      registrations: "reg", registration: "reg", regs: "reg", signups: "reg",
      submits: "submit", submitted: "submit", submission: "submit", submissions: "submit",
      l3_approved: "l3", approved: "l3",
      first_trade: "nfc", nfc_customers: "nfc", new_first_customers: "nfc",
      total_revenue: "new_total_revenue", gross_revenue: "new_total_revenue",
      spend: "marketing_spend", cost: "marketing_spend", marketing_cost: "marketing_spend",
      country: "market", region: "market",
    };
    header = header.map(function (h) { return ALIASES[h] || h; });

    var required = ["month", "market"];
    var missing = required.filter(function (c) { return header.indexOf(c) < 0; });
    if (missing.length) {
      return {
        rows: [],
        errors: ["Missing required column(s): " + missing.join(", ") +
                 ". Header found: " + header.join(", ")],
      };
    }

    var present = NUMERIC_COLS.filter(function (c) { return header.indexOf(c) >= 0; });

    var rows = [];
    var errors = [];
    for (var i = 1; i < lines.length; i++) {
      var cells = split(lines[i]);
      var rec = {};
      header.forEach(function (h, idx) { rec[h] = cells[idx]; });

      var market = String(rec.market || "").trim().toUpperCase();
      var month = String(rec.month || "").trim();
      // Accept "Aug-26", "2026-08", "August 2026", "01/08/2026" -> YYYY-MM
      month = normaliseMonth(month);
      if (!month) { errors.push("Row " + (i + 1) + ": cannot read month " + JSON.stringify(rec.month)); continue; }
      if (knownMarkets && knownMarkets.indexOf(market) < 0) {
        errors.push("Row " + (i + 1) + ": unknown market " + JSON.stringify(rec.market));
        continue;
      }
      var row = { month: month, market: market };
      present.forEach(function (c) { row[c] = parseNumber(rec[c]); });
      rows.push(row);
    }
    // `present` lets the caller merge only the columns that were actually
    // pasted, so a spend-only paste tops up CPA without erasing the funnel.
    return { rows: rows, errors: errors, columns: present };
  }

  var MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

  function normaliseMonth(s) {
    if (!s) return null;
    s = String(s).trim();
    var m = s.match(/^(\d{4})[-/](\d{1,2})$/); // 2026-08
    if (m) return m[1] + "-" + String(m[2]).padStart(2, "0");
    m = s.match(/^([a-z]{3,})[\s-]*(\d{2,4})$/i); // Aug-26, August 2026
    if (m) {
      var idx = MONTH_NAMES.indexOf(m[1].slice(0, 3).toLowerCase());
      if (idx >= 0) {
        var y = Number(m[2]);
        if (y < 100) y += 2000;
        return y + "-" + String(idx + 1).padStart(2, "0");
      }
    }
    m = s.match(/^(\d{1,2})[-/](\d{4})$/); // 08/2026
    if (m) return m[2] + "-" + String(m[1]).padStart(2, "0");
    var d = new Date(s);
    if (!isNaN(d.getTime())) {
      return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
    }
    return null;
  }

  global.Metrics = {
    STAGES: STAGES,
    STAGE_LABELS: STAGE_LABELS,
    NUMERIC_COLS: NUMERIC_COLS,
    HEALTH_COMPONENTS: HEALTH_COMPONENTS,
    BANDS: BANDS,
    deriveRow: deriveRow,
    sumRows: sumRows,
    aggregate: aggregate,
    scoreHealth: scoreHealth,
    bandFor: bandFor,
    parsePaste: parsePaste,
    parseNumber: parseNumber,
    normaliseMonth: normaliseMonth,
    ratio: ratio,
  };
})(window);
