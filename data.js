// Data fetching and processing module
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
            return { date: d.date, value: d.value, ma12: ma };
        });

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
            return { date: d.date, value: d.value, inflationRate: yoy };
        });

        this.processed.cpi = withInflation;
    },

    processVIX() {
        const data = this.raw.vix || [];
        if (data.length === 0) return;
        this.processed.vix = data.map(d => ({ ...d }));
    },

    processEquityAllocation() {
        const data = this.raw.equityAlloc || [];
        if (data.length === 0) return;
        this.processed.equityAlloc = data.map(d => ({ ...d }));
    },

    computeCAPE() {
        // Approximate CAPE from CPI-adjusted S&P 500 and earnings
        // Since we can't get Shiller's exact CAPE from FRED easily,
        // we'll use the equity allocation data timeline and compute
        // a simplified valuation metric. For a production dashboard,
        // you'd source Shiller's data directly.
        const cpiData = this.raw.cpi || [];
        const sp500Data = this.raw.sp500 || [];
        if (sp500Data.length === 0 || cpiData.length === 0) {
            this.processed.cape = [];
            return;
        }

        // Build a simplified CAPE proxy: P/E10 approximation
        // Use monthly S&P 500 closing values and CPI to get real prices
        const monthlySP = this.getMonthlyValues(sp500Data);
        const monthlyCPI = this.getMonthlyValues(cpiData);

        // Build CPI lookup
        const cpiLookup = {};
        monthlyCPI.forEach(d => { cpiLookup[d.date.substring(0, 7)] = d.value; });

        const latestCPI = monthlyCPI.length > 0 ? monthlyCPI[monthlyCPI.length - 1].value : 1;

        // Compute real S&P500
        const realSP = monthlySP.map(d => {
            const cpiVal = cpiLookup[d.date.substring(0, 7)] || latestCPI;
            return {
                date: d.date,
                nominal: d.value,
                real: d.value * (latestCPI / cpiVal),
            };
        });

        // Approximate earnings as ~5% yield on real price (long-run average E/P ~5-7%)
        // Then CAPE = real price / avg of 10 years of estimated real earnings
        const cape = [];
        for (let i = 0; i < realSP.length; i++) {
            const earnings10y = [];
            for (let j = Math.max(0, i - 119); j <= i; j++) {
                earnings10y.push(realSP[j].real * 0.055);
            }
            const avgEarnings = earnings10y.reduce((s, e) => s + e, 0) / earnings10y.length;
            const capeVal = avgEarnings > 0 ? realSP[i].real / avgEarnings : null;
            if (capeVal !== null && i >= 119) {
                cape.push({ date: realSP[i].date, value: capeVal });
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
};
