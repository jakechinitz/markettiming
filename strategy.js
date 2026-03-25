// Strategy computation and backtesting module
const Strategy = {
    controlsInitialized: false,

    // Put hedge parameters
    PUT_HEDGE: {
        STRIKE_OTM: 0.175,      // 17.5% out of the money (midpoint of 15-20%)
        TENOR_MONTHS: 6,        // 6-month puts
        PREMIUM_PCT: 0.03,      // spend 3% of portfolio on put premium
    },

    ADVANCED_TOGGLES: [
        {
            id: 'put_hedge',
            label: 'Crisis put hedge',
            description: 'In Crisis regime (score ≤ -3 + below 200d MA), buy 6-month puts at ~17.5% OTM using 3% of portfolio. Sell when in-the-money. Cost modeled via Black-Scholes using VIX.',
        },
        {
            id: 'vix_crisis_cap',
            label: 'VIX crisis cap',
            description: 'Cap to 40% equity when VIX z-score ≥ +2σ on 5-year rolling window (risk-off shock regime).',
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

    // ─── Black-Scholes put pricing ─────────────────────────────────────

    // Cumulative normal distribution (Abramowitz & Stegun approximation)
    normalCDF(x) {
        const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
        const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
        const sign = x < 0 ? -1 : 1;
        x = Math.abs(x) / Math.sqrt(2);
        const t = 1.0 / (1.0 + p * x);
        const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
        return 0.5 * (1.0 + sign * y);
    },

    // Black-Scholes put price (assumes r=0 for simplicity)
    // Returns price as fraction of spot (e.g., 0.019 = 1.9% of spot)
    bsPutPrice(spot, strike, T, sigma) {
        if (T <= 0 || sigma <= 0) return Math.max(0, strike - spot) / spot;
        const d1 = (Math.log(spot / strike) + 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T));
        const d2 = d1 - sigma * Math.sqrt(T);
        const putPrice = strike * this.normalCDF(-d2) - spot * this.normalCDF(-d1);
        return putPrice / spot; // as fraction of spot
    },

    // Estimate implied vol for put pricing: use VIX if available, else realized vol, with crisis floor
    getImpliedVol(dateStr) {
        // VIX is the best proxy for implied vol
        const vix = DataStore.getLaggedValue('vix', dateStr, 0);
        if (vix && vix.value > 0) {
            // When buying puts in a crisis, actual skew makes OTM puts ~20-30% more expensive
            // than ATM implied vol (VIX). Apply a skew premium.
            return (vix.value / 100) * 1.25;
        }
        // Fallback: 3-month realized vol with crisis premium
        const rv = this.getRealizedVolAtDate(dateStr);
        if (rv !== null) return (rv / 100) * 1.4; // bigger premium when no VIX
        return 0.30; // conservative default
    },

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

    // Classify using z-score: above +Nσ → bearish, below -Nσ → bullish
    classifyByZScore(value, stats) {
        if (!stats || stats.stddev === 0) return { signal: 0, z: 0 };
        const z = (value - stats.mean) / stats.stddev;
        let signal = 0;
        if (z >= CONFIG.STRATEGY.STDDEV_BEARISH) signal = -1;
        else if (z <= CONFIG.STRATEGY.STDDEV_BULLISH) signal = 1;
        return { signal, z };
    },

    // Core allocation model:
    //   Composite > 0                       → 100% equity (bullish)
    //   Composite ≤ 0, above 200d           →  80% equity (cautious, trend intact)
    //   Composite ≤ 0, below 200d           →  60% equity (defensive, broken trend)
    //   Composite ≤ -3, below 200d          →  40% equity (crisis: deeply bearish + broken trend)
    scoreToAllocation(score, trend) {
        if (score > 0) return 1.0;
        // Score ≤ 0: only go below 80% if price is below 200-day MA
        if (trend === -1) {
            if (score <= -3) return 0.4;
            return 0.6;
        }
        return 0.8;
    },

    scoreToRegime(score, trend) {
        if (score > 0) return 'Bullish';
        if (trend === -1 && score <= -3) return 'Crisis';
        if (trend === -1) return 'Defensive';
        return 'Cautious';
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

        if (toggles.vix_crisis_cap && context.vixZ !== null && context.vixZ >= CONFIG.STRATEGY.VIX_CRISIS_STDDEV) {
            if (alloc > 0.4) {
                alloc = 0.4;
                notes.push(`VIX crisis cap applied (z=${context.vixZ.toFixed(2)}, VIX ${context.vixValue.toFixed(1)})`);
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

        // 3. Volatility regime (real-time, 5-year rolling z-score)
        const vix = DataStore.getLatest('vix');
        if (vix) {
            const vixStats = DataStore.getSeriesStatsAsOf('vix', vix.date, CONFIG.STRATEGY.VIX_ROLLING_MONTHS);
            if (vixStats) {
                const { signal, z } = this.classifyByZScore(vix.value, vixStats);
                signals.vix = signal;
                signals.vixDetail = `VIX ${vix.value.toFixed(1)} (z=${z.toFixed(2)}, μ=${vixStats.mean.toFixed(1)}, σ=${vixStats.stddev.toFixed(1)})`;
                signals.vixZ = z;
            } else {
                signals.vix = 0;
                signals.vixDetail = `VIX at ${vix.value.toFixed(1)} (no stats)`;
            }
            signals.vixValue = vix.value;
        }

        // 4. Valuation (CAPE) — full-history z-score
        const cape = DataStore.getLatest('cape');
        if (cape) {
            const capeStats = DataStore.getSeriesStats('cape');
            if (capeStats) {
                const { signal, z } = this.classifyByZScore(cape.value, capeStats);
                signals.cape = signal;
                signals.capeDetail = `CAPE ${cape.value.toFixed(1)} (z=${z.toFixed(2)}, μ=${capeStats.mean.toFixed(1)}, σ=${capeStats.stddev.toFixed(1)})`;
            } else {
                signals.cape = 0;
                signals.capeDetail = `CAPE at ${cape.value.toFixed(1)} (no stats)`;
            }
        }

        // 5. Valuation (P/IE) — full-history z-score
        const pie = DataStore.getLatest('pie');
        if (pie) {
            const pieStats = DataStore.getSeriesStats('pie');
            if (pieStats) {
                const { signal, z } = this.classifyByZScore(pie.value, pieStats);
                signals.pie = signal;
                signals.pieDetail = `P/IE ${pie.value.toFixed(2)} (z=${z.toFixed(2)}, μ=${pieStats.mean.toFixed(2)}, σ=${pieStats.stddev.toFixed(2)})`;
            } else {
                signals.pie = 0;
                signals.pieDetail = `P/IE at ${pie.value.toFixed(2)} (no stats)`;
            }
        }

        // 6. Investor allocation (uses nowcast, full-history z-score)
        const alloc = DataStore.getLatest('equityAlloc');
        if (alloc) {
            const allocStats = DataStore.getSeriesStats('equityAlloc');
            if (allocStats) {
                const { signal, z } = this.classifyByZScore(alloc.value, allocStats);
                signals.allocation = signal;
                signals.allocationDetail = `Allocation ${alloc.value.toFixed(1)}% (z=${z.toFixed(2)}, μ=${allocStats.mean.toFixed(1)}%, σ=${allocStats.stddev.toFixed(1)}%)`;
            } else {
                signals.allocation = 0;
                signals.allocationDetail = `Allocation at ${alloc.value.toFixed(1)}% (no stats)`;
            }
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

        const trendSignal = signals.trend ?? 0;
        const baseAlloc = this.scoreToAllocation(signals.composite, trendSignal);
        const toggles = this.getActiveToggles();
        const realizedVol = sp ? this.getRealizedVolAtDate(sp.date) : null;
        const context = {
            score: signals.composite,
            trend: trendSignal,
            vixValue: signals.vixValue ?? null,
            vixZ: signals.vixZ ?? null,
            realizedVol,
            capeSignal: signals.cape,
            pieSignal: signals.pie,
        };
        const adjusted = this.applyAdvancedAllocation(baseAlloc, context, toggles);

        signals.regime = this.scoreToRegime(signals.composite, trendSignal);
        signals.equityPctBase = Math.round(baseAlloc * 100);
        signals.equityPct = Math.round(adjusted.alloc * 100);
        signals.adjustmentNotes = adjusted.notes;
        signals.realizedVol = realizedVol;

        // Put hedge recommendation for current signals
        if (toggles.put_hedge && signals.composite <= -3 && trendSignal === -1) {
            const vol = sp ? this.getImpliedVol(sp.date) : 0.35;
            const strike = sp ? sp.value * (1 - this.PUT_HEDGE.STRIKE_OTM) : 0;
            const putCost = this.bsPutPrice(1, 1 - this.PUT_HEDGE.STRIKE_OTM, this.PUT_HEDGE.TENOR_MONTHS / 12, vol);
            signals.adjustmentNotes.push(
                `Crisis put hedge: buy 6mo puts at ~${strike.toFixed(0)} strike (${(this.PUT_HEDGE.STRIKE_OTM * 100).toFixed(1)}% OTM), ` +
                `est. cost ${(putCost * 100).toFixed(1)}% of notional (vol ${(vol * 100).toFixed(0)}%), ` +
                `allocate ${(this.PUT_HEDGE.PREMIUM_PCT * 100).toFixed(0)}% of portfolio`
            );
        }

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
        // Cache stats (computed once per backtest run)
        if (!this._backtestStats) {
            this._backtestStats = {
                alloc: DataStore.getSeriesStats('equityAlloc'),
                cape: DataStore.getSeriesStats('cape'),
                pie: DataStore.getSeriesStats('pie'),
                // Pre-build rolling VIX stats lookup for efficiency
                vixRolling: DataStore.buildRollingStatsLookup('vix', CONFIG.STRATEGY.VIX_ROLLING_MONTHS),
            };
        }
        let score = 0;
        let count = 0;

        const context = {
            score: 0,
            trend: undefined,
            vixValue: null,
            vixZ: null,
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

        // 3. VIX (0 month lag — 5-year rolling z-score)
        const vix = DataStore.getLaggedValue('vix', dateStr, CONFIG.PUB_LAG.VIX);
        if (vix) {
            const vixMonth = vix.date.substring(0, 7);
            const vixStats = this._backtestStats.vixRolling[vixMonth];
            if (vixStats) {
                const { signal, z } = this.classifyByZScore(vix.value, vixStats);
                score += signal;
                context.vixZ = z;
            }
            context.vixValue = vix.value;
            count++;
        }

        // 4. CAPE (2 month lag — full-history z-score)
        const cape = DataStore.getLaggedValue('cape', dateStr, CONFIG.PUB_LAG.CAPE);
        if (cape && this._backtestStats.cape) {
            const { signal } = this.classifyByZScore(cape.value, this._backtestStats.cape);
            score += signal;
            context.capeSignal = signal;
            count++;
        }

        // 5. P/IE (2 month lag — full-history z-score)
        const pieLag = CONFIG.PUB_LAG.PIE ?? CONFIG.PUB_LAG.CAPE;
        const pie = DataStore.getLaggedValue('pie', dateStr, pieLag);
        if (pie && this._backtestStats.pie) {
            const { signal } = this.classifyByZScore(pie.value, this._backtestStats.pie);
            score += signal;
            context.pieSignal = signal;
            count++;
        }

        // 6. Equity allocation (1 month lag — full-history z-score)
        const alloc = DataStore.getLaggedValue('equityAlloc', dateStr, CONFIG.PUB_LAG.EQUITY_ALLOC);
        if (alloc && this._backtestStats.alloc) {
            const { signal } = this.classifyByZScore(alloc.value, this._backtestStats.alloc);
            score += signal;
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
        this._backtestStats = null; // clear cache so stats recompute fresh
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

        // Active put hedge state (for put_hedge toggle)
        let activePut = null; // { entryMonth, strike, entryPrice, numPuts, premiumSpent, expiryMonth }

        for (let i = 1; i < monthly.length; i++) {
            const prevPrice = monthly[i - 1].value;
            const currPrice = monthly[i].value;
            if (prevPrice <= 0) continue;
            const ret = (currPrice - prevPrice) / prevPrice;

            const lagged = this.computeLaggedScore(monthly[i - 1].date);
            const trendSignal = lagged.context.trend ?? 0;
            const baseAlloc = this.scoreToAllocation(lagged.score, trendSignal);
            const adjusted = this.applyAdvancedAllocation(baseAlloc, lagged.context, toggles);

            strategyValue *= (1 + ret * adjusted.alloc);
            buyHoldValue *= (1 + ret);

            // ─── Put hedge logic ─────────────────────────────────────
            if (toggles.put_hedge) {
                const isCrisis = lagged.score <= -3 && trendSignal === -1;

                // Check if active put should be settled
                if (activePut) {
                    const monthsHeld = i - activePut.entryMonth;
                    const intrinsic = Math.max(0, activePut.strike - currPrice) * activePut.numPuts;
                    const isExpired = monthsHeld >= this.PUT_HEDGE.TENOR_MONTHS;
                    // Sell when ITM (puts "print") or at expiry
                    const isITM = currPrice < activePut.strike;

                    if (isITM || isExpired) {
                        if (isITM) {
                            // Reprice with remaining time value using BS
                            const remainingT = Math.max(0, this.PUT_HEDGE.TENOR_MONTHS - monthsHeld) / 12;
                            const vol = this.getImpliedVol(monthly[i].date);
                            const putVal = this.bsPutPrice(currPrice, activePut.strike, remainingT, vol) * currPrice;
                            const totalValue = putVal * activePut.numPuts;
                            strategyValue += totalValue;
                        }
                        // else: expired OTM, worthless — premium already deducted
                        activePut = null;
                    }
                }

                // Buy new puts if in crisis and no active position
                if (isCrisis && !activePut) {
                    const premium = strategyValue * this.PUT_HEDGE.PREMIUM_PCT;
                    const strike = currPrice * (1 - this.PUT_HEDGE.STRIKE_OTM);
                    const vol = this.getImpliedVol(monthly[i].date);
                    const putCostPerUnit = this.bsPutPrice(currPrice, strike, this.PUT_HEDGE.TENOR_MONTHS / 12, vol) * currPrice;

                    if (putCostPerUnit > 0) {
                        const numPuts = premium / putCostPerUnit;
                        strategyValue -= premium; // pay the premium
                        activePut = {
                            entryMonth: i,
                            entryPrice: currPrice,
                            strike,
                            numPuts,
                            premiumSpent: premium,
                            expiryMonth: i + this.PUT_HEDGE.TENOR_MONTHS,
                        };
                    }
                }
            }

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
