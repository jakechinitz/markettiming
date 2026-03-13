// Strategy computation and backtesting module
const Strategy = {
    controlsInitialized: false,

    ADVANCED_TOGGLES: [
        {
            id: 'trend_gate_degross',
            label: 'Trend gate de-grossing',
            description: 'Only cut below 80% equity when both composite < +1 and S&P is below its 200-day MA.',
        },
        {
            id: 'vix_crisis_cap',
            label: 'VIX crisis cap',
            description: 'Cap to 40% equity when VIX is above 30 (risk-off shock regime).',
        },
        {
            id: 'realized_vol_cap',
            label: 'Realized volatility cap',
            description: 'Use 3-month annualized realized vol from S&P; cap at 60% when >25%, 40% when >35%.',
        },
        {
            id: 'valuation_double_cap',
            label: 'Valuation double-red cap',
            description: 'Cap to 60% equity when both CAPE and P/IE are in expensive territory simultaneously.',
        },
    ],

    getActiveToggles() {
        const active = {};
        this.ADVANCED_TOGGLES.forEach(t => {
            const el = document.getElementById(t.id);
            active[t.id] = !!(el && el.checked);
        });
        return active;
    },

    initAdvancedControls() {
        if (this.controlsInitialized) return;
        const root = document.getElementById('strategy-advanced-options');
        if (!root) return;

        root.addEventListener('change', () => {
            const signals = this.computeSignals();
            this.renderSignals(signals);
            this.renderStrategyChart();
            this.renderBacktest();
        });

        this.controlsInitialized = true;
    },

    classifyValuation(value, low, high) {
        if (value < low) return 1;
        if (value > high) return -1;
        return 0;
    },

    scoreToAllocation(score) {
        if (score >= 6) return 1.0;
        if (score >= 4) return 0.8;
        if (score >= 1) return 0.6;
        if (score >= -2) return 0.4;
        return 0.2;
    },

    scoreToRegime(score) {
        if (score >= 6) return 'Strong Buy';
        if (score >= 4) return 'Buy';
        if (score >= 1) return 'Neutral';
        if (score >= -2) return 'Reduce';
        return 'Defensive';
    },

    getRealizedVolAtDate(dateStr, monthsLookback = 3) {
        const sp = DataStore.processed.sp500 || [];
        if (sp.length === 0) return null;

        const monthly = DataStore.getMonthlyValues(sp).filter(d => d.date <= dateStr);
        const pointsNeeded = monthsLookback + 1;
        if (monthly.length < pointsNeeded) return null;

        const slice = monthly.slice(-pointsNeeded);
        const rets = [];
        for (let i = 1; i < slice.length; i++) {
            const prev = slice[i - 1].value;
            const curr = slice[i].value;
            if (prev > 0) rets.push((curr - prev) / prev);
        }
        if (rets.length < monthsLookback) return null;

        const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
        const variance = rets.reduce((s, v) => s + ((v - mean) ** 2), 0) / rets.length;
        return Math.sqrt(variance) * Math.sqrt(12) * 100;
    },

    applyAdvancedAllocation(baseAlloc, context, toggles) {
        let alloc = baseAlloc;
        const notes = [];

        if (toggles.trend_gate_degross && alloc < 0.8) {
            const allowDegross = context.score < 1 && context.trend === -1;
            if (!allowDegross) {
                alloc = 0.8;
                notes.push('Trend gate kept allocation at 80% floor');
            }
        }

        if (toggles.vix_crisis_cap && context.vixValue !== null && context.vixValue > CONFIG.STRATEGY.VIX_HIGH) {
            if (alloc > 0.4) {
                alloc = 0.4;
                notes.push(`VIX crisis cap applied (${context.vixValue.toFixed(1)})`);
            }
        }

        if (toggles.realized_vol_cap && context.realizedVol !== null) {
            if (context.realizedVol > 35 && alloc > 0.4) {
                alloc = 0.4;
                notes.push(`Realized vol cap to 40% (${context.realizedVol.toFixed(1)}% ann.)`);
            } else if (context.realizedVol > 25 && alloc > 0.6) {
                alloc = 0.6;
                notes.push(`Realized vol cap to 60% (${context.realizedVol.toFixed(1)}% ann.)`);
            }
        }

        if (
            toggles.valuation_double_cap
            && context.capeSignal === -1
            && context.pieSignal === -1
            && alloc > 0.6
        ) {
            alloc = 0.6;
            notes.push('Valuation double-red cap applied (CAPE + P/IE expensive)');
        }

        return { alloc, notes };
    },

    // Current signals — uses nowcast data for the most up-to-date reading
    computeSignals() {
        const signals = {};

        // 1. Trend: S&P 500 vs 200-day MA (real-time, no lag)
        const sp = DataStore.getLatest('sp500');
        if (sp && sp.ma200 !== null) {
            signals.trend = sp.value > sp.ma200 ? 1 : -1;
            signals.trendDetail = `S&P ${sp.value.toFixed(0)} ${sp.value > sp.ma200 ? '>' : '<'} MA ${sp.ma200.toFixed(0)}`;
        }

        // 2. Unemployment: below or above 12-month MA (uses nowcast if available)
        const unemp = DataStore.getLatest('unemployment');
        if (unemp && unemp.ma12 !== null) {
            signals.unemployment = unemp.value < unemp.ma12 ? 1 : -1;
            signals.unemploymentDetail = `${unemp.value.toFixed(1)}% ${unemp.value < unemp.ma12 ? '<' : '>'} MA ${unemp.ma12.toFixed(1)}%`;
            signals.unemploymentNowcast = !!unemp.nowcast;
        }

        // 3. Volatility regime (real-time, no lag)
        const vix = DataStore.getLatest('vix');
        if (vix) {
            if (vix.value < CONFIG.STRATEGY.VIX_LOW) signals.vix = 1;
            else if (vix.value > CONFIG.STRATEGY.VIX_HIGH) signals.vix = -1;
            else signals.vix = 0;
            signals.vixDetail = `VIX at ${vix.value.toFixed(1)}`;
            signals.vixValue = vix.value;
        }

        // 4. Valuation (CAPE)
        const cape = DataStore.getLatest('cape');
        if (cape) {
            signals.cape = this.classifyValuation(cape.value, CONFIG.STRATEGY.CAPE_LOW, CONFIG.STRATEGY.CAPE_HIGH);
            signals.capeDetail = `CAPE at ${cape.value.toFixed(1)}`;
        }

        // 5. Valuation (P/IE)
        const pie = DataStore.getLatest('pie');
        if (pie) {
            signals.pie = this.classifyValuation(pie.value, CONFIG.STRATEGY.PIE_LOW, CONFIG.STRATEGY.PIE_HIGH);
            signals.pieDetail = `P/IE at ${pie.value.toFixed(2)}`;
        }

        // 6. Investor allocation (uses nowcast)
        const alloc = DataStore.getLatest('equityAlloc');
        if (alloc) {
            if (alloc.value < CONFIG.STRATEGY.ALLOC_LOW) signals.allocation = 1;
            else if (alloc.value > CONFIG.STRATEGY.ALLOC_HIGH) signals.allocation = -1;
            else signals.allocation = 0;
            signals.allocationDetail = `Allocation at ${alloc.value.toFixed(1)}%`;
            signals.allocationNowcast = !!alloc.nowcast;
        }

        // 7. Yield curve: 10Y-2Y spread (real-time, no lag)
        const yc = DataStore.getLatest('yieldCurve');
        if (yc) {
            signals.yieldCurve = yc.value > CONFIG.STRATEGY.YIELD_CURVE_INVERSION ? 1 : -1;
            signals.yieldCurveDetail = `10Y-2Y spread at ${yc.value.toFixed(2)}%`;
        }

        const components = ['trend', 'unemployment', 'vix', 'cape', 'pie', 'allocation', 'yieldCurve'];
        const validSignals = components.filter(c => signals[c] !== undefined);
        signals.composite = validSignals.reduce((sum, c) => sum + signals[c], 0);
        signals.maxPossible = validSignals.length;

        const baseAlloc = this.scoreToAllocation(signals.composite);
        const toggles = this.getActiveToggles();
        const realizedVol = sp ? this.getRealizedVolAtDate(sp.date) : null;
        const context = {
            score: signals.composite,
            trend: signals.trend,
            vixValue: signals.vixValue ?? null,
            realizedVol,
            capeSignal: signals.cape,
            pieSignal: signals.pie,
        };
        const adjusted = this.applyAdvancedAllocation(baseAlloc, context, toggles);

        signals.regime = this.scoreToRegime(signals.composite);
        signals.equityPctBase = Math.round(baseAlloc * 100);
        signals.equityPct = Math.round(adjusted.alloc * 100);
        signals.adjustmentNotes = adjusted.notes;
        signals.realizedVol = realizedVol;

        return signals;
    },

    renderSignals(signals) {
        const container = document.getElementById('current-signals');
        if (!container) return;

        const items = [
            { name: 'Trend (200-Day MA)', value: signals.trend, detail: signals.trendDetail, nowcast: false },
            { name: 'Unemployment Trend', value: signals.unemployment, detail: signals.unemploymentDetail, nowcast: signals.unemploymentNowcast },
            { name: 'Volatility Regime', value: signals.vix, detail: signals.vixDetail, nowcast: false },
            { name: 'Valuation (CAPE)', value: signals.cape, detail: signals.capeDetail, nowcast: false },
            { name: 'Valuation (P/IE)', value: signals.pie, detail: signals.pieDetail, nowcast: false },
            { name: 'Investor Allocation', value: signals.allocation, detail: signals.allocationDetail, nowcast: signals.allocationNowcast },
            { name: 'Yield Curve', value: signals.yieldCurve, detail: signals.yieldCurveDetail, nowcast: false },
        ];

        let html = '';
        items.forEach(item => {
            if (item.value === undefined) return;
            const cls = item.value > 0 ? 'positive' : item.value < 0 ? 'negative' : 'neutral';
            const label = item.value > 0 ? '+1' : item.value < 0 ? '-1' : '0';
            const badge = item.nowcast ? ' <span class="nowcast-badge">NOWCAST</span>' : '';
            html += `
                <div class="signal-row">
                    <span>${item.name}${badge}</span>
                    <span class="signal-value ${cls}" title="${item.detail || ''}">${label}</span>
                </div>`;
        });

        const compositeClass = signals.composite > 0 ? 'positive' : signals.composite < 0 ? 'negative' : 'neutral';
        html += `
            <div class="composite-score">
                <span>Composite: ${signals.regime}</span>
                <span class="signal-value ${compositeClass}">${signals.composite > 0 ? '+' : ''}${signals.composite} / ${signals.maxPossible}</span>
            </div>
            <div class="signal-row">
                <span>Target Equity (base)</span>
                <span class="signal-value neutral">${signals.equityPctBase}%</span>
            </div>
            <div class="signal-row">
                <span>Target Equity (with toggles)</span>
                <span class="signal-value positive">${signals.equityPct}%</span>
            </div>`;

        if (signals.realizedVol !== null) {
            html += `
                <div class="signal-row">
                    <span>3m Realized Vol (ann.)</span>
                    <span class="signal-value neutral">${signals.realizedVol.toFixed(1)}%</span>
                </div>`;
        }

        if (signals.adjustmentNotes && signals.adjustmentNotes.length > 0) {
            html += '<div class="strategy-notes">' + signals.adjustmentNotes.map(n => `<div>• ${n}</div>`).join('') + '</div>';
        }

        container.innerHTML = html;
    },

    // Compute a single signal score at a given date using lagged data
    // This is what an investor would have actually known at `dateStr`
    computeLaggedScore(dateStr) {
        let score = 0;
        let count = 0;

        const context = {
            score: 0,
            trend: undefined,
            vixValue: null,
            realizedVol: this.getRealizedVolAtDate(dateStr),
            capeSignal: undefined,
            pieSignal: undefined,
        };

        // 1. S&P 500 trend (0 month lag — real-time)
        const sp = DataStore.getLaggedValue('sp500', dateStr, CONFIG.PUB_LAG.SP500);
        if (sp && sp.ma200 !== null) {
            const s = sp.value > sp.ma200 ? 1 : -1;
            score += s;
            context.trend = s;
            count++;
        }

        // 2. Unemployment (1 month lag)
        const unemp = DataStore.getLaggedValue('unemployment', dateStr, CONFIG.PUB_LAG.UNEMPLOYMENT);
        if (unemp && unemp.ma12 !== null) {
            score += unemp.value < unemp.ma12 ? 1 : -1;
            count++;
        }

        // 3. VIX (0 month lag — real-time)
        const vix = DataStore.getLaggedValue('vix', dateStr, CONFIG.PUB_LAG.VIX);
        if (vix) {
            if (vix.value < CONFIG.STRATEGY.VIX_LOW) score += 1;
            else if (vix.value > CONFIG.STRATEGY.VIX_HIGH) score -= 1;
            context.vixValue = vix.value;
            count++;
        }

        // 4. CAPE (2 month lag — depends on CPI)
        const cape = DataStore.getLaggedValue('cape', dateStr, CONFIG.PUB_LAG.CAPE);
        if (cape) {
            const s = this.classifyValuation(cape.value, CONFIG.STRATEGY.CAPE_LOW, CONFIG.STRATEGY.CAPE_HIGH);
            score += s;
            context.capeSignal = s;
            count++;
        }

        // 5. P/IE (2 month lag)
        const pieLag = CONFIG.PUB_LAG.PIE ?? CONFIG.PUB_LAG.CAPE;
        const pie = DataStore.getLaggedValue('pie', dateStr, pieLag);
        if (pie) {
            const s = this.classifyValuation(pie.value, CONFIG.STRATEGY.PIE_LOW, CONFIG.STRATEGY.PIE_HIGH);
            score += s;
            context.pieSignal = s;
            count++;
        }

        // 6. Equity allocation (1 month lag — nowcasted)
        const alloc = DataStore.getLaggedValue('equityAlloc', dateStr, CONFIG.PUB_LAG.EQUITY_ALLOC);
        if (alloc) {
            if (alloc.value < CONFIG.STRATEGY.ALLOC_LOW) score += 1;
            else if (alloc.value > CONFIG.STRATEGY.ALLOC_HIGH) score -= 1;
            count++;
        }

        // 7. Yield curve (0 month lag — real-time)
        const yc = DataStore.getLaggedValue('yieldCurve', dateStr, CONFIG.PUB_LAG.YIELD_CURVE);
        if (yc) {
            score += yc.value > CONFIG.STRATEGY.YIELD_CURVE_INVERSION ? 1 : -1;
            count++;
        }

        context.score = score;
        return { score, count, context };
    },

    renderStrategyChart() {
        const sp = DataStore.processed.sp500;
        if (!sp || sp.length === 0) return;

        const monthly = DataStore.getMonthlyValues(sp);
        const timeline = [];

        monthly.forEach(d => {
            const { score, count } = this.computeLaggedScore(d.date);
            if (count > 0) timeline.push({ date: d.date, score, price: d.value });
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
                        label: 'Composite Score (lag-aware)',
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

        const toggles = this.getActiveToggles();
        const monthly = DataStore.getMonthlyValues(sp);

        let strategyValue = 10000;
        let buyHoldValue = 10000;
        const strategyLine = [];
        const buyHoldLine = [];

        for (let i = 1; i < monthly.length; i++) {
            const prevPrice = monthly[i - 1].value;
            const currPrice = monthly[i].value;
            if (prevPrice <= 0) continue;
            const ret = (currPrice - prevPrice) / prevPrice;

            const lagged = this.computeLaggedScore(monthly[i - 1].date);
            const baseAlloc = this.scoreToAllocation(lagged.score);
            const adjusted = this.applyAdvancedAllocation(baseAlloc, lagged.context, toggles);

            strategyValue *= (1 + ret * adjusted.alloc);
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
                        text: 'Lag-Aware Backtest: Strategy vs Buy & Hold (starting $10,000)',
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

        this.renderStats(strategyLine, buyHoldLine);
    },

    renderStats(strategyLine, buyHoldLine) {
        const container = document.getElementById('strategy-stats');
        if (!container) return;

        const activeToggleLabels = this.ADVANCED_TOGGLES
            .filter(t => this.getActiveToggles()[t.id])
            .map(t => t.label);

        const stratFinal = strategyLine[strategyLine.length - 1].value;
        const bhFinal = buyHoldLine[buyHoldLine.length - 1].value;

        const startDate = new Date(strategyLine[0].date);
        const endDate = new Date(strategyLine[strategyLine.length - 1].date);
        const years = Math.max((endDate - startDate) / (365.25 * 24 * 60 * 60 * 1000), 1 / 12);

        const stratCAGR = (Math.pow(stratFinal / 10000, 1 / years) - 1) * 100;
        const bhCAGR = (Math.pow(bhFinal / 10000, 1 / years) - 1) * 100;

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
            <p class="lag-note">Backtest uses publication-lagged data: S&P/VIX/yield curve real-time, unemployment 1mo, CPI 2mo, allocation 1mo, CAPE/P-IE 2mo.</p>
            <p class="lag-note">Advanced toggles: ${activeToggleLabels.length ? activeToggleLabels.join(' | ') : 'None (base model only)'}</p>
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
