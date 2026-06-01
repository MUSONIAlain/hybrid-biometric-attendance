#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <SPI.h>
#include <MFRC522.h>
#include <Adafruit_Fingerprint.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <ThreeWire.h>
#include <RtcDS1302.h>

// ---------- WiFi and server settings ----------
const char* WIFI_SSID = "realme C12";
const char* WIFI_PASSWORD = "12345678";

// Use your computer IP address, not localhost.
// Example: const char* SERVER_BASE_URL = "http://192.168.1.10:3000";
const char* SERVER_BASE_URL = "http://192.168.0.102:3000";

// ---------- ESP32 pins ----------
#define RFID_SS_PIN 5
#define RFID_RST_PIN 4

#define FINGERPRINT_RX_PIN 16
#define FINGERPRINT_TX_PIN 17

#define LCD_SDA_PIN 21
#define LCD_SCL_PIN 22

#define RTC_CLK_PIN 14
#define RTC_DAT_PIN 27
#define RTC_RST_PIN 26

#define BUZZER_PIN 32

MFRC522 rfid(RFID_SS_PIN, RFID_RST_PIN);
HardwareSerial fingerprintSerial(2);
Adafruit_Fingerprint finger = Adafruit_Fingerprint(&fingerprintSerial);
LiquidCrystal_I2C lcd(0x27, 16, 2);
ThreeWire rtcWire(RTC_DAT_PIN, RTC_CLK_PIN, RTC_RST_PIN);
RtcDS1302<ThreeWire> rtc(rtcWire);

unsigned long lastRegistrationPoll = 0;
bool registrationBusy = false;

void setup() {
  Serial.begin(115200);
  pinMode(BUZZER_PIN, OUTPUT);

  Wire.begin(LCD_SDA_PIN, LCD_SCL_PIN);
  lcd.init();
  lcd.backlight();

  SPI.begin(18, 19, 23, RFID_SS_PIN);
  rfid.PCD_Init();

  fingerprintSerial.begin(57600, SERIAL_8N1, FINGERPRINT_RX_PIN, FINGERPRINT_TX_PIN);
  finger.begin(57600);

  rtc.Begin();
  if (!rtc.IsDateTimeValid()) {
    rtc.SetDateTime(RtcDateTime(__DATE__, __TIME__));
  }

  showMessage("Attendance6", "Starting...");
  connectWiFi();

  if (finger.verifyPassword()) {
    showMessage("Fingerprint", "Sensor ready");
    successBeep();
  } else {
    showMessage("Fingerprint", "Not found");
    errorBeep();
  }

  delay(1200);
  showMessage("Ready", "Scan RFID card");
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    connectWiFi();
  }

  if (!registrationBusy && millis() - lastRegistrationPoll > 3000) {
    lastRegistrationPoll = millis();
    checkRegistrationTask();
  }

  if (!registrationBusy) {
    handleAttendanceScan();
  }
}

void connectWiFi() {
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  showMessage("Connecting WiFi", WIFI_SSID);

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    showMessage("WiFi connected", WiFi.localIP().toString());
    delay(1000);
  } else {
    showMessage("WiFi failed", "Check settings");
    errorBeep();
    delay(2000);
  }
}

void checkRegistrationTask() {
  String response;
  int code = httpGet("/api/esp32/registration-task", response);
  if (code != 200) {
    Serial.print("Registration task HTTP code: ");
    Serial.println(code);
    Serial.print("Registration task response: ");
    Serial.println(response);
    return;
  }

  StaticJsonDocument<256> doc;
  DeserializationError error = deserializeJson(doc, response);
  if (error || !doc["active"]) return;

  registrationBusy = true;
  String name = doc["name"].as<String>();
  int fingerprintId = doc["fingerprint_id"].as<int>();

  showMessage("Registering", shortLine(name));
  delay(1200);

  bool enrolled = enrollFingerprint(fingerprintId);
  if (!enrolled) {
    showMessage("Enroll failed", "Try again");
    errorBeep();
    registrationBusy = false;
    delay(1500);
    showMessage("Ready", "Scan RFID card");
    return;
  }

  showMessage("Scan RFID card", "For this user");
  String uid = waitForRfidUid();

  if (uid.length() == 0) {
    showMessage("RFID failed", "Try again");
    errorBeep();
    registrationBusy = false;
    delay(1500);
    showMessage("Ready", "Scan RFID card");
    return;
  }

  bool saved = sendRegistrationComplete(fingerprintId, uid);
  if (saved) {
    showMessage("User saved", uid);
    successBeep();
  } else {
    showMessage("Save failed", "Check server");
    errorBeep();
  }

  delay(2000);
  registrationBusy = false;
  showMessage("Ready", "Scan RFID card");
}

bool enrollFingerprint(int id) {
  int result = -1;

  showMessage("Place finger", "ID: " + String(id));
  while ((result = finger.getImage()) != FINGERPRINT_OK) {
    if (result == FINGERPRINT_NOFINGER) delay(100);
    else return false;
  }

  if (finger.image2Tz(1) != FINGERPRINT_OK) return false;

  showMessage("Remove finger", "");
  delay(2000);
  while (finger.getImage() != FINGERPRINT_NOFINGER) {
    delay(100);
  }

  showMessage("Place again", "Same finger");
  while ((result = finger.getImage()) != FINGERPRINT_OK) {
    if (result == FINGERPRINT_NOFINGER) delay(100);
    else return false;
  }

  if (finger.image2Tz(2) != FINGERPRINT_OK) return false;
  if (finger.createModel() != FINGERPRINT_OK) return false;
  if (finger.storeModel(id) != FINGERPRINT_OK) return false;

  return true;
}

void handleAttendanceScan() {
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial()) {
    return;
  }

  String uid = getCurrentRfidUid();
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();

  showMessage("RFID scanned", uid);
  delay(700);

  bool biometricsEnabled = getBiometricsEnabled();
  int fingerprintId = -1;

  if (biometricsEnabled) {
    showMessage("Scan", "Fingerprint");
    fingerprintId = scanFingerprint();

    if (fingerprintId < 0) {
      showMessage("Access Denied", "No fingerprint");
      errorBeep();
      delay(1500);
      showMessage("Ready", "Scan RFID card");
      return;
    }
  }

  verifyAttendance(uid, fingerprintId, biometricsEnabled);
  delay(1800);
  showMessage("Ready", "Scan RFID card");
}

int scanFingerprint() {
  unsigned long started = millis();

  while (millis() - started < 10000) {
    int result = finger.getImage();
    if (result == FINGERPRINT_NOFINGER) {
      delay(100);
      continue;
    }
    if (result != FINGERPRINT_OK) return -1;
    if (finger.image2Tz() != FINGERPRINT_OK) return -1;
    if (finger.fingerSearch() != FINGERPRINT_OK) return -1;

    return finger.fingerID;
  }

  return -1;
}

bool getBiometricsEnabled() {
  String response;
  int code = httpGet("/api/settings/biometrics", response);
  if (code != 200) return true;

  StaticJsonDocument<128> doc;
  if (deserializeJson(doc, response)) return true;

  return doc["enabled"] | true;
}

void verifyAttendance(String uid, int fingerprintId, bool biometricsEnabled) {
  StaticJsonDocument<160> request;
  request["rfid_uid"] = uid;
  if (biometricsEnabled) {
    request["fingerprint_id"] = fingerprintId;
  }

  String body;
  serializeJson(request, body);

  String response;
  int code = httpPost("/api/attendance/verify", body, response);

  StaticJsonDocument<256> doc;
  deserializeJson(doc, response);
  bool success = code == 200 && doc["success"];

  if (success) {
    String name = doc["user"]["name"] | "";
    showMessage("Attendance OK", shortLine(name));
    successBeep();
  } else {
    const char* message = doc["message"] | "Access denied";
    showMessage("Access Denied", shortLine(String(message)));
    errorBeep();
  }
}

bool sendRegistrationComplete(int fingerprintId, String uid) {
  StaticJsonDocument<160> request;
  request["fingerprint_id"] = fingerprintId;
  request["rfid_uid"] = uid;

  String body;
  serializeJson(request, body);

  String response;
  int code = httpPost("/api/esp32/registration-complete", body, response);
  return code == 200;
}

String waitForRfidUid() {
  unsigned long started = millis();

  while (millis() - started < 20000) {
    if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
      String uid = getCurrentRfidUid();
      rfid.PICC_HaltA();
      rfid.PCD_StopCrypto1();
      return uid;
    }
    delay(100);
  }

  return "";
}

String getCurrentRfidUid() {
  String uid = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();
  return uid;
}

int httpGet(String path, String& response) {
  if (WiFi.status() != WL_CONNECTED) return -1;

  HTTPClient http;
  http.setTimeout(5000);
  String url = String(SERVER_BASE_URL) + path;
  Serial.print("GET ");
  Serial.println(url);
  http.begin(url);
  int code = http.GET();
  response = http.getString();
  Serial.print("HTTP code: ");
  Serial.println(code);
  http.end();
  return code;
}

int httpPost(String path, String body, String& response) {
  if (WiFi.status() != WL_CONNECTED) return -1;

  HTTPClient http;
  http.setTimeout(8000);
  String url = String(SERVER_BASE_URL) + path;
  Serial.print("POST ");
  Serial.println(url);
  Serial.print("Body: ");
  Serial.println(body);
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  response = http.getString();
  Serial.print("HTTP code: ");
  Serial.println(code);
  Serial.print("Response: ");
  Serial.println(response);
  http.end();
  return code;
}

void showMessage(String line1, String line2) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(shortLine(line1));
  lcd.setCursor(0, 1);
  lcd.print(shortLine(line2));

  Serial.print(line1);
  Serial.print(" | ");
  Serial.println(line2);
}

String shortLine(String value) {
  if (value.length() <= 16) return value;
  return value.substring(0, 16);
}

void successBeep() {
  tone(BUZZER_PIN, 1800, 120);
  delay(160);
  tone(BUZZER_PIN, 2300, 120);
  delay(160);
  noTone(BUZZER_PIN);
}

void errorBeep() {
  tone(BUZZER_PIN, 400, 450);
  delay(480);
  noTone(BUZZER_PIN);
}
