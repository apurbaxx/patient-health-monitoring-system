# Patient Health Monitor — Web Dashboard

Real-time web dashboard for heart rate (BPM) and blood oxygen saturation (SpO₂) data streamed from an ESP32 + MAX30100 sensor over USB serial.

---

## Files

| File | Purpose |
|------|---------|
| `spo2 and heart rate.py` | MicroPython firmware for ESP32 (runs on the device) |
| `server.py` | Python bridge: reads serial → WebSocket + REST |
| `dashboard.html` | **Simple HTML dashboard** (open in any browser) |
| `dashboard-react/` | **React dashboard** (modern UI, requires Node.js) |
| `requirements.txt` | Python dependencies |

---

## Hardware

- ESP32 development board
- MAX30100 pulse oximeter / heart rate sensor
  - VCC → 3.3 V
  - GND → GND
  - SDA → GPIO 21
  - SCL → GPIO 22

---

## Setup

### 1. Flash the firmware

Upload `spo2 and heart rate.py` to the ESP32 using Thonny or mpremote:

```bash
mpremote connect COM3 run "spo2 and heart rate.py"
```

### 2. Install Python dependencies

```bash
pip install -r requirements.txt
```

### 3. Configure the serial port

Open `server.py` and set `SERIAL_PORT` to the port your ESP32 is connected to:

```python
SERIAL_PORT = "COM3"   # Windows example
# SERIAL_PORT = "/dev/ttyUSB0"  # Linux example
# SERIAL_PORT = "/dev/cu.usbserial-0001"  # macOS example
```

To find your port:
- **Windows**: Device Manager → Ports (COM & LPT)
- **Linux/macOS**: `ls /dev/tty*` (look for ttyUSB0 or ttyACM0)

### 4. (Optional) Demo mode

If you don't have the hardware yet, enable demo mode to generate simulated data:

```python
DEMO_MODE = True   # in server.py
```

---

## Running — Choose Your Dashboard

### Option A: Simple HTML Dashboard

**Step 1 — Start the server:**
```bash
python server.py
```

**Step 2 — Open dashboard:**
npm run dev

### Option B: React Dashboard (Recommended)

**Step 1 — Start the server:**
```bash
python server.py
```

**Step 2 — Install React dependencies (one-time):**
```bash
cd dashboard-react
npm install
```

**Step 3 — Start React dev server:**
```bash
npm start
```
Opens automatically at `http://localhost:3000`

---

## Dashboard Features

- **Live BPM and SpO₂ gauges** with colour-coded status (Normal / Caution / Critical)
- **Rolling 60-second line charts** for both vitals
- **Clinical threshold lines** on each chart
- **Alert banner + card highlighting** when readings are outside safe range
- **Session statistics**: average/max BPM, average/min SpO₂
- **Auto-reconnect** if the server restarts
- **Heartbeat animation** on each new reading

### Alert thresholds

| Vital | Normal | Caution | Critical |
|-------|--------|---------|----------|
| Heart Rate | 60 – 100 BPM | < 60 or > 100 | < 40 or > 130 |
| SpO₂ | ≥ 95% | 90 – 95% | < 90% |

---
