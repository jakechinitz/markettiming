// Data fetching, processing, and nowcasting module
// Sources: Yahoo Finance (market data), FRED (economic data)
const DataStore = {
    raw: {},
    processed: {},
    apiKey: null,
    status: {},

    // CORS proxies to try (in order) for Yahoo Finance requests
    CORS_PROXIES: [
        url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
        url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
        url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    ],

    setApiKey(key) {
        this.apiKey = key.trim();
    },

    // ─── Yahoo Finance fetcher ───────────────────────────────────────
    // Returns [{date, value}, ...] from Yahoo Finance v8 chart API
    async fetchYahoo(symbol, startDate) {
        const period1 = Math.floor(new Date(startDate).getTime() / 1000);
        const period2 = Math.floor(Date.now() / 1000);
        const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
            + `?period1=${period1}&period2=${period2}&interval=1d&includeAdjustedClose=true`;

        let lastError = null;

        // Try each CORS proxy in order
        for (const makeUrl of this.CORS_PROXIES) {
            try {
                const proxiedUrl = makeUrl(yahooUrl);
                const resp = await fetch(proxiedUrl, { signal: AbortSignal.timeout(15000) });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const json = await resp.json();

                const result = json?.chart?.result?.[0];
                if (!result || !result.timestamp) throw new Error('No chart data in response');

                const timestamps = result.timestamp;
                const closes = result.indicators?.quote?.[0]?.close || [];
                const adjCloses = result.indicators?.adjclose?.[0]?.adjclose || closes;

                const data = [];
                for (let i = 0; i < timestamps.length; i++) {
                    const val = adjCloses[i] ?? closes[i];
                    if (val == null || isNaN(val)) continue;
                    const d = new Date(timestamps[i] * 1000);
                    const dateStr = d.toISOString().substring(0, 10);
                    data.push({ date: dateStr, value: val });
                }
                if (data.length === 0) throw new Error('No valid data points');
                return data;
            } catch (err) {
                lastError = err;
                continue; // try next proxy
            }
        }
        throw new Error(`Yahoo Finance failed for ${symbol}: ${lastError?.message || 'all proxies failed'}`);
    },

    // ─── FRED fetcher ────────────────────────────────────────────────
    async fetchFred(seriesId, startDate) {
        if (!this.apiKey) throw new Error('FRED API key is required');
        const params = new URLSearchParams({
            series_id: seriesId,
            api_key: this.apiKey,
            file_type: 'json',
            sort_order: 'asc',
        });
        if (startDate) params.set('observation_start', startDate);
        const url = `${CONFIG.FRED_BASE_URL}?${params}`;
        const resp = await fetch(url);
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`FRED ${resp.status} for ${seriesId}: ${text.substring(0, 120)}`);
        }
        const data = await resp.json();
        if (data.error_message) throw new Error(`FRED: ${data.error_message}`);
        const obs = (data.observations || [])
            .filter(o => o.value !== '.')
            .map(o => ({ date: o.date, value: parseFloat(o.value) }));
        if (obs.length === 0) throw new Error(`No data for ${seriesId}`);
        return obs;
    },

    // ─── Fetch with fallback (try multiple sources) ──────────────────
    async fetchWithFallback(sources) {
        const errors = [];
        for (const src of sources) {
            try {
                const data = await src.fn();
                return { data, source: src.name };
            } catch (err) {
                errors.push(`${src.name}: ${err.message}`);
            }
        }
        throw new Error(errors.join(' | '));
    },

    // ─── Main loader ─────────────────────────────────────────────────
    async loadAllSeries() {
        this.status = {};

        // Define data sources for each series
        // Market data: Yahoo Finance first (longer history, no key needed), FRED fallback
        // Economic data: FRED (best source, no alternative needed)
        const series = {
            sp500: {
                label: 'S&P 500',
                sources: [
                    { name: 'Yahoo Finance', fn: () => this.fetchYahoo('^GSPC', '2000-01-01') },
                    { name: 'FRED', fn: () => this.fetchFred(CONFIG.SERIES.SP500, '2000-01-01') },
                ],
            },
            vix: {
                label: 'VIX',
                sources: [
                    { name: 'Yahoo Finance', fn: () => this.fetchYahoo('^VIX', '2000-01-01') },
                    { name: 'FRED', fn: () => this.fetchFred(CONFIG.SERIES.VIXCLS, '2000-01-01') },
                ],
            },
            unemployment: {
                label: 'Unemployment',
                sources: [
                    { name: 'FRED', fn: () => this.fetchFred(CONFIG.SERIES.UNRATE, '1970-01-01') },
                ],
            },
            cpi: {
                label: 'CPI',
                sources: [
                    { name: 'FRED', fn: () => this.fetchFred(CONFIG.SERIES.CPIAUCSL, '1970-01-01') },
                ],
            },
            equityAlloc: {
                label: 'Equity Allocation',
                sources: [
                    { name: 'FRED', fn: () => this.fetchFred(CONFIG.SERIES.EQUITY_ALLOC, '1950-01-01') },
                ],
            },
            icsa: {
                label: 'Initial Claims',
                sources: [
                    { name: 'FRED', fn: () => this.fetchFred(CONFIG.SERIES.ICSA, '2000-01-01') },
                ],
            },
            yieldCurve: {
                label: 'Yield Curve',
                sources: [
                    { name: 'FRED', fn: () => this.fetchFred(CONFIG.SERIES.T10Y2Y, '1990-01-01') },
                ],
            },
        };

        // Fetch all in parallel, each with its own fallback chain
        const keys = Object.keys(series);
        const results = await Promise.allSettled(
            keys.map(k => this.fetchWithFallback(series[k].sources))
        );

        let loadedCount = 0;
        let failedCount = 0;

        keys.forEach((key, i) => {
            if (results[i].status === 'fulfilled') {
                const { data, source } = results[i].value;
                this.raw[key] = data;
                this.status[key] = {
                    ok: true,
                    label: series[key].label,
                    source,
                    count: data.length,
                };
                loadedCount++;
            } else {
                const errMsg = results[i].reason?.message || 'Unknown error';
                console.warn(`Failed to load ${key}:`, errMsg);
                this.raw[key] = [];
                this.status[key] = {
                    ok: false,
                    label: series[key].label,
                    error: errMsg,
                };
                failedCount++;
            }
        });

        if (loadedCount === 0) {
            throw new Error('All data series failed to load. Check your network and API key.');
        }

        this.processData();
        return { loadedCount, failedCount, total: keys.length };
    },

    // ─── Data processing ─────────────────────────────────────────────

    processData() {
        this.processSP500();
        this.processUnemployment();
        this.processCPI();
        this.processVIX();
        this.processEquityAllocation();
        this.processYieldCurve();
        this.computeCAPE();
    },

    processSP500() {
        const data = this.raw.sp500 || [];
        if (data.length === 0) return;

        const maWindow = CONFIG.STRATEGY.SP500_MA_DAYS;
        const withMA = data.map((d, i) => {
            let ma = null;
            if (i >= maWindow - 1) {
                const slice = data.slice(i - maWindow + 1, i + 1);
                ma = slice.reduce((s, v) => s + v.value, 0) / maWindow;
            }
            return { date: d.date, value: d.value, ma200: ma };
        });

        this.processed.sp500 = withMA;
    },

    processUnemployment() {
        const data = this.raw.unemployment || [];
        if (data.length === 0) return;

        const maPeriod = CONFIG.STRATEGY.UNEMPLOYMENT_MA_MONTHS;
        const withMA = data.map((d, i) => {
            let ma = null;
            if (i >= maPeriod - 1) {
                const slice = data.slice(i - maPeriod + 1, i + 1);
                ma = slice.reduce((s, v) => s + v.value, 0) / maPeriod;
            }
            return { date: d.date, value: d.value, ma12: ma, nowcast: false };
        });

        // Nowcast using Initial Jobless Claims (ICSA)
        const icsa = this.raw.icsa || [];
        if (icsa.length > 0 && withMA.length > 0) {
            const lastUnemp = withMA[withMA.length - 1];
            const lastUnempDate = new Date(lastUnemp.date);
            const recentClaims = icsa.filter(d => new Date(d.date) > lastUnempDate);

            if (recentClaims.length >= 2) {
                const claimsValues = recentClaims.slice(-4).map(d => d.value);
                const recentClaimsMA = claimsValues.reduce((s, v) => s + v, 0) / claimsValues.length;

                const priorClaims = icsa.filter(d => {
                    const dd = new Date(d.date);
                    return dd <= lastUnempDate && dd >= new Date(lastUnempDate.getTime() - 35 * 86400000);
                });
                if (priorClaims.length > 0) {
                    const priorClaimsMA = priorClaims.reduce((s, d) => s + d.value, 0) / priorClaims.length;
                    const claimsChange = recentClaimsMA - priorClaimsMA;
                    const unempDelta = claimsChange / 20000;

                    const nowcastValue = Math.max(0, lastUnemp.value + unempDelta);
                    const nowcastDate = new Date(lastUnempDate);
                    nowcastDate.setMonth(nowcastDate.getMonth() + 1);

                    const recentValues = withMA.slice(-(maPeriod - 1)).map(d => d.value);
                    recentValues.push(nowcastValue);
                    const nowcastMA = recentValues.reduce((s, v) => s + v, 0) / recentValues.length;

                    withMA.push({
                        date: nowcastDate.toISOString().substring(0, 10),
                        value: parseFloat(nowcastValue.toFixed(1)),
                        ma12: parseFloat(nowcastMA.toFixed(2)),
                        nowcast: true,
                    });
                }
            }
        }

        this.processed.unemployment = withMA;
    },

    processCPI() {
        const data = this.raw.cpi || [];
        if (data.length === 0) return;

        const withInflation = data.map((d, i) => {
            let yoy = null;
            if (i >= 12) {
                const prev = data[i - 12].value;
                yoy = ((d.value - prev) / prev) * 100;
            }
            return { date: d.date, value: d.value, inflationRate: yoy, nowcast: false };
        });

        // Nowcast: extrapolate 1-2 months using 3-month MoM trend
        if (data.length >= 4) {
            const last3MoM = [];
            for (let i = data.length - 3; i < data.length; i++) {
                last3MoM.push((data[i].value - data[i - 1].value) / data[i - 1].value);
            }
            const avgMoM = last3MoM.reduce((s, v) => s + v, 0) / last3MoM.length;
            const lastCPI = data[data.length - 1];
            const lastDate = new Date(lastCPI.date);

            for (let m = 1; m <= 2; m++) {
                const projDate = new Date(lastDate);
                projDate.setMonth(projDate.getMonth() + m);
                const projCPI = lastCPI.value * Math.pow(1 + avgMoM, m);
                const refIndex = data.length - (12 - m) - 1;
                let yoy = null;
                if (refIndex >= 0) {
                    yoy = ((projCPI - data[refIndex].value) / data[refIndex].value) * 100;
                }
                withInflation.push({
                    date: projDate.toISOString().substring(0, 10),
                    value: parseFloat(projCPI.toFixed(1)),
                    inflationRate: yoy !== null ? parseFloat(yoy.toFixed(2)) : null,
                    nowcast: true,
                });
            }
        }

        this.processed.cpi = withInflation;
    },

    processVIX() {
        const data = this.raw.vix || [];
        if (data.length === 0) return;
        this.processed.vix = data.map(d => ({ ...d, nowcast: false }));
    },

    processEquityAllocation() {
        const data = this.raw.equityAlloc || [];
        if (data.length === 0) return;

        const processed = data.map(d => ({ ...d, nowcast: false }));

        // Nowcast using S&P 500 price change
        const sp = this.raw.sp500 || [];
        if (sp.length > 0 && processed.length > 0) {
            const lastAlloc = processed[processed.length - 1];
            const lastAllocDate = new Date(lastAlloc.date);

            const spMonthly = this.getMonthlyValues(sp);
            const spLookup = {};
            spMonthly.forEach(d => { spLookup[d.date.substring(0, 7)] = d.value; });

            const allocMonthKey = lastAlloc.date.substring(0, 7);
            const spAtAlloc = spLookup[allocMonthKey];
            const latestSP = sp[sp.length - 1].value;
            const latestSPDate = new Date(sp[sp.length - 1].date);

            if (spAtAlloc && spAtAlloc > 0 && latestSPDate > lastAllocDate) {
                const A = lastAlloc.value / 100;
                const monthsAhead = (latestSPDate.getFullYear() - lastAllocDate.getFullYear()) * 12
                    + (latestSPDate.getMonth() - lastAllocDate.getMonth());

                for (let m = 1; m <= monthsAhead; m++) {
                    const projDate = new Date(lastAllocDate);
                    projDate.setMonth(projDate.getMonth() + m);
                    const projKey = projDate.toISOString().substring(0, 7);
                    const spAtProj = spLookup[projKey] || latestSP;

                    const ratio = spAtProj / spAtAlloc;
                    const eq = A * ratio;
                    const alloc = (eq / (eq + (1 - A))) * 100;

                    processed.push({
                        date: projDate.toISOString().substring(0, 10),
                        value: parseFloat(alloc.toFixed(1)),
                        nowcast: true,
                    });
                }
            }
        }

        this.processed.equityAlloc = processed;
    },

    processYieldCurve() {
        const data = this.raw.yieldCurve || [];
        if (data.length === 0) return;

        const maWindow = 20;
        const withMA = data.map((d, i) => {
            let ma = null;
            if (i >= maWindow - 1) {
                const slice = data.slice(i - maWindow + 1, i + 1);
                ma = slice.reduce((s, v) => s + v.value, 0) / maWindow;
            }
            return { date: d.date, value: d.value, ma20: ma, nowcast: false };
        });

        this.processed.yieldCurve = withMA;
    },

    computeCAPE() {
        const cpiData = this.raw.cpi || [];
        const sp500Data = this.raw.sp500 || [];
        if (sp500Data.length === 0 || cpiData.length === 0) {
            this.processed.cape = [];
            return;
        }

        const monthlySP = this.getMonthlyValues(sp500Data);
        const monthlyCPI = this.getMonthlyValues(cpiData);

        const cpiLookup = {};
        monthlyCPI.forEach(d => { cpiLookup[d.date.substring(0, 7)] = d.value; });

        const latestCPI = monthlyCPI.length > 0 ? monthlyCPI[monthlyCPI.length - 1].value : 1;

        const realSP = monthlySP.map(d => {
            const cpiVal = cpiLookup[d.date.substring(0, 7)] || latestCPI;
            return { date: d.date, nominal: d.value, real: d.value * (latestCPI / cpiVal) };
        });

        const cape = [];
        for (let i = 0; i < realSP.length; i++) {
            const earnings10y = [];
            for (let j = Math.max(0, i - 119); j <= i; j++) {
                earnings10y.push(realSP[j].real * 0.055);
            }
            const avgEarnings = earnings10y.reduce((s, e) => s + e, 0) / earnings10y.length;
            const capeVal = avgEarnings > 0 ? realSP[i].real / avgEarnings : null;
            if (capeVal !== null && i >= 119) {
                cape.push({ date: realSP[i].date, value: capeVal, nowcast: false });
            }
        }

        this.processed.cape = cape;
    },

    // ─── Helpers ──────────────────────────────────────────────────────

    getMonthlyValues(data) {
        const monthly = {};
        data.forEach(d => {
            const key = d.date.substring(0, 7);
            monthly[key] = d;
        });
        return Object.values(monthly).sort((a, b) => a.date.localeCompare(b.date));
    },

    getLatest(seriesName) {
        const data = this.processed[seriesName];
        if (!data || data.length === 0) return null;
        return data[data.length - 1];
    },

    getLatestConfirmed(seriesName) {
        const data = this.processed[seriesName];
        if (!data || data.length === 0) return null;
        for (let i = data.length - 1; i >= 0; i--) {
            if (!data[i].nowcast) return data[i];
        }
        return data[0];
    },

    getLaggedValue(seriesName, dateStr, lagMonths) {
        const data = this.processed[seriesName];
        if (!data || data.length === 0) return null;

        const targetDate = new Date(dateStr);
        targetDate.setMonth(targetDate.getMonth() - lagMonths);
        const targetStr = targetDate.toISOString().substring(0, 10);

        let result = null;
        for (const d of data) {
            if (d.nowcast) continue;
            if (d.date <= targetStr) {
                result = d;
            } else {
                break;
            }
        }
        return result;
    },
};
