// Strategy computation and backtesting module
const Strategy = {

    computeSignals() {
        const signals = {};

        // 1. Trend: S&P 500 vs 200-day MA
        const sp = DataStore.getLatest('sp500');
        if (sp && sp.ma200 !== null) {
            signals.trend = sp.value > sp.ma200 ? 1 : -1;
            signals.trendDetail = `S&P ${sp.value.toFixed(0)} ${sp.value > sp.ma200 ? '>' : '<'} MA ${sp.ma200.toFixed(0)}`;
        }

        // 2. Unemployment: below or above 12-month MA
        const unemp = DataStore.getLatest('unemployment');
        if (unemp && unemp.ma12 !== null) {
            signals.unemployment = unemp.value < unemp.ma12 ? 1 : -1;
            signals.unemploymentDetail = `${unemp.value.toFixed(1)}% ${unemp.value < unemp.ma12 ? '<' : '>'} MA ${unemp.ma12.toFixed(1)}%`;
        }

        // 3. Volatility regime
        const vix = DataStore.getLatest('vix');
        if (vix) {
            if (vix.value < CONFIG.STRATEGY.VIX_LOW) signals.vix = 1;
            else if (vix.value > CONFIG.STRATEGY.VIX_HIGH) signals.vix = -1;
            else signals.vix = 0;
            signals.vixDetail = `VIX at ${vix.value.toFixed(1)}`;
        }

        // 4. Valuation (CAPE)
        const cape = DataStore.getLatest('cape');
        if (cape) {
            if (cape.value < CONFIG.STRATEGY.CAPE_LOW) signals.cape = 1;
            else if (cape.value > CONFIG.STRATEGY.CAPE_HIGH) signals.cape = -1;
            else signals.cape = 0;
            signals.capeDetail = `CAPE at ${cape.value.toFixed(1)}`;
        }

        // 5. Investor allocation
        const alloc = DataStore.getLatest('equityAlloc');
        if (alloc) {
            if (alloc.value < CONFIG.STRATEGY.ALLOC_LOW) signals.allocation = 1;
            else if (alloc.value > CONFIG.STRATEGY.ALLOC_HIGH) signals.allocation = -1;
            else signals.allocation = 0;
            signals.allocationDetail = `Allocation at ${alloc.value.toFixed(1)}%`;
        }

        // Composite score
        const components = ['trend', 'unemployment', 'vix', 'cape', 'allocation'];
        const validSignals = components.filter(c => signals[c] !== undefined);
        signals.composite = validSignals.reduce((sum, c) => sum + signals[c], 0);
        signals.maxPossible = validSignals.length;

        // Determine regime
        if (signals.composite >= 4) {
            signals.regime = 'Strong Buy';
            signals.equityPct = 100;
        } else if (signals.composite >= 2) {
            signals.regime = 'Buy';
            signals.equityPct = 80;
        } else if (signals.composite >= 0) {
            signals.regime = 'Neutral';
            signals.equityPct = 60;
        } else if (signals.composite >= -2) {
            signals.regime = 'Reduce';
            signals.equityPct = 40;
        } else {
            signals.regime = 'Defensive';
            signals.equityPct = 20;
        }

        return signals;
    },

    renderSignals(signals) {
        const container = document.getElementById('current-signals');
        if (!container) return;

        const items = [
            { name: 'Trend (200-Day MA)', value: signals.trend, detail: signals.trendDetail },
            { name: 'Unemployment Trend', value: signals.unemployment, detail: signals.unemploymentDetail },
            { name: 'Volatility Regime', value: signals.vix, detail: signals.vixDetail },
            { name: 'Valuation (CAPE)', value: signals.cape, detail: signals.capeDetail },
            { name: 'Investor Allocation', value: signals.allocation, detail: signals.allocationDetail },
        ];

        let html = '';
        items.forEach(item => {
            if (item.value === undefined) return;
            const cls = item.value > 0 ? 'positive' : item.value < 0 ? 'negative' : 'neutral';
            const label = item.value > 0 ? '+1' : item.value < 0 ? '-1' : '0';
            html += `
                <div class="signal-row">
                    <span>${item.name}</span>
                    <span class="signal-value ${cls}" title="${item.detail || ''}">${label}</span>
                </div>`;
        });

        const compositeClass = signals.composite > 0 ? 'positive' : signals.composite < 0 ? 'negative' : 'neutral';
        html += `
            <div class="composite-score">
                <span>Composite: ${signals.regime}</span>
                <span class="signal-value ${compositeClass}">${signals.composite > 0 ? '+' : ''}${signals.composite} / ${signals.maxPossible}</span>
            </div>`;

        container.innerHTML = html;
    },

    renderStrategyChart() {
        // Historical composite signal chart
        const sp = DataStore.processed.sp500;
        const unemp = DataStore.processed.unemployment;
        const vix = DataStore.processed.vix;
        if (!sp || sp.length === 0) return;

        // Build monthly timeline with signals
        const monthly = DataStore.getMonthlyValues(sp);
        const unempLookup = {};
        if (unemp) unemp.forEach(d => { unempLookup[d.date.substring(0, 7)] = d; });
        const vixLookup = {};
        if (vix) {
            const monthlyVix = DataStore.getMonthlyValues(vix);
            monthlyVix.forEach(d => { vixLookup[d.date.substring(0, 7)] = d; });
        }

        const timeline = [];
        monthly.forEach(d => {
            const key = d.date.substring(0, 7);
            let score = 0;
            let count = 0;

            // Trend signal
            if (d.ma200 !== null) {
                score += d.value > d.ma200 ? 1 : -1;
                count++;
            }

            // Unemployment
            const u = unempLookup[key];
            if (u && u.ma12 !== null) {
                score += u.value < u.ma12 ? 1 : -1;
                count++;
            }

            // VIX
            const v = vixLookup[key];
            if (v) {
                if (v.value < CONFIG.STRATEGY.VIX_LOW) score += 1;
                else if (v.value > CONFIG.STRATEGY.VIX_HIGH) score -= 1;
                count++;
            }

            if (count > 0) {
                timeline.push({ date: d.date, score, price: d.value });
            }
        });

        if (timeline.length === 0) return;

        Charts.destroy('chart-strategy');
        const ctx = document.getElementById('chart-strategy').getContext('2d');

        Charts.instances['chart-strategy'] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: timeline.map(d => d.date),
                datasets: [
                    {
                        label: 'Composite Score',
                        data: timeline.map(d => d.score),
                        borderColor: CONFIG.COLORS.yellow,
                        backgroundColor: timeline.map(d =>
                            d.score > 0 ? 'rgba(52, 211, 153, 0.2)' : d.score < 0 ? 'rgba(248, 113, 113, 0.2)' : 'rgba(251, 191, 36, 0.2)'
                        ),
                        fill: true,
                        borderWidth: 2,
                        pointRadius: 0,
                        stepped: true,
                        yAxisID: 'y',
                    },
                    {
                        label: 'S&P 500',
                        data: timeline.map(d => d.price),
                        borderColor: CONFIG.COLORS.blue,
                        borderWidth: 1.5,
                        pointRadius: 0,
                        tension: 0.1,
                        yAxisID: 'y1',
                    },
                ],
            },
            options: {
                ...Charts.getBaseOptions(),
                scales: {
                    x: { ...CONFIG.CHART_DEFAULTS.scales.x },
                    y: {
                        ...CONFIG.CHART_DEFAULTS.scales.y,
                        position: 'left',
                        title: { display: true, text: 'Composite Score', color: '#6b7084', font: { size: 11 } },
                    },
                    y1: {
                        ...CONFIG.CHART_DEFAULTS.scales.y,
                        position: 'right',
                        grid: { drawOnChartArea: false },
                        title: { display: true, text: 'S&P 500', color: '#6b7084', font: { size: 11 } },
                    },
                },
            },
        });
    },

    renderBacktest() {
        const sp = DataStore.processed.sp500;
        if (!sp || sp.length === 0) return;

        const unemp = DataStore.processed.unemployment;
        const vix = DataStore.processed.vix;

        const monthly = DataStore.getMonthlyValues(sp);
        const unempLookup = {};
        if (unemp) unemp.forEach(d => { unempLookup[d.date.substring(0, 7)] = d; });
        const vixMonthly = vix ? DataStore.getMonthlyValues(vix) : [];
        const vixLookup = {};
        vixMonthly.forEach(d => { vixLookup[d.date.substring(0, 7)] = d; });

        // Backtest: strategy vs buy-and-hold
        let strategyValue = 10000;
        let buyHoldValue = 10000;
        const strategyLine = [];
        const buyHoldLine = [];

        for (let i = 1; i < monthly.length; i++) {
            const prevPrice = monthly[i - 1].value;
            const currPrice = monthly[i].value;
            if (prevPrice <= 0) continue;
            const ret = (currPrice - prevPrice) / prevPrice;

            // Compute signal at previous month
            const prevKey = monthly[i - 1].date.substring(0, 7);
            let score = 0;
            if (monthly[i - 1].ma200 !== null) {
                score += monthly[i - 1].value > monthly[i - 1].ma200 ? 1 : -1;
            }
            const u = unempLookup[prevKey];
            if (u && u.ma12 !== null) {
                score += u.value < u.ma12 ? 1 : -1;
            }
            const v = vixLookup[prevKey];
            if (v) {
                if (v.value < CONFIG.STRATEGY.VIX_LOW) score += 1;
                else if (v.value > CONFIG.STRATEGY.VIX_HIGH) score -= 1;
            }

            // Map score to allocation
            let alloc;
            if (score >= 2) alloc = 1.0;
            else if (score >= 1) alloc = 0.8;
            else if (score >= 0) alloc = 0.6;
            else if (score >= -1) alloc = 0.4;
            else alloc = 0.2;

            strategyValue *= (1 + ret * alloc);
            buyHoldValue *= (1 + ret);

            strategyLine.push({ date: monthly[i].date, value: strategyValue });
            buyHoldLine.push({ date: monthly[i].date, value: buyHoldValue });
        }

        if (strategyLine.length === 0) return;

        Charts.destroy('chart-backtest');
        const ctx = document.getElementById('chart-backtest').getContext('2d');

        Charts.instances['chart-backtest'] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: strategyLine.map(d => d.date),
                datasets: [
                    {
                        label: 'Strategy ($10k)',
                        data: strategyLine.map(d => d.value),
                        borderColor: CONFIG.COLORS.green,
                        borderWidth: 2,
                        pointRadius: 0,
                        tension: 0.1,
                    },
                    {
                        label: 'Buy & Hold ($10k)',
                        data: buyHoldLine.map(d => d.value),
                        borderColor: CONFIG.COLORS.blue,
                        borderWidth: 2,
                        pointRadius: 0,
                        tension: 0.1,
                    },
                ],
            },
            options: {
                ...Charts.getBaseOptions(),
                plugins: {
                    ...CONFIG.CHART_DEFAULTS.plugins,
                    title: {
                        display: true,
                        text: 'Backtest: Strategy vs Buy & Hold (starting $10,000)',
                        color: '#e8e9ed',
                        font: { size: 13, weight: '600' },
                    },
                },
                scales: {
                    x: { ...CONFIG.CHART_DEFAULTS.scales.x },
                    y: {
                        ...CONFIG.CHART_DEFAULTS.scales.y,
                        title: { display: true, text: 'Portfolio Value ($)', color: '#6b7084', font: { size: 11 } },
                        ticks: {
                            color: '#6b7084',
                            font: { size: 10 },
                            callback: v => '$' + v.toLocaleString(undefined, { maximumFractionDigits: 0 }),
                        },
                    },
                },
            },
        });

        // Compute stats
        this.renderStats(strategyLine, buyHoldLine);
    },

    renderStats(strategyLine, buyHoldLine) {
        const container = document.getElementById('strategy-stats');
        if (!container) return;

        const stratFinal = strategyLine[strategyLine.length - 1].value;
        const bhFinal = buyHoldLine[buyHoldLine.length - 1].value;
        const years = strategyLine.length / 12;

        const stratCAGR = (Math.pow(stratFinal / 10000, 1 / years) - 1) * 100;
        const bhCAGR = (Math.pow(bhFinal / 10000, 1 / years) - 1) * 100;

        // Max drawdown
        const stratDD = this.maxDrawdown(strategyLine.map(d => d.value));
        const bhDD = this.maxDrawdown(buyHoldLine.map(d => d.value));

        container.innerHTML = `
            <div class="stat-card">
                <div class="stat-label">Strategy CAGR</div>
                <div class="stat-value" style="color: ${CONFIG.COLORS.green}">${stratCAGR.toFixed(1)}%</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Buy & Hold CAGR</div>
                <div class="stat-value" style="color: ${CONFIG.COLORS.blue}">${bhCAGR.toFixed(1)}%</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Strategy Max DD</div>
                <div class="stat-value" style="color: ${CONFIG.COLORS.red}">${stratDD.toFixed(1)}%</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Buy & Hold Max DD</div>
                <div class="stat-value" style="color: ${CONFIG.COLORS.red}">${bhDD.toFixed(1)}%</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Strategy Final Value</div>
                <div class="stat-value">$${stratFinal.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
            </div>
            <div class="stat-card">
                <div class="stat-label">Buy & Hold Final Value</div>
                <div class="stat-value">$${bhFinal.toLocaleString(undefined, { maximumFractionDigits: 0 })}</div>
            </div>
        `;
    },

    maxDrawdown(values) {
        let peak = values[0];
        let maxDD = 0;
        for (const v of values) {
            if (v > peak) peak = v;
            const dd = ((peak - v) / peak) * 100;
            if (dd > maxDD) maxDD = dd;
        }
        return maxDD;
    },
};
