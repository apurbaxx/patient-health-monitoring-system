"""
serial_bridge.py
----------------
Reads ESP32 serial output (BPM + SpO2 lines) and exposes:
  - WebSocket  ws://localhost:8765   -> streams JSON readings in real time
  - REST GET   http://localhost:8766/latest  -> last known reading (JSON)
  - REST GET   http://localhost:8766/history -> last 200 readings (JSON array)

Serial line formats produced by the MicroPython firmware:
  "IR: 5432  RED: 4321  BPM: 75  SpO2: 98 %"
  "IR: 5432  RED: 4321  (measuring...)"
  "No finger detected..."
"""

import asyncio
import json
import re
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, HTTPServer

import serial
import websockets

# ── Configuration ────────────────────────────────────────────────────────────
SERIAL_PORT   = "COM3"      # ← change to your ESP32 port (e.g. COM5 on Windows, /dev/ttyUSB0 on Linux)
BAUD_RATE     = 115200
WS_HOST       = "localhost"
WS_PORT       = 8765
HTTP_HOST     = "localhost"
HTTP_PORT     = 8766
MAX_HISTORY   = 200         # number of readings kept in memory
DEMO_MODE     = False       # set True to generate fake data without a real device
# ─────────────────────────────────────────────────────────────────────────────

# Shared state
history: deque = deque(maxlen=MAX_HISTORY)
latest: dict = {"bpm": None, "spo2": None, "status": "waiting", "ts": None}
ws_clients: set = set()
state_lock = threading.Lock()

# ── Serial / Demo reader ──────────────────────────────────────────────────────

LINE_RE = re.compile(
    r"BPM:\s*(?P<bpm>\d+(?:\.\d+)?)\s+SpO2:\s*(?P<spo2>\d+(?:\.\d+)?)\s*%?"
)

def parse_line(line: str):
    """Return (bpm, spo2) floats or None if the line doesn't contain a reading."""
    m = LINE_RE.search(line)
    if m:
        return float(m.group("bpm")), float(m.group("spo2"))
    return None

def push_reading(bpm: float, spo2: float):
    """Store a new reading and schedule a WebSocket broadcast."""
    global latest
    ts = time.time()
    reading = {"bpm": round(bpm), "spo2": round(spo2, 1), "ts": ts, "fingerDetected": True}
    with state_lock:
        latest = {**reading, "status": "ok"}
        history.append(reading)
    # thread-safe: put the broadcast into the event loop
    asyncio.run_coroutine_threadsafe(broadcast(json.dumps(reading)), _loop)

def push_no_finger():
    """Send no finger detected status."""
    global latest
    ts = time.time()
    reading = {"bpm": None, "spo2": None, "ts": ts, "fingerDetected": False}
    with state_lock:
        latest = {**reading, "status": "no_finger"}
    # thread-safe: put the broadcast into the event loop
    asyncio.run_coroutine_threadsafe(broadcast(json.dumps(reading)), _loop)

def serial_reader():
    """Background thread: open serial port and parse lines forever."""
    while True:
        try:
            print(f"[serial] Opening {SERIAL_PORT} @ {BAUD_RATE}…")
            with serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=2) as ser:
                print("[serial] Connected.")
                while True:
                    raw = ser.readline()
                    if not raw:
                        continue
                    line = raw.decode("utf-8", errors="replace").strip()
                    
                    # DEBUG: Print every line received
                    if line:
                        print(f"[debug] Received: {repr(line)}")
                    
                    result = parse_line(line)
                    if result:
                        bpm, spo2 = result
                        print(f"[debug] Parsed: BPM={bpm}, SpO2={spo2}")
                        push_reading(bpm, spo2)
                    elif "No finger" in line:
                        print(f"[debug] No finger detected")
                        push_no_finger()
        except serial.SerialException as exc:
            print(f"[serial] Error: {exc}  – retrying in 3 s")
            time.sleep(3)

def demo_reader():
    """Background thread: generate simulated readings when DEMO_MODE=True."""
    import math, random
    t = 0
    while True:
        bpm  = 72 + 8 * math.sin(t / 20) + random.uniform(-1, 1)
        spo2 = 97 + 1.5 * math.sin(t / 30) + random.uniform(-0.3, 0.3)
        spo2 = min(100, max(90, spo2))
        push_reading(bpm, spo2)
        t += 1
        time.sleep(1)

# ── WebSocket server ──────────────────────────────────────────────────────────

async def broadcast(message: str):
    if not ws_clients:
        return
    
    # Send to all clients, remove any that fail
    dead_clients = set()
    for client in ws_clients:
        try:
            await client.send(message)
        except Exception:
            dead_clients.add(client)
    
    # Clean up dead connections
    for client in dead_clients:
        ws_clients.discard(client)

async def ws_handler(websocket):
    ws_clients.add(websocket)
    try:
        # Send the last 60 readings immediately so the chart fills in
        with state_lock:
            snapshot = list(history)[-60:]
        await websocket.send(json.dumps({"history": snapshot}))
        
        # Keep connection alive and handle messages
        async for message in websocket:
            # Echo back any messages (for keepalive)
            pass
    except Exception as e:
        # Silently handle disconnections and other WebSocket errors
        print(f"[ws] Client disconnected: {type(e).__name__}")
    finally:
        ws_clients.discard(websocket)

# ── HTTP REST server ──────────────────────────────────────────────────────────

class APIHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # silence default access log
        pass

    def _send_json(self, data, code=200):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/latest":
            with state_lock:
                self._send_json(latest)
        elif self.path == "/history":
            with state_lock:
                self._send_json(list(history))
        else:
            self._send_json({"error": "not found"}, 404)

def http_server_thread():
    server = HTTPServer((HTTP_HOST, HTTP_PORT), APIHandler)
    print(f"[http]   REST API  → http://{HTTP_HOST}:{HTTP_PORT}/latest")
    server.serve_forever()

# ── Entry point ───────────────────────────────────────────────────────────────

async def main():
    global _loop
    _loop = asyncio.get_running_loop()

    # Start background threads
    if DEMO_MODE:
        print("[demo] Starting demo mode - generating fake data")
        threading.Thread(target=demo_reader, daemon=True).start()
    else:
        threading.Thread(target=serial_reader, daemon=True).start()
    
    threading.Thread(target=http_server_thread, daemon=True).start()

    # Start WebSocket server
    print(f"[ws]     WebSocket  → ws://{WS_HOST}:{WS_PORT}")
    async with websockets.serve(ws_handler, WS_HOST, WS_PORT):
        print("\n✅ Server ready.  Open dashboard.html in your browser.\n")
        await asyncio.Future()   # run forever

if __name__ == "__main__":
    asyncio.run(main())
