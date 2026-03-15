#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const request = require('dropin-request');
const easyConf = require('./easyConf');
const eConf = new easyConf();

// we need to hold client connections to mqtt in case of special publish type sonoff
// client is defined online/alive only if it keeps connected...
var mqttClientDict = {};

// First consider commandline arguments and environment variables, respectively.
eConf.argv().env();

// Then load configuration from a designated file.
eConf.file({ file: 'config.json' });
// If configuration under conf exist -> load it this helps when running in docker and docker volume for conf is mounted under conf
eConf.file({ file: 'conf/config.json' });

// Provide default values for settings not provided above.
eConf.defaults({
    // if set to null, then default IP address discovery will be used,
    // otherwise use specified IP address
    'localIPv4Address': null,

    'mqtt': 'mqtt://127.0.0.1',
    'mqtt_home': 'MobileAlerts/', // default MQTT path for the device parsed data
    'keepalive': 600,
    'reconnectPeriod': 0,

    'publish_type': 'default', // Implementation to support multiple types of publishing via MQTT (implemented to support e.g. Sonoff Adapter)
    // check if the following should be a general implementation for all or all special publish types
    'sonoffPublish_prefix': null, // publish devices with a specific prefix rather than only their ID in case of publish type sonoff
    'logfile': './MobileAlerts.log',
    'logGatewayInfo': true,   // display info about all found gateways

    // The Mobile-Alert Cloud Server always uses port 8080, we do too,
    // so we are not using a privileged one.
    'proxyServerPort': 8080,

    // Should the proxy forward the data to the Mobile Alerts cloud
    'mobileAlertsCloudForward': false,

    // post the resulting JSON to a http(s) Service
    'serverPost': null,
    'serverPostUser': null,
    'serverPostPassword': null,
    'locale': null // locale that will be used to define how dates should be generated (to override system based locale) e.g. 'en-US'
});
console.log('running with configuration: ' + JSON.stringify(eConf.getConfig()));
let locale = eConf.get('locale');

var localIPv4Adress = "";
if (eConf.get('localIPv4Address') == null) {
    localIPv4Adress = require('./localIPv4Address')(1);
} else {
    localIPv4Adress = eConf.get('localIPv4Address');
}

const proxyServerPort = eConf.get('proxyServerPort');

// #############################################################

function round(value, decimals) {
    return Number(Math.round(value + 'e' + decimals) + 'e-' + decimals);
}

// #############################################################
// Setup MQTT to allow us sending data to the broker

const mqtt = require('mqtt');
const mqttBroker = eConf.get('mqtt')
var mqttClient;

// Helper to debounce reconnect attempts to avoid exponential loop bomb
var reconnectTimer = null;
function triggerReconnect() {
    if (reconnectTimer) return; // Reconnect already pending
    console.log('### MQTT server: reconnecting...');
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if(mqttClient) mqttClient.reconnect();
    }, 1000);
}

if (mqttBroker) {
    mqttClient = mqtt.connect(eConf.get('mqtt'), {
        'username': eConf.get('mqtt_username'),
        'password': eConf.get('mqtt_password'),
        'clientId': 'MABroker',
        'keepalive': eConf.get('keepalive'),
        'reconnectPeriod': eConf.get('reconnectPeriod')
    })
    mqttClient.on('connect', function () {
        console.log('### MQTT server is connected');
    });
    mqttClient.on('close', function () {
        console.log('### MQTT server is closed');
        triggerReconnect();
    });
    mqttClient.on('offline', function () {
        console.log('### MQTT server is offline');
        triggerReconnect();
    });
    mqttClient.on('error', function (error) {
        console.log('### MQTT server has an error', error);
        triggerReconnect();
    });
}

function publishSonoffSensorState(sensorJson) {
    var clientId = eConf.get('sonoffPublish_prefix') + sensorJson.id;
    console.log(new Date().toLocaleString() + 'sonoff publish...');
    console.log('clientId: ' + clientId);
    console.log('topic: ' + clientId + '/STATE');
    console.log('data: ' + JSON.stringify(sensorJson));
    var sonoffMqttClient = null;
    if (clientId in mqttClientDict && mqttClientDict[clientId].connected === true) {
        sonoffMqttClient = mqttClientDict[clientId];
    } else {
        var sonoffMqttClient = mqtt.connect(eConf.get('mqtt'), {
            'clientId': clientId,
            'username': eConf.get('mqtt_username'),
            'password': eConf.get('mqtt_password'),
            'keepalive': eConf.get('keepalive'),
            'reconnectPeriod': eConf.get('reconnectPeriod')
        });
        mqttClientDict[clientId] = sonoffMqttClient;
    }
    sonoffMqttClient.publish('tele/' + clientId + '/STATE', JSON.stringify(sensorJson));
}

function sendMQTTSensorOfflineStatus(sensor, isOffline) {
    var mqttHome = eConf.get('mqtt_home');
    mqttHome = (eConf.get('publish_type') == 'sonoff' ? eConf.get('sonoffPublish_prefix') : mqttHome);
    if (!mqttHome) {
        return;
    }

    var json = sensor.json
    json.offline = isOffline
    const sensorName = eConf.get('sensors:' + sensor.ID)
    if (sensorName)
        console.log('### Offline state ', sensorName, JSON.stringify(json))
    else
        console.log('### Offline state ', sensor.ID, JSON.stringify(json))
    if (eConf.get('publish_type') == 'default') {
        mqttClient.publish(mqttHome + sensor.ID + '/json', JSON.stringify(json));
    } else if (eConf.get('publish_type') == 'sonoff') {
        publishSonoffSensorState(json);
    }
}

// send sensor info via MQTT
function sendMQTT(sensor) {
    var mqttHome = eConf.get('mqtt_home');
    mqttHome = (eConf.get('publish_type') == 'sonoff' ? eConf.get('sonoffPublish_prefix') : mqttHome);
    if (!mqttHome) {
        return;
    }

    var json = sensor.json
    json.offline = false
    const sensorName = eConf.get('sensors:' + sensor.ID)
    if (sensorName)
        console.log(sensorName, mqttHome + sensor.ID + '/json', JSON.stringify(json))
    else
        console.log(sensor.ID, mqttHome + sensor.ID + '/json', JSON.stringify(json))

    if (eConf.get('publish_type') == 'default') {
        mqttClient.publish(mqttHome + sensor.ID + '/json', JSON.stringify(json));
    } else if (eConf.get('publish_type') == 'sonoff') {
        publishSonoffSensorState(json);
    }
    /* if(sensor.sensorType == 0x08) {
        var rain = 0;
        if(lastSensorMessages[sensor.ID]) {
          const eventCounterDelta = sensor.eventCounter
              - lastSensorMessages[sensor.ID].eventCounter;
          if(eventCounterDelta > 0) {
            rain = round(0.258 * eventCounterDelta,1);
          }
        }
      }
    */
}

// send sensor info via Server POST
function sendPOST(sensor) {
    const serverPost = eConf.get('serverPost');
    if (serverPost == null) {
        return;
    }

    var json = sensor.json
    json.offline = false

    var auth = "";
    var header = {};
    if (eConf.get('serverPostUser') != null && eConf.get('serverPostPassword') != null) {
        auth = 'Basic ' + Buffer.from(eConf.get('serverPostUser') + ':' + eConf.get('serverPostPassword')).toString('base64');
        header = { 'Authorization': auth };
    }

    var options = {
        uri: serverPost,
        method: 'POST',
        headers: header,
        json: json
    };

    console.log("posting data...");
    request(options, function (error, response, body) {
        if (error || response.statusCode != 200) {
            console.log("serverPOST failed: " + error);
        }
    });

}

// #############################################################
// Mobile Alerts Sensor Code

const sensors = require('./sensors');
if (locale != null) {
    sensors.setLocale(locale);
}

var lastSensorMessages = {};
const configPath = path.join(process.env.APPDATA, 'maserver', 'lastSensorMessages.json');
try {
    if (fs.existsSync(configPath)) {
        sensorList = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        for (sensorID in sensorList) {
            buf = sensorList[sensorID].buffer;
            if (buf) {
                lastSensorMessages[sensorID] = sensors.CreateSensorObject(Buffer.from(buf.data));
                lastSensorMessages[sensorID].isOffline = sensorList[sensorID].isOffline
            }
        }
    } else {
        lastSensorMessages = {};
    }
}
catch (err) {
    console.error(err);
    lastSensorMessages = {};
}

var lastWriteTimestamp = 0;

function processSensorData(buffer) {
    var sensor = sensors.CreateSensorObject(buffer);
    if (sensor) {
        // Is the transmit ID unchanged (= is it the same package as the last one?)
        if (lastSensorMessages[sensor.ID]) {
            const lastMsg = lastSensorMessages[sensor.ID];
            const lastTx = lastMsg.tx;
            const timeDiff = Date.now() - lastMsg.unixTime_ms;
            if (lastTx == sensor.tx) {
                if(sensor.sensorType != 0x10) {     // then we ignore it!
                    return;
                }
                else {
                    if(timeDiff < 30000) {
                        return;
                    }
                }
            }               
        }

        sensor.isOffline = false;

        sendMQTT(sensor);   // send the sensor via MQTT
        sendPOST(sensor);   // send the sensor via JSON POST

        // check all sensors if they are considered offline
        // (no message within a given period)
        for (sensorID in lastSensorMessages) {
            // make sure we modify a copy
            var sensorTimeoutDate = new Date(lastSensorMessages[sensorID].unixTime);
            // add the timeout to the last time the sensor was transmitting
            // sensor timeout + a 7 minutes transmission buffer for the gateway
            sensorTimeoutDate.setMinutes(sensorTimeoutDate.getMinutes()
                + lastSensorMessages[sensorID].timeoutInMinutes);
            // compare with the current time to check for the timeout
            var currentDate = new Date();
            const isOffline = sensorTimeoutDate < currentDate;
            // status changed?
            if (lastSensorMessages[sensorID].isOffline != isOffline) {
                lastSensorMessages[sensorID].isOffline = isOffline;
                sendMQTTSensorOfflineStatus(lastSensorMessages[sensorID], isOffline);
            }
        }
        // remember this package as the new last one
        lastSensorMessages[sensor.ID] = sensor;

        // throttle writing to happen only once every 10s
        var currentTimestamp = Date.now() / 1000;
        if (lastWriteTimestamp + 10 <= currentTimestamp) {
            lastWriteTimestamp = currentTimestamp;
            // Ordner für die App definieren
            const appDir = path.join(process.env.APPDATA, 'maserver');
            // Sicherstellen, dass der Ordner existiert
            if (!fs.existsSync(appDir)) {
                fs.mkdirSync(appDir, { recursive: true });
            }
            const configPath = path.join(appDir, 'lastSensorMessages.json');
            fs.writeFile(configPath, JSON.stringify(lastSensorMessages, null, 4), 'utf8', function (error) { });
        }
    }
}

// #############################################################

// configure the Mobile Alerts Gateway to use us as a proxy server, if necessary
const publicIPv4Adress = eConf.get('publicIPv4adress')
//In case NAT is used configuration can contain public IP -> Could contain docker system public IP
const proxyListenIp = publicIPv4Adress ? publicIPv4Adress : localIPv4Adress;
console.log('### Proxy IP address:Port: ' + proxyListenIp + ':' + proxyServerPort);

var gatewayConfigClass = require('./gatewayConfig');
var gatewayConfig = new gatewayConfigClass();
gatewayConfig.configureGateways(
    localIPv4Adress
    , proxyListenIp
    , proxyServerPort
    , eConf.get('gatewayID')
    , eConf.get('logGatewayInfo')
    , eConf.get('gatewayIp')
    , eConf.get('logfile')
    , eConf.get('mobileAlertsCloudForward'),
    function (gatewayArr, servConfDict) {
        console.log('callback 1 reached');
        printGateways(gatewayArr);
        startProxy(servConfDict);
    }
);

function printGateways(gatewayConfigArrUDP) {
    console.log('found following (static) gateways:')
    for (const [gatewayID, gatewayConfigDict] of Object.entries(gatewayConfigArrUDP)) {
        console.log(gatewayID.toString() + ':');
        for (const [gatewayConfigKey, gatewayConfigValue] of Object.entries(gatewayConfigDict)) {
            console.log(gatewayConfigKey + ' :  ' + gatewayConfigValue);
        }
    }
}
function startProxy(confDict) {
    console.log('starting proxy server...');

    // setup ourselves as a proxy server for the Mobile Alerts Gateway.
    // All 64-byte packages will arrive via this function
    const proxyServerExpressApp = require('./gatewayProxyServer')(
        confDict['ip'], confDict['port']
        , confDict['log'], confDict['cloudForward']
        , function (buffer) { processSensorData(buffer); });
}

// KONFIGURATION
const GATEWAY_IP = '192.168.179.2'; // IP deines Gateways
const GATEWAY_MAC = '001d8c0e8945'; // MAC ohne Doppelpunkte eintragen

const dgram = require('dgram');

function resetGatewayConfigBE(gatewayIp, gatewayId) {
    const client = dgram.createSocket('udp4');
    const buf = Buffer.alloc(181, 0); // Initialisiere mit Nullen

    // Offset 0: Command (4) als Word (Big-Endian)
    buf.writeUInt16BE(4, 0);

    // Offset 2: Gateway ID (6 Bytes) - MAC bleibt als Byte-Folge gleich
    const idBytes = Buffer.from(gatewayId.replace(/[: -]/g, ''), 'hex');
    idBytes.copy(buf, 2);

    // Offset 8: Gesamtlänge (181) als Word (Big-Endian)
    buf.writeUInt16BE(181, 8);

    // Offset 10: Use DHCP (1 = Ja)
    buf.writeUInt8(1, 10);

    // Offset 23: Device Name (String muss mit 0-Byte enden)
    buf.write("MOBILEALERTS-Gateway", 23, 'ascii');

    // Offset 44: Data Server Name (Zwingend für Cloud-Betrieb)
    buf.write("www.data199.com", 44, 'ascii');

    // Offset 109: USE PROXY -> 0 (No)
    buf.writeUInt8(0, 109);

    // Proxy Server Name (Offset 110) und Proxy Port (Offset 175) 
    // sind durch das initial Buffer.alloc(181, 0) bereits genullt.
    // Falls du den Port explizit nullen willst:
    buf.writeUInt16BE(0, 175);

    console.log(`Sende Big-Endian Reset-Paket an ${gatewayIp}...`);

    client.send(buf, 0, buf.length, 8003, gatewayIp, (err) => {
        if (err) {
            console.error("UDP Sende-Fehler:", err);
        } else {
            console.log("Konfiguration gesendet. Prüfe das Gateway Web-Interface.");
        }
        setTimeout(() => client.close(), 500);
    });
}

function resetGatewayConfig(gatewayIp, gatewayId) {
    const client = dgram.createSocket('udp4');
    
    // 1. Buffer mit Nullen initialisieren (Ganz wichtig für die Validierung am Gateway!)
    const buf = Buffer.alloc(181, 0); 

    // Offset 0: Command (4)
    buf.writeUInt16LE(4, 0);

    // Offset 2: Gateway ID (6 Bytes) - Sicherstellen, dass es 6 Bytes sind
    const idBytes = Buffer.from(gatewayId.replace(/[: -]/g, ''), 'hex');
    console.log("gatewayId: " + gatewayId)
    console.log("gw id: " + idBytes.toString())
    console.log("length: " + idBytes.length)
    if (idBytes.length !== 6) {
        console.error("Fehler: Gateway-ID muss 6 Bytes lang sein!");
        return;
    }
    idBytes.copy(buf, 0x02, 0x02, 0x08);

    // Offset 8: Gesamtlänge (181)
    buf.writeUInt16LE(181, 8);

    // Offset 10: Use DHCP (1 = Ja)
    buf.writeUInt8(1, 10);

    // Offset 23: Device Name (Standard-String laut Sarnau)
    buf.write("MOBILEALERTS-Gateway", 23, 'ascii');

    // Offset 44: Data Server Name (Zwingend erforderlich für Cloud-Betrieb)
    buf.write("www.data199.com", 44, 'ascii');

    // Offset 109: USE PROXY (0 = AUS)
    buf.writeUInt8(0, 109);

    // Offsets 110-174 (Proxy Name) und 175 (Port) bleiben durch Buffer.alloc(0) genullt.

    console.log(`Sende Reset-Paket an ${gatewayIp} (ID: ${gatewayId})...`);

    client.send(buf, 0, buf.length, 8003, gatewayIp, (err) => {
        if (err) {
            console.error("Sende-Fehler:", err);
        } else {
            console.log("Paket gesendet. Prüfe jetzt die Gateway-Webseite (Settings).");
        }
        // Gib dem Netzwerk 500ms Zeit, bevor der Socket schließt
        setTimeout(() => client.close(), 500);
    });
}

function resetGatewayConfig2(gatewayIp, gatewayId) {
    const client = dgram.createSocket('udp4');
    const buf = Buffer.alloc(181); // Gesamtlänge laut Doku

    // Offset 0: Command (4) als Word (Little Endian)
    buf.writeUInt16LE(4, 0);

    // Offset 2: Gateway ID (6 Bytes)
    const idBytes = Buffer.from(gatewayId, 'hex');
    idBytes.copy(buf, 2);

    // Offset 8: Gesamtlänge (181)
    buf.writeUInt16LE(181, 8);

    // Offset 10: Use DHCP (Standard: 1 = Ja)
    buf.writeUInt8(1, 10);

    // Offset 23: Device Name (20 Bytes + 0-Byte)
    buf.write("MOBILEALERTS-Gateway", 23, 'ascii');

    // Offset 44: Data Server Name (Standard Cloud)
    buf.write("www.data199.com", 44, 'ascii');

    // Offset 109: USE PROXY -> 0 (Deaktivieren!)
    buf.writeUInt8(0, 109);

    // Offset 110: Proxy Server Name leeren (64 Bytes + 0-Byte)
    buf.write("", 110, 'ascii');

    // Offset 175: Proxy Port auf 0 setzen
    buf.writeUInt16LE(0, 175);

    // Paket absenden an Port 8003
    client.send(buf, 8003, gatewayIp, (err) => {
        if (err) console.error("Reset Fehler:", err);
        else console.log("Gateway-Konfiguration zurückgesetzt (Proxy AUS).");
        client.close();
    });
}

// Exit-Hook Integration
process.on('SIGINT', () => {
    // Hier deine echten Werte eintragen:
    resetGatewayConfigBE(GATEWAY_IP, GATEWAY_MAC);
    setTimeout(() => process.exit(), 500); // Kurz warten für UDP-Versand
});

process.on('SIGTERM', () => {
    // Hier deine echten Werte eintragen:
    resetGatewayConfigBE(GATEWAY_IP, GATEWAY_MAC);
    setTimeout(() => process.exit(), 500); // Kurz warten für UDP-Versand
});

process.on('SIGBREAK', () => {
    // Hier deine echten Werte eintragen:
    resetGatewayConfigBE(GATEWAY_IP, GATEWAY_MAC);
    setTimeout(() => process.exit(), 500); // Kurz warten für UDP-Versand
});

process.on('SIGHUP', () => {
    // Hier deine echten Werte eintragen:
    resetGatewayConfigBE(GATEWAY_IP, GATEWAY_MAC);
    setTimeout(() => process.exit(), 500); // Kurz warten für UDP-Versand
});


// Verhindert, dass Node sofort schließt, bevor UDP gesendet wurde
process.on('exit', (code) => {
    console.log(`Server beendet mit Code: ${code}`);
});
