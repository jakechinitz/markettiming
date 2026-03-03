// Data fetching, processing, and nowcasting module
// Sources: Yahoo Finance (market data), FRED (economic data)
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

    // ─── FRED fetcher (tries all keys, then proxied) ─────────────────
    async fetchFred(seriesId, startDate) {
        const keys = CONFIG.FRED_API_KEYS || [];
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

    // ─── Shiller data fetcher (Yale XLS via CORS proxy) ─────────────
    async fetchShillerData() {
        // Ensure SheetJS is loaded (may still be loading via defer)
        if (typeof XLSX === 'undefined') {
            await new Promise((resolve, reject) => {
                const interval = setInterval(() => {
                    if (typeof XLSX !== 'undefined') { clearInterval(interval); resolve(); }
                }, 200);
                setTimeout(() => { clearInterval(interval); reject(new Error('SheetJS not loaded')); }, 10000);
            });
        }

        const xlsUrl = 'http://www.econ.yale.edu/~shiller/data/ie_data.xls';
        for (const makeProxy of this.CORS_PROXIES) {
            try {
                const proxied = makeProxy(xlsUrl);
                console.log(`[Shiller] Trying ${proxied.substring(0, 50)}...`);
                const resp = await this._fetch(proxied, 30000);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const buf = await resp.arrayBuffer();
                return this._parseShillerXLS(buf);
            } catch (err) {
                console.warn(`[Shiller] Failed: ${err.message}`);
            }
        }
        throw new Error('Failed to fetch Shiller data from all proxies');
    },

    _parseShillerXLS(arrayBuffer) {
        const wb = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
        const sheetName = wb.SheetNames.find(n => n.toLowerCase().includes('data')) || wb.SheetNames[0];
        const sheet = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });

        // Find first data row: column 0 is a decimal like 1871.01
        let dataStartIdx = -1;
        for (let i = 0; i < rows.length; i++) {
            const val = rows[i]?.[0];
            if (typeof val === 'number' && val > 1800 && val < 2200) {
                dataStartIdx = i;
                break;
            }
        }
        if (dataStartIdx === -1) throw new Error('Cannot find data start in Shiller XLS');

        // Identify columns from header rows
        let capeCol = -1, priceCol = 1, earningsCol = 3, cpiCol = 4, dividendCol = 2;
        for (let i = Math.max(0, dataStartIdx - 5); i < dataStartIdx; i++) {
            const row = rows[i];
            if (!row) continue;
            for (let j = 0; j < row.length; j++) {
                const cell = String(row[j] || '').toLowerCase().trim();
                if (cell.includes('cape') || cell === 'p/e10' || cell === 'pe10') capeCol = j;
            }
        }

        const data = [];
        for (let i = dataStartIdx; i < rows.length; i++) {
            const row = rows[i];
            if (!row) continue;
            const rawDate = row[0];
            if (typeof rawDate !== 'number' || rawDate < 1800 || rawDate > 2200) continue;

            const year = Math.floor(rawDate);
            const month = Math.round((rawDate - year) * 100);
            if (month < 1 || month > 12) continue;
            const dateStr = `${year}-${String(month).padStart(2, '0')}-01`;

            const price = parseFloat(row[priceCol]);
            if (isNaN(price) || price <= 0) continue;

            data.push({
                date: dateStr,
                price,
                earnings: row[earningsCol] != null ? parseFloat(row[earningsCol]) || null : null,
                cpi: row[cpiCol] != null ? parseFloat(row[cpiCol]) || null : null,
                dividend: row[dividendCol] != null ? parseFloat(row[dividendCol]) || null : null,
                cape: capeCol >= 0 && row[capeCol] != null ? parseFloat(row[capeCol]) || null : null,
            });
        }

        if (data.length === 0) throw new Error('No valid data parsed from Shiller XLS');
        console.log(`[Shiller] Parsed ${data.length} rows: ${data[0].date} to ${data[data.length - 1].date}`);
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
                label: 'Shiller Data',
                sources: [
                    { name: 'Yale/Shiller', fn: () => this.fetchShillerData() },
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

        // Primary: use actual Shiller CAPE (PE10) from Yale dataset
        if (shiller.length > 0) {
            const cape = shiller
                .filter(d => d.cape && !isNaN(d.cape) && d.cape > 0)
                .map(d => ({ date: d.date, value: d.cape, nowcast: false }));

            if (cape.length > 0) {
                // Extend with nowcast if Shiller data is stale vs live S&P data
                const sp = this.raw.sp500 || [];
                if (sp.length > 0) {
                    const lastCAPE = cape[cape.length - 1];
                    const lastCAPEDate = new Date(lastCAPE.date);
                    const latestSPDate = new Date(sp[sp.length - 1].date);

                    if (latestSPDate > lastCAPEDate) {
                        const spMonthly = this.getMonthlyValues(sp);
                        const spLookup = {};
                        spMonthly.forEach(d => { spLookup[d.date.substring(0, 7)] = d.value; });
                        const lastKey = lastCAPE.date.substring(0, 7);
                        const spAtLast = spLookup[lastKey];

                        if (spAtLast && spAtLast > 0) {
                            const monthsAhead = (latestSPDate.getFullYear() - lastCAPEDate.getFullYear()) * 12
                                + (latestSPDate.getMonth() - lastCAPEDate.getMonth());
                            for (let m = 1; m <= monthsAhead; m++) {
                                const d = new Date(lastCAPEDate);
                                d.setMonth(d.getMonth() + m);
                                const mKey = d.toISOString().substring(0, 7);
                                const spNow = spLookup[mKey] || sp[sp.length - 1].value;
                                // CAPE moves ~proportionally with price (10yr avg earnings barely changes month-to-month)
                                const ratio = spNow / spAtLast;
                                cape.push({
                                    date: d.toISOString().substring(0, 10),
                                    value: parseFloat((lastCAPE.value * ratio).toFixed(2)),
                                    nowcast: true,
                                });
                            }
                        }
                    }
                }

                this.processed.cape = cape;
                return;
            }
        }

        // Fallback: approximate CAPE from S&P + CPI (no real earnings data)
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
        const latestCPI = monthlyCPI[monthlyCPI.length - 1].value;
        const realSP = monthlySP.map(d => {
            const cpiVal = cpiLookup[d.date.substring(0, 7)] || latestCPI;
            return { date: d.date, real: d.value * (latestCPI / cpiVal) };
        });
        // Use price-to-10yr-avg-real-price as rough proxy (not true CAPE)
        const cape = [];
        for (let i = 119; i < realSP.length; i++) {
            const avg10y = realSP.slice(i - 119, i + 1).reduce((s, d) => s + d.real, 0) / 120;
            if (avg10y > 0) {
                cape.push({ date: realSP[i].date, value: parseFloat((realSP[i].real / avg10y * 16.8).toFixed(2)), nowcast: false });
            }
        }
        this.processed.cape = cape;
    },

    computeTrailingPE() {
        const shiller = this.raw.shiller || [];
        if (shiller.length === 0) {
            this.processed.trailingPE = [];
            return;
        }

        const pe = shiller
            .filter(d => d.price && d.earnings && d.earnings > 0)
            .map(d => ({
                date: d.date,
                value: parseFloat((d.price / d.earnings).toFixed(2)),
                nowcast: false,
            }));

        // Extend with nowcast using latest S&P price + extrapolated earnings
        const sp = this.raw.sp500 || [];
        if (pe.length > 0 && sp.length > 0) {
            const lastPEDate = new Date(pe[pe.length - 1].date);
            const latestSPDate = new Date(sp[sp.length - 1].date);

            if (latestSPDate > lastPEDate) {
                // Estimate monthly earnings growth from last 12 months of Shiller data
                const withEarnings = shiller.filter(d => d.earnings && d.earnings > 0);
                let monthlyGrowth = 0;
                if (withEarnings.length >= 13) {
                    const e12ago = withEarnings[withEarnings.length - 13].earnings;
                    const eNow = withEarnings[withEarnings.length - 1].earnings;
                    monthlyGrowth = Math.pow(eNow / e12ago, 1 / 12) - 1;
                }
                const lastEarnings = withEarnings[withEarnings.length - 1].earnings;
                const spMonthly = this.getMonthlyValues(sp);
                const spLookup = {};
                spMonthly.forEach(d => { spLookup[d.date.substring(0, 7)] = d.value; });

                const monthsAhead = (latestSPDate.getFullYear() - lastPEDate.getFullYear()) * 12
                    + (latestSPDate.getMonth() - lastPEDate.getMonth());
                for (let m = 1; m <= monthsAhead; m++) {
                    const d = new Date(lastPEDate);
                    d.setMonth(d.getMonth() + m);
                    const mKey = d.toISOString().substring(0, 7);
                    const spNow = spLookup[mKey] || sp[sp.length - 1].value;
                    const projE = lastEarnings * Math.pow(1 + monthlyGrowth, m);
                    if (projE > 0) {
                        pe.push({
                            date: d.toISOString().substring(0, 10),
                            value: parseFloat((spNow / projE).toFixed(2)),
                            nowcast: true,
                        });
                    }
                }
            }
        }

        this.processed.trailingPE = pe;
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
