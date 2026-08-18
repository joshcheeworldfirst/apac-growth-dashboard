/* APAC Growth Dashboard - view layer.
 * Reads window.APAC_DATA (built from data/*.csv) and window.MAP_PATHS,
 * derives every metric through window.Metrics, and renders the page.
 */
(function () {
  "use strict";

  var M = window.Metrics;
  var REFERENCE_MARKET = "UK"; // non-APAC, used as the mature-market yardstick

  var TIERS = {
    mature: { label: "Mature", color: "var(--series-1)", order: 0 },
    growth: { label: "Growth", color: "var(--series-2)", order: 1 },
    emerging: { label: "Emerging", color: "var(--series-3)", order: 2 },
  };

  var BAND_COLOR = {
    healthy: "var(--good)",
    watch: "var(--warning)",
    serious: "var(--serious)",
    critical: "var(--critical)",
    nodata: "var(--nodata)",
  };
  /* Status colour never travels alone - each band carries a glyph and a word. */
  var BAND_ICON = { healthy: "●", watch: "▲", serious: "◆", critical: "■", nodata: "○" };

  /* Nudges so labels clear the coastline they belong to. */
  var LABEL_OFFSET = {
    SG: [14, 2], MY: [12, 10], VN: [12, -16], TH: [-40, -18],
    ANZ: [0, 0],
  };

  /* Markets spread over many countries get a fixed label position in open
   * water instead of a meaningless multi-country centroid. Map pixel coords. */
  var LABEL_ANCHOR = { LONGTAIL: [846, 300] };

  var state = {
    month: null,
    period: "month",
    selected: null,
    trendMetric: "rev_total",
    sort: { key: "health", dir: -1 },
    rows: [],          // raw monthly rows (mutable - the paste path replaces these)
  };

  var el = {};
  var data = window.APAC_DATA || { markets: [], geography: {}, rows: [] };
  var marketsById = {};
  var months = [];

  /* ------------------------------------------------------------ formatting */

  function fmtInt(v) {
    if (v === null || v === undefined || !isFinite(v)) return "—";
    return Math.round(v).toLocaleString("en-US");
  }

  function fmtMoney(v, opts) {
    if (v === null || v === undefined || !isFinite(v)) return "—";
    var abs = Math.abs(v);
    var sign = v < 0 ? "-" : "";
    if (opts && opts.exact) {
      return sign + "$" + Math.round(abs).toLocaleString("en-US");
    }
    if (abs >= 1e9) return sign + "$" + (abs / 1e9).toFixed(2) + "B";
    if (abs >= 1e6) return sign + "$" + (abs / 1e6).toFixed(2) + "M";
    if (abs >= 1e4) return sign + "$" + Math.round(abs / 1e3) + "K";
    if (abs >= 1e3) return sign + "$" + (abs / 1e3).toFixed(1) + "K";
    return sign + "$" + abs.toFixed(abs < 10 ? 2 : 0);
  }

  function fmtPct(v, dp) {
    if (v === null || v === undefined || !isFinite(v)) return "—";
    return (v * 100).toFixed(dp === undefined ? 1 : dp) + "%";
  }

  function fmtNum(v, dp) {
    if (v === null || v === undefined || !isFinite(v)) return "—";
    return v.toFixed(dp === undefined ? 1 : dp);
  }

  function fmtMonths(v) {
    if (v === null || v === undefined || !isFinite(v)) return "—";
    if (v > 240) return "> 20 yrs";
    return v.toFixed(1) + " mo";
  }

  function monthLabel(m) {
    if (!m) return "";
    var parts = m.split("-");
    var names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return names[Number(parts[1]) - 1] + " " + parts[0];
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /* --------------------------------------------------------------- compute */

  /** Raw rows for a market, in month order, up to and including `upto`. */
  function rawSeries(market, upto) {
    return state.rows
      .filter(function (r) { return r.market === market && (!upto || r.month <= upto); })
      .sort(function (a, b) { return a.month < b.month ? -1 : 1; });
  }

  function rawAt(market, month) {
    for (var i = 0; i < state.rows.length; i++) {
      if (state.rows[i].market === market && state.rows[i].month === month) return state.rows[i];
    }
    return null;
  }

  function hasData(row) {
    if (!row) return false;
    return M.NUMERIC_COLS.some(function (c) { return row[c] !== null && row[c] !== undefined; });
  }

  /** Metrics for one market over the active period (single month or YTD). */
  function periodMetrics(market) {
    var mk = marketsById[market];
    if (state.period === "ytd") {
      var year = state.month.slice(0, 4);
      var rows = rawSeries(market, state.month).filter(function (r) {
        return r.month.slice(0, 4) === year && hasData(r);
      });
      if (!rows.length) return null;
      var totals = { month: state.month, market: market };
      M.NUMERIC_COLS.forEach(function (c) {
        var vals = rows.map(function (r) { return r[c]; })
          .filter(function (v) { return v !== null && v !== undefined; });
        totals[c] = vals.length ? vals.reduce(function (a, b) { return a + b; }, 0) : null;
      });
      return M.deriveRow(totals, mk);
    }
    var raw = rawAt(market, state.month);
    if (!hasData(raw)) return null;
    return M.deriveRow(raw, mk);
  }

  /** Previous *month* metrics - momentum is always month-on-month, even in YTD view. */
  function previousMonthMetrics(market) {
    var idx = months.indexOf(state.month);
    if (idx <= 0) return null;
    var raw = rawAt(market, months[idx - 1]);
    if (!hasData(raw)) return null;
    return M.deriveRow(raw, marketsById[market]);
  }

  /** Aggregate across a set of markets for the active period. */
  function aggregateMarkets(codes, label) {
    var rows = [];
    var year = state.month.slice(0, 4);
    codes.forEach(function (code) {
      if (state.period === "ytd") {
        rawSeries(code, state.month).forEach(function (r) {
          if (r.month.slice(0, 4) === year && hasData(r)) rows.push(r);
        });
      } else {
        var r = rawAt(code, state.month);
        if (hasData(r)) rows.push(r);
      }
    });
    if (!rows.length) return null;
    return M.aggregate(rows, state.month, label, marketsById);
  }

  /**
   * Benchmarks a market is scored against: an explicit target from
   * assumptions.csv when set, otherwise the reference market's own actual.
   */
  function benchmarksFor(market) {
    var mk = marketsById[market];
    var ref = market === REFERENCE_MARKET ? null : periodMetrics(REFERENCE_MARKET);
    return {
      cvr_reg_nfc: mk.target_reg_to_nfc_pct !== null && mk.target_reg_to_nfc_pct !== undefined
        ? mk.target_reg_to_nfc_pct / 100
        : (ref ? ref.cvr_reg_nfc : null),
      cpa: mk.target_cpa !== null && mk.target_cpa !== undefined
        ? mk.target_cpa
        : (ref ? ref.cpa : null),
    };
  }

  /** Everything the render pass needs, computed once per state change. */
  function snapshot() {
    var out = [];
    data.markets.forEach(function (mk) {
      var cur = periodMetrics(mk.market);
      var entry = {
        market: mk.market,
        meta: mk,
        metrics: cur,
        health: null,
        benchmarks: benchmarksFor(mk.market),
      };
      if (cur) {
        entry.health = M.scoreHealth(cur, previousMonthMetrics(mk.market), mk, entry.benchmarks);
      }
      out.push(entry);
    });
    return out;
  }

  /* ------------------------------------------------------------- rendering */

  function render() {
    var snap = snapshot();
    var apac = snap.filter(function (s) { return s.meta.in_apac; });

    renderBanner(snap);
    renderKpis(apac, snap);
    renderMap(snap);
    renderRank(snap);
    renderFunnel(snap);
    renderScatter(snap);
    renderTrends();
    renderTable(snap);
    renderMethodNote();
  }

  function renderBanner(snap) {
    var withData = snap.filter(function (s) { return s.metrics; });
    var apacWith = withData.filter(function (s) { return s.meta.in_apac; });
    var missing = data.markets.filter(function (mk) {
      return !withData.some(function (s) { return s.market === mk.market; });
    });
    var noSpend = withData.filter(function (s) { return s.metrics.cpa === null; });

    var bits = [];
    if (state.isDemo) {
      el.banner.innerHTML = '<span class="dot" style="background:var(--critical)"></span>' +
        "<span><strong>Every figure on this page is invented.</strong> This is a " +
        "demonstration of the dashboard, not a report — the numbers exist so the layout " +
        "has something to render, and describe no real business. Use " +
        "<em>Paste data</em> to load your own; it stays in your browser.</span>";
      return;
    }
    if (!withData.length) {
      bits.push("<strong>No data loaded yet.</strong> Load your rows with the " +
        "<em>Paste data</em> button — tab- or comma-separated, straight from a spreadsheet.");
    } else {
      bits.push("<strong>" + apacWith.length + " of " + data.markets.filter(function (m) { return m.in_apac; }).length +
        " APAC markets</strong> reporting for " +
        (state.period === "ytd" ? "YTD to " : "") + monthLabel(state.month) + ".");
      if (missing.length) {
        bits.push("No data for " + missing.map(function (m) { return m.market; }).join(", ") + ".");
      }
      if (noSpend.length) {
        bits.push("<strong>CPA, payback and LTV:CAC are blank for " +
          noSpend.map(function (s) { return s.market; }).join(", ") +
          "</strong> — those need the <code>marketing_spend</code> column.");
      }
      var partial = withData.filter(function (s) { return s.metrics.is_partial; });
      if (partial.length) {
        var label = partial[0].metrics.period_label || "a part month";
        bits.push("<strong>" + esc(label) + " is a partial period</strong> — " +
          "month-on-month momentum is skipped rather than compared against a full month.");
      }
      var bases = {};
      withData.forEach(function (s) {
        if (s.metrics.arpu_basis) bases[s.metrics.arpu_basis] = true;
      });
      var basisList = Object.keys(bases);
      if (basisList.length) {
        bits.push("Net LTV and payback use <strong>" + esc(basisList.join(" / ")) +
          "</strong> as revenue per customer.");
      }
      var allocated = withData.filter(function (s) {
        return s.metrics.spend_basis && s.metrics.spend_basis.indexOf("allocated") === 0;
      });
      if (allocated.length) {
        bits.push("Spend for " + allocated.map(function (s) { return s.market; }).join(", ") +
          " is <strong>allocated from the SEA-5 total by NFC share</strong>, not measured " +
          "per country — treat their CPA as indicative.");
      }
    }
    var band = !withData.length ? "nodata" : (noSpend.length || missing.length ? "watch" : "healthy");
    el.banner.innerHTML =
      '<span class="dot" style="background:' + BAND_COLOR[band] + '"></span><span>' +
      bits.join(" ") + "</span>";
  }

  function kpiCard(label, value, sub, deltaHtml) {
    return '<div class="card kpi"><span class="label">' + esc(label) + "</span>" +
      '<span class="value' + (value === "—" ? " muted" : "") + '">' + value + "</span>" +
      '<span class="delta' + (deltaHtml ? deltaHtml.cls : "") + '">' +
      (deltaHtml ? deltaHtml.html : esc(sub || "")) + "</span></div>";
  }

  function deltaVs(cur, prev, opts) {
    if (cur === null || prev === null || !isFinite(cur) || !isFinite(prev) || prev === 0) {
      return { cls: "", html: esc((opts && opts.fallback) || "no prior month") };
    }
    var pct = cur / prev - 1;
    var better = (opts && opts.lowerIsBetter) ? pct < 0 : pct > 0;
    var cls = Math.abs(pct) < 0.001 ? "" : (better ? " up" : " down");
    var arrow = pct > 0 ? "▲" : pct < 0 ? "▼" : "•";
    return {
      cls: cls,
      html: arrow + " " + (pct * 100).toFixed(1) + "% vs " + ((opts && opts.label) || "prior month"),
    };
  }

  function renderKpis(apac, snap) {
    var codes = apac.map(function (s) { return s.market; });
    var cur = aggregateMarkets(codes, "APAC");
    if (!cur) {
      el.kpis.innerHTML = '<div class="card empty" style="grid-column:1/-1">No data for this period yet.</div>';
      return;
    }
    // Prior-month APAC aggregate for the deltas.
    var idx = months.indexOf(state.month);
    var prev = null;
    if (idx > 0) {
      var saveMonth = state.month;
      var savePeriod = state.period;
      state.month = months[idx - 1];
      state.period = "month";
      prev = aggregateMarkets(codes, "APAC");
      state.month = saveMonth;
      state.period = savePeriod;
    }
    var prevCmp = state.period === "month" ? prev : null;

    var ref = snap.filter(function (s) { return s.market === REFERENCE_MARKET; })[0];
    var refCvr = ref && ref.metrics ? ref.metrics.cvr_reg_nfc : null;

    el.kpis.innerHTML = [
      kpiCard("APAC new customers (NFC)", fmtInt(cur.nfc), "",
        prevCmp ? deltaVs(cur.nfc, prevCmp.nfc) : null),
      kpiCard("Total revenue (whole book)", fmtMoney(cur.rev_book), "",
        prevCmp ? deltaVs(cur.rev_book, prevCmp.rev_book) : null),
      kpiCard("New-cohort revenue", fmtMoney(cur.rev_total), "month-1 revenue from this month's NFC",
        prevCmp ? deltaVs(cur.rev_total, prevCmp.rev_total) : null),
      kpiCard("REG → NFC conversion", fmtPct(cur.cvr_reg_nfc, 2),
        refCvr !== null ? "UK reference " + fmtPct(refCvr, 2) : "no UK reference yet"),
      kpiCard("Blended CPA", fmtMoney(cur.cpa, { exact: cur.cpa !== null && cur.cpa < 10000 }),
        cur.cpa === null ? "needs marketing_spend" : "",
        cur.cpa !== null && prevCmp ? deltaVs(cur.cpa, prevCmp.cpa, { lowerIsBetter: true }) : null),
      kpiCard("Revenue per NFC", fmtMoney(cur.arpa, { exact: true }), "month-1 revenue per new customer"),
      kpiCard("CAC payback", fmtMonths(cur.payback_months),
        cur.payback_months === null ? "needs marketing_spend" : "target ≤ 12 mo"),
    ].join("");
  }

  /* ------------------------------------------------------------------ map */

  function pathCentroid(d) {
    // Bounding-box centre of the largest subpath - good enough to hang a label on.
    var best = null;
    d.split("M").forEach(function (sub) {
      if (!sub.trim()) return;
      var nums = sub.replace(/Z/g, "").split("L");
      var xs = [], ys = [];
      nums.forEach(function (p) {
        var xy = p.split(",");
        var x = Number(xy[0]), y = Number(xy[1]);
        if (isFinite(x) && isFinite(y)) { xs.push(x); ys.push(y); }
      });
      if (xs.length < 3) return;
      var w = Math.max.apply(null, xs) - Math.min.apply(null, xs);
      var h = Math.max.apply(null, ys) - Math.min.apply(null, ys);
      var area = w * h;
      if (!best || area > best.area) {
        best = {
          area: area,
          x: (Math.max.apply(null, xs) + Math.min.apply(null, xs)) / 2,
          y: (Math.max.apply(null, ys) + Math.min.apply(null, ys)) / 2,
        };
      }
    });
    return best;
  }

  function isoToMarket() {
    var map = {};
    Object.keys(data.geography || {}).forEach(function (mk) {
      (data.geography[mk].iso || []).forEach(function (iso) { map[iso] = mk; });
    });
    return map;
  }

  function renderMap(snap) {
    var paths = window.MAP_PATHS;
    if (!paths) { el.mapStage.innerHTML = '<div class="empty">Map geometry not loaded.</div>'; return; }

    var byMarket = {};
    snap.forEach(function (s) { byMarket[s.market] = s; });
    var iso2mk = isoToMarket();
    var apacView = paths.apac;
    var W = apacView.width, H = apacView.height;

    var svg = ['<svg viewBox="0 0 ' + W + " " + H + '" role="img" ' +
      'aria-label="Map of APAC markets shaded by health band">'];

    // 1. every country as background land, then repaint our markets on top
    var labels = [];
    Object.keys(apacView.shapes).forEach(function (iso) {
      var shape = apacView.shapes[iso];
      var mk = iso2mk[iso];
      if (!mk || !byMarket[mk]) {
        svg.push('<path class="country" d="' + shape.d + '"></path>');
      }
    });
    Object.keys(apacView.shapes).forEach(function (iso) {
      var shape = apacView.shapes[iso];
      var mk = iso2mk[iso];
      if (!mk || !byMarket[mk]) return;
      var s = byMarket[mk];
      var band = s.health ? s.health.band.key : "nodata";
      // Inline style, not a fill attribute: `.country { fill }` in the
      // stylesheet outranks a presentation attribute and would grey it out.
      svg.push('<path class="country market' + (state.selected === mk ? " selected" : "") +
        '" data-market="' + mk + '" d="' + shape.d + '" style="fill:' + BAND_COLOR[band] +
        (state.selected && state.selected !== mk ? ";opacity:.45" : "") + '"></path>');
    });

    // 2. one label per market, on its largest shape
    data.markets.forEach(function (mk) {
      if (!mk.in_apac) return;
      var geo = data.geography[mk.market];
      if (!geo) return;
      var s = byMarket[mk.market];
      var anchorIso = geo.iso[0];
      var shape = apacView.shapes[anchorIso];
      var pt = null;
      if (LABEL_ANCHOR[mk.market]) {
        pt = { x: LABEL_ANCHOR[mk.market][0], y: LABEL_ANCHOR[mk.market][1] };
      } else if (geo.marker && apacView.points[geo.marker]) {
        pt = { x: apacView.points[geo.marker][0], y: apacView.points[geo.marker][1] };
        var band = s && s.health ? s.health.band.key : "nodata";
        svg.push('<circle class="marker" data-market="' + mk.market + '" cx="' + pt.x +
          '" cy="' + pt.y + '" r="6" style="fill:' + BAND_COLOR[band] + '"></circle>');
      } else if (shape) {
        pt = pathCentroid(shape.d);
      }
      if (!pt) return;
      var off = LABEL_OFFSET[mk.market] || [0, 0];
      var score = s && s.health && s.health.score !== null ? Math.round(s.health.score) : null;
      labels.push('<text class="map-label" x="' + (pt.x + off[0]) + '" y="' + (pt.y + off[1]) +
        '">' + esc(mk.market) + "</text>");
      labels.push('<text class="map-label sub" x="' + (pt.x + off[0]) + '" y="' + (pt.y + off[1] + 12) +
        '">' + (score === null ? "no data" : score + " · " + esc(s.health.band.label)) + "</text>");
    });
    svg.push(labels.join(""));

    // 3. UK reference inset, bottom-left. UK is not in APAC - it sits in its own
    //    framed panel so it reads as a yardstick, not as part of the region.
    var uk = paths.uk;
    var padX = 10, padTop = 26, padBottom = 34;
    var frameW = uk.width + padX * 2;
    var frameH = uk.height + padTop + padBottom;
    var ix = 14, iy = H - frameH - 14;
    var ukState = byMarket[REFERENCE_MARKET];
    var ukBand = ukState && ukState.health ? ukState.health.band.key : "nodata";
    svg.push('<g transform="translate(' + ix + "," + iy + ')">');
    svg.push('<rect class="inset-frame" x="0" y="0" width="' + frameW + '" height="' + frameH +
      '" rx="8"></rect>');
    svg.push('<text class="inset-title" x="' + padX + '" y="17">REFERENCE MARKET</text>');
    svg.push('<g transform="translate(' + padX + "," + padTop + ')">');
    Object.keys(uk.shapes).forEach(function (iso) {
      if (iso === "826") return;
      svg.push('<path class="country" d="' + uk.shapes[iso].d + '"></path>');
    });
    if (uk.shapes["826"]) {
      svg.push('<path class="country market' + (state.selected === "UK" ? " selected" : "") +
        '" data-market="UK" d="' + uk.shapes["826"].d + '" style="fill:' + BAND_COLOR[ukBand] +
        '"></path>');
    }
    svg.push("</g>");
    var ukScore = ukState && ukState.health && ukState.health.score !== null
      ? Math.round(ukState.health.score) : null;
    svg.push('<text class="map-label" x="' + padX + '" y="' + (frameH - 20) + '">UK</text>');
    svg.push('<text class="map-label sub" x="' + padX + '" y="' + (frameH - 8) + '">' +
      (ukScore === null ? "no data" : ukScore + " · " + esc(ukState.health.band.label)) +
      "</text>");
    svg.push("</g>");

    svg.push("</svg>");
    el.mapStage.innerHTML = svg.join("");

    // legend: status colour + glyph + word, so colour never carries meaning alone
    el.mapLegend.innerHTML = M.BANDS.map(function (b) {
      return '<span class="legend-item"><span class="swatch-icon" style="color:' +
        BAND_COLOR[b.key] + '">' + BAND_ICON[b.key] + "</span>" + esc(b.label) +
        " (" + (b.min === -Infinity ? "&lt; 50" : "≥ " + b.min) + ")</span>";
    }).join("") +
      '<span class="legend-item"><span class="swatch-icon" style="color:' + BAND_COLOR.nodata +
      '">' + BAND_ICON.nodata + "</span>No data</span>";

    // hover + click
    Array.prototype.forEach.call(el.mapStage.querySelectorAll("[data-market]"), function (node) {
      var mk = node.getAttribute("data-market");
      node.addEventListener("mousemove", function (e) { showMarketTip(e, byMarket[mk]); });
      node.addEventListener("mouseleave", hideTip);
      node.addEventListener("click", function () { toggleSelect(mk); });
    });
  }

  function showMarketTip(e, s) {
    if (!s) return hideTip();
    var m = s.metrics;
    var band = s.health ? s.health.band : { key: "nodata", label: "No data" };
    var rows = [];
    if (m) {
      rows.push(tipRow("REG → NFC", fmtPct(m.cvr_reg_nfc, 2)));
      rows.push(tipRow("NFC", fmtInt(m.nfc)));
      rows.push(tipRow("New total revenue", fmtMoney(m.rev_total)));
      rows.push(tipRow("Revenue per NFC", fmtMoney(m.arpa, { exact: true })));
      rows.push(tipRow("CPA", fmtMoney(m.cpa, { exact: true })));
      rows.push(tipRow("CAC payback", fmtMonths(m.payback_months)));
      rows.push(tipRow("Net LTV : CAC", m.ltv_cac === null ? "—" : fmtNum(m.ltv_cac, 2) + "×"));
    } else {
      rows.push('<div class="tt-note">No data for this period.</div>');
    }
    var note = s.health && s.health.coverage < 1
      ? '<div class="tt-note">Score uses ' + Math.round(s.health.coverage * 100) +
        "% of the health inputs — the rest are missing.</div>"
      : "";
    showTip(e,
      '<div class="tt-title"><span style="color:' + BAND_COLOR[band.key] + '">' +
      BAND_ICON[band.key] + "</span>" + esc(s.meta.name) +
      (s.meta.in_apac ? "" : " · reference") + "</div>" +
      tipRow("Health", (s.health && s.health.score !== null ? Math.round(s.health.score) : "—") +
        " · " + band.label) +
      rows.join("") + note);
  }

  function tipRow(k, v) {
    return '<div class="tt-row"><span>' + esc(k) + "</span><b>" + v + "</b></div>";
  }

  function showTip(e, html) {
    el.tooltip.innerHTML = html;
    el.tooltip.classList.add("on");
    var pad = 14;
    var r = el.tooltip.getBoundingClientRect();
    var x = e.clientX + pad;
    var y = e.clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
    el.tooltip.style.left = Math.max(8, x) + "px";
    el.tooltip.style.top = Math.max(8, y) + "px";
  }

  function hideTip() { el.tooltip.classList.remove("on"); }

  function toggleSelect(mk) {
    state.selected = state.selected === mk ? null : mk;
    render();
  }

  /* ---------------------------------------------------------- health rail */

  function renderRank(snap) {
    var sorted = snap.slice().sort(function (a, b) {
      var as = a.health && a.health.score !== null ? a.health.score : -1;
      var bs = b.health && b.health.score !== null ? b.health.score : -1;
      return bs - as;
    });
    el.rankList.innerHTML = sorted.map(function (s) {
      var band = s.health ? s.health.band : { key: "nodata", label: "No data" };
      var score = s.health && s.health.score !== null ? Math.round(s.health.score) : "—";
      var tier = TIERS[s.meta.tier] ? TIERS[s.meta.tier].label : s.meta.tier;
      return '<button class="rank-row' + (state.selected === s.market ? " selected" : "") +
        '" data-market="' + s.market + '" type="button">' +
        '<span style="color:' + BAND_COLOR[band.key] + '">' + BAND_ICON[band.key] + "</span>" +
        "<span><span class='mk'>" + esc(s.market) + "</span> " +
        "<span class='tier'>" + esc(tier) +
        (s.meta.group && s.meta.group !== s.market ? " · " + esc(s.meta.group) : "") +
        (s.meta.in_apac ? "" : " · reference") + "</span></span>" +
        "<span><span class='score'>" + score + "</span><br>" +
        "<span class='state'>" + esc(band.label) + "</span></span></button>";
    }).join("");

    Array.prototype.forEach.call(el.rankList.querySelectorAll("[data-market]"), function (node) {
      var mk = node.getAttribute("data-market");
      node.addEventListener("click", function () { toggleSelect(mk); });
      node.addEventListener("mousemove", function (e) {
        showMarketTip(e, snap.filter(function (x) { return x.market === mk; })[0]);
      });
      node.addEventListener("mouseleave", hideTip);
    });
  }

  /* --------------------------------------------------------------- funnel */

  function renderFunnel(snap) {
    var refState = snap.filter(function (s) { return s.market === REFERENCE_MARKET; })[0];
    var ref = refState ? refState.metrics : null;
    el.funnelBenchName.textContent = ref ? "UK" : "nothing (no UK data)";

    var shown = snap.filter(function (s) {
      return s.metrics && (!state.selected || s.market === state.selected);
    });
    if (!shown.length) {
      el.funnelGrid.innerHTML = '<div class="empty">No funnel data for this period.</div>';
      return;
    }
    var stageColors = ["var(--stage-1)", "var(--stage-2)", "var(--stage-3)", "var(--stage-4)"];
    var steps = [
      ["reg", "submit", "cvr_reg_submit"],
      ["submit", "l3", "cvr_submit_l3"],
      ["l3", "nfc", "cvr_l3_nfc"],
    ];

    el.funnelGrid.innerHTML = shown.map(function (s) {
      var m = s.metrics;
      var top = m.reg || Math.max.apply(null, M.STAGES.map(function (k) { return m[k] || 0; })) || 1;
      var html = ['<div class="funnel-card">'];
      html.push('<div class="fh"><span class="mk">' + esc(s.market) + "</span>" +
        '<span class="tier">' + esc(s.meta.name) + "</span>" +
        '<span class="e2e">REG→NFC <b>' + fmtPct(m.cvr_reg_nfc, 2) + "</b></span></div>");

      M.STAGES.forEach(function (stage, i) {
        var v = m[stage];
        var w = v === null || !top ? 0 : Math.max(0.4, (v / top) * 100);
        html.push('<div class="stage-row"><span class="sl">' + M.STAGE_LABELS[stage] + "</span>" +
          '<span class="stage-bar-track">' +
          '<span class="stage-bar" style="width:' + w.toFixed(1) + "%;background:" +
          stageColors[i] + '"></span></span>' +
          '<span class="val">' + fmtInt(v) + "</span></div>");

        if (i < steps.length) {
          var st = steps[i];
          var val = m[st[2]];
          var refVal = ref ? ref[st[2]] : null;
          var cmp = "";
          // No point comparing the reference market against itself.
          if (val !== null && refVal && s.market !== REFERENCE_MARKET) {
            var d = val / refVal - 1;
            var cls = Math.abs(d) < 0.02 ? "" : (d > 0 ? "above" : "below");
            cmp = ' <span class="vs ' + cls + '">' + (d >= 0 ? "+" : "") +
              (d * 100).toFixed(0) + "% vs UK</span>";
          }
          html.push('<div class="step-cvr"><span></span><span class="arrow">↳ <b>' +
            fmtPct(val, 1) + "</b>" + cmp + "</span><span></span></div>");
        }
      });
      html.push("</div>");
      return html.join("");
    }).join("");
  }

  /* -------------------------------------------------------------- scatter */

  function renderScatter(snap) {
    var pts = snap.filter(function (s) {
      return s.metrics && s.metrics.payback_months !== null && s.metrics.ltv_cac !== null;
    });
    if (!pts.length) {
      el.scatter.innerHTML = '<div class="empty">Needs <code>marketing_spend</code> to plot ' +
        "CAC payback and LTV:CAC. Add that column and re-import.</div>";
      el.scatterLegend.innerHTML = "";
      return;
    }

    var W = 900, H = 420, pad = { l: 56, r: 24, t: 16, b: 48 };
    var iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    var targetPay = 12, targetRatio = 2;

    var maxX = Math.max(targetPay * 1.6, Math.max.apply(null, pts.map(function (p) {
      return Math.min(p.metrics.payback_months, 60);
    })) * 1.15);
    var maxY = Math.max(targetRatio * 1.6, Math.max.apply(null, pts.map(function (p) {
      return p.metrics.ltv_cac;
    })) * 1.15);
    var maxRev = Math.max.apply(null, pts.map(function (p) { return p.metrics.rev_total || 0; })) || 1;

    var X = function (v) { return pad.l + (Math.min(v, maxX) / maxX) * iw; };
    var Y = function (v) { return pad.t + ih - (Math.min(v, maxY) / maxY) * ih; };
    var R = function (v) { return 6 + Math.sqrt(Math.max(v, 0) / maxRev) * 17; };

    var svg = ['<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Scatter of CAC ' +
      'payback against LTV to CAC ratio, one bubble per market">'];

    // target quadrant: payback at or under target AND ratio at or above target
    svg.push('<rect class="quadrant" x="' + pad.l + '" y="' + pad.t + '" width="' +
      (X(targetPay) - pad.l) + '" height="' + (Y(targetRatio) - pad.t) + '" rx="4"></rect>');

    // gridlines + ticks
    var xTicks = niceTicks(maxX, 6), yTicks = niceTicks(maxY, 5);
    yTicks.forEach(function (t) {
      svg.push('<line class="gridline" x1="' + pad.l + '" y1="' + Y(t) + '" x2="' + (W - pad.r) +
        '" y2="' + Y(t) + '"></line>');
      svg.push('<text class="axis-text" x="' + (pad.l - 8) + '" y="' + (Y(t) + 4) +
        '" text-anchor="end">' + t.toFixed(t < 10 ? 1 : 0) + "×</text>");
    });
    xTicks.forEach(function (t) {
      svg.push('<text class="axis-text" x="' + X(t) + '" y="' + (H - pad.b + 18) +
        '" text-anchor="middle">' + t.toFixed(0) + "</text>");
    });
    svg.push('<line class="axis-line" x1="' + pad.l + '" y1="' + (pad.t + ih) + '" x2="' +
      (W - pad.r) + '" y2="' + (pad.t + ih) + '"></line>');

    // target reference lines
    svg.push('<line class="target-line" x1="' + X(targetPay) + '" y1="' + pad.t + '" x2="' +
      X(targetPay) + '" y2="' + (pad.t + ih) + '"></line>');
    svg.push('<text class="target-text" x="' + (X(targetPay) + 5) + '" y="' + (pad.t + 12) +
      '">payback target 12 mo</text>');
    svg.push('<line class="target-line" x1="' + pad.l + '" y1="' + Y(targetRatio) + '" x2="' +
      (W - pad.r) + '" y2="' + Y(targetRatio) + '"></line>');
    svg.push('<text class="target-text" x="' + (W - pad.r - 4) + '" y="' + (Y(targetRatio) - 6) +
      '" text-anchor="end">Net LTV:CAC target 2×</text>');

    svg.push('<text class="axis-title" x="' + (pad.l + iw / 2) + '" y="' + (H - 8) +
      '" text-anchor="middle">CAC payback (months) — lower is better</text>');
    svg.push('<text class="axis-title" transform="translate(14,' + (pad.t + ih / 2) +
      ') rotate(-90)" text-anchor="middle">Net LTV : CAC — higher is better</text>');

    // Every bubble is directly labelled (the relief rule - one tier colour sits
    // under 3:1 on the light surface), so labels must not collide.
    var placed = pts.map(function (p) {
      return {
        p: p,
        x: X(p.metrics.payback_months),
        y: Y(p.metrics.ltv_cac),
        r: R(p.metrics.rev_total || 0),
      };
    });
    layoutLabels(placed, pad.t);

    // largest first, so a small bubble is never buried under a big one
    placed.slice().sort(function (a, b) {
      return (b.p.metrics.rev_total || 0) - (a.p.metrics.rev_total || 0);
    }).forEach(function (it) {
      var tier = TIERS[it.p.meta.tier] || TIERS.emerging;
      var dim = state.selected && state.selected !== it.p.market;
      svg.push('<circle class="bubble' +
        (it.p.market === REFERENCE_MARKET ? " reference" : "") + '" data-market="' + it.p.market +
        '" cx="' + it.x.toFixed(1) + '" cy="' + it.y.toFixed(1) + '" r="' + it.r.toFixed(1) +
        '" fill="' + tier.color + '" opacity="' + (dim ? 0.25 : 0.85) + '"></circle>');
      if (it.leader) {
        svg.push('<line class="leader" x1="' + it.x.toFixed(1) + '" y1="' +
          (it.y - it.r - 2).toFixed(1) + '" x2="' + it.x.toFixed(1) + '" y2="' +
          (it.ly + 3).toFixed(1) + '" opacity="' + (dim ? 0.3 : 1) + '"></line>');
      }
      svg.push('<text class="bubble-label" x="' + it.x.toFixed(1) + '" y="' + it.ly.toFixed(1) +
        '" text-anchor="middle" opacity="' + (dim ? 0.35 : 1) + '">' + esc(it.p.market) + "</text>");
    });

    svg.push("</svg>");
    el.scatter.innerHTML = svg.join("");

    el.scatterLegend.innerHTML = Object.keys(TIERS)
      .sort(function (a, b) { return TIERS[a].order - TIERS[b].order; })
      .map(function (k) {
        return '<span class="legend-item"><span class="dot" style="background:' +
          TIERS[k].color + '"></span>' + TIERS[k].label + " markets</span>";
      }).join("") +
      '<span class="legend-item" style="color:var(--text-muted)">Bubble area ∝ new total revenue</span>' +
      '<span class="legend-item" style="color:var(--text-muted)">Dashed outline = ' +
      REFERENCE_MARKET + " reference market (not APAC)</span>";

    Array.prototype.forEach.call(el.scatter.querySelectorAll("[data-market]"), function (node) {
      var mk = node.getAttribute("data-market");
      node.addEventListener("mousemove", function (e) {
        showMarketTip(e, snap.filter(function (x) { return x.market === mk; })[0]);
      });
      node.addEventListener("mouseleave", hideTip);
      node.addEventListener("click", function () { toggleSelect(mk); });
    });
  }

  /**
   * Place one label per bubble, above it by default, nudged up in 13px steps
   * while it would sit on top of an already-placed label. Anything pushed past
   * the top of the plot flips below its bubble instead and gets a leader line
   * so it stays attached to the right mark.
   */
  function layoutLabels(items, topLimit) {
    var LH = 13, HALF_W = 26;
    var done = [];
    var collides = function (x, ly) {
      return done.some(function (d) {
        return Math.abs(d.ly - ly) < LH && Math.abs(d.x - x) < HALF_W * 2;
      });
    };
    items.slice().sort(function (a, b) { return a.y - b.y; }).forEach(function (it) {
      var ly = it.y - it.r - 7;
      var guard = 0;
      while (collides(it.x, ly) && guard++ < 40) ly -= LH;
      if (ly < topLimit + LH) {
        // no room above - drop it below the bubble and draw a leader
        ly = it.y + it.r + 14;
        guard = 0;
        while (collides(it.x, ly) && guard++ < 40) ly += LH;
        it.leader = false;
      } else {
        it.leader = ly < it.y - it.r - 16;
      }
      it.ly = ly;
      done.push(it);
    });
  }

  function niceTicks(max, count) {
    var step = Math.pow(10, Math.floor(Math.log10(max / count)));
    var err = max / count / step;
    if (err >= 7.5) step *= 10; else if (err >= 3) step *= 5; else if (err >= 1.5) step *= 2;
    var out = [];
    for (var v = 0; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(6)));
    return out;
  }

  /* -------------------------------------------------------- small mults */

  var TREND_FMT = {
    rev_book: fmtMoney, rev_total: fmtMoney, rev_txn: fmtMoney, nfc: fmtInt, reg: fmtInt,
    cvr_reg_nfc: function (v) { return fmtPct(v, 2); },
    cpa: function (v) { return fmtMoney(v, { exact: true }); },
    arpa: function (v) { return fmtMoney(v, { exact: true }); },
    payback_months: fmtMonths,
  };

  function renderTrends() {
    var metric = state.trendMetric;
    var fmt = TREND_FMT[metric] || fmtNum;
    var shown = data.markets.filter(function (mk) {
      return !state.selected || mk.market === state.selected;
    });

    el.trendGrid.innerHTML = shown.map(function (mk) {
      var series = months.map(function (mo) {
        var raw = rawAt(mk.market, mo);
        if (!hasData(raw)) return { month: mo, v: null };
        return { month: mo, v: M.deriveRow(raw, mk)[metric] };
      });
      var vals = series.filter(function (p) { return p.v !== null && isFinite(p.v); });
      if (!vals.length) {
        return '<div class="sm-card"><div class="sm-head"><span class="mk">' + esc(mk.market) +
          '</span></div><div class="empty" style="padding:18px 0">no data</div></div>';
      }
      var last = vals[vals.length - 1];
      return '<div class="sm-card"><div class="sm-head"><span class="mk">' + esc(mk.market) +
        '</span><span class="last">' + fmt(last.v) + " · " + monthLabel(last.month) +
        "</span></div>" + sparkline(series, mk.market, metric) + "</div>";
    }).join("");

    Array.prototype.forEach.call(el.trendGrid.querySelectorAll("[data-point]"), function (node) {
      node.addEventListener("mousemove", function (e) {
        var d = JSON.parse(node.getAttribute("data-point"));
        showTip(e, '<div class="tt-title">' + esc(d.market) + " · " + monthLabel(d.month) +
          "</div>" + tipRow(el.trendMetric.selectedOptions[0].text, d.label));
      });
      node.addEventListener("mouseleave", hideTip);
    });
  }

  function sparkline(series, market, metric) {
    var W = 260, H = 84, pad = { l: 4, r: 4, t: 10, b: 14 };
    var vals = series.map(function (p) { return p.v; }).filter(function (v) {
      return v !== null && isFinite(v);
    });
    var min = Math.min.apply(null, vals);
    var max = Math.max.apply(null, vals);
    // Value axes start at zero so bar-like magnitude reads honestly; rate metrics
    // get a padded window because their interesting range rarely includes zero.
    var isRate = metric === "cvr_reg_nfc" || metric === "payback_months";
    var lo = isRate ? min - (max - min || Math.abs(min) * 0.1 || 1) * 0.25 : Math.min(0, min);
    var hi = max + (max - lo || Math.abs(max) * 0.1 || 1) * 0.15;
    if (hi === lo) hi = lo + 1;

    var n = series.length;
    var X = function (i) { return pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - pad.l - pad.r)); };
    var Y = function (v) { return pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b); };

    var svg = ['<svg viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img" ' +
      'aria-label="' + esc(market) + ' trend">'];
    svg.push('<line class="gridline" x1="' + pad.l + '" y1="' + (H - pad.b) + '" x2="' +
      (W - pad.r) + '" y2="' + (H - pad.b) + '"></line>');

    // Split into contiguous runs so a gap in the data is drawn as a gap.
    var runs = [];
    var cur = [];
    series.forEach(function (p, i) {
      if (p.v === null || !isFinite(p.v)) { if (cur.length) { runs.push(cur); cur = []; } }
      else cur.push({ i: i, v: p.v, month: p.month });
    });
    if (cur.length) runs.push(cur);

    runs.forEach(function (run) {
      if (run.length === 1) return;
      var d = run.map(function (p, k) {
        return (k ? "L" : "M") + X(p.i).toFixed(1) + "," + Y(p.v).toFixed(1);
      }).join("");
      var area = d + "L" + X(run[run.length - 1].i).toFixed(1) + "," + (H - pad.b) +
        "L" + X(run[0].i).toFixed(1) + "," + (H - pad.b) + "Z";
      svg.push('<path class="spark-area" d="' + area + '"></path>');
      svg.push('<path class="spark-line" d="' + d + '"></path>');
    });

    var fmt = TREND_FMT[metric] || fmtNum;
    runs.forEach(function (run) {
      run.forEach(function (p) {
        var payload = JSON.stringify({ market: market, month: p.month, label: fmt(p.v) })
          .replace(/"/g, "&quot;");
        svg.push('<circle data-point="' + payload + '" cx="' + X(p.i).toFixed(1) + '" cy="' +
          Y(p.v).toFixed(1) + '" r="9" fill="transparent" style="cursor:pointer"></circle>');
      });
      var lastPt = run[run.length - 1];
      svg.push('<circle class="spark-dot" cx="' + X(lastPt.i).toFixed(1) + '" cy="' +
        Y(lastPt.v).toFixed(1) + '" r="3.5" pointer-events="none"></circle>');
    });

    svg.push("</svg>");
    return svg.join("");
  }

  /* ---------------------------------------------------------------- table */

  var COLUMNS = [
    { key: "market", label: "Market", type: "text", get: function (s) { return s.market; } },
    { key: "tier", label: "Tier", type: "text", get: function (s) {
      return (TIERS[s.meta.tier] ? TIERS[s.meta.tier].label : s.meta.tier) +
        (s.meta.in_apac ? "" : " · ref"); } },
    { key: "group", label: "Region", type: "text",
      get: function (s) { return s.meta.group || "\u2014"; } },
    { key: "reg", label: "REG", get: function (s) { return v(s, "reg"); }, fmt: fmtInt },
    { key: "submit", label: "Submit", get: function (s) { return v(s, "submit"); }, fmt: fmtInt },
    { key: "l3", label: "L3", get: function (s) { return v(s, "l3"); }, fmt: fmtInt },
    { key: "nfc", label: "NFC", get: function (s) { return v(s, "nfc"); }, fmt: fmtInt },
    { key: "cvr_reg_nfc", label: "REG→NFC", get: function (s) { return v(s, "cvr_reg_nfc"); },
      fmt: function (x) { return fmtPct(x, 2); } },
    { key: "cpa", label: "CPA", get: function (s) { return v(s, "cpa"); },
      fmt: function (x) { return fmtMoney(x, { exact: true }); } },
    { key: "rev_book", label: "Total rev", get: function (s) { return v(s, "rev_book"); }, fmt: fmtMoney },
    { key: "rev_total", label: "New-cohort rev", get: function (s) { return v(s, "rev_total"); }, fmt: fmtMoney },
    { key: "rev_txn", label: "New txn rev", get: function (s) { return v(s, "rev_txn"); }, fmt: fmtMoney },
    { key: "arpa", label: "Rev / NFC", get: function (s) { return v(s, "arpa"); },
      fmt: function (x) { return fmtMoney(x, { exact: true }); } },
    { key: "payback_months", label: "Payback", get: function (s) { return v(s, "payback_months"); },
      fmt: fmtMonths },
    { key: "ltv", label: "Net LTV", get: function (s) { return v(s, "ltv"); },
      fmt: function (x) { return fmtMoney(x, { exact: true }); } },
    { key: "ltv_cac", label: "Net LTV:CAC", get: function (s) { return v(s, "ltv_cac"); },
      fmt: function (x) { return x === null ? "—" : fmtNum(x, 2) + "×"; } },
    { key: "health", label: "Health", get: function (s) {
      return s.health && s.health.score !== null ? s.health.score : null; }, health: true },
  ];

  function v(s, key) { return s.metrics ? s.metrics[key] : null; }

  function renderTable(snap) {
    el.tableHead.innerHTML = COLUMNS.map(function (c) {
      var active = state.sort.key === c.key;
      var caret = active ? (state.sort.dir > 0 ? " ▲" : " ▼") : "";
      return '<th data-key="' + c.key + '" scope="col" aria-sort="' +
        (active ? (state.sort.dir > 0 ? "ascending" : "descending") : "none") + '">' +
        esc(c.label) + '<span class="caret">' + caret + "</span></th>";
    }).join("");

    var col = COLUMNS.filter(function (c) { return c.key === state.sort.key; })[0] || COLUMNS[0];
    var sorted = snap.slice().sort(function (a, b) {
      var av = col.get(a), bv = col.get(b);
      if (col.type === "text") {
        return String(av).localeCompare(String(bv)) * state.sort.dir;
      }
      var an = av === null || av === undefined || !isFinite(av) ? -Infinity : av;
      var bn = bv === null || bv === undefined || !isFinite(bv) ? -Infinity : bv;
      return (an - bn) * state.sort.dir;
    });

    el.tableBody.innerHTML = sorted.map(function (s) {
      var cells = COLUMNS.map(function (c) {
        var val = c.get(s);
        if (c.health) {
          var band = s.health ? s.health.band : { key: "nodata", label: "No data" };
          return "<td><span class='cell-flag'><span style='color:" + BAND_COLOR[band.key] + "'>" +
            BAND_ICON[band.key] + "</span>" +
            (val === null ? "—" : Math.round(val)) + " " + esc(band.label) + "</span></td>";
        }
        if (c.type === "text") return "<td>" + esc(val) + "</td>";
        var txt = c.fmt ? c.fmt(val) : fmtNum(val);
        return '<td class="' + (txt === "—" ? "na" : "") + '">' + txt + "</td>";
      });
      return "<tr" + (s.meta.in_apac ? "" : ' class="ref"') + ">" + cells.join("") + "</tr>";
    }).join("");

    Array.prototype.forEach.call(el.tableHead.querySelectorAll("th"), function (th) {
      th.addEventListener("click", function () {
        var key = th.getAttribute("data-key");
        if (state.sort.key === key) state.sort.dir *= -1;
        else state.sort = { key: key, dir: key === "market" || key === "tier" ? 1 : -1 };
        renderTable(snap);
      });
    });
  }

  function downloadTableCsv() {
    var snap = snapshot();
    var head = COLUMNS.map(function (c) { return c.label; }).join(",");
    var body = snap.map(function (s) {
      return COLUMNS.map(function (c) {
        var val = c.get(s);
        if (c.type === "text") return '"' + String(val).replace(/"/g, '""') + '"';
        if (val === null || val === undefined || !isFinite(val)) return "";
        return c.key === "cvr_reg_nfc" ? val.toFixed(6) : val.toFixed(2);
      }).join(",");
    }).join("\n");
    var period = state.period === "ytd" ? "YTD-to-" + state.month : state.month;
    download("apac-dashboard-" + period + ".csv", head + "\n" + body, "text/csv");
  }

  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime + ";charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /* --------------------------------------------------------- method notes */

  function renderMethodNote() {
    var bases = {};
    snapshot().forEach(function (s) {
      if (s.metrics && s.metrics.arpu_basis) bases[s.metrics.arpu_basis] = true;
    });
    var note = document.getElementById("arpu-basis-note");
    if (note) {
      note.textContent = "Currently: " + Object.keys(bases).join(", ") + ".";
    }
    el.healthFormula.textContent = M.HEALTH_COMPONENTS.map(function (c) {
      return String(Math.round(c.weight * 100)).padStart(3) + "%  " + c.label;
    }).join("\n") + "\n\nBands: " + M.BANDS.map(function (b) {
      return b.label + " " + (b.min === -Infinity ? "< 50" : "≥ " + b.min);
    }).join(" · ");

    var gen = data.generated ? new Date(data.generated).toUTCString() : "unknown";
    el.footerNote.innerHTML = "Data built " + esc(gen) + " from " + esc(data.source || "data/*.csv") +
      ". Map geometry: Natural Earth (public domain) via world-atlas. " +
      "Gross margin, NRR and the LTV horizon are assumptions set in " +
      "<code>data/assumptions.csv</code> — confirm them with Finance before quoting LTV externally.";
  }

  /* ---------------------------------------------------------------- paste */

  function blankTemplate() {
    var header = ["month", "market"].concat(M.NUMERIC_COLS).join("\t");
    var rows = data.markets.map(function (mk) {
      return [state.month, mk.market].concat(M.NUMERIC_COLS.map(function () { return ""; })).join("\t");
    });
    return [header].concat(rows).join("\n");
  }

  function applyPaste() {
    var known = data.markets.map(function (m) { return m.market; });
    var text = el.pasteArea.value;
    state.isDemo = !!window.APAC_DEMO_TSV && text.trim() === window.APAC_DEMO_TSV.trim();
    var res = M.parsePaste(text, known);
    if (!res.rows.length) {
      setMsg((res.errors[0] || "Nothing recognised in that paste."), "err");
      return;
    }
    // Merge into matching (month, market) rows, touching only the columns that
    // were actually in the paste - so a spend-only block tops up CPA without
    // erasing the funnel. Every other period is left alone.
    var index = {};
    state.rows.forEach(function (r, i) { index[r.month + "|" + r.market] = i; });
    var added = 0, updated = 0;
    res.rows.forEach(function (r) {
      var key = r.month + "|" + r.market;
      if (index[key] !== undefined) {
        var target = state.rows[index[key]];
        res.columns.forEach(function (c) { target[c] = r[c]; });
        updated++;
      } else {
        M.NUMERIC_COLS.forEach(function (c) {
          if (r[c] === undefined) r[c] = null;
        });
        state.rows.push(r);
        index[key] = state.rows.length - 1;
        added++;
      }
    });

    refreshMonths();
    var touched = res.rows.map(function (r) { return r.month; }).sort();
    state.month = touched[touched.length - 1];
    syncMonthSelect();
    render();

    var msg = updated + " row(s) updated, " + added + " added (" +
      res.columns.join(", ") + ").";
    if (res.errors.length) msg += " Skipped " + res.errors.length + ": " + res.errors[0];
    setMsg(msg, res.errors.length ? "err" : "ok");
  }

  function setMsg(text, cls) {
    el.dlgMsg.textContent = text;
    el.dlgMsg.className = "msg " + (cls || "");
  }

  function downloadDataJs() {
    var payload = {
      generated: new Date().toISOString().replace(/\.\d+Z$/, "+00:00"),
      source: "pasted in browser on " + new Date().toISOString().slice(0, 10),
      markets: data.markets,
      geography: data.geography,
      rows: state.rows.slice().sort(function (a, b) {
        return a.month === b.month ? (a.market < b.market ? -1 : 1) : (a.month < b.month ? -1 : 1);
      }),
    };
    download("data.js",
      "/* Exported from the dashboard paste panel. Commit to docs/data/data.js. */\n" +
      "window.APAC_DATA = " + JSON.stringify(payload) + ";\n", "text/javascript");
    setMsg("Downloaded. Commit it to docs/data/data.js to publish.", "ok");
  }

  /* ------------------------------------------------------------------ boot */

  function refreshMonths() {
    var set = {};
    state.rows.forEach(function (r) { set[r.month] = true; });
    months = Object.keys(set).sort();
  }

  function syncMonthSelect() {
    el.monthSelect.innerHTML = months.map(function (m) {
      var filled = state.rows.some(function (r) { return r.month === m && hasData(r); });
      return '<option value="' + m + '"' + (m === state.month ? " selected" : "") + ">" +
        monthLabel(m) + (filled ? "" : " (empty)") + "</option>";
    }).join("");
  }

  function defaultMonth() {
    // Prefer the most recent month that actually has numbers in it.
    for (var i = months.length - 1; i >= 0; i--) {
      if (state.rows.some(function (r) { return r.month === months[i] && hasData(r); })) {
        return months[i];
      }
    }
    var now = new Date();
    var thisMonth = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
    return months.indexOf(thisMonth) >= 0 ? thisMonth : months[months.length - 1];
  }

  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem("apac-theme"); } catch (e) { /* private mode */ }
    if (saved) document.documentElement.setAttribute("data-theme", saved);
    el.themeBtn.addEventListener("click", function () {
      var cur = document.documentElement.getAttribute("data-theme");
      var isDark = cur === "dark" ||
        (!cur && window.matchMedia("(prefers-color-scheme: dark)").matches);
      var next = isDark ? "light" : "dark";
      document.documentElement.setAttribute("data-theme", next);
      try { localStorage.setItem("apac-theme", next); } catch (e) { /* ignore */ }
      render();
    });
  }

  function boot() {
    [
      ["banner", "banner"], ["kpis", "kpis"], ["mapStage", "map-stage"],
      ["mapLegend", "map-legend"], ["rankList", "rank-list"], ["funnelGrid", "funnel-grid"],
      ["funnelBenchName", "funnel-bench-name"], ["scatter", "scatter"],
      ["scatterLegend", "scatter-legend"], ["trendGrid", "trend-grid"],
      ["tableHead", "table-head"], ["tableBody", "table-body"], ["tooltip", "tooltip"],
      ["monthSelect", "month-select"], ["periodSelect", "period-select"],
      ["trendMetric", "trend-metric"], ["themeBtn", "theme-btn"],
      ["importBtn", "import-btn"], ["dialog", "import-dialog"], ["pasteArea", "paste-area"],
      ["dlgMsg", "dlg-msg"], ["healthFormula", "health-formula"], ["footerNote", "footer-note"],
      ["subtitle", "subtitle"],
    ].forEach(function (pair) { el[pair[0]] = document.getElementById(pair[1]); });

    data.markets.forEach(function (mk) { marketsById[mk.market] = mk; });
    state.isDemo = !!data.is_demo;
    state.rows = (data.rows || []).slice();
    refreshMonths();
    if (!months.length) {
      var now = new Date();
      state.month = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
      months = [state.month];
    } else {
      state.month = defaultMonth();
    }
    syncMonthSelect();
    initTheme();

    el.monthSelect.addEventListener("change", function () {
      state.month = el.monthSelect.value;
      render();
    });
    el.periodSelect.addEventListener("change", function () {
      state.period = el.periodSelect.value;
      render();
    });
    el.trendMetric.addEventListener("change", function () {
      state.trendMetric = el.trendMetric.value;
      renderTrends();
    });
    el.importBtn.addEventListener("click", function () {
      setMsg("", "");
      el.dialog.showModal();
    });
    document.getElementById("dlg-close").addEventListener("click", function () { el.dialog.close(); });
    document.getElementById("dlg-apply").addEventListener("click", applyPaste);
    document.getElementById("dlg-template").addEventListener("click", function () {
      el.pasteArea.value = blankTemplate();
      setMsg("Blank rows for " + monthLabel(state.month) + " inserted above — fill and apply.", "ok");
    });
    document.getElementById("dlg-demo").addEventListener("click", function () {
      if (!window.APAC_DEMO_TSV) { setMsg("demo.js is not loaded.", "err"); return; }
      el.pasteArea.value = window.APAC_DEMO_TSV;
      setMsg("Demo rows loaded — these are INVENTED numbers for previewing the layout. " +
        "Apply to see the dashboard populated.", "");
    });
    document.getElementById("dlg-download").addEventListener("click", downloadDataJs);
    document.getElementById("csv-btn").addEventListener("click", downloadTableCsv);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { state.selected = null; render(); }
    });

    render();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
