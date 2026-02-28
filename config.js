// FRED API configuration and series definitions
const CONFIG = {
    FRED_BASE_URL: 'https://api.stlouisfed.org/fred/series/observations',

    // FRED series IDs
    SERIES: {
        SP500: 'SP500',
        UNRATE: 'UNRATE',
        CPIAUCSL: 'CPIAUCSL',
        VIXCLS: 'VIXCLS',
        // Household equity allocation proxy from Z.1 Flow of Funds
        EQUITY_ALLOC: 'BOGZ1FL153064005Q',
        // For CAPE we use Shiller data via FRED (quarterly, multpl source)
        CAPE: 'MULTPL/SHILLER_PE_RATIO_MONTH',
        // Initial Jobless Claims (weekly) — leading indicator for unemployment
        ICSA: 'ICSA',
        // 10-Year minus 2-Year Treasury spread (yield curve)
        T10Y2Y: 'T10Y2Y',
    },

    // Publication lags in months (how long after the reference period
    // before the data is actually available to an investor)
    PUB_LAG: {
        SP500: 0,       // real-time
        VIX: 0,         // real-time
        UNEMPLOYMENT: 1, // released ~1 month after reference month
        CPI: 2,         // released ~2 months after reference month
        EQUITY_ALLOC: 1, // 3-month FRED lag but we nowcast, so treat as ~1 month
        CAPE: 2,        // derived from S&P + CPI, so limited by CPI lag
        YIELD_CURVE: 0, // real-time daily data
    },

    // Chart colors
    COLORS: {
        blue: '#4f8ff7',
        green: '#34d399',
        red: '#f87171',
        yellow: '#fbbf24',
        purple: '#a78bfa',
        orange: '#fb923c',
        cyan: '#22d3ee',
        gray: '#6b7084',
        white: '#e8e9ed',
        nowcast: '#ff79c6',
        gridLine: 'rgba(45, 48, 72, 0.5)',
        gridLineLight: 'rgba(45, 48, 72, 0.3)',
    },

    // Strategy thresholds
    STRATEGY: {
        VIX_LOW: 20,
        VIX_HIGH: 30,
        CAPE_LOW: 20,
        CAPE_HIGH: 30,
        ALLOC_LOW: 35,
        ALLOC_HIGH: 45,
        UNEMPLOYMENT_MA_MONTHS: 12,
        SP500_MA_DAYS: 200,
        YIELD_CURVE_INVERSION: 0, // spread below 0 = inverted = bearish
    },

    // Default chart options
    CHART_DEFAULTS: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
            mode: 'index',
            intersect: false,
        },
        plugins: {
            legend: {
                labels: {
                    color: '#9ca0b0',
                    font: { size: 11 },
                    usePointStyle: true,
                    pointStyleWidth: 10,
                },
            },
            tooltip: {
                backgroundColor: '#1e2130',
                titleColor: '#e8e9ed',
                bodyColor: '#9ca0b0',
                borderColor: '#2d3048',
                borderWidth: 1,
                padding: 10,
                cornerRadius: 6,
                titleFont: { size: 12, weight: '600' },
                bodyFont: { size: 11 },
            },
        },
        scales: {
            x: {
                type: 'time',
                grid: {
                    color: 'rgba(45, 48, 72, 0.3)',
                    drawBorder: false,
                },
                ticks: {
                    color: '#6b7084',
                    font: { size: 10 },
                    maxTicksLimit: 12,
                },
            },
            y: {
                grid: {
                    color: 'rgba(45, 48, 72, 0.3)',
                    drawBorder: false,
                },
                ticks: {
                    color: '#6b7084',
                    font: { size: 10 },
                },
            },
        },
    },
};
