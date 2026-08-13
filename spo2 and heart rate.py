import time

from machine import I2C, Pin

i2c = I2C(0, scl=Pin(22), sda=Pin(21), freq=100000)
ADDR = 0x57


def write_reg(reg, value):
    i2c.writeto_mem(ADDR, reg, bytes([value]))


def read_reg(reg):
    return i2c.readfrom_mem(ADDR, reg, 1)[0]


def read_sample():
    data = i2c.readfrom_mem(ADDR, 0x05, 4)
    ir = (data[0] << 8) | data[1]
    red = (data[2] << 8) | data[3]
    return ir, red


# ---------------- Sensor init (same as before) ----------------
write_reg(0x06, 0x40)  # Reset
time.sleep_ms(100)

write_reg(0x02, 0x00)  # Write pointer
write_reg(0x03, 0x00)  # Overflow counter
write_reg(0x04, 0x00)  # Read pointer

write_reg(0x08, 0x10)  # FIFO: 1-sample avg, rollover enabled
write_reg(0x07, 0x47)  # SpO2 config: 100Hz, high-res, 1600us pulse
write_reg(0x09, 0x33)  # LED current: Red=11mA, IR=11mA
write_reg(0x06, 0x03)  # Start SpO2 mode

print("MAX30100 running!")
print("Place your finger gently on the sensor.")
print()

# ---------------- HR / SpO2 processing ----------------

FINGER_THRESHOLD = 1000  # IR below this -> assume no finger present
ALPHA_DC = 0.98  # baseline (DC) tracking speed - SLOW, must not chase the pulse
ALPHA_AC_SMOOTH = 0.6  # low-pass smoothing on the AC (pulse) signal to kill noise
MIN_BEAT_INTERVAL_MS = 400  # caps HR at 150 BPM (rejects noise spikes)
MAX_BEAT_INTERVAL_MS = 2000  # floors HR at 30 BPM (rejects stray long gaps)
BEAT_HISTORY = 4  # number of intervals averaged for a stable BPM
WINDOW_MS = 1000  # SpO2 recompute window
HYST_FRACTION = 0.35  # beat re-arms/triggers at +-35% of recent AC amplitude

ir_dc = None
red_dc = None
ir_ac_smooth = 0
ac_amplitude = (
    10  # running estimate of pulse amplitude, used to size the hysteresis band
)
armed = False  # Schmitt-trigger state: True once signal has risen above +threshold
last_beat_time = 0
beat_intervals = []

win_ir_min = win_ir_max = None
win_red_min = win_red_max = None
win_ir_sum = win_red_sum = 0
win_count = 0
win_start = time.ticks_ms()

bpm = 0
spo2 = 0


def reset_window():
    global win_ir_min, win_ir_max, win_red_min, win_red_max
    global win_ir_sum, win_red_sum, win_count, win_start
    win_ir_min = win_ir_max = None
    win_red_min = win_red_max = None
    win_ir_sum = win_red_sum = 0
    win_count = 0
    win_start = time.ticks_ms()


reset_window()

while True:
    wr = read_reg(0x02)
    rd = read_reg(0x04)
    available = (wr - rd) & 0x0F

    while available > 0:
        ir, red = read_sample()
        available -= 1
        now = time.ticks_ms()

        if ir < FINGER_THRESHOLD:
            # No finger on sensor - reset all running state
            ir_dc = red_dc = None
            ir_ac_smooth = 0
            ac_amplitude = 10
            armed = False
            last_beat_time = 0
            beat_intervals = []
            reset_window()
            bpm = 0
            spo2 = 0
            print("No finger detected...")
            continue

        # --- Track DC baseline (slow-moving average, must not chase the pulse) ---
        if ir_dc is None:
            ir_dc = ir
            red_dc = red
        else:
            ir_dc = ALPHA_DC * ir_dc + (1 - ALPHA_DC) * ir
            red_dc = ALPHA_DC * red_dc + (1 - ALPHA_DC) * red

        ir_ac_raw = ir - ir_dc
        # Smooth the AC signal to remove sample noise before checking for beats
        ir_ac_smooth = (
            ALPHA_AC_SMOOTH * ir_ac_smooth + (1 - ALPHA_AC_SMOOTH) * ir_ac_raw
        )

        # Track a running estimate of pulse amplitude, so the hysteresis band
        # scales with signal strength instead of using a fixed magic number
        ac_amplitude = 0.99 * ac_amplitude + 0.01 * abs(ir_ac_smooth)
        threshold = max(ac_amplitude * HYST_FRACTION, 3)

        # --- Beat detection: Schmitt trigger (hysteresis) instead of raw zero-crossing ---
        if not armed and ir_ac_smooth > threshold:
            armed = True
        elif armed and ir_ac_smooth < -threshold:
            armed = False
            if last_beat_time != 0:
                interval = time.ticks_diff(now, last_beat_time)
                if MIN_BEAT_INTERVAL_MS < interval < MAX_BEAT_INTERVAL_MS:
                    beat_intervals.append(interval)
                    if len(beat_intervals) > BEAT_HISTORY:
                        beat_intervals.pop(0)
                    avg_interval = sum(beat_intervals) / len(beat_intervals)
                    bpm = 60000 / avg_interval
            last_beat_time = now

        # --- Accumulate stats for SpO2 (ratio-of-ratios) ---
        win_ir_min = ir if win_ir_min is None else min(win_ir_min, ir)
        win_ir_max = ir if win_ir_max is None else max(win_ir_max, ir)
        win_red_min = red if win_red_min is None else min(win_red_min, red)
        win_red_max = red if win_red_max is None else max(win_red_max, red)
        win_ir_sum += ir
        win_red_sum += red
        win_count += 1

        if time.ticks_diff(now, win_start) >= WINDOW_MS and win_count > 0:
            ir_ac_amp = win_ir_max - win_ir_min
            red_ac_amp = win_red_max - win_red_min
            ir_dc_avg = win_ir_sum / win_count
            red_dc_avg = win_red_sum / win_count

            if ir_ac_amp > 0 and red_ac_amp > 0 and ir_dc_avg > 0 and red_dc_avg > 0:
                R = (red_ac_amp / red_dc_avg) / (ir_ac_amp / ir_dc_avg)
                new_spo2 = 110 - 25 * R  # standard empirical approximation
                new_spo2 = max(0, min(100, new_spo2))
                spo2 = new_spo2 if spo2 == 0 else (0.7 * spo2 + 0.3 * new_spo2)

            reset_window()

        if bpm > 0 and spo2 > 0:
            print(
                "IR:",
                ir,
                " RED:",
                red,
                "  BPM:",
                round(bpm),
                "  SpO2:",
                round(spo2),
                "%",
            )
        else:
            print("IR:", ir, " RED:", red, "  (measuring...)")

    time.sleep_ms(10)
