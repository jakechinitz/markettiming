// Data fetching, processing, and nowcasting module
// Sources: Yahoo Finance (S&P 500, VIX), FRED (economic data), Shiller/GitHub CSV (historical earnings/CAPE)
const DataStore = {
    raw: {},
    processed: {},
    status: {},

    // CORS proxies — tried in order when direct fetch fails
    CORS_PROXIES: [
        url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
        url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
        url => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    ],

    // Shiller data (GitHub-hosted CSV, CORS-friendly, updated monthly, data from 1871)
    SHILLER_CSV_URL: 'https://raw.githubusercontent.com/datasets/s-and-p-500/main/data/data.csv',

    // ─── Low-level fetchers ──────────────────────────────────────────

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

    // Try a URL directly, then through each CORS proxy
    async _fetchWithProxies(url, timeoutMs = 15000) {
        const errors = [];
        const urls = [url, ...this.CORS_PROXIES.map(make => make(url))];
        for (const u of urls) {
            try {
                const resp = await this._fetch(u, timeoutMs);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                return resp;
            } catch (err) {
                errors.push(err.message);
            }
        }
        throw new Error(errors.join(' | '));
    },

    // ─── FRED fetcher (JSON API with key → CSV via proxy fallback) ──

    _getFredKeys() {
        const keys = (CONFIG.FRED_API_KEYS || []).filter(k => k && !k.startsWith('__'));
        try {
            const urlKey = new URLSearchParams(window.location.search).get('fred_key');
            if (urlKey && !keys.includes(urlKey)) keys.unshift(urlKey);
        } catch (e) { /* ignore */ }
        return keys;
    },

    _parseFredJson(json, seriesId) {
        if (json.error_message) throw new Error(`FRED: ${json.error_message}`);
        const obs = (json.observations || [])
            .filter(o => o.value !== '.')
            .map(o => ({ date: o.date, value: parseFloat(o.value) }));
        if (obs.length === 0) throw new Error(`No data for ${seriesId}`);
        return obs;
    },

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
        if (out.length === 0) throw new Error(`No valid observations for ${seriesId}`);
        return out;
    },

    async fetchFred(seriesId, startDate) {
        const errors = [];
        const keys = this._getFredKeys();

        // Strategy 1: FRED JSON API with API key (has CORS headers)
        for (const key of keys) {
            try {
                const params = new URLSearchParams({
                    series_id: seriesId, file_type: 'json', sort_order: 'asc', api_key: key,
                });
                if (startDate) params.set('observation_start', startDate);
                const url = `${CONFIG.FRED_BASE_URL}?${params}`;
                console.log(`[FRED] ${seriesId} via API (key ...${key.slice(-4)})`);
                const resp = await this._fetch(url);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                return this._parseFredJson(await resp.json(), seriesId);
            } catch (err) {
                errors.push(`api(${key.slice(-4)}): ${err.message}`);
            }
        }

        // Strategy 2: FRED CSV endpoint via CORS proxy (no key needed)
        const csvParams = new URLSearchParams({ id: seriesId });
        if (startDate) csvParams.set('cosd', startDate);
        const csvUrl = `https://fred.stlouisfed.org/graph/fredgraph.csv?${csvParams}`;
        for (const makeProxy of this.CORS_PROXIES) {
            try {
                const proxied = makeProxy(csvUrl);
                console.log(`[FRED] ${seriesId} via CSV proxy`);
                const resp = await this._fetch(proxied, 20000);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                return this._parseFredCsv(await resp.text(), seriesId);
            } catch (err) {
                errors.push(`csv-proxy: ${err.message}`);
            }
        }

        throw new Error(`FRED failed for ${seriesId}: ${errors.join(' | ')}`);
    },

    // ─── Yahoo Finance fetcher (v8 chart — no crumb needed) ─────────

    async fetchYahoo(symbol) {
        const sym = encodeURIComponent(symbol);
        // Use period1/period2 (not range=max) to guarantee daily granularity.
        // range=max can silently return monthly data for long-history symbols like ^GSPC.
        const period1 = Math.floor((Date.now() - 35 * 365.25 * 86400000) / 1000);
        const period2 = Math.floor(Date.now() / 1000);
        const qs = `?period1=${period1}&period2=${period2}&interval=1d&includeAdjustedClose=true`;
        // Try both Yahoo load-balancers, each direct then proxied
        const baseUrls = [
            `https://query1.finance.yahoo.com/v8/finance/chart/${sym}${qs}`,
            `https://query2.finance.yahoo.com/v8/finance/chart/${sym}${qs}`,
        ];
        const errors = [];
        let json;
        for (const baseUrl of baseUrls) {
            const urls = [baseUrl, ...this.CORS_PROXIES.map(make => make(baseUrl))];
            for (const url of urls) {
                try {
                    console.log(`[Yahoo] ${symbol} via ${url.substring(0, 55)}...`);
                    const resp = await this._fetch(url, 30000);
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    json = await resp.json();
                    break;
                } catch (err) {
                    errors.push(err.message);
                }
            }
            if (json) break;
        }
        if (!json) throw new Error(`Yahoo failed for ${symbol}: ${errors.join(' | ')}`);

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
        console.log(`[Yahoo] ${symbol}: ${data.length} daily points (${data[0].date} → ${data[data.length-1].date})`);
        return data;
    },

    // ─── Shiller data fetcher (GitHub CSV, CORS-friendly) ───────────
    // Returns [{date, sp500, dividend, earnings, cape, cpi}, ...]

    async fetchShillerData() {
        console.log('[Shiller] Fetching GitHub CSV...');
        const resp = await this._fetchWithProxies(this.SHILLER_CSV_URL, 20000);
        const csv = await resp.text();
        const data = this._parseShillerCSV(csv);
        if (data.length < 100) throw new Error(`Only ${data.length} rows`);
        console.log(`[Shiller] ${data.length} months (${data[0].date} → ${data[data.length-1].date})`);
        return data;
    },

    // Parse GitHub CSV (datasets/s-and-p-500 format)
    // Columns: Date,SP500,Dividend,Earnings,Consumer Price Index,Long Interest Rate,Real Price,Real Dividend,Real Earnings,PE10
    _parseShillerCSV(csv) {
        const lines = csv.trim().split('\n');
        const data = [];
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',');
            if (cols.length < 10) continue;
            const dateStr = cols[0];
            const sp500 = parseFloat(cols[1]);
            const dividend = parseFloat(cols[2]);
            const earnings = parseFloat(cols[3]);
            const cpi = parseFloat(cols[4]);
            const pe10 = parseFloat(cols[9]);
            if (!dateStr || (isNaN(sp500) && isNaN(earnings))) continue;
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

    // ─── Main loader ─────────────────────────────────────────────────

    async loadAllSeries() {
        this.status = {};

        // Fetch everything — Yahoo for market data, FRED for economic data, Shiller for historical
        const series = {
            sp500: {
                label: 'S&P 500',
                fn: () => this.fetchYahoo('^GSPC'),
            },
            vix: {
                label: 'VIX',
                fn: () => this.fetchYahoo('^VIX'),
            },
            unemployment: {
                label: 'Unemployment',
                fn: () => this.fetchFred(CONFIG.SERIES.UNRATE),
            },
            cpi: {
                label: 'CPI',
                fn: () => this.fetchFred(CONFIG.SERIES.CPIAUCSL),
            },
            equityAlloc: {
                label: 'Equity Allocation',
                fn: () => this.fetchFred(CONFIG.SERIES.EQUITY_ALLOC),
            },
            icsa: {
                label: 'Initial Claims',
                fn: () => this.fetchFred(CONFIG.SERIES.ICSA),
            },
            yieldCurve: {
                label: 'Yield Curve',
                fn: () => this.fetchFred(CONFIG.SERIES.T10Y2Y, '1990-01-01'),
            },
            shiller: {
                label: 'Shiller Earnings/CAPE',
                fn: () => this.fetchShillerData(),
            },
        };

        const keys = Object.keys(series);
        const results = await Promise.allSettled(
            keys.map(k => series[k].fn())
        );

        let loadedCount = 0;
        let failedCount = 0;

        // Map source names from the fetch functions
        const sourceNames = {
            sp500: 'Yahoo Finance',
            vix: 'Yahoo Finance',
            unemployment: 'FRED',
            cpi: 'FRED',
            equityAlloc: 'FRED',
            icsa: 'FRED',
            yieldCurve: 'FRED',
            shiller: 'Shiller/GitHub',
        };

        keys.forEach((key, i) => {
            if (results[i].status === 'fulfilled') {
                this.raw[key] = results[i].value;
                this.status[key] = {
                    ok: true,
                    label: series[key].label,
                    source: sourceNames[key],
                    count: results[i].value.length,
                };
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

        // Nowcast: use Initial Claims to estimate next unemployment reading
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

        // Nowcast: extrapolate 2 months using recent MoM trend
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

        // Nowcast: project forward using S&P 500 price changes
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
        const earningsModel = this.buildMonthlyEarningsLookup();
        const monthlySP = this.getBlendedMonthlySP();
        if (monthlySP.length === 0) {
            this.processed.cape = [];
            return;
        }
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

            // Nowcast: extend to present using last known earnings + growth rate
            if (lastEntry && lastEntry.earnings > 0) {
                const lastShillerMonth = lastEntry.date.substring(0, 7);
                const monthlySP = this.getBlendedMonthlySP();

                let earningsGrowthRate = 0;
                if (shiller.length >= 13) {
                    const e12ago = shiller[shiller.length - 13].earnings;
                    if (e12ago > 0) {
                        earningsGrowthRate = (lastEntry.earnings / e12ago) - 1;
                    }
                }

                for (const sp of monthlySP) {
                    const spMonth = sp.date.substring(0, 7);
                    if (spMonth > lastShillerMonth) {
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
    computePIE() {
        const shiller = this.raw.shiller || [];
        if (shiller.length === 0) {
            this.processed.pie = [];
            return;
        }

        const cpiByMonth = {};
        shiller.forEach(d => {
            if (d.cpi && d.cpi > 0) cpiByMonth[d.date.substring(0, 7)] = d.cpi;
        });
        (this.raw.cpi || []).forEach(d => {
            if (d.value && d.value > 0) cpiByMonth[d.date.substring(0, 7)] = d.value;
        });

        const earningsModel = this.buildMonthlyEarningsLookup();
        const dividendByMonth = {};
        shiller.forEach(d => {
            if (d.dividend != null && d.dividend >= 0) {
                dividendByMonth[d.date.substring(0, 7)] = d.dividend;
            }
        });

        // Estimate payout ratio from recent Shiller data for months beyond Shiller
        const shillerSorted = [...shiller].filter(d => d.earnings > 0 && d.dividend != null)
            .sort((a, b) => a.date.localeCompare(b.date));
        let lastPayoutRatio = 0.4;
        if (shillerSorted.length >= 12) {
            const recent = shillerSorted.slice(-12);
            const avgE = recent.reduce((s, d) => s + d.earnings, 0) / recent.length;
            const avgD = recent.reduce((s, d) => s + d.dividend, 0) / recent.length;
            if (avgE > 0) lastPayoutRatio = Math.min(1, Math.max(0, avgD / avgE));
        }

        const monthlySP = this.getBlendedMonthlySP();
        const allMonths = Object.keys(earningsModel.lookup).sort();
        if (allMonths.length === 0) {
            this.processed.pie = [];
            return;
        }

        const cpiSorted = Object.entries(cpiByMonth).sort((a, b) => a[0].localeCompare(b[0]));
        const latestCPI = cpiSorted.length > 0 ? cpiSorted[cpiSorted.length - 1][1] : null;
        if (!latestCPI) {
            this.processed.pie = [];
            return;
        }

        // Compute integrated equity: cumulative inflation-adjusted retained earnings
        // Skip the first 50 years (600 months) of accumulation — IE starts near zero
        // and takes decades to build up, producing misleadingly high early P/IE values.
        const integratedEquityByMonth = {};
        let cumulativeIE = 0;
        let monthCount = 0;
        const MIN_ACCUMULATION_MONTHS = 600;

        for (const month of allMonths) {
            const e = earningsModel.lookup[month];
            if (!e || e <= 0) continue;
            const d = dividendByMonth[month] ?? (e * lastPayoutRatio);
            const retained = Math.max(0, e - d) / 12;
            const cpiThen = cpiByMonth[month];
            if (!cpiThen || cpiThen <= 0) continue;
            const realRetained = retained * (latestCPI / cpiThen);
            cumulativeIE += realRetained;
            monthCount++;
            if (cumulativeIE > 0 && monthCount >= MIN_ACCUMULATION_MONTHS) {
                integratedEquityByMonth[month] = cumulativeIE;
            }
        }

        const pie = [];
        const shillerMonths = new Set(shiller.map(d => d.date.substring(0, 7)));
        const confirmedCutoff = [...shillerMonths].sort().slice(-1)[0] || null;

        for (const sp of monthlySP) {
            const monthKey = sp.date.substring(0, 7);
            const ie = integratedEquityByMonth[monthKey];
            if (!ie || ie <= 0 || !sp.value || sp.value <= 0) continue;
            // IE is in latestCPI dollars — adjust price to the same real basis
            const cpi = cpiByMonth[monthKey] || latestCPI;
            const realPrice = sp.value * (latestCPI / cpi);
            pie.push({
                date: sp.date,
                value: parseFloat((realPrice / ie).toFixed(4)),
                nowcast: !confirmedCutoff || monthKey > confirmedCutoff,
            });
        }

        pie.sort((a, b) => a.date.localeCompare(b.date));
        this.processed.pie = pie;
    },

    // ─── Helpers ──────────────────────────────────────────────────────

    // Blended monthly S&P 500: Shiller historical + Yahoo recent (for CAPE/PIE/backtest)
    // Yahoo daily data only covers ~35 years; Shiller provides monthly back to 1871.
    getBlendedMonthlySP() {
        const monthly = {};
        // Layer 1: Shiller historical S&P prices
        (this.raw.shiller || []).forEach(d => {
            if (d.sp500 && d.sp500 > 0) {
                monthly[d.date.substring(0, 7)] = { date: d.date, value: d.sp500 };
            }
        });
        // Layer 2: Yahoo recent (overwrites Shiller for overlapping months — more current)
        (this.raw.sp500 || []).forEach(d => {
            const key = d.date.substring(0, 7);
            monthly[key] = d;
        });
        return Object.values(monthly).sort((a, b) => a.date.localeCompare(b.date));
    },

    // Compute mean and standard deviation for a processed series (non-nowcast values only)
    getSeriesStats(seriesName) {
        const data = this.processed[seriesName];
        if (!data || data.length === 0) return null;
        const confirmed = data.filter(d => !d.nowcast).map(d => d.value);
        if (confirmed.length < 2) return null;
        const mean = confirmed.reduce((s, v) => s + v, 0) / confirmed.length;
        const variance = confirmed.reduce((s, v) => s + (v - mean) ** 2, 0) / confirmed.length;
        const stddev = Math.sqrt(variance);
        return { mean, stddev, count: confirmed.length };
    },

    _median(values) {
        if (!values || values.length === 0) return null;
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    },

    // Build monthly earnings lookup: Shiller historical + growth-rate projection
    buildMonthlyEarningsLookup() {
        const shiller = this.raw.shiller || [];
        const lookup = {};

        // Shiller historical earnings (most authoritative, monthly from 1871)
        shiller.forEach(d => {
            if (d.earnings && d.earnings > 0) lookup[d.date.substring(0, 7)] = d.earnings;
        });

        // Project forward from last known earnings using growth rate
        const monthKeys = Object.keys(lookup).sort();
        if (monthKeys.length > 0) {
            const latestSPDate = (this.raw.sp500 || []).slice(-1)[0]?.date;
            if (latestSPDate) {
                const lastKey = monthKeys[monthKeys.length - 1];
                const lastVal = lookup[lastKey];
                if (lastVal && lastVal > 0) {
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
                }
            }
        }

        return { lookup, hasFreshFeed: false };
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
