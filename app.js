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

    seriesDefs.forEach(s => {
        const data = DataStore.processed[s.proc] || [];
        const monthly = DataStore.getMonthlyValues(data);
        const map = {};
        monthly.forEach(d => { map[d.date.substring(0, 7)] = d; });
        monthlyMaps[s.key] = map;
        monthly.forEach(d => allMonths.add(d.date.substring(0, 7)));
    });

    const sortedMonths = Array.from(allMonths).sort();
    if (sortedMonths.length === 0) return;

    // Pre-compute expanding-window z-score stats once. No look-ahead: each
    // month's bands use only data up to that month.
    Strategy._backtestStats = {
        alloc: DataStore.buildRollingStatsLookup('equityAlloc', 0),
        cape: DataStore.buildRollingStatsLookup('cape', 0),
        pie: DataStore.buildRollingStatsLookup('pie', 0),
        vixRolling: DataStore.buildRollingStatsLookup('vix', CONFIG.STRATEGY.VIX_ROLLING_MONTHS),
    };
    const fmtSig = v => (v === undefined || v === null) ? '' : (v > 0 ? `+${v}` : String(v));
    const monthKeyOffset = (ym, delta) => {
        const [y, m] = ym.split('-').map(Number);
        const d = new Date(Date.UTC(y, m - 1 + delta, 1));
        return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
    };

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

        // Signals are computed from THIS row's own (contemporaneous) values so
        // each row is internally consistent \u2014 the signal always matches the
        // numbers shown in the same row. Z-score bands use expanding stats
        // (data up to this month only), so there's still no look-ahead.
        let sigTrend = '', sigUnemp = '', sigVix = '', sigCape = '', sigPie = '', sigAlloc = '', sigYC = '', sigFed = '';
        let scoreStr = '', regimeStr = '', allocPctStr = '';
        let scoreVal = 0, count = 0, trendNum = 0;
        let allocFrac = prevAllocFrac;

        if (sp && sp.ma200 !== null) {
            const s = sp.value > sp.ma200 ? 1 : -1;
            sigTrend = fmtSig(s); scoreVal += s; trendNum = s; count++;
        }
        if (unemp && unemp.ma12 !== null) {
            const gap = unemp.value - unemp.ma12;
            const s = gap < 0 ? 1 : (gap >= 0.5 ? -2 : -1);
            sigUnemp = fmtSig(s); scoreVal += s; count++;
        }
        if (vix) {
            const st = Strategy._backtestStats.vixRolling[ym];
            if (st) { const { signal } = Strategy.classifyByZScore(vix.value, st); sigVix = fmtSig(signal); scoreVal += signal; count++; }
        }
        if (cape) {
            const st = Strategy._backtestStats.cape[ym];
            if (st) { const { signal } = Strategy.classifyByZScore(cape.value, st); const v = signal * 0.5; sigCape = fmtSig(v); scoreVal += v; count++; }
        }
        if (pie) {
            const st = Strategy._backtestStats.pie[ym];
            if (st) { const { signal } = Strategy.classifyByZScore(pie.value, st); const v = signal * 0.5; sigPie = fmtSig(v); scoreVal += v; count++; }
        }
        if (alloc) {
            const st = Strategy._backtestStats.alloc[ym];
            if (st) { const { signal } = Strategy.classifyByZScore(alloc.value, st); sigAlloc = fmtSig(signal); scoreVal += signal; count++; }
        }
        if (yc) {
            const s = yc.value > CONFIG.STRATEGY.YIELD_CURVE_INVERSION ? 1 : -1;
            sigYC = fmtSig(s); scoreVal += s; count++;
        }
        if (fed) {
            const fedPrior = monthlyMaps.fedFunds[monthKeyOffset(ym, -3)];
            const inflR = cpi ? cpi.inflationRate : null;
            const unempR = unemp && unemp.ma12 !== null && unemp.value > unemp.ma12;
            const { signal } = Strategy.classifyFedPolicy(fed.value, fedPrior ? fedPrior.value : null, inflR, unempR);
            sigFed = fmtSig(signal); scoreVal += signal; count++;
        }

        if (count > 0) {
            scoreStr = scoreVal.toFixed(1);
            regimeStr = Strategy.scoreToRegime(scoreVal, trendNum);
            allocFrac = Strategy.scoreToAllocation(scoreVal, trendNum, false);
            allocPctStr = Math.round(allocFrac * 100) + '%';
        }

        // Cumulative backtest: the allocation decided from the PRIOR month's
        // signals earns this month's return (no look-ahead).
        let moReturnStr = '';
        if (sp && prevSP && prevSP > 0) {
            const ret = (sp.value - prevSP) / prevSP;
            moReturnStr = (ret * 100).toFixed(2) + '%';
            strategyValue *= (1 + ret * prevAllocFrac);
            buyHoldValue *= (1 + ret);
        }
        if (sp) prevSP = sp.value;
        if (count > 0) prevAllocFrac = allocFrac;

        // Mark a row with ⦾ when any of its values is a nowcast estimate.
        const nowcastRow = [sp, unemp, cpi, vix, cape, pie, alloc, yc, fed].some(d => d && d.nowcast);

        rows.push([
            nowcastRow ? ym + ' ⦾' : ym,
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
