// Data fetching, processing, and nowcasting module
// Sources: Yahoo Finance (market data), FRED (economic data), Shiller (earnings/CAPE)
const DataStore = {
    raw: {},
    processed: {},
    status: {},

    // CORS proxies — tried in order for requests that need proxying
    // Note: free proxies are inherently unreliable; we try several
    CORS_PROXIES: [
        url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
        url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
        url => `https://proxy.corsfix.com/?${encodeURIComponent(url)}`,
        url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
        url => `https://crossorigin.me/${url}`,
    ],

    // Shiller data source (GitHub-hosted CSV, CORS-friendly, updated monthly)
    SHILLER_CSV_URL: 'https://raw.githubusercontent.com/datasets/s-and-p-500/main/data/data.csv',
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


    // Try multiple free FRED earnings series IDs and return the first usable one
    async fetchSP500Earnings(startDate = '1990-01-01') {
        const candidateIds = ['SP500EPS', 'SP500EARNINGS', 'SP500EARN'];
        const errors = [];

        for (const id of candidateIds) {
            try {
                const data = await this.fetchFred(id, startDate);
                const clean = (data || []).filter(d => d.value != null && d.value > 0);
                if (clean.length >= 8) {
                    console.log(`[FRED] Using earnings series ${id} (${clean.length} pts)`);
                    return clean;
                }
                throw new Error(`only ${clean.length} points`);
            } catch (err) {
                errors.push(`${id}: ${err.message}`);
            }
        }

        throw new Error(`No usable S&P earnings series: ${errors.slice(0, 3).join(' | ')}`);
    },


    // ─── Yahoo Finance S&P 500 earnings (derived from trailing PE) ───
    // Yahoo deprecated v6 in 2023 and v10 now requires crumb+cookie.
    // Strategy: try v7 quote (current, needs crumb so may fail from browser),
    // then fall back to deriving from chart metadata + known PE sources.
    async fetchYahooSPEarnings() {
        const errors = [];

        // Strategy 1: v7 quote endpoint (current Yahoo API, may need crumb)
        const quoteUrls = [
            'https://query1.finance.yahoo.com/v7/finance/quote?symbols=%5EGSPC',
            'https://query2.finance.yahoo.com/v7/finance/quote?symbols=%5EGSPC',
        ];

        for (const baseUrl of quoteUrls) {
            const urlsToTry = [baseUrl, ...this.CORS_PROXIES.map(make => make(baseUrl))];
            for (const url of urlsToTry) {
                try {
                    const resp = await this._fetch(url, 10000);
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const json = await resp.json();

                    const quote = json?.quoteResponse?.result?.[0];
                    const price = quote?.regularMarketPrice;
                    const trailingPE = quote?.trailingPE;

                    if (!price || !trailingPE || trailingPE <= 0) {
                        throw new Error('Missing price or trailingPE');
                    }

                    const eps = parseFloat((price / trailingPE).toFixed(2));
                    if (!isFinite(eps) || eps <= 0) throw new Error(`Invalid EPS: ${eps}`);

                    // Capture dividend rate for P/IE
                    const divRate = quote?.trailingAnnualDividendRate;
                    if (divRate && divRate > 0) {
                        this._yahooDividendRate = divRate;
                        console.log(`[Yahoo] Trailing annual dividend rate: ${divRate}`);
                    }

                    const now = new Date();
                    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
                        .toISOString().substring(0, 10);

                    console.log(`[Yahoo Earnings] v7 EPS=${eps} from price=${price}, PE=${trailingPE}`);
                    return [{ date, value: eps }];
                } catch (err) {
                    errors.push(`v7: ${err.message}`);
                }
            }
        }

        // Strategy 2: Use chart metadata price (captured by fetchYahoo) + Shiller CAPE
        // This works because fetchYahoo runs in parallel and may already have metadata
        try {
            const meta = this._yahooChartMeta?.['^GSPC'] || this._yahooChartMeta?.['%5EGSPC'];
            if (meta?.regularMarketPrice) {
                const price = meta.regularMarketPrice;
                // Use a reasonable trailing PE estimate from last known Shiller data
                // S&P 500 trailing PE typically ranges 15-30
                const shiller = this.raw?.shiller;
                const lastCAPE = shiller?.filter(d => d.cape > 0)?.slice(-1)?.[0]?.cape;
                if (lastCAPE && lastCAPE > 0) {
                    // CAPE is 10yr avg earnings; trailing PE is ~60-80% of CAPE for estimation
                    const estimatedPE = lastCAPE * 0.7;
                    const eps = parseFloat((price / estimatedPE).toFixed(2));
                    if (isFinite(eps) && eps > 0) {
                        const now = new Date();
                        const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
                            .toISOString().substring(0, 10);
                        console.log(`[Yahoo Earnings] Chart meta EPS=${eps} from price=${price}, estPE=${estimatedPE.toFixed(1)}`);
                        return [{ date, value: eps }];
                    }
                }
            }
            throw new Error('No chart metadata available');
        } catch (err) {
            errors.push(`chart-meta: ${err.message}`);
        }

        throw new Error(`Yahoo earnings failed: ${errors.slice(0, 3).join(' | ')}`);
    },

    // ─── Yahoo Finance fetcher (v8 chart — no crumb needed) ─────────
    async fetchYahoo(symbol, startDate) {
        const period1 = Math.floor(new Date(startDate).getTime() / 1000);
        const period2 = Math.floor(Date.now() / 1000);
        // Try both query1 and query2 load-balancers
        const yahooUrls = [
            `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
                + `?period1=${period1}&period2=${period2}&interval=1d&includeAdjustedClose=true`,
            `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
                + `?period1=${period1}&period2=${period2}&interval=1d&includeAdjustedClose=true`,
        ];

        const errors = [];

        for (const yahooUrl of yahooUrls) {
            // Try direct first (works if browser/extension allows, or in non-browser contexts)
            const urlsToTry = [yahooUrl, ...this.CORS_PROXIES.map(make => make(yahooUrl))];
            for (const url of urlsToTry) {
                try {
                    const resp = await this._fetch(url, 12000);
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const json = await resp.json();

                    const result = json?.chart?.result?.[0];
                    if (!result || !result.timestamp) throw new Error('No chart data');

                    // Store chart meta for potential use (has regularMarketPrice)
                    if (result.meta?.regularMarketPrice) {
                        this._yahooChartMeta = this._yahooChartMeta || {};
                        this._yahooChartMeta[symbol] = result.meta;
                    }

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
                    console.log(`[Yahoo] ${symbol}: ${data.length} data points from ${url.substring(0, 60)}`);
                    return data;
                } catch (err) {
                    errors.push(err.message);
                }
            }
        }
        throw new Error(`Yahoo failed for ${symbol}: ${errors.slice(0, 3).join(' | ')}`);
    },


    // ─── Shiller data fetcher (2-tier fallback) ─────────────────────
    // Returns [{date, sp500, dividend, earnings, cape, cpi}, ...]
    // Source 1: GitHub CSV (datasets/s-and-p-500) — CORS-friendly, data from 1871
    // Source 2: Yale XLS via CORS proxy — original source, binary format (needs SheetJS)
    async fetchShillerData() {
        const errors = [];

        // Source 1: GitHub CSV (updated monthly, CORS-friendly)
        try {
            console.log('[Shiller] Trying GitHub CSV...');
            const resp = await this._fetch(this.SHILLER_CSV_URL, 20000);
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

        // Source 2: Yale XLS via CORS proxy (needs SheetJS/xlsx library)
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
            if (cols.length < 10) continue;

            const dateStr = cols[0]; // YYYY-MM format or YYYY-MM-DD
            const sp500 = parseFloat(cols[1]);
            const dividend = parseFloat(cols[2]);
            const earnings = parseFloat(cols[3]);
            const cpi = parseFloat(cols[4]);
            const pe10 = parseFloat(cols[9]);

            if (!dateStr || (isNaN(sp500) && isNaN(earnings))) continue;

            // Normalize date to YYYY-MM-01
            const date = dateStr.length <= 7 ? dateStr + '-01' : dateStr.substring(0, 10);

            data.push({
                date,
                sp500: isNaN(sp500) ? null : sp500,
                dividend: (isNaN(dividend) || dividend <= 0) ? null : dividend,
                earnings: (isNaN(earnings) || earnings <= 0) ? null : earnings,
                cape: (isNaN(pe10) || pe10 <= 0) ? null : pe10,
                cpi: (isNaN(cpi) || cpi <= 0) ? null : cpi,
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
            const moRaw = Math.round((dateVal - yr) * 100) || 1;
            const mo = Math.min(12, Math.max(1, moRaw));
            const date = `${yr}-${String(mo).padStart(2, '0')}-01`;
            const sp500 = parseFloat(row[1]);
            const dividend = parseFloat(row[2]);
            const earnings = parseFloat(row[3]);
            const cpi = parseFloat(row[4]);
            const pe10 = parseFloat(row[10]);

            if (isNaN(earnings) || earnings <= 0) continue;

            data.push({
                date,
                sp500: isNaN(sp500) ? null : sp500,
                dividend: isNaN(dividend) ? null : dividend,
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
            sp500Earnings: {
                label: 'S&P 500 Earnings',
                sources: [
                    // FRED is primary — Yahoo quote endpoints need crumb+cookie from browser
                    { name: 'FRED', fn: () => this.fetchSP500Earnings('1990-01-01') },
                    { name: 'Yahoo Finance', fn: () => this.fetchYahooSPEarnings() },
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
        const steps = [
            ['sp500', () => this.processSP500()],
            ['unemployment', () => this.processUnemployment()],
            ['cpi', () => this.processCPI()],
            ['vix', () => this.processVIX()],
            ['equityAlloc', () => this.processEquityAllocation()],
            ['yieldCurve', () => this.processYieldCurve()],
            ['cape', () => this.computeCAPE()],
            ['trailingPE', () => this.computeTrailingPE()],
            ['pie', () => this.computePIE()],
        ];

        for (const [key, fn] of steps) {
            try {
                fn();
            } catch (err) {
                console.error(`[processData] ${key} failed:`, err);
                if (!this.processed[key]) this.processed[key] = [];
                this.status[key] = {
                    ...(this.status[key] || { label: key }),
                    ok: false,
                    error: `Processing failed: ${err.message}`,
                };
            }
        }
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
                if (prev > 0) yoy = ((d.value - prev) / prev) * 100;
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
                if (refIndex >= 0 && data[refIndex].value > 0) {
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
        const earningsModel = this.buildMonthlyEarningsLookup();
        if (sp500Data.length === 0) {
            this.processed.cape = [];
            return;
        }

        const monthlySP = this.getMonthlyValues(sp500Data);
        const cpiByMonth = {};
        shiller.forEach(d => {
            if (d.cpi && d.cpi > 0) cpiByMonth[d.date.substring(0, 7)] = d.cpi;
        });
        (this.raw.cpi || []).forEach(d => {
            if (d.value && d.value > 0) cpiByMonth[d.date.substring(0, 7)] = d.value;
        });

        const shillerCapeByMonth = {};
        shiller.forEach(d => {
            if (d.cape && d.cape > 0) shillerCapeByMonth[d.date.substring(0, 7)] = d.cape;
        });

        const confirmedShillerMonths = Object.keys(shillerCapeByMonth).sort();
        const lastConfirmedMonth = confirmedShillerMonths.length > 0 ? confirmedShillerMonths[confirmedShillerMonths.length - 1] : null;
        const latestKnownCPI = Object.values(cpiByMonth).filter(v => v > 0).slice(-1)[0] || null;
        const cape = [];

        for (let i = 0; i < monthlySP.length; i++) {
            if (i < 119) continue;

            const monthKey = monthlySP[i].date.substring(0, 7);
            const price = monthlySP[i].value;
            const cpiNow = cpiByMonth[monthKey] || latestKnownCPI;
            if (!price || price <= 0 || !cpiNow || cpiNow <= 0) continue;

            const realEarningsWindow = [];
            for (let j = i - 119; j <= i; j++) {
                const wMonth = monthlySP[j].date.substring(0, 7);
                const eNominal = earningsModel.lookup[wMonth];
                const cpiThen = cpiByMonth[wMonth] || latestKnownCPI;
                if (!eNominal || eNominal <= 0 || !cpiThen || cpiThen <= 0) continue;
                realEarningsWindow.push(eNominal * (cpiNow / cpiThen));
            }

            if (realEarningsWindow.length < 100) continue;

            const avgRealE = realEarningsWindow.reduce((s, v) => s + v, 0) / realEarningsWindow.length;
            if (avgRealE <= 0) continue;

            const computed = price / avgRealE;
            const shillerCape = shillerCapeByMonth[monthKey];
            const isNowcast = !lastConfirmedMonth || monthKey > lastConfirmedMonth;

            cape.push({
                date: monthlySP[i].date,
                value: parseFloat((shillerCape || computed).toFixed(2)),
                nowcast: isNowcast,
            });
        }

        this.processed.cape = cape;
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

    // P/IE (Price to Integrated Equity) — OSAM "Earnings Mirage" methodology
    // Integrated Equity = cumulative sum of inflation-adjusted retained earnings
    // For each month: retained = earnings - dividends, adjusted to current CPI
    // P/IE = Price / Integrated Equity (per share)
    // Reference: Jesse Livermore / O'Shaughnessy Asset Management, "The Earnings Mirage" (2019)
    computePIE() {
        const shiller = this.raw.shiller || [];
        const sp500Data = this.raw.sp500 || [];
        if (shiller.length === 0 || sp500Data.length === 0) {
            this.processed.pie = [];
            return;
        }

        // Build CPI lookup: Shiller historical + FRED for recent months
        const cpiByMonth = {};
        shiller.forEach(d => {
            if (d.cpi && d.cpi > 0) cpiByMonth[d.date.substring(0, 7)] = d.cpi;
        });
        (this.raw.cpi || []).forEach(d => {
            if (d.value && d.value > 0) cpiByMonth[d.date.substring(0, 7)] = d.value;
        });

        // Build monthly earnings and dividends from Shiller data
        // Shiller earnings/dividends are trailing 12-month per-share values
        const earningsModel = this.buildMonthlyEarningsLookup();
        const dividendByMonth = {};
        shiller.forEach(d => {
            if (d.dividend != null && d.dividend >= 0) {
                dividendByMonth[d.date.substring(0, 7)] = d.dividend;
            }
        });

        // For months beyond Shiller, use Yahoo dividend rate if available, else estimate from payout ratio
        const yahooDivRate = this._yahooDividendRate || null; // trailing annual dividend per share
        const shillerSorted = [...shiller].filter(d => d.earnings > 0 && d.dividend != null)
            .sort((a, b) => a.date.localeCompare(b.date));
        let lastPayoutRatio = 0.4; // sensible default
        if (shillerSorted.length >= 12) {
            const recent = shillerSorted.slice(-12);
            const avgE = recent.reduce((s, d) => s + d.earnings, 0) / recent.length;
            const avgD = recent.reduce((s, d) => s + d.dividend, 0) / recent.length;
            if (avgE > 0) lastPayoutRatio = Math.min(1, Math.max(0, avgD / avgE));
        }

        // Get monthly S&P prices for the output timeline
        const monthlySP = this.getMonthlyValues(sp500Data);

        // Sort all months we have earnings for
        const allMonths = Object.keys(earningsModel.lookup).sort();
        if (allMonths.length === 0) {
            this.processed.pie = [];
            return;
        }

        // Get latest CPI for adjusting all retained earnings to current dollars
        const cpiSorted = Object.entries(cpiByMonth).sort((a, b) => a[0].localeCompare(b[0]));
        const latestCPI = cpiSorted.length > 0 ? cpiSorted[cpiSorted.length - 1][1] : null;
        if (!latestCPI) {
            this.processed.pie = [];
            return;
        }

        // Compute integrated equity: cumulative sum of inflation-adjusted monthly retained earnings
        // Earnings/dividends in Shiller are annualized trailing 12-month values,
        // so monthly retained = (earnings - dividends) / 12
        const integratedEquityByMonth = {};
        let cumulativeIE = 0;

        for (const month of allMonths) {
            const e = earningsModel.lookup[month];
            if (!e || e <= 0) continue;

            // Use Shiller dividend if available, else Yahoo annual rate, else payout ratio estimate
            const d = dividendByMonth[month] ?? yahooDivRate ?? (e * lastPayoutRatio);
            const retained = Math.max(0, e - d) / 12; // monthly portion of annual retained earnings
            const cpiThen = cpiByMonth[month];
            if (!cpiThen || cpiThen <= 0) continue;

            // Adjust retained earnings to current dollars
            const realRetained = retained * (latestCPI / cpiThen);
            cumulativeIE += realRetained;

            if (cumulativeIE > 0) {
                integratedEquityByMonth[month] = cumulativeIE;
            }
        }

        // Build P/IE series
        const pie = [];
        const shillerMonths = new Set(shiller.map(d => d.date.substring(0, 7)));
        const confirmedCutoff = [...shillerMonths].sort().slice(-1)[0] || null;

        for (const sp of monthlySP) {
            const monthKey = sp.date.substring(0, 7);
            const ie = integratedEquityByMonth[monthKey];
            if (!ie || ie <= 0 || !sp.value || sp.value <= 0) continue;

            pie.push({
                date: sp.date,
                value: parseFloat((sp.value / ie).toFixed(2)),
                nowcast: !confirmedCutoff || monthKey > confirmedCutoff,
            });
        }

        pie.sort((a, b) => a.date.localeCompare(b.date));
        this.processed.pie = pie;
    },

    // ─── Helpers ──────────────────────────────────────────────────────


    _median(values) {
        if (!values || values.length === 0) return null;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    },

    // Build a monthly earnings lookup that blends Shiller history with fresher data sources.
    // Priority: Shiller (historical) → FRED/Yahoo earnings → growth-rate projection
    // Returns {lookup, hasFreshFeed} where lookup[YYYY-MM] = earnings estimate for that month.
    buildMonthlyEarningsLookup() {
        const shiller = this.raw.shiller || [];
        const fred = this.raw.sp500Earnings || [];
        const lookup = {};
        let hasFreshFeed = false;

        // Layer 1: Shiller historical earnings (most authoritative for past data)
        shiller.forEach(d => {
            if (d.earnings && d.earnings > 0) lookup[d.date.substring(0, 7)] = d.earnings;
        });

        // Layer 2: Blend in FRED/Yahoo direct earnings (fills gaps & extends forward)
        if (fred.length >= 4) {
            const fredByMonth = {};
            fred.forEach(d => {
                if (d.value && d.value > 0) fredByMonth[d.date.substring(0, 7)] = d.value;
            });

            // Compute scale factor to align FRED earnings to Shiller's basis
            const scaleSamples = [];
            Object.keys(fredByMonth).forEach(month => {
                if (lookup[month] && fredByMonth[month] > 0) {
                    scaleSamples.push(lookup[month] / fredByMonth[month]);
                }
            });
            const scale = this._median(scaleSamples) || 1;

            // Extend month-by-month, carrying latest quarterly forward
            const fredSorted = [...fred].sort((a, b) => a.date.localeCompare(b.date));
            const start = new Date(fredSorted[0].date);
            const end = new Date((this.raw.sp500 || []).slice(-1)[0]?.date || Date.now());
            let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
            let j = 0;
            let lastVal = null;

            while (cursor <= end) {
                const monthKey = cursor.toISOString().substring(0, 7);
                while (j < fredSorted.length && fredSorted[j].date.substring(0, 7) <= monthKey) {
                    if (fredSorted[j].value > 0) lastVal = fredSorted[j].value;
                    j++;
                }
                if (lastVal && !lookup[monthKey]) lookup[monthKey] = lastVal * scale;
                cursor.setUTCMonth(cursor.getUTCMonth() + 1);
            }
            hasFreshFeed = true;
        }

        // Layer 3: Project forward from last known earnings (growth-rate extrapolation)
        const projectForward = () => {
            const monthKeys = Object.keys(lookup).sort();
            if (monthKeys.length === 0) return;

            const latestSPDate = (this.raw.sp500 || []).slice(-1)[0]?.date;
            if (!latestSPDate) return;

            const lastKey = monthKeys[monthKeys.length - 1];
            const lastVal = lookup[lastKey];
            if (!lastVal || lastVal <= 0) return;

            const growthSamples = [];
            for (let i = Math.max(12, monthKeys.length - 36); i < monthKeys.length; i++) {
                const cur = lookup[monthKeys[i]];
                const prev = lookup[monthKeys[i - 12]];
                if (cur && prev && prev > 0) growthSamples.push((cur / prev) - 1);
            }
            const annualGrowth = growthSamples.length > 0
                ? growthSamples.reduce((sum, g) => sum + g, 0) / growthSamples.length
                : 0;

            const end = new Date(latestSPDate);
            let cursor = new Date(`${lastKey}-01T00:00:00Z`);
            while (cursor < end) {
                cursor.setUTCMonth(cursor.getUTCMonth() + 1);
                const mk = cursor.toISOString().substring(0, 7);
                if (lookup[mk]) continue;
                const monthsDiff = (cursor.getUTCFullYear() - parseInt(lastKey.substring(0, 4), 10)) * 12
                    + (cursor.getUTCMonth() - (parseInt(lastKey.substring(5, 7), 10) - 1));
                const projected = lastVal * Math.pow(1 + annualGrowth, monthsDiff / 12);
                if (projected > 0) lookup[mk] = projected;
            }
        };

        // Always try to project forward to fill any remaining gaps
        projectForward();

        return { lookup, hasFreshFeed };
    },

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
