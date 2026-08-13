import React, { useState, useEffect, useRef } from "react";
import "./App.css";

const WS_URL = "ws://localhost:8765";

// Clinical thresholds
const HR_LOW = 60,
  HR_HIGH = 100;
const SPO2_LOW = 95,
  SPO2_WARN = 90;

function App() {
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const [latestReading, setLatestReading] = useState({
    bpm: null,
    spo2: null,
    ts: null,
  });
  const [fingerDetected, setFingerDetected] = useState(true);
  const [alerts, setAlerts] = useState([]);

  const ws = useRef(null);
  const heartbeatRef = useRef(null);

  // WebSocket connection
  useEffect(() => {
    connectWebSocket();
    return () => {
      if (ws.current) {
        ws.current.close();
      }
    };
  }, []);

  const connectWebSocket = () => {
    setConnectionStatus("connecting");

    ws.current = new WebSocket(WS_URL);

    ws.current.onopen = () => {
      setConnectionStatus("connected");
      console.log("[ws] Connected");
    };

    ws.current.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.history) {
          // Take the latest reading from history
          if (msg.history.length > 0) {
            const latest = msg.history[msg.history.length - 1];
            processReading(latest.bpm, latest.spo2, latest.ts, true);
          }
        } else if (msg.fingerDetected === false) {
          // No finger detected
          setFingerDetected(false);
          setAlerts([]);
        } else if (
          typeof msg.bpm === "number" &&
          typeof msg.spo2 === "number"
        ) {
          // Live reading with finger detected
          processReading(msg.bpm, msg.spo2, msg.ts, true);
        }
      } catch (e) {
        console.warn("[ws] Parse error:", e);
      }
    };

    ws.current.onerror = () => {
      setConnectionStatus("error");
    };

    ws.current.onclose = () => {
      setConnectionStatus("reconnecting");
      setTimeout(connectWebSocket, 3000);
    };
  };

  const processReading = (bpm, spo2, ts, fingerDetected) => {
    // Update latest reading
    setLatestReading({ bpm, spo2, ts });
    setFingerDetected(fingerDetected);

    if (fingerDetected) {
      // Check for alerts only when finger is detected
      checkAlerts(bpm, spo2);
      // Trigger heartbeat animation
      triggerHeartbeat();
    } else {
      setAlerts([]);
    }
  };

  const checkAlerts = (bpm, spo2) => {
    const newAlerts = [];

    const hrClass = classifyHR(bpm);
    const spo2Class = classifySpo2(spo2);

    if (hrClass === "danger")
      newAlerts.push(`Critical heart rate: ${Math.round(bpm)} BPM`);
    if (hrClass === "warning")
      newAlerts.push(`Heart rate outside normal: ${Math.round(bpm)} BPM`);
    if (spo2Class === "danger")
      newAlerts.push(`Critical oxygen level: ${spo2.toFixed(1)}%`);
    if (spo2Class === "warning")
      newAlerts.push(`Low oxygen saturation: ${spo2.toFixed(1)}%`);

    setAlerts(newAlerts);
  };

  const triggerHeartbeat = () => {
    if (heartbeatRef.current) {
      heartbeatRef.current.classList.remove("beat");
      void heartbeatRef.current.offsetWidth; // Force reflow
      heartbeatRef.current.classList.add("beat");
    }
  };

  const classifyHR = (bpm) => {
    if (bpm < 40 || bpm > 130) return "danger";
    if (bpm < HR_LOW || bpm > HR_HIGH) return "warning";
    return "normal";
  };

  const classifySpo2 = (spo2) => {
    if (spo2 < SPO2_WARN) return "danger";
    if (spo2 < SPO2_LOW) return "warning";
    return "normal";
  };

  const getStatusClass = (status) => {
    switch (status) {
      case "normal":
        return "normal";
      case "warning":
        return "warning";
      case "danger":
        return "danger";
      default:
        return "";
    }
  };

  const getStatusLabel = (status) => {
    switch (status) {
      case "normal":
        return "Normal";
      case "warning":
        return "Caution";
      case "danger":
        return "Critical";
      default:
        return "—";
    }
  };

  const hrClass = latestReading.bpm ? classifyHR(latestReading.bpm) : "";
  const spo2Class = latestReading.spo2 ? classifySpo2(latestReading.spo2) : "";

  return (
    <div className="app">
      <div className="container">
        {/* Alert Banner */}
        {!fingerDetected ? (
          <div className="alert-banner no-finger">
            <div className="alert-icon"></div>
            <div className="alert-text">
              Please place your finger on the sensor
            </div>
          </div>
        ) : alerts.length > 0 ? (
          <div className="alert-banner">
            <div className="alert-icon">⚠</div>
            <div className="alert-text">{alerts.join(" • ")}</div>
          </div>
        ) : null}

        {/* Main Vitals */}
        <div className="vitals-grid">
          {/* Heart Rate Card */}
          <div className={`vital-card heart-rate ${getStatusClass(hrClass)}`}>
            <div className="vital-header">
              <span className="vital-icon" ref={heartbeatRef}>
                ❤️
              </span>
              <span className="vital-label">Heart Rate</span>
            </div>
            <div className="vital-value">
              {fingerDetected && latestReading.bpm
                ? Math.round(latestReading.bpm)
                : "--"}
              <span className="vital-unit">BPM</span>
            </div>
            <div className="vital-status">
              {fingerDetected ? getStatusLabel(hrClass) : "Waiting..."}
            </div>
            <div className="vital-range">Normal: 60-100 BPM</div>
          </div>

          {/* SpO2 Card */}
          <div className={`vital-card oxygen ${getStatusClass(spo2Class)}`}>
            <div className="vital-header">
              <span className="vital-icon">🫁</span>
              <span className="vital-label">Oxygen Level</span>
            </div>
            <div className="vital-value">
              {fingerDetected && latestReading.spo2
                ? latestReading.spo2.toFixed(1)
                : "--"}
              <span className="vital-unit">%</span>
            </div>
            <div className="vital-status">
              {fingerDetected ? getStatusLabel(spo2Class) : "Waiting..."}
            </div>
            <div className="vital-range">Normal: 95-100%</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
