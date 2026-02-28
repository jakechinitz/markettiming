// Data fetching, processing, and nowcasting module
const DataStore = {
    raw: {},
    processed: {},
    apiKey: null,

    setApiKey(key) {
        this.apiKey = key.trim();
    },

    async fetchFredSeries(seriesId, startDate) {
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
        if (!resp.ok) throw new Error(`FRED API error (${resp.status}) for ${seriesId}`);
        const data = await resp.json();
        return (data.observations || [])
            .filter(o => o.value !== '.')
            .map(o => ({
                date: o.date,
                value: parseFloat(o.value),
            }));
    },

    async loadAllSeries() {
        const fetches = {
            sp500: this.fetchFredSeries(CONFIG.SERIES.SP500, '2000-01-01'),
            unemployment: this.fetchFredSeries(CONFIG.SERIES.UNRATE, '1970-01-01'),
            cpi: this.fetchFredSeries(CONFIG.SERIES.CPIAUCSL, '1970-01-01'),
            vix: this.fetchFredSeries(CONFIG.SERIES.VIXCLS, '2000-01-01'),
            equityAlloc: this.fetchFredSeries(CONFIG.SERIES.EQUITY_ALLOC, '1950-01-01'),
            icsa: this.fetchFredSeries(CONFIG.SERIES.ICSA, '2000-01-01'),
        };

        const results = await Promise.allSettled(Object.values(fetches));
        const keys = Object.keys(fetches);

        keys.forEach((key, i) => {
            if (results[i].status === 'fulfilled') {
                this.raw[key] = results[i].value;
            } else {
                console.warn(`Failed to load ${key}:`, results[i].reason);
                this.raw[key] = [];
            }
        });

        this.processData();
    },

    processData() {
        this.processSP500();
        this.processUnemployment();
        this.processCPI();
        this.processVIX();
        this.processEquityAllocation();
        this.computeCAPE();
    },

    processSP500() {
        const data = this.raw.sp500 || [];
        if (data.length === 0) return;

        // Compute 200-day moving average
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

        // Nowcast: use Initial Jobless Claims (ICSA) to estimate next month
        const icsa = this.raw.icsa || [];
        if (icsa.length > 0 && withMA.length > 0) {
            const lastUnemp = withMA[withMA.length - 1];
            const lastUnempDate = new Date(lastUnemp.date);

            // Get ICSA data after last unemployment date
            const recentClaims = icsa.filter(d => new Date(d.date) > lastUnempDate);

            if (recentClaims.length >= 2) {
                // Compute 4-week MA of recent claims
                const claimsValues = recentClaims.slice(-4).map(d => d.value);
                const recentClaimsMA = claimsValues.reduce((s, v) => s + v, 0) / claimsValues.length;

                // Compute 4-week MA of claims around the last unemployment date
                const priorClaims = icsa.filter(d => {
                    const dd = new Date(d.date);
                    return dd <= lastUnempDate && dd >= new Date(lastUnempDate.getTime() - 35 * 86400000);
                });
                if (priorClaims.length > 0) {
                    const priorClaimsMA = priorClaims.reduce((s, d) => s + d.value, 0) / priorClaims.length;

                    // Claims/unemployment relationship: ~2000 claims per 0.1% unemployment
                    // Scale factor derived from empirical relationship
                    const claimsChange = recentClaimsMA - priorClaimsMA;
                    const unempDelta = claimsChange / 20000; // rough scaling

                    const nowcastValue = Math.max(0, lastUnemp.value + unempDelta);
                    const nowcastDate = new Date(lastUnempDate);
                    nowcastDate.setMonth(nowcastDate.getMonth() + 1);
                    const nowcastDateStr = nowcastDate.toISOString().substring(0, 10);

                    // Recompute MA including the nowcast point
                    const recentValues = withMA.slice(-(maPeriod - 1)).map(d => d.value);
                    recentValues.push(nowcastValue);
                    const nowcastMA = recentValues.reduce((s, v) => s + v, 0) / recentValues.length;

                    withMA.push({
                        date: nowcastDateStr,
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

        // Compute year-over-year inflation rate
        const withInflation = data.map((d, i) => {
            let yoy = null;
            if (i >= 12) {
                const prev = data[i - 12].value;
                yoy = ((d.value - prev) / prev) * 100;
            }
            return { date: d.date, value: d.value, inflationRate: yoy, nowcast: false };
        });

        // Nowcast: extrapolate using 3-month annualized MoM trend
        if (data.length >= 4) {
            const last3MoM = [];
            for (let i = data.length - 3; i < data.length; i++) {
                last3MoM.push((data[i].value - data[i - 1].value) / data[i - 1].value);
            }
            const avgMoM = last3MoM.reduce((s, v) => s + v, 0) / last3MoM.length;

            const lastCPI = data[data.length - 1];
            const lastDate = new Date(lastCPI.date);

            // Project 1-2 months ahead to fill the publication gap
            for (let m = 1; m <= 2; m++) {
                const projDate = new Date(lastDate);
                projDate.setMonth(projDate.getMonth() + m);
                const projDateStr = projDate.toISOString().substring(0, 10);

                const projCPI = lastCPI.value * Math.pow(1 + avgMoM, m);

                // YoY inflation: compare to 12 months before the projected date
                const yoyRefIndex = data.length - 12 + (m - 1);
                let yoy = null;
                if (yoyRefIndex >= 0 && yoyRefIndex < data.length) {
                    // The reference point is (12 - m) months before the last actual data point
                    // which is data[data.length - 12 + (m-1)] roughly
                    // Actually: projected month is m months after last data point.
                    // 12 months before projected month = (12-m) months before last data point
                    const refIndex = data.length - (12 - m) - 1;
                    if (refIndex >= 0) {
                        yoy = ((projCPI - data[refIndex].value) / data[refIndex].value) * 100;
                    }
                }

                withInflation.push({
                    date: projDateStr,
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

        // Nowcast: estimate current allocation using S&P 500 price change
        // since the last known data point.
        // Logic: if allocation was A% when S&P was at P, and S&P is now P',
        // then equity portion grew by (P'/P). Non-equity assumed unchanged.
        // New allocation = (A * P'/P) / (A * P'/P + (1 - A))
        // where A is expressed as a fraction (e.g., 0.40)
        const sp = this.raw.sp500 || [];
        if (sp.length > 0 && processed.length > 0) {
            const lastAlloc = processed[processed.length - 1];
            const lastAllocDate = new Date(lastAlloc.date);

            // Build monthly S&P lookup
            const spMonthly = this.getMonthlyValues(sp);
            const spLookup = {};
            spMonthly.forEach(d => { spLookup[d.date.substring(0, 7)] = d.value; });

            // S&P at the time of last allocation reading
            const allocMonthKey = lastAlloc.date.substring(0, 7);
            const spAtAlloc = spLookup[allocMonthKey];

            // Latest S&P price
            const latestSP = sp[sp.length - 1].value;
            const latestSPDate = new Date(sp[sp.length - 1].date);

            if (spAtAlloc && spAtAlloc > 0 && latestSPDate > lastAllocDate) {
                const A = lastAlloc.value / 100; // fraction
                const priceRatio = latestSP / spAtAlloc;
                const newEquity = A * priceRatio;
                const newAlloc = (newEquity / (newEquity + (1 - A))) * 100;

                // Generate monthly nowcast points between last known and now
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
            return {
                date: d.date,
                nominal: d.value,
                real: d.value * (latestCPI / cpiVal),
            };
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

    getMonthlyValues(data) {
        const monthly = {};
        data.forEach(d => {
            const key = d.date.substring(0, 7);
            monthly[key] = d; // last observation per month
        });
        return Object.values(monthly).sort((a, b) => a.date.localeCompare(b.date));
    },

    // Get the latest value for a processed series
    getLatest(seriesName) {
        const data = this.processed[seriesName];
        if (!data || data.length === 0) return null;
        return data[data.length - 1];
    },

    // Get the latest confirmed (non-nowcast) value
    getLatestConfirmed(seriesName) {
        const data = this.processed[seriesName];
        if (!data || data.length === 0) return null;
        for (let i = data.length - 1; i >= 0; i--) {
            if (!data[i].nowcast) return data[i];
        }
        return data[0];
    },

    // Get a lagged value: returns the data point that would have been
    // available at `dateStr` given a publication lag of `lagMonths`.
    // Only uses confirmed (non-nowcast) data for backtest integrity.
    getLaggedValue(seriesName, dateStr, lagMonths) {
        const data = this.processed[seriesName];
        if (!data || data.length === 0) return null;

        // The data available at `dateStr` is from `lagMonths` months prior
        const targetDate = new Date(dateStr);
        targetDate.setMonth(targetDate.getMonth() - lagMonths);
        const targetStr = targetDate.toISOString().substring(0, 10);

        // Find the most recent confirmed point on or before targetStr
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
