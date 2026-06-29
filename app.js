// Main application logic
(function () {
    'use strict';

    // Tab navigation
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            const tab = btn.dataset.tab;
            document.getElementById('tab-' + tab).classList.add('active');
        });
    });

    // Auto-load data on page load — API keys are built into config
    loadAllData();
})();

function showStatus(message, type) {
    const el = document.getElementById('data-status');
    if (!el) return;
    el.className = 'data-status ' + (type || 'info');
    el.innerHTML = message;
    el.classList.remove('hidden');
}

function hideStatus() {
    const el = document.getElementById('data-status');
    if (el) el.classList.add('hidden');
}

function showSeriesStatus(status) {
    const el = document.getElementById('series-status');
    if (!el) return;

    const items = Object.entries(status).map(([key, s]) => {
        const icon = s.ok ? '<span class="status-ok">OK</span>' : '<span class="status-fail">FAIL</span>';
        const detail = s.ok
            ? `${s.count.toLocaleString()} pts via ${s.source}`
            : s.error;
        return `<div class="status-row">${icon} <strong>${s.label}</strong>: ${detail}</div>`;
    });

    el.innerHTML = items.join('');
    el.classList.remove('hidden');
}

// Global: load all data
async function loadAllData() {
    const loading = document.getElementById('loading');
    loading.classList.remove('hidden');
    hideStatus();

    try {
        const result = await DataStore.loadAllSeries();

        // Show series status
        showSeriesStatus(DataStore.status);

        if (result.failedCount > 0) {
            showStatus(
                `Loaded ${result.loadedCount}/${result.total} series. ${result.failedCount} failed (see details below). Charts may be incomplete.`,
                result.loadedCount > 0 ? 'warning' : 'error'
            );
        }

        // Render charts
        Charts.renderAllCharts();

        // Render strategy
        Strategy.initAdvancedControls();
        const signals = Strategy.computeSignals();
        Strategy.renderSignals(signals);
        Strategy.renderStrategyChart();
        Strategy.renderBacktest();

        // Populate data table
        populateDataTable();
    } catch (err) {
        console.error('Error loading data:', err);
        showStatus(
            `Failed to load data: ${err.message}. <br>
            Check your internet connection and try again.`,
            'error'
        );
    } finally {
        loading.classList.add('hidden');
    }
}

// Data table population
function populateDataTable() {
    renderUnifiedDataTable();
}

function renderUnifiedDataTable() {
    const thead = document.getElementById('data-thead');
    const tbody = document.getElementById('data-tbody');

    // Build monthly lookup maps for each series
    const seriesDefs = [
        { key: 'sp500', proc: 'sp500' },
        { key: 'unemployment', proc: 'unemployment' },
        { key: 'cpi', proc: 'cpi' },
        { key: 'vix', proc: 'vix' },
        { key: 'cape', proc: 'cape' },
        { key: 'pie', proc: 'pie' },
        { key: 'equityAlloc', proc: 'equityAlloc' },
        { key: 'yieldCurve', proc: 'yieldCurve' },
        { key: 'fedFunds', proc: 'fedFunds' },
    ];

    const monthlyMaps = {};
    const allMonths = new Set();

    // Historical ledger uses CONFIRMED data only. Nowcast estimates appear
    // solely as the live "Now" row at the bottom — never in the backtest.
    seriesDefs.forEach(s => {
        const data = (DataStore.processed[s.proc] || []).filter(d => !d.nowcast);
        const monthly = DataStore.getMonthlyValues(data);
        const map = {};
        monthly.forEach(d => { map[d.date.substring(0, 7)] = d; });
        monthlyMaps[s.key] = map;
        monthly.forEach(d => allMonths.add(d.date.substring(0, 7)));
    });

    const sortedMonths = Array.from(allMonths).sort();
    if (sortedMonths.length === 0) return;

    // Expanding-window z-score stats, reused by computeLaggedScore so each
    // month's bands use only data up to that month (no look-ahead).
    Strategy._backtestStats = {
        alloc: DataStore.buildRollingStatsLookup('equityAlloc', 0),
        cape: DataStore.buildRollingStatsLookup('cape', 0),
        pie: DataStore.buildRollingStatsLookup('pie', 0),
        vixRolling: DataStore.buildRollingStatsLookup('vix', CONFIG.STRATEGY.VIX_ROLLING_MONTHS),
    };
    const fmtSig = v => (v === undefined || v === null) ? '' : (v > 0 ? `+${v}` : String(v));

    // Build rows with values, signals, and backtest
    const columns = [
        'Date', 'S&P 500', '200d MA',
        'Unemp %', 'U MA12',
        'CPI', 'Infl %',
        'VIX', 'CAPE', 'P/IE',
        'Eq Alloc %', 'YC 10-2', 'Fed Rate',
        'Trend', 'Unemp', 'VIX Sig', 'CAPE Sig', 'P/IE Sig', 'Alloc Sig', 'YC Sig', 'Fed Sig',
        'Score', 'Regime', 'Alloc %',
        'Mo Return', 'Strategy', 'Buy&Hold',
    ];

    let strategyValue = 10000;
    let buyHoldValue = 10000;
    let prevSP = null;
    let prevAllocFrac = 1; // allocation carried into the month (decided last month)
    const rows = [];

    for (const ym of sortedMonths) {
        const sp = monthlyMaps.sp500[ym];
        const unemp = monthlyMaps.unemployment[ym];
        const cpi = monthlyMaps.cpi[ym];
        const vix = monthlyMaps.vix[ym];
        const cape = monthlyMaps.cape[ym];
        const pie = monthlyMaps.pie[ym];
        const alloc = monthlyMaps.equityAlloc[ym];
        const yc = monthlyMaps.yieldCurve[ym];
        const fed = monthlyMaps.fedFunds[ym];

        // Lag-aware signals: each row uses only data that would have been
        // PUBLISHED by that month (publication lags), so there is no look-ahead.
        // The score/allocation shown is the decision made that month; it is
        // applied to the FOLLOWING month's return in the backtest.
        const dateStr = sp?.date || unemp?.date || cape?.date || (ym + '-01');
        const lagged = Strategy.computeLaggedScore(dateStr);
        const trendSignal = lagged.context.trend ?? 0;

        let sigTrend = '', sigUnemp = '', sigVix = '', sigCape = '', sigPie = '', sigAlloc = '', sigYC = '', sigFed = '';
        let scoreStr = '', regimeStr = '', allocPctStr = '';
        let allocFrac = prevAllocFrac;

        if (lagged.count > 0) {
            const spLag = DataStore.getLaggedValue('sp500', dateStr, CONFIG.PUB_LAG.SP500);
            if (spLag && spLag.ma200 !== null) sigTrend = spLag.value > spLag.ma200 ? '+1' : '-1';

            const unempLag = DataStore.getLaggedValue('unemployment', dateStr, CONFIG.PUB_LAG.UNEMPLOYMENT);
            if (unempLag && unempLag.ma12 !== null) {
                const gap = unempLag.value - unempLag.ma12;
                sigUnemp = gap < 0 ? '+1' : (gap >= 0.5 ? '-2' : '-1');
            }

            const vixLag = DataStore.getLaggedValue('vix', dateStr, CONFIG.PUB_LAG.VIX);
            if (vixLag) {
                const st = Strategy._backtestStats.vixRolling[vixLag.date.substring(0, 7)];
                if (st) { const { signal } = Strategy.classifyByZScore(vixLag.value, st); sigVix = signal > 0 ? '+1' : signal < 0 ? '-1' : '0'; }
            }
            const capeLag = DataStore.getLaggedValue('cape', dateStr, CONFIG.PUB_LAG.CAPE);
            if (capeLag) {
                const st = Strategy._backtestStats.cape[capeLag.date.substring(0, 7)];
                if (st) { const { signal } = Strategy.classifyByZScore(capeLag.value, st); sigCape = signal > 0 ? '+0.5' : signal < 0 ? '-0.5' : '0'; }
            }
            const pieLag = DataStore.getLaggedValue('pie', dateStr, CONFIG.PUB_LAG.PIE ?? CONFIG.PUB_LAG.CAPE);
            if (pieLag) {
                const st = Strategy._backtestStats.pie[pieLag.date.substring(0, 7)];
                if (st) { const { signal } = Strategy.classifyByZScore(pieLag.value, st); sigPie = signal > 0 ? '+0.5' : signal < 0 ? '-0.5' : '0'; }
            }
            const allocLag = DataStore.getLaggedValue('equityAlloc', dateStr, CONFIG.PUB_LAG.EQUITY_ALLOC);
            if (allocLag) {
                const st = Strategy._backtestStats.alloc[allocLag.date.substring(0, 7)];
                if (st) { const { signal } = Strategy.classifyByZScore(allocLag.value, st); sigAlloc = signal > 0 ? '+1' : signal < 0 ? '-1' : '0'; }
            }
            const ycLag = DataStore.getLaggedValue('yieldCurve', dateStr, CONFIG.PUB_LAG.YIELD_CURVE);
            if (ycLag) sigYC = ycLag.value > CONFIG.STRATEGY.YIELD_CURVE_INVERSION ? '+1' : '-1';

            const fedLag = DataStore.getLaggedValue('fedFunds', dateStr, CONFIG.PUB_LAG.FED_FUNDS);
            if (fedLag) {
                const fedPrior = DataStore.getLaggedValue('fedFunds', dateStr, CONFIG.PUB_LAG.FED_FUNDS + 3);
                const cpiLag = DataStore.getLaggedValue('cpi', dateStr, CONFIG.PUB_LAG.CPI);
                const unempLagFed = DataStore.getLaggedValue('unemployment', dateStr, CONFIG.PUB_LAG.UNEMPLOYMENT);
                const unempR = unempLagFed && unempLagFed.ma12 !== null && unempLagFed.value > unempLagFed.ma12;
                const inflR = cpiLag ? cpiLag.inflationRate : null;
                const { signal } = Strategy.classifyFedPolicy(fedLag.value, fedPrior ? fedPrior.value : null, inflR, unempR);
                sigFed = signal > 0 ? `+${signal}` : String(signal);
            }

            scoreStr = lagged.score.toFixed(1);
            regimeStr = Strategy.scoreToRegime(lagged.score, trendSignal);
            allocFrac = Strategy.scoreToAllocation(lagged.score, trendSignal, false);
            allocPctStr = Math.round(allocFrac * 100) + '%';
        }

        // Cumulative backtest: the allocation set the PRIOR month earns this
        // month's return (no look-ahead).
        let moReturnStr = '';
        if (sp && prevSP && prevSP > 0) {
            const ret = (sp.value - prevSP) / prevSP;
            moReturnStr = (ret * 100).toFixed(2) + '%';
            strategyValue *= (1 + ret * prevAllocFrac);
            buyHoldValue *= (1 + ret);
        }
        if (sp) prevSP = sp.value;
        if (lagged.count > 0) prevAllocFrac = allocFrac;

        rows.push([
            ym,
            sp ? sp.value.toFixed(2) : '',
            sp && sp.ma200 !== null ? sp.ma200.toFixed(2) : '',
            unemp ? unemp.value.toFixed(1) : '',
            unemp && unemp.ma12 !== null ? unemp.ma12.toFixed(1) : '',
            cpi ? cpi.value.toFixed(1) : '',
            cpi && cpi.inflationRate !== null ? cpi.inflationRate.toFixed(2) : '',
            vix ? vix.value.toFixed(1) : '',
            cape ? cape.value.toFixed(1) : '',
            pie ? pie.value.toFixed(2) : '',
            alloc ? alloc.value.toFixed(1) : '',
            yc ? yc.value.toFixed(2) : '',
            fed ? fed.value.toFixed(2) : '',
            sigTrend, sigUnemp, sigVix, sigCape, sigPie, sigAlloc, sigYC, sigFed,
            scoreStr, regimeStr, allocPctStr,
            moReturnStr,
            sp ? '$' + strategyValue.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '',
            sp ? '$' + buyHoldValue.toLocaleString(undefined, { maximumFractionDigits: 0 }) : '',
        ]);
    }

    // Live "Now" row — the ONLY place nowcast is used: the current rating,
    // never the backtest. Values and signals both come from the latest
    // (nowcast) readings, so this row is internally consistent.
    const cur = Strategy.computeSignals();
    if (cur && typeof cur.composite === 'number') {
        const L = k => DataStore.getLatest(k);
        const lSp = L('sp500'), lUn = L('unemployment'), lCpi = L('cpi'), lVix = L('vix');
        const lCape = L('cape'), lPie = L('pie'), lAl = L('equityAlloc'), lYc = L('yieldCurve'), lFed = L('fedFunds');
        rows.push([
            'Now ⦾',
            lSp ? lSp.value.toFixed(2) : '',
            lSp && lSp.ma200 != null ? lSp.ma200.toFixed(2) : '',
            lUn ? lUn.value.toFixed(1) : '',
            lUn && lUn.ma12 != null ? lUn.ma12.toFixed(1) : '',
            lCpi ? lCpi.value.toFixed(1) : '',
            lCpi && lCpi.inflationRate != null ? lCpi.inflationRate.toFixed(2) : '',
            lVix ? lVix.value.toFixed(1) : '',
            lCape ? lCape.value.toFixed(1) : '',
            lPie ? lPie.value.toFixed(2) : '',
            lAl ? lAl.value.toFixed(1) : '',
            lYc ? lYc.value.toFixed(2) : '',
            lFed ? lFed.value.toFixed(2) : '',
            fmtSig(cur.trend), fmtSig(cur.unemployment), fmtSig(cur.vix), fmtSig(cur.cape),
            fmtSig(cur.pie), fmtSig(cur.allocation), fmtSig(cur.yieldCurve), fmtSig(cur.fedPolicy),
            cur.composite.toFixed(1), cur.regime || '', (cur.equityPctBase != null ? cur.equityPctBase : '') + '%',
            '', '', '',
        ]);
    }

    thead.innerHTML = '<tr>' + columns.map(c => `<th>${c}</th>`).join('') + '</tr>';
    tbody.innerHTML = rows.map(r => {
        const regime = r[22];
        let cls = '';
        if (regime === 'Crisis') cls = ' class="row-crisis"';
        else if (regime === 'Defensive') cls = ' class="row-defensive"';
        else if (regime === 'Cautious') cls = ' class="row-cautious"';
        return `<tr${cls}>` + r.map(cell => `<td>${cell}</td>`).join('') + '</tr>';
    }).join('');
}

// CSV download
function downloadCSV() {
    const table = document.getElementById('data-table');
    if (!table) return;
    const headerCells = table.querySelectorAll('thead th');
    const bodyRows = table.querySelectorAll('tbody tr');
    if (headerCells.length === 0) return;

    let csv = Array.from(headerCells).map(th => th.textContent).join(',') + '\n';
    bodyRows.forEach(row => {
        const cells = row.querySelectorAll('td');
        csv += Array.from(cells).map(td => td.textContent).join(',') + '\n';
    });

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'market_timing_data.csv';
    a.click();
    URL.revokeObjectURL(url);
}

// Copy data to clipboard
function copyData() {
    const table = document.getElementById('data-table');
    if (!table) return;
    const headerCells = table.querySelectorAll('thead th');
    const bodyRows = table.querySelectorAll('tbody tr');
    if (headerCells.length === 0) return;

    let text = Array.from(headerCells).map(th => th.textContent).join('\t') + '\n';
    bodyRows.forEach(row => {
        const cells = row.querySelectorAll('td');
        text += Array.from(cells).map(td => td.textContent).join('\t') + '\n';
    });

    navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('copy-data');
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy to Clipboard'; }, 2000);
    });
}
