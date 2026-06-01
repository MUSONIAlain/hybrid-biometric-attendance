# Attendance6 - ESP32 RFID and Fingerprint Attendance System

Simple student project prototype using:

- ESP32 DevKitC V4
- MFRC522 RFID reader
- R307 fingerprint sensor
- I2C 16x2 LCD
- DS1302 RTC
- Passive buzzer
- Node.js + Express.js
- PostgreSQL
- Plain HTML, CSS, and JavaScript

The ESP32 communicates directly with the backend using HTTP.

## Folder Structure

```text
attendance6/
  backend/
    db.js
    server.js
  database/
    schema.sql
  esp32/
    attendance6_esp32.ino
  frontend/
    index.html
    styles.css
    app.js
  .env.example
  package.json
  README.md
```

## Hardware Wiring

### MFRC522 RFID

| RFID Pin | ESP32 Pin |
| --- | --- |
| SDA | GPIO 5 |
| SCK | GPIO 18 |
| MOSI | GPIO 23 |
| MISO | GPIO 19 |
| RST | GPIO 4 |
| 3.3V | 3.3V |
| GND | GND |

### R307 Fingerprint Sensor

| Fingerprint Pin | ESP32 Pin |
| --- | --- |
| TX | GPIO 16 |
| RX | GPIO 17 |
| VCC | 3.3V or 5V, based on your module |
| GND | GND |

### I2C LCD 16x2

| LCD Pin | ESP32 Pin |
| --- | --- |
| SDA | GPIO 21 |
| SCL | GPIO 22 |
| VCC | 5V or 3.3V, based on your module |
| GND | GND |

### DS1302 RTC

| RTC Pin | ESP32 Pin |
| --- | --- |
| CLK | GPIO 14 |
| DAT | GPIO 27 |
| RST | GPIO 26 |
| VCC | 3.3V |
| GND | GND |

### Passive Buzzer

| Buzzer Pin | ESP32 Pin |
| --- | --- |
| Signal | GPIO 32 |
| GND | GND |

## Database Setup

1. Install PostgreSQL.
2. Open a terminal in the project folder.
3. Run:

```bash
psql -U postgres -f database/schema.sql
```

This creates the database named `attendance6` and the tables:

- `users`
- `settings`
- `attendance_logs`

## Backend Setup

1. Install Node.js.
2. Install dependencies:

```bash
npm install
```

3. Create your environment file. Either location works:

```bash
copy .env.example .env
```

or:

```bash
copy .env.example backend\.env
```

4. Edit `.env` or `backend/.env` and set your PostgreSQL password:

```text
PORT=3000
DB_HOST=localhost
DB_PORT=5432
DB_NAME=attendance6
DB_USER=postgres
DB_PASSWORD=your_postgres_password
```

5. Start the server:

```bash
npm start
```

6. Open the dashboard:

```text
http://localhost:3000
```

## ESP32 Arduino Setup

Open `esp32/attendance6_esp32.ino` in Arduino IDE.

Install these Arduino libraries:

- `MFRC522`
- `Adafruit Fingerprint Sensor Library`
- `LiquidCrystal I2C`
- `ArduinoJson`
- `Rtc by Makuna`

In the `.ino` file, edit:

```cpp
const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* SERVER_BASE_URL = "http://YOUR_COMPUTER_IP:3000";
```

Important: `SERVER_BASE_URL` must use your computer's local network IP address, not `localhost`.

Example:

```cpp
const char* SERVER_BASE_URL = "http://192.168.1.10:3000";
```

Upload the sketch to the ESP32.

## Registration Workflow

1. Open the dashboard.
2. Enter the student's name.
3. Click `Start Registration`.
4. The ESP32 sees the pending registration task.
5. LCD asks the user to scan a fingerprint twice.
6. Fingerprint template is stored in the R307 sensor.
7. LCD asks the user to scan an RFID card.
8. ESP32 sends the fingerprint ID and RFID UID to the backend.
9. Backend saves the new user in PostgreSQL.

## Attendance Workflow

When biometrics are enabled:

1. User scans RFID card.
2. LCD asks for fingerprint.
3. ESP32 sends RFID UID and fingerprint ID to backend.
4. Backend checks that both belong to the same user.
5. If matched, attendance is recorded.
6. If not matched, access is denied.

When biometrics are disabled:

1. User scans RFID card.
2. ESP32 sends RFID UID only.
3. Backend records attendance if the RFID card is registered.

## API Summary

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/users` | List users |
| POST | `/api/registration/start` | Start web registration |
| GET | `/api/registration/status` | Dashboard registration status |
| GET | `/api/esp32/registration-task` | ESP32 checks for pending registration |
| POST | `/api/esp32/registration-complete` | ESP32 saves fingerprint/RFID result |
| DELETE | `/api/users/:id` | Delete user |
| GET | `/api/settings/biometrics` | Read biometrics mode |
| PUT | `/api/settings/biometrics` | Enable or disable biometrics |
| POST | `/api/attendance/verify` | Verify RFID/fingerprint attendance |
| GET | `/api/attendance/logs` | View attendance logs |
| GET | `/api/attendance/export` | Download CSV |

## Notes for Student Project Demo

- The fingerprint image is not stored in PostgreSQL. The R307 sensor stores the fingerprint template internally and the database stores only the fingerprint ID.
- Deleting a user removes the database record. It does not erase the fingerprint template from the sensor.
- This prototype keeps the system simple and does not use MQTT, offline sync, role management, or authentication.
