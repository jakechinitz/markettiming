// Chart rendering module
const Charts = {
    instances: {},

    destroy(id) {
        if (this.instances[id]) {
            this.instances[id].destroy();
            delete this.instances[id];
        }
    },

    destroyAll() {
        Object.keys(this.instances).forEach(id => this.destroy(id));
    },

    getBaseOptions(overrides = {}) {
        return JSON.parse(JSON.stringify({
            ...CONFIG.CHART_DEFAULTS,
            ...overrides,
        }));
    },

    renderAllCharts() {
        this.renderEquityAllocation();
        this.renderAllocationScatter();
        this.renderCAPE();
        this.renderPIE();
        this.renderUnemployment();
        this.renderSP500();
        this.renderCPI();
        this.renderVIX();
    },

    // Helper: split data into confirmed and nowcast segments for a dual-line look
    splitNowcast(data) {
        const lastConfirmedIdx = data.reduce((acc, d, i) => d.nowcast ? acc : i, -1);
        const confirmed = data.map((d, i) => i <= lastConfirmedIdx ? d.value : null);
        // Overlap by 1 point so the lines connect
        const nowcast = data.map((d, i) => {
            if (i >= lastConfirmedIdx && d.nowcast) return d.value;
            if (i === lastConfirmedIdx) return d.value; // bridge point
            return null;
        });
        const hasNowcast = data.some(d => d.nowcast);
        return { confirmed, nowcast, hasNowcast };
    },

    renderEquityAllocation() {
        const data = DataStore.processed.equityAlloc;
        if (!data || data.length === 0) return;

        this.destroy('chart-allocation');
        const ctx = document.getElementById('chart-allocation').getContext('2d');

        const { confirmed, nowcast, hasNowcast } = this.splitNowcast(data);
        const datasets = [{
            label: 'Equity Allocation (%)',
            data: confirmed,
            borderColor: CONFIG.COLORS.blue,
            backgroundColor: 'rgba(79, 143, 247, 0.1)',
            fill: true,
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.3,
        }];
        if (hasNowcast) {
            datasets.push({
                label: 'Nowcast',
                data: nowcast,
                borderColor: CONFIG.COLORS.nowcast,
                borderWidth: 2,
                borderDash: [6, 3],
                pointRadius: data.map(d => d.nowcast ? 4 : 0),
                pointBackgroundColor: CONFIG.COLORS.nowcast,
                tension: 0.3,
                fill: false,
            });
        }

        this.instances['chart-allocation'] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.map(d => d.date),
                datasets,
            },
            options: {
                ...this.getBaseOptions(),
                plugins: {
                    ...CONFIG.CHART_DEFAULTS.plugins,
                    annotation: {
                        annotations: {
                            low: {
                                type: 'line',
                                yMin: CONFIG.STRATEGY.ALLOC_LOW,
                                yMax: CONFIG.STRATEGY.ALLOC_LOW,
                                borderColor: CONFIG.COLORS.green,
                                borderWidth: 1,
                                borderDash: [5, 5],
                                label: { content: 'Bullish (<35%)', display: true, position: 'start', color: CONFIG.COLORS.green, font: { size: 10 }, backgroundColor: 'transparent' },
                            },
                            high: {
                                type: 'line',
                                yMin: CONFIG.STRATEGY.ALLOC_HIGH,
                                yMax: CONFIG.STRATEGY.ALLOC_HIGH,
                                borderColor: CONFIG.COLORS.red,
                                borderWidth: 1,
                                borderDash: [5, 5],
                                label: { content: 'Bearish (>45%)', display: true, position: 'start', color: CONFIG.COLORS.red, font: { size: 10 }, backgroundColor: 'transparent' },
                            },
                        },
                    },
                },
                scales: {
                    x: { ...CONFIG.CHART_DEFAULTS.scales.x },
                    y: {
                        ...CONFIG.CHART_DEFAULTS.scales.y,
                        title: { display: true, text: 'Equity Allocation (%)', color: '#6b7084', font: { size: 11 } },
                    },
                },
            },
        });
    },

    renderAllocationScatter() {
        const data = DataStore.processed.equityAlloc;
        if (!data || data.length === 0) return;

        this.destroy('chart-allocation-scatter');
        const ctx = document.getElementById('chart-allocation-scatter').getContext('2d');

        // Build scatter: allocation vs subsequent 10-year return (approximated)
        // We need S&P 500 data for returns
        const sp = DataStore.processed.sp500;
        if (!sp || sp.length === 0) return;

        const spLookup = {};
        sp.forEach(d => { spLookup[d.date.substring(0, 7)] = d.value; });

        const scatterData = [];
        data.forEach(d => {
            const dateKey = d.date.substring(0, 7);
            const spNow = spLookup[dateKey];
            // Look 10 years ahead
            const futureDate = new Date(d.date);
            futureDate.setFullYear(futureDate.getFullYear() + 10);
            const futureKey = futureDate.toISOString().substring(0, 7);
            const spFuture = spLookup[futureKey];
            if (spNow && spFuture && spNow > 0) {
                const annReturn = (Math.pow(spFuture / spNow, 1 / 10) - 1) * 100;
                scatterData.push({ x: d.value, y: annReturn });
            }
        });

        if (scatterData.length === 0) return;

        this.instances['chart-allocation-scatter'] = new Chart(ctx, {
            type: 'scatter',
            data: {
                datasets: [{
                    label: 'Equity Alloc vs Future 10yr Return',
                    data: scatterData,
                    backgroundColor: CONFIG.COLORS.blue,
                    pointRadius: 3,
                    pointHoverRadius: 5,
                }],
            },
            options: {
                ...this.getBaseOptions(),
                scales: {
                    x: {
                        type: 'linear',
                        grid: { color: CONFIG.COLORS.gridLineLight, drawBorder: false },
                        ticks: { color: '#6b7084', font: { size: 10 } },
                        title: { display: true, text: 'Equity Allocation (%)', color: '#6b7084', font: { size: 11 } },
                    },
                    y: {
                        grid: { color: CONFIG.COLORS.gridLineLight, drawBorder: false },
                        ticks: { color: '#6b7084', font: { size: 10 }, callback: v => v.toFixed(1) + '%' },
                        title: { display: true, text: 'Subsequent 10yr Ann. Return (%)', color: '#6b7084', font: { size: 11 } },
                    },
                },
            },
        });
    },

    renderCAPE() {
        const data = DataStore.processed.cape;
        if (!data || data.length === 0) return;

        this.destroy('chart-cape');
        const ctx = document.getElementById('chart-cape').getContext('2d');

        this.instances['chart-cape'] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.map(d => d.date),
                datasets: [{
                    label: 'CAPE Ratio (approx)',
                    data: data.map(d => d.value),
                    borderColor: CONFIG.COLORS.purple,
                    backgroundColor: 'rgba(167, 139, 250, 0.1)',
                    fill: true,
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.3,
                }],
            },
            options: {
                ...this.getBaseOptions(),
                plugins: {
                    ...CONFIG.CHART_DEFAULTS.plugins,
                    annotation: {
                        annotations: {
                            low: {
                                type: 'line',
                                yMin: CONFIG.STRATEGY.CAPE_LOW,
                                yMax: CONFIG.STRATEGY.CAPE_LOW,
                                borderColor: CONFIG.COLORS.green,
                                borderWidth: 1,
                                borderDash: [5, 5],
                                label: { content: 'Cheap (<20)', display: true, position: 'start', color: CONFIG.COLORS.green, font: { size: 10 }, backgroundColor: 'transparent' },
                            },
                            high: {
                                type: 'line',
                                yMin: CONFIG.STRATEGY.CAPE_HIGH,
                                yMax: CONFIG.STRATEGY.CAPE_HIGH,
                                borderColor: CONFIG.COLORS.red,
                                borderWidth: 1,
                                borderDash: [5, 5],
                                label: { content: 'Expensive (>30)', display: true, position: 'start', color: CONFIG.COLORS.red, font: { size: 10 }, backgroundColor: 'transparent' },
                            },
                        },
                    },
                },
                scales: {
                    x: { ...CONFIG.CHART_DEFAULTS.scales.x },
                    y: {
                        ...CONFIG.CHART_DEFAULTS.scales.y,
                        title: { display: true, text: 'CAPE Ratio', color: '#6b7084', font: { size: 11 } },
                    },
                },
            },
        });
    },

    renderPIE() {
        // P/IE approximation using CPI-adjusted earnings
        const cpi = DataStore.processed.cpi;
        const sp = DataStore.processed.sp500;
        if (!cpi || cpi.length === 0 || !sp || sp.length === 0) return;

        this.destroy('chart-pie');
        const ctx = document.getElementById('chart-pie').getContext('2d');

        // Build monthly CPI lookup
        const cpiLookup = {};
        cpi.forEach(d => { cpiLookup[d.date.substring(0, 7)] = d; });

        // Use monthly S&P and CPI to compute P/IE
        const monthly = DataStore.getMonthlyValues(DataStore.raw.sp500);
        const latestCPI = cpi[cpi.length - 1].value;
        const pieData = [];

        monthly.forEach((d, i) => {
            if (i < 12) return;
            const cpiNow = cpiLookup[d.date.substring(0, 7)];
            const cpiPrev = cpiLookup[monthly[Math.max(0, i - 12)].date.substring(0, 7)];
            if (!cpiNow || !cpiPrev) return;

            const inflationRate = (cpiNow.value - cpiPrev.value) / cpiPrev.value;
            // Approximate real P/E adjustment
            const earningsYield = 0.055; // ~5.5% long-run E/P
            const nominalE = d.value * earningsYield;
            const inflationAdj = nominalE * (1 - inflationRate * 0.3); // partial inflation distortion
            const pie = inflationAdj > 0 ? d.value / inflationAdj : null;

            if (pie !== null && pie < 100) {
                pieData.push({ date: d.date, value: pie });
            }
        });

        if (pieData.length === 0) return;

        this.instances['chart-pie'] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: pieData.map(d => d.date),
                datasets: [{
                    label: 'P/IE (approx)',
                    data: pieData.map(d => d.value),
                    borderColor: CONFIG.COLORS.orange,
                    backgroundColor: 'rgba(251, 146, 60, 0.1)',
                    fill: true,
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.3,
                }],
            },
            options: {
                ...this.getBaseOptions(),
                scales: {
                    x: { ...CONFIG.CHART_DEFAULTS.scales.x },
                    y: {
                        ...CONFIG.CHART_DEFAULTS.scales.y,
                        title: { display: true, text: 'P/IE Ratio', color: '#6b7084', font: { size: 11 } },
                    },
                },
            },
        });
    },

    renderUnemployment() {
        const data = DataStore.processed.unemployment;
        if (!data || data.length === 0) return;

        this.destroy('chart-unemployment');
        const ctx = document.getElementById('chart-unemployment').getContext('2d');

        const { confirmed, nowcast, hasNowcast } = this.splitNowcast(data);
        const datasets = [
            {
                label: 'Unemployment Rate (%)',
                data: confirmed,
                borderColor: CONFIG.COLORS.blue,
                borderWidth: 2,
                pointRadius: 0,
                tension: 0.2,
            },
            {
                label: '12-Month MA',
                data: data.map(d => d.ma12),
                borderColor: CONFIG.COLORS.red,
                borderWidth: 1.5,
                borderDash: [5, 5],
                pointRadius: 0,
                tension: 0.2,
            },
        ];
        if (hasNowcast) {
            datasets.push({
                label: 'Nowcast',
                data: nowcast,
                borderColor: CONFIG.COLORS.nowcast,
                borderWidth: 2,
                borderDash: [6, 3],
                pointRadius: data.map(d => d.nowcast ? 4 : 0),
                pointBackgroundColor: CONFIG.COLORS.nowcast,
                tension: 0.2,
                fill: false,
            });
        }

        this.instances['chart-unemployment'] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.map(d => d.date),
                datasets,
            },
            options: {
                ...this.getBaseOptions(),
                scales: {
                    x: { ...CONFIG.CHART_DEFAULTS.scales.x },
                    y: {
                        ...CONFIG.CHART_DEFAULTS.scales.y,
                        title: { display: true, text: 'Rate (%)', color: '#6b7084', font: { size: 11 } },
                    },
                },
            },
        });
    },

    renderSP500() {
        const data = DataStore.processed.sp500;
        if (!data || data.length === 0) return;

        this.destroy('chart-sp500');
        const ctx = document.getElementById('chart-sp500').getContext('2d');

        this.instances['chart-sp500'] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.map(d => d.date),
                datasets: [
                    {
                        label: 'S&P 500',
                        data: data.map(d => d.value),
                        borderColor: CONFIG.COLORS.blue,
                        borderWidth: 2,
                        pointRadius: 0,
                        tension: 0.1,
                    },
                    {
                        label: '200-Day MA',
                        data: data.map(d => d.ma200),
                        borderColor: CONFIG.COLORS.yellow,
                        borderWidth: 1.5,
                        borderDash: [5, 5],
                        pointRadius: 0,
                        tension: 0.1,
                    },
                ],
            },
            options: {
                ...this.getBaseOptions(),
                scales: {
                    x: { ...CONFIG.CHART_DEFAULTS.scales.x },
                    y: {
                        ...CONFIG.CHART_DEFAULTS.scales.y,
                        title: { display: true, text: 'Price', color: '#6b7084', font: { size: 11 } },
                    },
                },
            },
        });
    },

    renderCPI() {
        const data = DataStore.processed.cpi;
        if (!data || data.length === 0) return;

        // Show only inflation rate (YoY)
        const inflData = data.filter(d => d.inflationRate !== null);

        this.destroy('chart-cpi');
        const ctx = document.getElementById('chart-cpi').getContext('2d');

        const { confirmed, nowcast, hasNowcast } = this.splitNowcast(inflData);
        const datasets = [{
            label: 'YoY Inflation Rate (%)',
            data: confirmed,
            borderColor: CONFIG.COLORS.cyan,
            backgroundColor: inflData.map(d => d.inflationRate >= 0 ? 'rgba(248, 113, 113, 0.1)' : 'rgba(52, 211, 153, 0.1)'),
            fill: true,
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.2,
        }];
        if (hasNowcast) {
            datasets.push({
                label: 'Nowcast',
                data: nowcast,
                borderColor: CONFIG.COLORS.nowcast,
                borderWidth: 2,
                borderDash: [6, 3],
                pointRadius: inflData.map(d => d.nowcast ? 4 : 0),
                pointBackgroundColor: CONFIG.COLORS.nowcast,
                tension: 0.2,
                fill: false,
            });
        }

        this.instances['chart-cpi'] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: inflData.map(d => d.date),
                datasets,
            },
            options: {
                ...this.getBaseOptions(),
                plugins: {
                    ...CONFIG.CHART_DEFAULTS.plugins,
                    annotation: {
                        annotations: {
                            zero: {
                                type: 'line',
                                yMin: 0,
                                yMax: 0,
                                borderColor: CONFIG.COLORS.gray,
                                borderWidth: 1,
                            },
                            target: {
                                type: 'line',
                                yMin: 2,
                                yMax: 2,
                                borderColor: CONFIG.COLORS.yellow,
                                borderWidth: 1,
                                borderDash: [5, 5],
                                label: { content: 'Fed Target (2%)', display: true, position: 'start', color: CONFIG.COLORS.yellow, font: { size: 10 }, backgroundColor: 'transparent' },
                            },
                        },
                    },
                },
                scales: {
                    x: { ...CONFIG.CHART_DEFAULTS.scales.x },
                    y: {
                        ...CONFIG.CHART_DEFAULTS.scales.y,
                        title: { display: true, text: 'Inflation Rate (%)', color: '#6b7084', font: { size: 11 } },
                    },
                },
            },
        });
    },

    renderVIX() {
        const data = DataStore.processed.vix;
        if (!data || data.length === 0) return;

        this.destroy('chart-vix');
        const ctx = document.getElementById('chart-vix').getContext('2d');

        this.instances['chart-vix'] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.map(d => d.date),
                datasets: [{
                    label: 'VIX',
                    data: data.map(d => d.value),
                    borderColor: CONFIG.COLORS.red,
                    backgroundColor: 'rgba(248, 113, 113, 0.05)',
                    fill: true,
                    borderWidth: 1.5,
                    pointRadius: 0,
                    tension: 0.1,
                }],
            },
            options: {
                ...this.getBaseOptions(),
                plugins: {
                    ...CONFIG.CHART_DEFAULTS.plugins,
                    annotation: {
                        annotations: {
                            low: {
                                type: 'box',
                                yMin: 0,
                                yMax: CONFIG.STRATEGY.VIX_LOW,
                                backgroundColor: 'rgba(52, 211, 153, 0.05)',
                                borderWidth: 0,
                                label: { content: 'Low Vol', display: true, position: { x: 'start', y: 'center' }, color: CONFIG.COLORS.green, font: { size: 10 }, backgroundColor: 'transparent' },
                            },
                            mid: {
                                type: 'box',
                                yMin: CONFIG.STRATEGY.VIX_LOW,
                                yMax: CONFIG.STRATEGY.VIX_HIGH,
                                backgroundColor: 'rgba(251, 191, 36, 0.05)',
                                borderWidth: 0,
                            },
                            high: {
                                type: 'box',
                                yMin: CONFIG.STRATEGY.VIX_HIGH,
                                yMax: 90,
                                backgroundColor: 'rgba(248, 113, 113, 0.05)',
                                borderWidth: 0,
                                label: { content: 'High Vol', display: true, position: { x: 'start', y: 'center' }, color: CONFIG.COLORS.red, font: { size: 10 }, backgroundColor: 'transparent' },
                            },
                        },
                    },
                },
                scales: {
                    x: { ...CONFIG.CHART_DEFAULTS.scales.x },
                    y: {
                        ...CONFIG.CHART_DEFAULTS.scales.y,
                        title: { display: true, text: 'VIX Level', color: '#6b7084', font: { size: 11 } },
                    },
                },
            },
        });
    },
};
