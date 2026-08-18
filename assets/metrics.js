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
    "new_transaction_revenue",
    "total_gross_revenue",
    "marketing_spend",
    "active_customers",
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
   * LTV uses a finite-horizon net-revenue-retention model:
   *
   *   GP1  = (new_total_revenue / nfc) * gross_margin        month-1 gross profit per new customer
   *   r    = nrr / (1 + monthly_discount_rate)
   *   LTV  = GP1 * (1 - r^T) / (1 - r)                       T = ltv_horizon_months
   *
   * NRR (not logo churn) is the decay term because a surviving cross-border
   * customer's revenue moves with their trade volume - it expands as well as
   * contracts, and logo churn alone systematically understates the value of a
   * growth market. The horizon T is what keeps the sum finite when NRR >= 1,
   * which is common in the first year of a young market; the classic 1/churn
   * form diverges there and prints a meaningless LTV.
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
    // Whole-book revenue for the market, as opposed to the new-cohort revenue
    // that drives revenue-per-customer, payback and LTV.
    m.rev_book = row.total_gross_revenue === undefined ? null : row.total_gross_revenue;
    m.rev_total = row.new_total_revenue;
    m.rev_txn = row.new_transaction_revenue;
    m.rev_other =
      m.rev_total !== null && m.rev_txn !== null ? m.rev_total - m.rev_txn : null;
    m.txn_share = ratio(m.rev_txn, m.rev_total);
    m.spend = row.marketing_spend;

    // Funnel step conversion + end-to-end.
    m.cvr_reg_submit = ratio(m.submit, m.reg);
    m.cvr_submit_l3 = ratio(m.l3, m.submit);
    m.cvr_l3_nfc = ratio(m.nfc, m.l3);
    m.cvr_reg_nfc = ratio(m.nfc, m.reg);

    // Unit economics.
    m.cpa = ratio(m.spend, m.nfc);
    m.arpa = ratio(m.rev_total, m.nfc); // revenue per new customer, month 1
    m.arpa_txn = ratio(m.rev_txn, m.nfc);

    var gm = market && market.gross_margin_pct !== null ? market.gross_margin_pct / 100 : null;
    m.gross_margin = gm;

    // Average monthly revenue per customer. Preferred source is whole-book
    // revenue over the active base; falls back to a per-market assumption, and
    // last of all to month-1 new-cohort revenue (which understates a customer
    // who ramps - see METHODOLOGY.md).
    m.active_customers = row.active_customers === undefined ? null : row.active_customers;
    m.arpu = ratio(m.rev_book, m.active_customers);
    m.arpu_basis = {
      estimate: "book revenue \u00f7 estimated active base",
      total_nfc: "book revenue \u00f7 total NFC",
    }[row.active_customers_basis] || "book revenue \u00f7 active customers";
    if (m.arpu === null && market && market.avg_monthly_revenue_per_customer) {
      m.arpu = market.avg_monthly_revenue_per_customer;
      m.arpu_basis = "per-market assumption";
    }
    if (m.arpu === null) {
      m.arpu = m.arpa;
      m.arpu_basis = "month-1 new cohort (a floor)";
    }

    // Monthly gross profit from one customer, on the same revenue basis as LTV.
    m.gp_per_customer = m.arpu !== null && gm !== null ? m.arpu * gm : null;

    // CAC payback, in months of that gross profit.
    m.payback_months =
      m.cpa !== null && m.gp_per_customer ? m.cpa / m.gp_per_customer : null;


    // LTV. See METHODOLOGY.md - the ramp term is what makes this usable for a
    // payments book, where a new merchant's month-1 revenue is a small
    // fraction of what the same merchant produces once established.
    m.ltv = null;
    m.ltv_method = (market && market.ltv_method) || "simple_net";
    if (m.ltv_method === "simple_net") {
      /* The agreed working formula:
       *   LTV = (N months x average monthly revenue per customer) - CPA
       * A net figure: what one customer is worth over N months after paying
       * to acquire them. Deliberately simple, and only as good as the ARPU
       * basis above - if that is month-1 revenue for a customer who ramps,
       * this reads far too low. */
      var horizonSimple = (market && market.ltv_months) || 18;
      if (m.arpu !== null && m.cpa !== null) {
        m.ltv = horizonSimple * m.arpu - m.cpa;
        m.ltv_horizon = horizonSimple;
      }
    } else if (m.gp_per_customer !== null && market) {
      var nrr = market.monthly_nrr_pct !== null ? market.monthly_nrr_pct / 100 : null;
      var horizon = market.ltv_horizon_months || 36;
      var annual = market.discount_rate_annual_pct || 0;
      var monthlyDiscount = annual ? Math.pow(1 + annual / 100, 1 / 12) - 1 : 0;
      var rampTo = market.revenue_ramp_multiple;
      rampTo = rampTo === null || rampTo === undefined ? 1 : rampTo;
      var rampMonths = market.ramp_months || 12;
      if (nrr !== null && nrr >= 0) {
        var r = nrr / (1 + monthlyDiscount);
        var sum = 0;
        for (var t = 0; t < horizon; t++) {
          // linear ramp from 1x month-1 revenue to rampTo over rampMonths,
          // flat thereafter; then the usual NRR decay on top
          var ramp = rampTo === 1
            ? 1
            : 1 + (rampTo - 1) * Math.min(t, rampMonths) / rampMonths;
          sum += ramp * Math.pow(r, t);
        }
        m.ltv = m.gp_per_customer * sum;
        m.ltv_horizon = horizon;
        m.ltv_ramp = rampTo;
      }
    }
    m.ltv_cac = ratio(m.ltv, m.cpa);

    return m;
  }

  /** Sum the raw columns across rows, then derive once from the totals. */
  function aggregate(rows, month, label, marketsById) {
    var totals = { month: month, market: label };
    NUMERIC_COLS.forEach(function (c) {
      var vals = rows.map(function (r) { return r[c]; }).filter(function (v) {
        return v !== null && v !== undefined;
      });
      totals[c] = vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) : null;
    });
    // Rate-style inputs cannot be summed - blend them by NFC weight so the
    // aggregate LTV/payback reflect where customers were actually acquired.
    var blended = weightedBy(rows, marketsById);
    var agg = deriveRow(totals, {
      gross_margin_pct: blended.gross_margin_pct,
      monthly_nrr_pct: blended.monthly_nrr_pct,
      ltv_horizon_months: blended.ltv_horizon_months || 36,
      discount_rate_annual_pct: blended.discount_rate_annual_pct || 0,
    });
    agg.is_aggregate = true;
    agg.member_count = rows.length;
    agg.is_partial = rows.some(function (r) { return r.is_partial; });
    // Keep the "estimated" qualifier through a roll-up rather than losing it.
    var basis = (rows[0] || {}).active_customers_basis;
    if (basis) {
      agg.arpu_basis = deriveRow({ active_customers_basis: basis }, null).arpu_basis;
    }
    return agg;
  }

  function weightedBy(rows, marketsById) {
    var keys = [
      "gross_margin_pct",
      "monthly_nrr_pct",
      "ltv_horizon_months",
      "discount_rate_annual_pct",
    ];
    var out = {};
    keys.forEach(function (k) {
      var num = 0;
      var den = 0;
      rows.forEach(function (r) {
        var mk = marketsById && marketsById[r.market];
        var w = r.nfc || 0;
        if (mk && mk[k] !== null && mk[k] !== undefined && w > 0) {
          num += mk[k] * w;
          den += w;
        }
      });
      out[k] = den ? num / den : null;
    });
    return out;
  }

  /* ---------------------------------------------------------------- health */

  /* Weights sum to 1 when every component is present; when an input is missing
   * the component is dropped and the rest are renormalised, so a market is
   * never penalised for data you have not supplied yet. */
  var HEALTH_COMPONENTS = [
    { key: "funnel", label: "REG→NFC conversion", weight: 0.25, higherIsBetter: true },
    { key: "cpa", label: "CPA vs target", weight: 0.2, higherIsBetter: false },
    { key: "ltv_cac", label: "LTV : CAC", weight: 0.25, higherIsBetter: true },
    { key: "payback", label: "CAC payback", weight: 0.2, higherIsBetter: false },
    { key: "momentum", label: "Revenue momentum", weight: 0.1, higherIsBetter: true },
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
   * `benchmarks` supplies the yardstick per component: an explicit target from
   * assumptions.csv where one is set, otherwise the reference market (UK).
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
    parts.ltv_cac = {
      actual: current.ltv_cac,
      benchmark: market.target_ltv_cac || 3,
      score: scoreAgainst(current.ltv_cac, market.target_ltv_cac || 3, true),
    };
    parts.payback = {
      actual: current.payback_months,
      benchmark: market.target_payback_months || 12,
      score: scoreAgainst(current.payback_months, market.target_payback_months || 12, false),
    };

    // Momentum: MoM revenue growth, scored so flat = 80 and +12.5% or better = 100.
    var growth = null;
    // Comparing a part-month against a full month would read as a collapse in
    // revenue that never happened, so momentum is skipped for partial periods.
    if (previous && previous.rev_total && current.rev_total !== null &&
        !current.is_partial && !previous.is_partial) {
      growth = current.rev_total / previous.rev_total - 1;
    }
    parts.momentum = {
      actual: growth,
      benchmark: 0,
      score: growth === null ? null : clamp(80 + growth * 160, 0, 100),
    };

    var total = 0;
    var weight = 0;
    HEALTH_COMPONENTS.forEach(function (c) {
      var p = parts[c.key];
      p.label = c.label;
      p.weight = c.weight;
      if (p.score !== null) {
        total += p.score * c.weight;
        weight += c.weight;
      }
    });

    var score = weight > 0 ? clamp(total / weight, 0, 100) : null;
    return {
      score: score,
      band: bandFor(score),
      coverage: weight, // 1.0 = every component had data
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
      transaction_revenue: "new_transaction_revenue",
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
    aggregate: aggregate,
    weightedBy: weightedBy,
    scoreHealth: scoreHealth,
    bandFor: bandFor,
    parsePaste: parsePaste,
    parseNumber: parseNumber,
    normaliseMonth: normaliseMonth,
    ratio: ratio,
  };
})(window);
