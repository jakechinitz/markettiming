// Data fetching, processing, and nowcasting module
// Sources: Yahoo Finance (market data), FRED (economic data), Shiller (earnings/CAPE)
const DataStore = {
    raw: {},
    processed: {},
    status: {},

    // CORS proxies — tried in order for requests that need proxying
    CORS_PROXIES: [
        url => `https://proxy.corsfix.com/?${encodeURIComponent(url)}`,
        url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
        url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
        url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    ],

    // Shiller data sources — tried in order (GitHub-hosted CSV/JSON are CORS-friendly)
    SHILLER_SOURCES: [
        'https://raw.githubusercontent.com/datasets/s-and-p-500/main/data/data.csv',
        'https://raw.githubusercontent.com/jamesplease/stock-market-data/master/data.json',
    ],
    SHILLER_XLS_URL: 'http://www.econ.yale.edu/~shiller/data/ie_data.xls',

    // ─── Low-level fetchers ──────────────────────────────────────────

    // Fetch with a timeout (some browsers don't support AbortSignal.timeout)
    async _fetch(url, timeoutMs = 15000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const resp = await fetch(url, { signal: controller.signal });
            return resp;
        } finally {
            clearTimeout(timer);
        }
    },

    // Parse FRED JSON response into [{date, value}, ...]
    _parseFredResponse(json, seriesId) {
        if (json.error_message) throw new Error(`FRED: ${json.error_message}`);
        const obs = (json.observations || [])
            .filter(o => o.value !== '.')
            .map(o => ({ date: o.date, value: parseFloat(o.value) }));
        if (obs.length === 0) throw new Error(`No data for ${seriesId}`);
        return obs;
    },

    // Build a FRED API URL
    _fredUrl(seriesId, apiKey, startDate) {
        const params = new URLSearchParams({
            series_id: seriesId,
            api_key: apiKey,
            file_type: 'json',
            sort_order: 'asc',
        });
        if (startDate) params.set('observation_start', startDate);
        return `${CONFIG.FRED_BASE_URL}?${params}`;
    },

    // Build a FRED CSV URL (no API key required)
    _fredCsvUrl(seriesId, startDate) {
        const params = new URLSearchParams({ id: seriesId });
        if (startDate) params.set('cosd', startDate);
        return `https://fred.stlouisfed.org/graph/fredgraph.csv?${params}`;
    },

    // Get valid FRED API keys (filter out placeholders, support URL param for local dev)
    _getFredKeys() {
        const keys = (CONFIG.FRED_API_KEYS || []).filter(k => k && !k.startsWith('__'));
        // Support ?fred_key=xxx URL param for local development
        try {
            const urlKey = new URLSearchParams(window.location.search).get('fred_key');
            if (urlKey && !keys.includes(urlKey)) keys.unshift(urlKey);
        } catch (e) { /* ignore */ }
        return keys;
    },

    // Parse FRED CSV response into [{date, value}, ...]
    _parseFredCsv(csv, seriesId) {
        const lines = csv.trim().split('\n');
        if (lines.length < 2) throw new Error(`No CSV data for ${seriesId}`);

        const out = [];
        for (let i = 1; i < lines.length; i++) {
            const [date, valueRaw] = lines[i].split(',');
            if (!date || !valueRaw || valueRaw === '.') continue;
            const value = parseFloat(valueRaw);
            if (isNaN(value)) continue;
            out.push({ date, value });
        }

        if (out.length === 0) throw new Error(`No valid CSV observations for ${seriesId}`);
        return out;
    },

    // ─── FRED fetcher (tries all keys, then proxied) ─────────────────
    async fetchFred(seriesId, startDate) {
        const keys = this._getFredKeys();
        const errors = [];

        // Strategy 1: Direct fetch with each API key
        for (const key of keys) {
            try {
                const url = this._fredUrl(seriesId, key, startDate);
                console.log(`[FRED] Trying direct ${seriesId} with key ...${key.slice(-4)}`);
                const resp = await this._fetch(url);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const json = await resp.json();
                return this._parseFredResponse(json, seriesId);
            } catch (err) {
                errors.push(`direct(${key.slice(-4)}): ${err.message}`);
            }
        }

        // Strategy 2: Route through CORS proxies (in case direct CORS is blocked)
        for (const key of keys) {
            const fredUrl = this._fredUrl(seriesId, key, startDate);
            for (const makeProxy of this.CORS_PROXIES) {
                try {
                    const proxied = makeProxy(fredUrl);
                    console.log(`[FRED] Trying proxied ${seriesId} via ${proxied.substring(0, 40)}...`);
                    const resp = await this._fetch(proxied);
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const json = await resp.json();
                    return this._parseFredResponse(json, seriesId);
                } catch (err) {
                    errors.push(`proxy: ${err.message}`);
                }
            }
        }

        // Strategy 3: FRED CSV endpoint (no API key required)
        const csvUrl = this._fredCsvUrl(seriesId, startDate);

        // 3a) Direct CSV fetch
        try {
            console.log(`[FRED] Trying CSV ${seriesId} direct`);
            const resp = await this._fetch(csvUrl);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const csv = await resp.text();
            return this._parseFredCsv(csv, seriesId);
        } catch (err) {
            errors.push(`csv-direct: ${err.message}`);
        }

        // 3b) Proxied CSV fetch
        for (const makeProxy of this.CORS_PROXIES) {
            try {
                const proxied = makeProxy(csvUrl);
                console.log(`[FRED] Trying CSV ${seriesId} via ${proxied.substring(0, 40)}...`);
                const resp = await this._fetch(proxied);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const csv = await resp.text();
                return this._parseFredCsv(csv, seriesId);
            } catch (err) {
                errors.push(`csv-proxy: ${err.message}`);
            }
        }

        throw new Error(`FRED failed for ${seriesId}: ${errors.slice(0, 3).join(' | ')}`);
    },

    // ─── Yahoo Finance fetcher ───────────────────────────────────────
    async fetchYahoo(symbol, startDate) {
        const period1 = Math.floor(new Date(startDate).getTime() / 1000);
        const period2 = Math.floor(Date.now() / 1000);
        const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
            + `?period1=${period1}&period2=${period2}&interval=1d&includeAdjustedClose=true`;

        let lastError = null;

        for (const makeUrl of this.CORS_PROXIES) {
            try {
                const proxiedUrl = makeUrl(yahooUrl);
                const resp = await this._fetch(proxiedUrl);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const json = await resp.json();

                const result = json?.chart?.result?.[0];
                if (!result || !result.timestamp) throw new Error('No chart data');

                const timestamps = result.timestamp;
                const closes = result.indicators?.quote?.[0]?.close || [];
                const adjCloses = result.indicators?.adjclose?.[0]?.adjclose || closes;

                const data = [];
                for (let i = 0; i < timestamps.length; i++) {
                    const val = adjCloses[i] ?? closes[i];
                    if (val == null || isNaN(val)) continue;
                    const d = new Date(timestamps[i] * 1000);
                    data.push({ date: d.toISOString().substring(0, 10), value: val });
                }
                if (data.length === 0) throw new Error('No valid data points');
                return data;
            } catch (err) {
                lastError = err;
            }
        }
        throw new Error(`Yahoo failed for ${symbol}: ${lastError?.message || 'all proxies failed'}`);
    },

    // ─── Shiller data fetcher (3-tier fallback) ─────────────────────
    // Returns [{date, sp500, earnings, cape, cpi}, ...]
    // Source 1: GitHub CSV (datasets/s-and-p-500) — CORS-friendly, data from 1871
    // Source 2: GitHub JSON (jamesplease/stock-market-data) — CORS-friendly, 1871-2023
    // Source 3: Yale XLS via CORS proxy — original source, binary format (needs SheetJS)
    async fetchShillerData() {
        const errors = [];

        // Source 1: GitHub CSV
        try {
            console.log('[Shiller] Trying GitHub CSV...');
            const resp = await this._fetch(this.SHILLER_SOURCES[0], 20000);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const csv = await resp.text();
            const data = this._parseShillerCSV(csv);
            if (data.length >= 100) {
                console.log(`[Shiller] GitHub CSV: ${data.length} months`);
                return data;
            }
            throw new Error(`Only ${data.length} rows`);
        } catch (err) {
            errors.push(`CSV: ${err.message}`);
            console.warn('[Shiller] GitHub CSV failed:', err.message);
        }

        // Source 2: GitHub JSON
        try {
            console.log('[Shiller] Trying GitHub JSON...');
            const resp = await this._fetch(this.SHILLER_SOURCES[1], 20000);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const json = await resp.json();
            const data = this._parseShillerJSON(json);
            if (data.length >= 100) {
                console.log(`[Shiller] GitHub JSON: ${data.length} months`);
                return data;
            }
            throw new Error(`Only ${data.length} rows`);
        } catch (err) {
            errors.push(`JSON: ${err.message}`);
            console.warn('[Shiller] GitHub JSON failed:', err.message);
        }

        // Source 3: Yale XLS via CORS proxy (needs SheetJS/xlsx library)
        if (typeof XLSX !== 'undefined') {
            for (const makeProxy of this.CORS_PROXIES) {
                try {
                    const url = makeProxy(this.SHILLER_XLS_URL);
                    console.log(`[Shiller] Trying Yale XLS via proxy...`);
                    const resp = await this._fetch(url, 30000);
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const buf = await resp.arrayBuffer();
                    const data = this._parseShillerXLS(buf);
                    if (data.length >= 100) {
                        console.log(`[Shiller] Yale XLS: ${data.length} months`);
                        return data;
                    }
                    throw new Error(`Only ${data.length} rows`);
                } catch (err) {
                    errors.push(`XLS: ${err.message}`);
                    console.warn('[Shiller] XLS proxy failed:', err.message);
                }
            }
        }

        throw new Error(`Shiller data failed: ${errors.slice(0, 3).join(' | ')}`);
    },

    // Parse GitHub CSV (datasets/s-and-p-500 format)
    // Columns: Date,SP500,Dividend,Earnings,Consumer Price Index,Long Interest Rate,Real Price,Real Dividend,Real Earnings,PE10
    _parseShillerCSV(csv) {
        const lines = csv.trim().split('\n');
        const header = lines[0].split(',');
        const data = [];

        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',');
            if (cols.length < 9) continue;

            const dateStr = cols[0]; // YYYY-MM format or YYYY-MM-DD
            const sp500 = parseFloat(cols[1]);
            const earnings = parseFloat(cols[3]);
            const cpi = parseFloat(cols[4]);
            const pe10 = parseFloat(cols[9]);

            if (!dateStr || isNaN(earnings) || earnings <= 0) continue;

            // Normalize date to YYYY-MM-01
            const date = dateStr.length <= 7 ? dateStr + '-01' : dateStr.substring(0, 10);

            data.push({
                date,
                sp500: isNaN(sp500) ? null : sp500,
                earnings,
                cape: isNaN(pe10) ? null : pe10,
                cpi: isNaN(cpi) ? null : cpi,
            });
        }
        return data;
    },

    // Parse GitHub JSON (jamesplease/stock-market-data format)
    // Fields: {date (decimal year), comp, dividend, earnings, cpi, cape, year, month}
    _parseShillerJSON(json) {
        const arr = Array.isArray(json) ? json : (json.data || []);
        const data = [];

        for (const row of arr) {
            const earnings = parseFloat(row.earnings);
            if (isNaN(earnings) || earnings <= 0) continue;

            // Convert decimal date (e.g. 2023.5) or {year, month} to YYYY-MM-01
            let date;
            if (row.year && row.month) {
                date = `${row.year}-${String(row.month).padStart(2, '0')}-01`;
            } else if (row.date) {
                const yr = Math.floor(parseFloat(row.date));
                const mo = Math.round((parseFloat(row.date) - yr) * 12) + 1;
                date = `${yr}-${String(mo).padStart(2, '0')}-01`;
            } else continue;

            data.push({
                date,
                sp500: parseFloat(row.comp) || parseFloat(row.sp500) || null,
                earnings,
                cape: parseFloat(row.cape) || null,
                cpi: parseFloat(row.cpi) || null,
            });
        }
        return data;
    },

    // Parse Yale XLS (Shiller's ie_data.xls) using SheetJS
    _parseShillerXLS(arrayBuffer) {
        const wb = XLSX.read(arrayBuffer, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        const data = [];

        // Find header row (contains "Date" and "P" or "Price")
        let startRow = 0;
        for (let i = 0; i < Math.min(rows.length, 20); i++) {
            const row = rows[i].map(c => String(c).toLowerCase());
            if (row.includes('date') || row.some(c => c.includes('price'))) {
                startRow = i + 1;
                break;
            }
        }

        for (let i = startRow; i < rows.length; i++) {
            const row = rows[i];
            if (!row || row.length < 5) continue;

            const dateVal = parseFloat(row[0]);
            if (isNaN(dateVal) || dateVal < 1800) continue;

            const yr = Math.floor(dateVal);
            const mo = Math.round((dateVal - yr) * 100) || 1;
            const date = `${yr}-${String(mo).padStart(2, '0')}-01`;
            const sp500 = parseFloat(row[1]);
            const earnings = parseFloat(row[3]);
            const cpi = parseFloat(row[4]);
            const pe10 = parseFloat(row[10]);

            if (isNaN(earnings) || earnings <= 0) continue;

            data.push({
                date,
                sp500: isNaN(sp500) ? null : sp500,
                earnings,
                cape: isNaN(pe10) ? null : pe10,
                cpi: isNaN(cpi) ? null : cpi,
            });
        }
        return data;
    },

    // ─── Fetch with fallback chain ───────────────────────────────────
    async fetchWithFallback(sources) {
        const errors = [];
        for (const src of sources) {
            try {
                const data = await src.fn();
                return { data, source: src.name };
            } catch (err) {
                console.warn(`[${src.name}] ${err.message}`);
                errors.push(`${src.name}: ${err.message}`);
            }
        }
        throw new Error(errors.join(' | '));
    },

    // ─── Main loader ─────────────────────────────────────────────────
    async loadAllSeries() {
        this.status = {};

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
            shiller: {
                label: 'Shiller Earnings/CAPE',
                sources: [
                    { name: 'Shiller/Yale', fn: () => this.fetchShillerData() },
                ],
            },
        };

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
                this.status[key] = { ok: true, label: series[key].label, source, count: data.length };
                loadedCount++;
            } else {
                const errMsg = results[i].reason?.message || 'Unknown error';
                console.error(`Failed to load ${key}:`, errMsg);
                this.raw[key] = [];
                this.status[key] = { ok: false, label: series[key].label, error: errMsg };
                failedCount++;
            }
        });

        if (loadedCount === 0) {
            throw new Error('All data series failed to load. Check your network connection.');
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
        this.computeTrailingPE();
        this.computePIE();
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
        const shiller = this.raw.shiller || [];
        const sp500Data = this.raw.sp500 || [];
        const cpiData = this.raw.cpi || [];

        // Strategy 1: Use Shiller's pre-computed CAPE (based on real earnings)
        if (shiller.length > 0) {
            const cape = [];
            const shillerByMonth = {};
            shiller.forEach(d => {
                if (d.cape && d.cape > 0) {
                    shillerByMonth[d.date.substring(0, 7)] = d.cape;
                }
            });

            // Use Shiller data for historical CAPE
            const lastShiller = shiller[shiller.length - 1];
            for (const [monthKey, capeVal] of Object.entries(shillerByMonth)) {
                cape.push({ date: monthKey + '-01', value: capeVal, nowcast: false });
            }

            // Extend to present: adjust last Shiller CAPE by recent price change
            if (lastShiller && lastShiller.cape > 0 && lastShiller.sp500 > 0 && sp500Data.length > 0) {
                const lastShillerMonth = lastShiller.date.substring(0, 7);
                const monthlySP = this.getMonthlyValues(sp500Data);
                for (const sp of monthlySP) {
                    const spMonth = sp.date.substring(0, 7);
                    if (spMonth > lastShillerMonth) {
                        // CAPE scales roughly linearly with price (earnings avg changes slowly)
                        const priceRatio = sp.value / lastShiller.sp500;
                        cape.push({
                            date: sp.date,
                            value: parseFloat((lastShiller.cape * priceRatio).toFixed(2)),
                            nowcast: true,
                        });
                    }
                }
            }

            cape.sort((a, b) => a.date.localeCompare(b.date));
            this.processed.cape = cape;
            return;
        }

        // Strategy 2: Fallback — compute from S&P 500 + CPI with estimated earnings
        // Uses long-run average earnings yield (~5.5%) as proxy — clearly not ideal
        if (sp500Data.length > 0 && cpiData.length > 0) {
            const monthlySP = this.getMonthlyValues(sp500Data);
            const monthlyCPI = this.getMonthlyValues(cpiData);
            const cpiLookup = {};
            monthlyCPI.forEach(d => { cpiLookup[d.date.substring(0, 7)] = d.value; });
            const latestCPI = monthlyCPI[monthlyCPI.length - 1].value;

            const realSP = monthlySP.map(d => {
                const cpiVal = cpiLookup[d.date.substring(0, 7)] || latestCPI;
                return { date: d.date, real: d.value * (latestCPI / cpiVal) };
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
            return;
        }

        this.processed.cape = [];
    },

    computeTrailingPE() {
        const shiller = this.raw.shiller || [];
        const sp500Data = this.raw.sp500 || [];

        // Strategy 1: Compute from Shiller's actual trailing 12-month earnings
        if (shiller.length > 0) {
            const pe = [];
            const lastEntry = shiller[shiller.length - 1];

            for (const d of shiller) {
                if (d.earnings > 0 && d.sp500 > 0) {
                    pe.push({
                        date: d.date.substring(0, 10),
                        value: parseFloat((d.sp500 / d.earnings).toFixed(2)),
                        nowcast: false,
                    });
                }
            }

            // Extend to present: use last known earnings with current price
            if (lastEntry && lastEntry.earnings > 0 && sp500Data.length > 0) {
                const lastShillerMonth = lastEntry.date.substring(0, 7);
                const monthlySP = this.getMonthlyValues(sp500Data);

                // Estimate earnings growth: annualized trend from last 12 months of Shiller data
                let earningsGrowthRate = 0;
                if (shiller.length >= 13) {
                    const e12ago = shiller[shiller.length - 13].earnings;
                    if (e12ago > 0) {
                        earningsGrowthRate = (lastEntry.earnings / e12ago) - 1; // annual rate
                    }
                }

                for (const sp of monthlySP) {
                    const spMonth = sp.date.substring(0, 7);
                    if (spMonth > lastShillerMonth) {
                        // Extrapolate earnings using observed growth rate
                        const monthsDiff = (new Date(sp.date) - new Date(lastEntry.date)) / (30.44 * 86400000);
                        const projEarnings = lastEntry.earnings * Math.pow(1 + earningsGrowthRate, monthsDiff / 12);
                        if (projEarnings > 0) {
                            pe.push({
                                date: sp.date,
                                value: parseFloat((sp.value / projEarnings).toFixed(2)),
                                nowcast: true,
                            });
                        }
                    }
                }
            }

            pe.sort((a, b) => a.date.localeCompare(b.date));
            this.processed.trailingPE = pe;
            return;
        }

        this.processed.trailingPE = [];
    },

    // P/IE (Inflation-adjusted Earnings) — OSAM "Earnings Mirage" methodology
    // Adjusts reported earnings for inflation distortion (FIFO inventory profits + historical-cost depreciation)
    // Adjusted E = Reported E × (1 - k × YoY_inflation), where k ≈ 1.5
    // Reference: O'Shaughnessy Asset Management, "The Earnings Mirage"
    computePIE() {
        const shiller = this.raw.shiller || [];
        const sp500Data = this.raw.sp500 || [];
        if (shiller.length === 0) {
            this.processed.pie = [];
            return;
        }

        const K = 1.5; // inflation sensitivity coefficient (calibrated to NIPA IVA+CCAdj)
        const pie = [];

        // Build CPI lookup from Shiller data for YoY inflation
        const cpiByMonth = {};
        shiller.forEach(d => {
            if (d.cpi && d.cpi > 0) {
                cpiByMonth[d.date.substring(0, 7)] = d.cpi;
            }
        });

        // Also use FRED CPI if available (more recent)
        const fredCPI = this.raw.cpi || [];
        fredCPI.forEach(d => {
            cpiByMonth[d.date.substring(0, 7)] = d.value;
        });

        for (let i = 0; i < shiller.length; i++) {
            const d = shiller[i];
            if (!d.earnings || d.earnings <= 0 || !d.sp500 || d.sp500 <= 0) continue;

            const monthKey = d.date.substring(0, 7);
            const cpiNow = cpiByMonth[monthKey];

            // Find CPI from 12 months ago
            const dt = new Date(d.date);
            dt.setMonth(dt.getMonth() - 12);
            const prevKey = dt.toISOString().substring(0, 7);
            const cpiPrev = cpiByMonth[prevKey];

            if (cpiNow && cpiPrev && cpiPrev > 0) {
                const yoyInflation = (cpiNow - cpiPrev) / cpiPrev; // e.g. 0.03 for 3%
                const adjustedEarnings = d.earnings * (1 - K * yoyInflation);

                if (adjustedEarnings > 0) {
                    pie.push({
                        date: d.date.substring(0, 10),
                        value: parseFloat((d.sp500 / adjustedEarnings).toFixed(2)),
                        nowcast: false,
                    });
                }
            }
        }

        // Extend to present using latest known inflation-adjusted earnings
        if (pie.length > 0 && sp500Data.length > 0) {
            const lastPIE = pie[pie.length - 1];
            const lastShiller = shiller[shiller.length - 1];
            const lastShillerMonth = lastShiller.date.substring(0, 7);

            // Get latest inflation rate from processed CPI
            const processedCPI = this.processed.cpi || [];
            const latestCPIEntry = processedCPI.filter(d => d.inflationRate !== null).pop();
            const latestInflation = latestCPIEntry ? latestCPIEntry.inflationRate / 100 : 0;

            if (lastShiller.earnings > 0) {
                // Estimate earnings growth rate from last 12 months
                let earningsGrowthRate = 0;
                if (shiller.length >= 13) {
                    const e12ago = shiller[shiller.length - 13].earnings;
                    if (e12ago > 0) earningsGrowthRate = (lastShiller.earnings / e12ago) - 1;
                }

                const monthlySP = this.getMonthlyValues(sp500Data);
                for (const sp of monthlySP) {
                    const spMonth = sp.date.substring(0, 7);
                    if (spMonth > lastShillerMonth) {
                        const monthsDiff = (new Date(sp.date) - new Date(lastShiller.date)) / (30.44 * 86400000);
                        const projEarnings = lastShiller.earnings * Math.pow(1 + earningsGrowthRate, monthsDiff / 12);
                        const adjEarnings = projEarnings * (1 - K * latestInflation);

                        if (adjEarnings > 0) {
                            pie.push({
                                date: sp.date,
                                value: parseFloat((sp.value / adjEarnings).toFixed(2)),
                                nowcast: true,
                            });
                        }
                    }
                }
            }
        }

        pie.sort((a, b) => a.date.localeCompare(b.date));
        this.processed.pie = pie;
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
