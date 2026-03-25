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
        this.destroyAll();
        this.renderEquityAllocation();
        this.renderAllocationScatter();
        this.renderCAPE();
        this.renderPIE();
        this.renderUnemployment();
        this.renderSP500();
        this.renderCPI();
        this.renderVIX();
        this.renderYieldCurve();
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

    nowcastStyle(data, label = 'Nowcast') {
        return {
            label,
            data,
            borderColor: 'rgba(167, 139, 250, 0.75)',
            borderWidth: 1.5,
            borderDash: [4, 4],
            pointRadius: Array.isArray(data) ? data.map(v => (v === null ? 0 : 2)) : 2,
            pointHoverRadius: 3,
            pointBackgroundColor: 'rgba(167, 139, 250, 0.75)',
            pointBorderWidth: 0,
            tension: 0.25,
            fill: false,
        };
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
            datasets.push(this.nowcastStyle(nowcast, 'Nowcast'));
        }

        // Compute dynamic std-dev bands from confirmed data
        const stats = DataStore.getSeriesStats('equityAlloc');
        const annotations = {};
        if (stats) {
            const bullishLine = stats.mean + CONFIG.STRATEGY.STDDEV_BULLISH * stats.stddev;
            const bearishLine = stats.mean + CONFIG.STRATEGY.STDDEV_BEARISH * stats.stddev;
            annotations.mean = {
                type: 'line',
                yMin: stats.mean,
                yMax: stats.mean,
                borderColor: CONFIG.COLORS.gray,
                borderWidth: 1,
                borderDash: [3, 3],
                label: { content: `Mean (${stats.mean.toFixed(1)}%)`, display: true, position: 'end', color: CONFIG.COLORS.gray, font: { size: 10 }, backgroundColor: 'transparent' },
            };
            annotations.low = {
                type: 'line',
                yMin: bullishLine,
                yMax: bullishLine,
                borderColor: CONFIG.COLORS.green,
                borderWidth: 1,
                borderDash: [5, 5],
                label: { content: `Bullish (<${bullishLine.toFixed(0)}%)`, display: true, position: 'start', color: CONFIG.COLORS.green, font: { size: 10 }, backgroundColor: 'transparent' },
            };
            annotations.high = {
                type: 'line',
                yMin: bearishLine,
                yMax: bearishLine,
                borderColor: CONFIG.COLORS.red,
                borderWidth: 1,
                borderDash: [5, 5],
                label: { content: `Bearish (>${bearishLine.toFixed(0)}%)`, display: true, position: 'start', color: CONFIG.COLORS.red, font: { size: 10 }, backgroundColor: 'transparent' },
            };
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
                    annotation: { annotations },
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

        const hasShiller = (DataStore.raw.shiller || []).length > 0;
        const { confirmed, nowcast, hasNowcast } = this.splitNowcast(data);
        const datasets = [{
            label: hasShiller ? 'Shiller CAPE (PE10)' : 'CAPE Ratio (approx)',
            data: confirmed,
            borderColor: CONFIG.COLORS.purple,
            backgroundColor: 'rgba(167, 139, 250, 0.1)',
            fill: true,
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.3,
        }];
        if (hasNowcast) {
            datasets.push(this.nowcastStyle(nowcast, 'Nowcast'));
        }

        // Compute dynamic std-dev bands from full history
        const capeStats = DataStore.getSeriesStats('cape');
        const capeAnnotations = {};
        if (capeStats) {
            const bullishLine = capeStats.mean + CONFIG.STRATEGY.STDDEV_BULLISH * capeStats.stddev;
            const bearishLine = capeStats.mean + CONFIG.STRATEGY.STDDEV_BEARISH * capeStats.stddev;
            capeAnnotations.mean = {
                type: 'line',
                yMin: capeStats.mean,
                yMax: capeStats.mean,
                borderColor: CONFIG.COLORS.gray,
                borderWidth: 1,
                borderDash: [3, 3],
                label: { content: `Mean (${capeStats.mean.toFixed(1)})`, display: true, position: 'end', color: CONFIG.COLORS.gray, font: { size: 10 }, backgroundColor: 'transparent' },
            };
            capeAnnotations.low = {
                type: 'line',
                yMin: bullishLine,
                yMax: bullishLine,
                borderColor: CONFIG.COLORS.green,
                borderWidth: 1,
                borderDash: [5, 5],
                label: { content: `Cheap -1σ (${bullishLine.toFixed(1)})`, display: true, position: 'start', color: CONFIG.COLORS.green, font: { size: 10 }, backgroundColor: 'transparent' },
            };
            capeAnnotations.high = {
                type: 'line',
                yMin: bearishLine,
                yMax: bearishLine,
                borderColor: CONFIG.COLORS.red,
                borderWidth: 1,
                borderDash: [5, 5],
                label: { content: `Expensive +1σ (${bearishLine.toFixed(1)})`, display: true, position: 'start', color: CONFIG.COLORS.red, font: { size: 10 }, backgroundColor: 'transparent' },
            };
        }

        this.instances['chart-cape'] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.map(d => d.date),
                datasets,
            },
            options: {
                ...this.getBaseOptions(),
                plugins: {
                    ...CONFIG.CHART_DEFAULTS.plugins,
                    annotation: { annotations: capeAnnotations },
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
        const data = DataStore.processed.pie;
        if (!data || data.length === 0) return;

        this.destroy('chart-pie');
        const ctx = document.getElementById('chart-pie').getContext('2d');

        const { confirmed, nowcast, hasNowcast } = this.splitNowcast(data);
        const datasets = [{
            label: 'P/IE (Integrated Equity)',
            data: confirmed,
            borderColor: CONFIG.COLORS.orange,
            backgroundColor: 'rgba(251, 146, 60, 0.1)',
            fill: true,
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.3,
        }];
        if (hasNowcast) {
            datasets.push(this.nowcastStyle(nowcast, 'Estimated (recent)'));
        }

        // Compute dynamic std-dev bands from full history
        const pieStats = DataStore.getSeriesStats('pie');
        const pieAnnotations = {};
        if (pieStats) {
            const bullishLine = pieStats.mean + CONFIG.STRATEGY.STDDEV_BULLISH * pieStats.stddev;
            const bearishLine = pieStats.mean + CONFIG.STRATEGY.STDDEV_BEARISH * pieStats.stddev;
            pieAnnotations.mean = {
                type: 'line',
                yMin: pieStats.mean,
                yMax: pieStats.mean,
                borderColor: CONFIG.COLORS.gray,
                borderWidth: 1,
                borderDash: [3, 3],
                label: { content: `Mean (${pieStats.mean.toFixed(2)})`, display: true, position: 'end', color: CONFIG.COLORS.gray, font: { size: 10 }, backgroundColor: 'transparent' },
            };
            pieAnnotations.low = {
                type: 'line',
                yMin: bullishLine,
                yMax: bullishLine,
                borderColor: CONFIG.COLORS.green,
                borderWidth: 1,
                borderDash: [5, 5],
                label: { content: `Cheap -1σ (${bullishLine.toFixed(2)})`, display: true, position: 'start', color: CONFIG.COLORS.green, font: { size: 10 }, backgroundColor: 'transparent' },
            };
            pieAnnotations.high = {
                type: 'line',
                yMin: bearishLine,
                yMax: bearishLine,
                borderColor: CONFIG.COLORS.red,
                borderWidth: 1,
                borderDash: [5, 5],
                label: { content: `Expensive +1σ (${bearishLine.toFixed(2)})`, display: true, position: 'start', color: CONFIG.COLORS.red, font: { size: 10 }, backgroundColor: 'transparent' },
            };
        }

        this.instances['chart-pie'] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.map(d => d.date),
                datasets,
            },
            options: {
                ...this.getBaseOptions(),
                plugins: {
                    ...CONFIG.CHART_DEFAULTS.plugins,
                    annotation: { annotations: pieAnnotations },
                },
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
            datasets.push(this.nowcastStyle(nowcast, 'Nowcast'));
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

        // Show only inflation rate (YoY) — remap value to inflationRate for splitNowcast
        const inflData = data
            .filter(d => d.inflationRate !== null)
            .map(d => ({ ...d, value: d.inflationRate }));

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
            datasets.push(this.nowcastStyle(nowcast, 'Nowcast'));
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

        // Compute rolling z-score bands from 5-year window
        const lastVix = data[data.length - 1];
        const vixStats = lastVix ? DataStore.getSeriesStatsAsOf('vix', lastVix.date, CONFIG.STRATEGY.VIX_ROLLING_MONTHS) : null;
        const vixAnnotations = {};
        if (vixStats) {
            const bullishLine = vixStats.mean + CONFIG.STRATEGY.STDDEV_BULLISH * vixStats.stddev;
            const bearishLine = vixStats.mean + CONFIG.STRATEGY.STDDEV_BEARISH * vixStats.stddev;
            vixAnnotations.mean = {
                type: 'line',
                yMin: vixStats.mean,
                yMax: vixStats.mean,
                borderColor: CONFIG.COLORS.gray,
                borderWidth: 1,
                borderDash: [3, 3],
                label: { content: `5yr Mean (${vixStats.mean.toFixed(1)})`, display: true, position: 'end', color: CONFIG.COLORS.gray, font: { size: 10 }, backgroundColor: 'transparent' },
            };
            vixAnnotations.low = {
                type: 'line',
                yMin: bullishLine,
                yMax: bullishLine,
                borderColor: CONFIG.COLORS.green,
                borderWidth: 1,
                borderDash: [5, 5],
                label: { content: `Low Vol -1σ (${bullishLine.toFixed(1)})`, display: true, position: 'start', color: CONFIG.COLORS.green, font: { size: 10 }, backgroundColor: 'transparent' },
            };
            vixAnnotations.high = {
                type: 'line',
                yMin: bearishLine,
                yMax: bearishLine,
                borderColor: CONFIG.COLORS.red,
                borderWidth: 1,
                borderDash: [5, 5],
                label: { content: `High Vol +1σ (${bearishLine.toFixed(1)})`, display: true, position: 'start', color: CONFIG.COLORS.red, font: { size: 10 }, backgroundColor: 'transparent' },
            };
        }

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
                    annotation: { annotations: vixAnnotations },
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

    renderYieldCurve() {
        const data = DataStore.processed.yieldCurve;
        if (!data || data.length === 0) return;

        this.destroy('chart-yieldcurve');
        const ctx = document.getElementById('chart-yieldcurve').getContext('2d');

        this.instances['chart-yieldcurve'] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: data.map(d => d.date),
                datasets: [
                    {
                        label: '10Y-2Y Spread (%)',
                        data: data.map(d => d.value),
                        borderColor: CONFIG.COLORS.purple,
                        backgroundColor: data.map(d =>
                            d.value >= 0 ? 'rgba(52, 211, 153, 0.08)' : 'rgba(248, 113, 113, 0.08)'
                        ),
                        fill: true,
                        borderWidth: 1.5,
                        pointRadius: 0,
                        tension: 0.1,
                    },
                    {
                        label: '20-Day MA',
                        data: data.map(d => d.ma20),
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
                plugins: {
                    ...CONFIG.CHART_DEFAULTS.plugins,
                    annotation: {
                        annotations: {
                            zero: {
                                type: 'line',
                                yMin: 0,
                                yMax: 0,
                                borderColor: CONFIG.COLORS.red,
                                borderWidth: 2,
                                label: { content: 'Inversion Line', display: true, position: 'start', color: CONFIG.COLORS.red, font: { size: 10 }, backgroundColor: 'transparent' },
                            },
                        },
                    },
                },
                scales: {
                    x: { ...CONFIG.CHART_DEFAULTS.scales.x },
                    y: {
                        ...CONFIG.CHART_DEFAULTS.scales.y,
                        title: { display: true, text: 'Spread (%)', color: '#6b7084', font: { size: 11 } },
                    },
                },
            },
        });
    },
};
