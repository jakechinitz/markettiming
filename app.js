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
            Make sure your <a href="https://fred.stlouisfed.org/docs/api/api_key.html" target="_blank">FRED API key</a> is valid and you have internet access.`,
            'error'
        );
    } finally {
        loading.classList.add('hidden');
    }
}

// Data table population
let dataTableInitialized = false;
function populateDataTable() {
    const select = document.getElementById('data-series-select');
    if (!dataTableInitialized) {
        select.addEventListener('change', () => renderDataTable(select.value));
        dataTableInitialized = true;
    }
    renderDataTable(select.value);
}

function renderDataTable(series) {
    const thead = document.getElementById('data-thead');
    const tbody = document.getElementById('data-tbody');

    let columns = [];
    let rows = [];

    switch (series) {
        case 'sp500': {
            columns = ['Date', 'S&P 500', '200-Day MA'];
            const data = DataStore.processed.sp500 || [];
            rows = data.slice(-500).map(d => [
                d.date,
                d.value.toFixed(2),
                d.ma200 !== null ? d.ma200.toFixed(2) : '\u2014',
            ]);
            break;
        }
        case 'cape': {
            columns = ['Date', 'CAPE Ratio', 'Source'];
            const data = DataStore.processed.cape || [];
            rows = data.slice(-200).map(d => [
                d.date,
                d.value.toFixed(2),
                d.nowcast ? 'Estimated' : 'Shiller',
            ]);
            break;
        }
        case 'trailingPE': {
            columns = ['Date', 'Trailing P/E', 'Source'];
            const data = DataStore.processed.trailingPE || [];
            rows = data.slice(-200).map(d => [
                d.date,
                d.value.toFixed(2),
                d.nowcast ? 'Estimated' : 'Shiller',
            ]);
            break;
        }
        case 'unemployment': {
            columns = ['Date', 'Rate (%)', '12-Mo MA (%)', 'Source'];
            const data = DataStore.processed.unemployment || [];
            rows = data.slice(-200).map(d => [
                d.date,
                d.value.toFixed(1),
                d.ma12 !== null ? d.ma12.toFixed(1) : '\u2014',
                d.nowcast ? 'Nowcast' : 'FRED',
            ]);
            break;
        }
        case 'cpi': {
            columns = ['Date', 'CPI', 'YoY Inflation (%)', 'Source'];
            const data = DataStore.processed.cpi || [];
            rows = data.filter(d => d.inflationRate !== null).slice(-200).map(d => [
                d.date,
                d.value.toFixed(1),
                d.inflationRate.toFixed(2),
                d.nowcast ? 'Nowcast' : 'FRED',
            ]);
            break;
        }
        case 'vix': {
            columns = ['Date', 'VIX'];
            const data = DataStore.processed.vix || [];
            rows = data.slice(-500).map(d => [d.date, d.value.toFixed(2)]);
            break;
        }
        case 'allocation': {
            columns = ['Date', 'Equity Allocation (%)', 'Source'];
            const data = DataStore.processed.equityAlloc || [];
            rows = data.map(d => [d.date, d.value.toFixed(1), d.nowcast ? 'Nowcast' : 'FRED']);
            break;
        }
        case 'yieldcurve': {
            columns = ['Date', '10Y-2Y Spread (%)', '20-Day MA (%)'];
            const data = DataStore.processed.yieldCurve || [];
            rows = data.slice(-500).map(d => [
                d.date,
                d.value.toFixed(2),
                d.ma20 !== null ? d.ma20.toFixed(2) : '\u2014',
            ]);
            break;
        }
        case 'strategy': {
            columns = ['Indicator', 'Signal', 'Value'];
            const signals = Strategy.computeSignals();
            const items = [
                ['Trend (200-Day MA)', signals.trend, signals.trendDetail],
                ['Unemployment', signals.unemployment, signals.unemploymentDetail],
                ['VIX', signals.vix, signals.vixDetail],
                ['CAPE', signals.cape, signals.capeDetail],
                ['Allocation', signals.allocation, signals.allocationDetail],
                ['Yield Curve', signals.yieldCurve, signals.yieldCurveDetail],
                ['Composite', signals.composite, signals.regime],
            ];
            rows = items
                .filter(r => r[1] !== undefined)
                .map(r => [r[0], String(r[1]), r[2] || '']);
            break;
        }
        default: {
            // All series summary
            columns = ['Series', 'Latest Date', 'Latest Value'];
            const summaries = [
                ['S&P 500', DataStore.getLatest('sp500')],
                ['Unemployment', DataStore.getLatest('unemployment')],
                ['CPI', DataStore.getLatest('cpi')],
                ['VIX', DataStore.getLatest('vix')],
                ['Equity Allocation', DataStore.getLatest('equityAlloc')],
                ['Yield Curve (10Y-2Y)', DataStore.getLatest('yieldCurve')],
                ['Shiller CAPE', DataStore.getLatest('cape')],
                ['Trailing P/E', DataStore.getLatest('trailingPE')],
            ];
            rows = summaries
                .filter(s => s[1])
                .map(s => [s[0], s[1].date, s[1].value.toFixed(2)]);
        }
    }

    thead.innerHTML = '<tr>' + columns.map(c => `<th>${c}</th>`).join('') + '</tr>';
    tbody.innerHTML = rows.map(r =>
        '<tr>' + r.map(cell => `<td>${cell}</td>`).join('') + '</tr>'
    ).join('');
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
