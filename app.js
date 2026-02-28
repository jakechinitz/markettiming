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

    // Enter key on API key input triggers load
    document.getElementById('fred-api-key').addEventListener('keydown', e => {
        if (e.key === 'Enter') loadAllData();
    });

    // Restore API key from localStorage
    const savedKey = localStorage.getItem('fred_api_key');
    if (savedKey) {
        document.getElementById('fred-api-key').value = savedKey;
    }
})();

// Global: load all data
async function loadAllData() {
    const keyInput = document.getElementById('fred-api-key');
    const key = keyInput.value.trim();
    if (!key) {
        keyInput.focus();
        keyInput.style.borderColor = '#f87171';
        return;
    }
    keyInput.style.borderColor = '';
    localStorage.setItem('fred_api_key', key);

    const loading = document.getElementById('loading');
    const loadBtn = document.getElementById('load-data-btn');
    loading.classList.remove('hidden');
    loadBtn.disabled = true;
    loadBtn.textContent = 'Loading...';

    try {
        DataStore.setApiKey(key);
        await DataStore.loadAllSeries();

        // Render charts
        Charts.renderAllCharts();

        // Render strategy
        const signals = Strategy.computeSignals();
        Strategy.renderSignals(signals);
        Strategy.renderStrategyChart();
        Strategy.renderBacktest();

        // Populate data table
        populateDataTable();

        // Hide banner on success
        document.getElementById('api-key-banner').style.display = 'none';
    } catch (err) {
        console.error('Error loading data:', err);
        alert('Error loading data: ' + err.message);
    } finally {
        loading.classList.add('hidden');
        loadBtn.disabled = false;
        loadBtn.textContent = 'Load Data';
    }
}

// Data table population
function populateDataTable() {
    const select = document.getElementById('data-series-select');
    select.addEventListener('change', () => renderDataTable(select.value));
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
                d.ma200 !== null ? d.ma200.toFixed(2) : '—',
            ]);
            break;
        }
        case 'cape': {
            columns = ['Date', 'CAPE Ratio'];
            const data = DataStore.processed.cape || [];
            rows = data.slice(-200).map(d => [d.date, d.value.toFixed(2)]);
            break;
        }
        case 'unemployment': {
            columns = ['Date', 'Rate (%)', '12-Mo MA (%)', 'Source'];
            const data = DataStore.processed.unemployment || [];
            rows = data.slice(-200).map(d => [
                d.date,
                d.value.toFixed(1),
                d.ma12 !== null ? d.ma12.toFixed(1) : '—',
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
                d.ma20 !== null ? d.ma20.toFixed(2) : '—',
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
                ['CAPE (approx)', DataStore.getLatest('cape')],
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
