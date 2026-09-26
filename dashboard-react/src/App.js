import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
} from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Filler,
} from "chart.js";
import { Line } from "react-chartjs-2";
import "./App.css";

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Filler
);

const WS_URL = "ws://localhost:8765";

const HR_LOW = 60, HR_HIGH = 100, HR_CRITICAL_LOW = 40, HR_CRITICAL_HIGH = 130;
const SPO2_LOW = 95, SPO2_CRITICAL = 90;
const MAX_READINGS = 360;
const DISCONNECT_TIMEOUT = 7000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function classifyHR(bpm) {
  if (bpm == null) return "";
  if (bpm < HR_CRITICAL_LOW || bpm > HR_CRITICAL_HIGH) return "critical";
  if (bpm < HR_LOW || bpm > HR_HIGH) return "warning";
  return "normal";
}

function classifySpo2(spo2) {
  if (spo2 == null) return "";
  if (spo2 < SPO2_CRITICAL) return "critical";
  if (spo2 < SPO2_LOW) return "warning";
  return "normal";
}

function statusLabel(cls) {
  if (cls === "normal")   return "NORMAL";
  if (cls === "warning")  return "CAUTION";
  if (cls === "critical") return "CRITICAL";
  return "—";
}

function formatTime(ts) {
  if (!ts) return "--:--:--";
  return new Date(ts * 1000).toLocaleTimeString("en-GB");
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2,"0")}m ${String(sec).padStart(2,"0")}s`;
  return `${String(m).padStart(2,"0")}m ${String(sec).padStart(2,"0")}s`;
}

function avg(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ─── SVG Icons (no emoji) ─────────────────────────────────────────────────────

function IconHeart({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
    </svg>
  );
}

function IconLung({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 16c0 2 1.5 4 4 4 1 0 2-.5 2-2V6c0-1-.5-2-2-2S8 5 8 6v2"/>
      <path d="M18 16c0 2-1.5 4-4 4-1 0-2-.5-2-2V6c0-1 .5-2 2-2s2 1 2 2v2"/>
      <path d="M6 9c-2 0-4 1.5-4 4s1.5 4 4 4"/>
      <path d="M18 9c2 0 4 1.5 4 4s-1.5 4-4 4"/>
    </svg>
  );
}

function IconSignal({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1.5 8.5A13 13 0 0 1 22.5 8.5"/>
      <path d="M5 12a10 10 0 0 1 14 0"/>
      <path d="M8.5 15.5a6 6 0 0 1 7 0"/>
      <circle cx="12" cy="19" r="1" fill="currentColor"/>
    </svg>
  );
}

function IconActivity({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
    </svg>
  );
}

function IconBell({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    </svg>
  );
}

function IconClock({ className }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <polyline points="12 6 12 12 16 14"/>
    </svg>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function App() {
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const wsRef = useRef(null);
  const disconnectTimerRef = useRef(null);

  const [latestReading, setLatestReading] = useState({ bpm: null, spo2: null, ts: null });
  const [fingerDetected, setFingerDetected] = useState(true);
  const heartbeatBarRef = useRef(null);

  const allReadingsRef = useRef([]);
  const [chartWindow, setChartWindow] = useState("1m");
  const [chartTick, setChartTick] = useState(0);

  const [isMonitoring, setIsMonitoring] = useState(false);
  const [sessionStart, setSessionStart] = useState(null);
  const [sessionDuration, setSessionDuration] = useState(0);
  const sessionReadingsRef = useRef([]);
  const [sessionAbnormal, setSessionAbnormal] = useState(0);
  const [sessionSummary, setSessionSummary] = useState(null);
  const sessionTimerRef = useRef(null);
  const isMonitoringRef = useRef(false);

  const [recentAlerts, setRecentAlerts] = useState([]);
  const [activeAlerts, setActiveAlerts] = useState([]);
  const [signalQuality, setSignalQuality] = useState("unknown");

  // Clock — update every second
  const [clock, setClock] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // ── WebSocket ──────────────────────────────────────────────────────────────

  const connectWebSocket = useCallback(() => {
    setConnectionStatus("connecting");
    const socket = new WebSocket(WS_URL);
    wsRef.current = socket;

    socket.onopen = () => { setConnectionStatus("connected"); };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        resetDisconnectTimer();

        if (msg.history) {
          const valid = msg.history.filter(
            (r) => typeof r.bpm === "number" && typeof r.spo2 === "number"
          );
          allReadingsRef.current = valid.slice(-MAX_READINGS);
          if (valid.length > 0) {
            const last = valid[valid.length - 1];
            processReading(last.bpm, last.spo2, last.ts, true, false);
          }
          setChartTick((t) => t + 1);
        } else if (msg.fingerDetected === false) {
          setFingerDetected(false);
          setSignalQuality("none");
          setActiveAlerts([]);
        } else if (typeof msg.bpm === "number" && typeof msg.spo2 === "number") {
          processReading(msg.bpm, msg.spo2, msg.ts, true, true);
        }
      } catch (e) {
        console.warn("[ws] parse error:", e);
      }
    };

    socket.onerror = () => setConnectionStatus("error");
    socket.onclose = () => {
      setConnectionStatus("reconnecting");
      setTimeout(connectWebSocket, 3000);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const resetDisconnectTimer = () => {
    if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
    disconnectTimerRef.current = setTimeout(() => {
      setSignalQuality("disconnected");
      setConnectionStatus("disconnected");
    }, DISCONNECT_TIMEOUT);
  };

  useEffect(() => {
    connectWebSocket();
    return () => {
      wsRef.current?.close();
      if (disconnectTimerRef.current) clearTimeout(disconnectTimerRef.current);
      if (sessionTimerRef.current) clearInterval(sessionTimerRef.current);
    };
  }, [connectWebSocket]);

  // ── Process Reading ────────────────────────────────────────────────────────

  const processReading = useCallback((bpm, spo2, ts, fingerOk, addToSession) => {
    const reading = { bpm, spo2, ts: ts ?? Date.now() / 1000 };
    setLatestReading({ bpm, spo2, ts: reading.ts });
    setFingerDetected(fingerOk);

    if (!fingerOk) {
      setSignalQuality("none");
      setActiveAlerts([]);
      return;
    }

    const hrC   = classifyHR(bpm);
    const spo2C = classifySpo2(spo2);
    setSignalQuality(hrC === "critical" || spo2C === "critical" ? "weak" : "good");

    allReadingsRef.current = [
      ...allReadingsRef.current.slice(-(MAX_READINGS - 1)),
      reading,
    ];
    setChartTick((t) => t + 1);

    // Pulse the HR bar
    if (heartbeatBarRef.current) {
      heartbeatBarRef.current.classList.remove("pulse");
      void heartbeatBarRef.current.offsetWidth;
      heartbeatBarRef.current.classList.add("pulse");
    }

    const banners = [];
    if (hrC === "critical")
      banners.push({ type: "critical", text: `Critical Heart Rate: ${Math.round(bpm)} BPM` });
    else if (hrC === "warning")
      banners.push({ type: "warning",  text: bpm > HR_HIGH ? `High Heart Rate: ${Math.round(bpm)} BPM` : `Low Heart Rate: ${Math.round(bpm)} BPM` });

    if (spo2C === "critical")
      banners.push({ type: "critical", text: `Critical SpO2: ${spo2.toFixed(1)}%` });
    else if (spo2C === "warning")
      banners.push({ type: "warning",  text: `Low SpO2: ${spo2.toFixed(1)}%` });

    setActiveAlerts(banners);

    if (banners.length > 0) {
      const timeStr = formatTime(reading.ts);
      setRecentAlerts((prev) =>
        [...banners.map((b) => ({ time: timeStr, text: b.text, type: b.type })), ...prev].slice(0, 30)
      );
    }

    if (isMonitoringRef.current && addToSession) {
      sessionReadingsRef.current.push(reading);
      if (banners.length > 0) setSessionAbnormal((n) => n + 1);
    }
  }, []);

  // ── Session ────────────────────────────────────────────────────────────────

  const startMonitoring = () => {
    const now = Date.now();
    setIsMonitoring(true);
    isMonitoringRef.current = true;
    setSessionStart(now);
    setSessionDuration(0);
    setSessionSummary(null);
    setSessionAbnormal(0);
    sessionReadingsRef.current = [];
    sessionTimerRef.current = setInterval(() => setSessionDuration(Date.now() - now), 1000);
  };

  const stopMonitoring = () => {
    setIsMonitoring(false);
    isMonitoringRef.current = false;
    if (sessionTimerRef.current) clearInterval(sessionTimerRef.current);

    const readings = sessionReadingsRef.current;
    if (readings.length === 0) { setSessionSummary({ empty: true }); return; }

    const bpms  = readings.map((r) => r.bpm);
    const spo2s = readings.map((r) => r.spo2);
    const abnCount = readings.filter(
      (r) => classifyHR(r.bpm) !== "normal" || classifySpo2(r.spo2) !== "normal"
    ).length;
    const avgHR   = avg(bpms);
    const avgSpo2 = avg(spo2s);

    setSessionSummary({
      duration: Date.now() - sessionStart,
      count: readings.length,
      avgHR, minHR: Math.min(...bpms), maxHR: Math.max(...bpms),
      avgSpo2, minSpo2: Math.min(...spo2s), maxSpo2: Math.max(...spo2s),
      abnormal: abnCount,
      overallStatus: classifyHR(avgHR) === "normal" && classifySpo2(avgSpo2) === "normal"
        ? "Stable" : "Abnormal readings detected",
    });
  };

  // ── Charts ─────────────────────────────────────────────────────────────────

  const windowSeconds = chartWindow === "1m" ? 60 : chartWindow === "5m" ? 300 : 1800;

  const getVisible = () => {
    const cutoff = Date.now() / 1000 - windowSeconds;
    return allReadingsRef.current.filter((r) => r.ts >= cutoff);
  };

  const downsample = (arr, max = 60) => {
    if (arr.length <= max) return arr;
    const step = Math.ceil(arr.length / max);
    return arr.filter((_, i) => i % step === 0);
  };

  const buildChart = (key, color) => {
    const visible = downsample(getVisible());
    return {
      labels: visible.map((r) => formatTime(r.ts)),
      datasets: [{
        data: visible.map((r) => r[key]),
        borderColor: color,
        backgroundColor: color + "18",
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 4,
        fill: true,
        tension: 0.35,
      }],
    };
  };

  const chartOpts = (unit, yMin, yMax) => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 0 },
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: { label: (ctx) => ` ${ctx.parsed.y} ${unit}` } },
    },
    scales: {
      x: {
        ticks: { maxTicksLimit: 5, font: { size: 10, family: "monospace" }, color: "#555e6b" },
        grid:  { color: "#1e2530" },
        border: { color: "#1e2530" },
      },
      y: {
        min: yMin, max: yMax,
        ticks: { font: { size: 10, family: "monospace" }, color: "#555e6b", count: 5 },
        grid:  { color: "#1e2530" },
        border: { color: "#1e2530" },
      },
    },
  });

  // ── Derived state ──────────────────────────────────────────────────────────

  const hrC    = classifyHR(latestReading.bpm);
  const spo2C  = classifySpo2(latestReading.spo2);
  const hasData = fingerDetected && latestReading.bpm != null;

  // Connection indicator
  const connState =
    connectionStatus === "connected" && signalQuality === "good"        ? "good"
    : connectionStatus === "connected" && signalQuality === "weak"      ? "weak"
    : connectionStatus === "reconnecting" || signalQuality === "disconnected" ? "lost"
    : connectionStatus === "connecting"                                  ? "connecting"
    : "weak";

  const connLabel =
    connState === "good"       ? "Connected"
    : connState === "weak"     ? "Weak Signal"
    : connState === "lost"     ? "Connection Lost"
    : "Connecting";

  const connSubLabel =
    signalQuality === "none"   ? "Place finger on sensor"
    : connState === "lost"     ? "Attempting reconnect..."
    : connState === "connecting" ? "Waiting for device..."
    : "ESP32 · ws://localhost:8765";

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="app">

      {/* ── HEADER ──────────────────────────────────────────────────────────── */}
      <header className="app-header">
        <div className="app-header__left">
          <span className="app-header__brand">PATIENT HEALTH MONITOR</span>
          <span className="app-header__sub">ESP32 + MAX30102 · Real-Time Vitals</span>
        </div>
        <div className="app-header__right">
          <div className={`conn-status conn-status--${connState}`}>
            <span className="conn-status__dot" />
            <span className="conn-status__label">{connLabel}</span>
          </div>
          <span className="app-header__clock">
            {clock.toLocaleTimeString("en-GB")}
          </span>
        </div>
      </header>

      {/* ── ALERT BAR ───────────────────────────────────────────────────────── */}
      {!fingerDetected && (
        <div className="alert-bar alert-bar--info">
          <span className="alert-bar__marker" />
          Place finger on the sensor to begin monitoring
        </div>
      )}
      {fingerDetected && activeAlerts.map((a, i) => (
        <div key={i} className={`alert-bar alert-bar--${a.type}`}>
          <span className="alert-bar__marker" />
          <span className="alert-bar__label">MONITORING ALERT</span>
          {a.text}
        </div>
      ))}

      <main className="app-main">

        {/* ── VITAL CHANNELS ──────────────────────────────────────────────── */}
        <div className="channels-grid">

          {/* Heart Rate Channel */}
          <div className={`channel channel--hr channel--${hrC}`}>
            <div className="channel__accent" ref={heartbeatBarRef} />
            <div className="channel__inner">
              <div className="channel__header">
                <IconHeart className="channel__icon" />
                <span className="channel__label">HEART RATE</span>
                <span className={`channel__status channel__status--${hrC}`}>
                  {hasData ? statusLabel(hrC) : "WAITING"}
                </span>
              </div>
              <div className="channel__value-row">
                <span className="channel__value">
                  {hasData ? Math.round(latestReading.bpm) : "--"}
                </span>
                <span className="channel__unit">BPM</span>
              </div>
              <div className="channel__footer">
                <span className="channel__range">Normal  60 – 100 BPM</span>
                <span className="channel__updated">
                  {latestReading.ts ? formatTime(latestReading.ts) : "--:--:--"}
                </span>
              </div>
            </div>
          </div>

          {/* SpO2 Channel */}
          <div className={`channel channel--spo2 channel--${spo2C}`}>
            <div className="channel__accent" />
            <div className="channel__inner">
              <div className="channel__header">
                <IconLung className="channel__icon" />
                <span className="channel__label">SpO2</span>
                <span className={`channel__status channel__status--${spo2C}`}>
                  {hasData ? statusLabel(spo2C) : "WAITING"}
                </span>
              </div>
              <div className="channel__value-row">
                <span className="channel__value">
                  {hasData ? latestReading.spo2.toFixed(1) : "--"}
                </span>
                <span className="channel__unit">%</span>
              </div>
              <div className="channel__footer">
                <span className="channel__range">Normal  95 – 100%</span>
                <span className="channel__updated">
                  {latestReading.ts ? formatTime(latestReading.ts) : "--:--:--"}
                </span>
              </div>
            </div>
          </div>

          {/* Sensor Status Channel */}
          <div className="channel channel--sensor">
            <div className="channel__accent channel__accent--sensor" />
            <div className="channel__inner">
              <div className="channel__header">
                <IconSignal className="channel__icon" />
                <span className="channel__label">SENSOR STATUS</span>
              </div>
              <div className="sensor-state">
                <span className={`sensor-state__dot sensor-state__dot--${connState}`} />
                <div className="sensor-state__text">
                  <span className="sensor-state__label">{connLabel}</span>
                  <span className="sensor-state__sub">{connSubLabel}</span>
                </div>
              </div>
              <div className="sensor-table">
                <div className="sensor-table__row">
                  <span>Device</span><span>ESP32 + MAX30102</span>
                </div>
                <div className="sensor-table__row">
                  <span>Protocol</span><span>WebSocket</span>
                </div>
                <div className="sensor-table__row">
                  <span>Readings buffered</span>
                  <span>{allReadingsRef.current.length}</span>
                </div>
              </div>
            </div>
          </div>

        </div>

        {/* ── TRENDS ──────────────────────────────────────────────────────── */}
        <section className="panel">
          <div className="panel__header">
            <div className="panel__title-row">
              <IconActivity className="panel__title-icon" />
              <span className="panel__title">REAL-TIME TRENDS</span>
            </div>
            <div className="window-tabs">
              {["1m", "5m", "30m"].map((w) => (
                <button
                  key={w}
                  className={`window-tab ${chartWindow === w ? "window-tab--active" : ""}`}
                  onClick={() => setChartWindow(w)}
                >{w}</button>
              ))}
            </div>
          </div>

          <div className="charts-grid">
            <div className="chart-panel">
              <div className="chart-panel__label chart-panel__label--hr">
                Heart Rate <span>BPM</span>
              </div>
              <div className="chart-panel__canvas">
                {allReadingsRef.current.length === 0
                  ? <div className="chart-empty">No data — waiting for sensor readings</div>
                  : <Line
                      key={`hr-${chartTick}-${chartWindow}`}
                      data={buildChart("bpm", "#e05252")}
                      options={chartOpts("BPM", 40, 140)}
                    />
                }
              </div>
            </div>
            <div className="chart-panel">
              <div className="chart-panel__label chart-panel__label--spo2">
                SpO2 <span>%</span>
              </div>
              <div className="chart-panel__canvas">
                {allReadingsRef.current.length === 0
                  ? <div className="chart-empty">No data — waiting for sensor readings</div>
                  : <Line
                      key={`spo2-${chartTick}-${chartWindow}`}
                      data={buildChart("spo2", "#4fc3f7")}
                      options={chartOpts("%", 85, 100)}
                    />
                }
              </div>
            </div>
          </div>
        </section>

        {/* ── BOTTOM ROW ──────────────────────────────────────────────────── */}
        <div className="bottom-row">

          {/* Monitoring Session */}
          <section className="panel panel--session">
            <div className="panel__header">
              <div className="panel__title-row">
                <IconClock className="panel__title-icon" />
                <span className="panel__title">MONITORING SESSION</span>
              </div>
              {isMonitoring
                ? <button className="btn btn--stop" onClick={stopMonitoring}>Stop Session</button>
                : <button className="btn btn--start" onClick={startMonitoring}>Start Session</button>
              }
            </div>

            {isMonitoring && (
              <div className="session-active">
                <div className="session-active__indicator" />
                <div className="session-active__body">
                  <span className="session-active__dur">{formatDuration(sessionDuration)}</span>
                  <span className="session-active__meta">
                    {sessionReadingsRef.current.length} readings &nbsp;·&nbsp; {sessionAbnormal} abnormal
                  </span>
                </div>
              </div>
            )}

            {!isMonitoring && !sessionSummary && (
              <p className="panel__hint">
                Press <strong>Start Session</strong> to begin recording.
                Statistics will be calculated when the session ends.
              </p>
            )}

            {sessionSummary && !sessionSummary.empty && (
              <div className="summary">
                <div className="summary__header">Session Summary</div>
                <table className="summary__table">
                  <tbody>
                    <tr><td>Duration</td><td>{formatDuration(sessionSummary.duration)}</td></tr>
                    <tr><td>Total readings</td><td>{sessionSummary.count}</td></tr>
                    <tr className="summary__divider"><td colSpan="2" /></tr>
                    <tr><td>Avg Heart Rate</td><td>{sessionSummary.avgHR?.toFixed(0)} BPM</td></tr>
                    <tr><td>Min Heart Rate</td><td>{sessionSummary.minHR?.toFixed(0)} BPM</td></tr>
                    <tr><td>Max Heart Rate</td><td>{sessionSummary.maxHR?.toFixed(0)} BPM</td></tr>
                    <tr className="summary__divider"><td colSpan="2" /></tr>
                    <tr><td>Avg SpO2</td><td>{sessionSummary.avgSpo2?.toFixed(1)}%</td></tr>
                    <tr><td>Min SpO2</td><td>{sessionSummary.minSpo2?.toFixed(1)}%</td></tr>
                    <tr><td>Max SpO2</td><td>{sessionSummary.maxSpo2?.toFixed(1)}%</td></tr>
                    <tr className="summary__divider"><td colSpan="2" /></tr>
                    <tr>
                      <td>Abnormal readings</td>
                      <td className={sessionSummary.abnormal > 0 ? "summary__val--warn" : "summary__val--ok"}>
                        {sessionSummary.abnormal}
                      </td>
                    </tr>
                    <tr>
                      <td>Overall status</td>
                      <td className={sessionSummary.overallStatus === "Stable" ? "summary__val--ok" : "summary__val--warn"}>
                        {sessionSummary.overallStatus}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <p className="summary__disclaimer">
                  This summary is for monitoring purposes only and does not constitute medical advice.
                </p>
              </div>
            )}

            {sessionSummary?.empty && (
              <p className="panel__hint">No readings were collected during this session.</p>
            )}
          </section>

          {/* Alerts Log */}
          <section className="panel panel--alerts">
            <div className="panel__header">
              <div className="panel__title-row">
                <IconBell className="panel__title-icon" />
                <span className="panel__title">ALERT LOG</span>
                <span className="panel__count">{recentAlerts.length}</span>
              </div>
              {recentAlerts.length > 0 && (
                <button className="btn btn--ghost" onClick={() => setRecentAlerts([])}>
                  Clear
                </button>
              )}
            </div>

            {recentAlerts.length === 0 ? (
              <div className="alerts-empty">
                <div className="alerts-empty__icon">
                  {/* checkmark */}
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </div>
                <span>No abnormal readings detected</span>
              </div>
            ) : (
              <div className="alerts-log">
                <div className="alerts-log__head">
                  <span>Time</span><span>Event</span>
                </div>
                {recentAlerts.map((a, i) => (
                  <div key={i} className={`alerts-log__row alerts-log__row--${a.type}`}>
                    <span className="alerts-log__time">{a.time}</span>
                    <span className="alerts-log__text">{a.text}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

        </div>
      </main>

      <footer className="app-footer">
        <span>Patient Health Monitoring System &nbsp;·&nbsp; ESP32 + MAX30102</span>
        <span>For academic and demonstration use only &nbsp;·&nbsp; Not a medical device</span>
      </footer>
    </div>
  );
}
