'use strict';

const os = require('os');
const path = require('path');
const store = require('node-storage');
const reqson = require('request-json');

const version = require('./package.json').version;
const author = require('./package.json').author.name;

let Service;
let Characteristic;

module.exports = function(homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerAccessory(
        'homebridge-rituals',
        'Rituals',
        RitualsAccessory
    );
};

function RitualsAccessory(log, config) {
    //logger = log;
    this.log = log;
    this.services = [];
    this.hub = config.hub || '';
    var dt = Math.floor(Math.random() * 10000) + 1;

    this.log.debug('RitualsAccessory -> init :: RitualsAccessory(log, config)');

    this.storage = new store(
        path.join(os.homedir(), '.homebridge') + '/.uix-rituals-secrets_' + this.hub
    );
    this.user =
        path.join(os.homedir(), '.homebridge') +
        '/.uix-rituals-secrets_' +
        this.hub;
    this.log.debug('RitualsAccessory -> storage path is :: ' + this.user);

    this.on_state;
    this.fan_speed;
    this.account = config.account;
    this.password = config.password;

    this.key = this.storage.get('key') || 0;
    this.log.debug('RitualsAccessory -> key :: ' + this.key);

    this.name = this.storage.get('name') || config.name || 'Genie';
    this.log.debug('RitualsAccessory -> name :: ' + this.name);

    this.hublot = this.storage.get('hublot') || 'SN_RND' + dt;
    this.log.debug('RitualsAccessory -> hublot :: ' + this.hublot);

    this.version = this.storage.get('version') || version;
    this.log.debug('RitualsAccessory -> version :: ' + this.version);

    this.fragance = this.storage.get('fragance') || 'N/A';
    this.log.debug('RitualsAccessory -> fragance :: ' + this.fragance);

    var determinate_model = this.version.split('.');
    if (determinate_model[determinate_model.length - 1] < 12) {
        this.model_version = '1.0';
    } else {
        this.model_version = '2.0';
    }

    this.service = new Service.Fan(this.name, 'AirFresher');
    this.service
        .getCharacteristic(Characteristic.On)
        .on('get', this.getCurrentState.bind(this))
        .on('set', this.setActiveState.bind(this));

    this.service
        .getCharacteristic(Characteristic.RotationSpeed)
        .setProps({
            minValue: 1,
            maxValue: 3,
        })
        .on('get', (callback) => callback(null, this.fan_speed))
        .on('set', this.setFanSpeed.bind(this));

    this.serviceInfo = new Service.AccessoryInformation();
    this.serviceInfo
        .setCharacteristic(Characteristic.Manufacturer, author)
        .setCharacteristic(
            Characteristic.Model,
            'Rituals Genie ' + this.model_version
        )
        .setCharacteristic(Characteristic.SerialNumber, this.hublot)
        .setCharacteristic(Characteristic.FirmwareRevision, this.version);

    if (this.model_version == '1.0') {
        this.serviceBatt = new Service.BatteryService('Battery', 'AirFresher');
        this.serviceBatt
            .setCharacteristic(Characteristic.BatteryLevel, '100')
            .setCharacteristic(
                Characteristic.ChargingState,
                Characteristic.ChargingState.CHARGING
            )
            .setCharacteristic(
                Characteristic.StatusLowBattery,
                Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL
            )
            .setCharacteristic(Characteristic.Name, 'Genie Battery');
    }

    this.serviceFilter = new Service.FilterMaintenance('Filter', 'AirFresher');
    this.serviceFilter
        .setCharacteristic(
            Characteristic.FilterChangeIndication,
            Characteristic.FilterChangeIndication.FILTER_OK
        )
        .setCharacteristic(Characteristic.Name, this.fragance);

    //ChargingState.NOT_CHARGING (0)
    //ChargingState.CHARGING (1)
    //ChargingState.NOT_CHARGAEABLE (2)
    //StatusLowBattery.BATTERY_LEVEL_NORMAL (0)
    //StatusLowBattery.BATTERY_LEVEL_LOW (1)

    this.services.push(this.service);
    this.services.push(this.serviceInfo);
    if (this.serviceBatt) this.services.push(this.serviceBatt);
    this.services.push(this.serviceFilter);

    // Add cache variables
    this.cache = {};
    this.cacheTimestamp = {};
    this.cacheDuration = 6 * 1000; // Cache duration in milliseconds (e.g., 6 seconds)

    this.retryCount = 0;
    this.maxRetries = 3;
    this.retryDelay = 10000; // 10 Sekunden

    this.discover();

    this.log.debug('RitualsAccessory -> finish :: RitualsAccessory(log, config)');
}

RitualsAccessory.prototype = {
    discover: function () {
        this.log.debug('RitualsAccessory -> init :: discover()');

        const storedToken = this.storage.get('token');
        const storedHub = this.storage.get('hub');
        this.token = storedToken || null;

        // Fallback: Hub aus Storage validieren
        if (!storedHub) {
            this.log.warn('Kein Hub im Speicher gefunden. Wahrscheinlich Erststart.');
        } else {
            this.log.debug(`Hub aus Speicher geladen: ${storedHub}`);
        }

        // Token validieren
        if (!this.token) {
            this.log.debug('Kein gültiger Token gefunden – starte Authentifizierung...');
            this.authenticateV2();
        } else {
            this.log.debug('Token vorhanden – versuche Zugriff auf Hub-Daten');
            this.getHub(); // diese Methode macht jetzt den echten Request via makeAuthenticatedRequest
        }

        this.log.debug('RitualsAccessory -> finish :: discover()');
    },

    makeAuthenticatedRequest: function (method, path, data, callback, retry = true) {
        const that = this;
        const token = this.token || this.storage.get('token');

        if (!token) {
            this.log.warn('Kein gültiger Token vorhanden. Versuche Authentifizierung...');
            this.authenticateV2AndThen(() => {
                that.makeAuthenticatedRequest(method, path, data, callback, false);
            });
            return;
        }

        const client = reqson.createClient('https://rituals.sense-company.com/');
        client.headers['Authorization'] = token;

        const requestCallback = function (err, res, body) {
            if (err) {
                that.log.warn(`${method.toUpperCase()} ${path} fehlgeschlagen: ${err}`);
                callback(err, null);
                return;
            }

            if (res.statusCode === 401 && retry) {
                that.log.warn(`401 Unauthorized für ${path}. Versuche Token neu zu holen...`);
                that.storage.remove('token');
                that.token = null;

                that.authenticateV2AndThen(() => {
                    that.makeAuthenticatedRequest(method, path, data, callback, false);
                });
                return;
            }

            if (res.statusCode >= 400) {
                that.log.warn(`Fehler ${res.statusCode} bei ${method.toUpperCase()} ${path}`);

                // Mehr Details
                if (body) {
                    that.log.debug(`Fehlermeldung Body: ${JSON.stringify(body)}`);
                }
                if (res && res.headers) {
                    that.log.debug(`Fehlermeldung Headers: ${JSON.stringify(res.headers)}`);
                }

                callback(new Error(`HTTP ${res.statusCode} – ${JSON.stringify(body)}`), null);
                return;
            }

            callback(null, body);
        };

        if (method === 'get') {
            client.get(path, requestCallback);
        } else if (method === 'post') {
            // URL-encoded senden
            client.headers['Content-Type'] = 'application/x-www-form-urlencoded';

            const querystring = require('querystring');
            const encodedData = typeof data === 'string' ? data : querystring.stringify(data);

            client.post(path, encodedData, requestCallback);
        } else {
            this.log.error('Ungültige HTTP-Methode: ' + method);
        }
    },

    authenticateV2AndThen: function (next) {
        const that = this;

        if (this.retryCount >= this.maxRetries) {
            this.log.error('Authentifizierung fehlgeschlagen nach mehreren Versuchen. Abbruch.');
            return;
        }

        const client = reqson.createClient('https://rituals.sense-company.com/');
        const data = { email: this.account, password: this.password };

        client.post('apiv2/account/token', data, function (err, res, body) {
            if (err || res.statusCode !== 200 || !body.success) {
                that.retryCount++;
                that.log.warn(`Token holen fehlgeschlagen (Versuch ${that.retryCount}): ${err || res.statusCode}`);
                setTimeout(() => that.authenticateV2AndThen(next), that.retryDelay);
                return;
            }

            that.token = body.success;
            that.storage.put('token', that.token);
            that.retryCount = 0;

            that.log.debug('Token erfolgreich geholt: ' + that.token);
            next();
        });
    },

    authenticateV2: function () {
        const that = this;

        // Wenn wir schon zu oft probiert haben, abbrechen
        if (this.retryCount >= this.maxRetries) {
            this.log.error('Authentifizierung fehlgeschlagen nach mehreren Versuchen. Vorgang abgebrochen.');
            return;
        }

        this.log.debug(`Authentifizierung Versuch ${this.retryCount + 1}/${this.maxRetries}`);

        const client = reqson.createClient('https://rituals.sense-company.com/');
        const data = { email: this.account, password: this.password };

        client.post('apiv2/account/token', data, function (err, res, body) {
            if (err || res.statusCode !== 200) {
                that.log.warn(`Authentifizierung HTTP-Fehler: ${err || 'Status ' + res.statusCode}`);
                if (body) that.log.debug('Body:', JSON.stringify(body));
                that._scheduleRetry();
                return;
            }

            if (!body || typeof body.success !== 'string') {
                const msg = body?.message || 'kein success-Token';
                that.log.warn(`Authentifizierung abgelehnt: ${msg}`);
                that.log.debug('Server-Body:', JSON.stringify(body));

                // Wenn Rate-Limit gemeldet, nextRetryDelay anpassen:
                const m = /(\d+)\s+seconds/.exec(msg);
                if (m) {
                    const wait = parseInt(m[1], 10) * 1000;
                    that.log.info(`Nächster Versuch in ${m[1]} s (Rate-Limit)`);
                    setTimeout(() => that.authenticateV2(), wait);
                } else {
                    that._scheduleRetry();
                }
                return;
            }

            // erfolgreich
            that.token = body.success;
            that.storage.put('token', that.token);
            that.retryCount = 0;
            that.log.debug('Neuer Token erhalten:', that.token);
            that.getHub();
        });
    },

    // Hilfs-Methode, um standardisiert nach retryDelay erneut zu versuchen
    _scheduleRetry: function() {
        this.retryCount++;
        setTimeout(() => this.authenticateV2(), this.retryDelay);
    },

    getHub: function () {
        const that = this;
        this.log.debug('RitualsAccessory -> init :: getHub()');

        const now = Date.now();
        if (this.cacheTimestamp.getHub && (now - this.cacheTimestamp.getHub) < this.cacheDuration) {
            that.log.debug('Using cached data for getHub');
            that.applyHubData(this.cache.getHubData);
            return;
        }

        this.makeAuthenticatedRequest('get', 'apiv2/account/hubs', null, function (err, body) {
            if (err) {
                that.log.info(`${that.name} :: ERROR :: apiv2/account/hubs :: getHub() > ${err}`);
                return;
            }

            if (!Array.isArray(body)) {
                that.log.warn('Ungültige Antwortstruktur erhalten, keine Hubs gefunden.');
                return;
            }

            that.log.debug(`RitualsAccessory -> apiv2/account/hubs OK :: ${body.length} Genies gefunden`);

            // Cache speichern
            that.cache.getHubData = body;
            that.cacheTimestamp.getHub = now;

            that.applyHubData(body);
        });

        this.log.debug('RitualsAccessory -> finish :: getHub()');
    },

    applyHubData: function(body) {
        const that = this;

        if (!Array.isArray(body) || body.length === 0) {
            that.log.warn('Keine Genies im Account gefunden.');
            return;
        }

        if (body.length === 1) {
            const hub = body[0];
            that.key = 0;
            that.name = hub.attributeValues?.roomnamec || 'Genie';
            that.hublot = hub.hublot;
            that.hub = hub.hash;

            that.storage.put('key', that.key);
            that.storage.put('name', that.name);
            that.storage.put('hublot', that.hublot);
            that.storage.put('hub', that.hub);

            // TODO
            that.fragance = 'Unknown';
            that.storage.put('fragance', that.fragance);

            that.log.debug('RitualsAccessory -> hub 1 genie updated');
        } else {
            let found = false;

            Object.keys(body).forEach(function(key) {
                const hub = body[key];
                if (hub.hash === that.hub) {
                    found = true;
                    that.key = key;
                    that.name = hub.attributeValues?.roomnamec || 'Genie';
                    that.hublot = hub.hublot;
                    that.fragance = 'Unknown';

                    that.storage.put('key', key);
                    that.storage.put('name', that.name);
                    that.storage.put('hublot', that.hublot);
                    that.storage.put('fragance', that.fragance);

                    that.log.debug('RitualsAccessory -> HUB matched and preferences stored');
                }
            });

            if (!found) {
                that.log.info('************************************************');
                that.log.info('HUB in Config NOT validated or missing.');
                that.log.info('Multiple Genies found, select correct one in config.json.');
                that.log.info('************************************************');
                Object.keys(body).forEach(function(key) {
                    const hub = body[key];
                    that.log.info('********************');
                    that.log.info('Name   : ' + (hub.attributeValues?.roomnamec || 'Unknown'));
                    that.log.info('Hublot : ' + hub.hublot);
                    that.log.info('Hub    : ' + hub.hash);
                    that.log.info('Key    : ' + key);
                });
                that.log.info('************************************************');
            }
        }
    },

    getCurrentState: function(callback) {
        const that = this;
        this.log.debug('RitualsAccessory -> init :: getCurrentState()');

        const now = Date.now();
        if (this.cacheTimestamp.getCurrentState && (now - this.cacheTimestamp.getCurrentState) < this.cacheDuration) {
            that.log.debug('Using cached data for getCurrentState');
            callback(null, this.cache.on_state);
            return;
        }

        const hub = that.storage.get('hub');
        that.log.debug(`Abrufen des aktuellen Status für Hub: ${hub}`);

        that.makeAuthenticatedRequest('get', `apiv2/hubs/${hub}/attributes/fanc`, null, function(err1, fancRes) {
            if (err1) {
                that.log.debug(`Fehler beim Abrufen von fanc: ${err1}`);
                return callback(err1);
            }

            that.log.debug(`fancRes erhalten: ${JSON.stringify(fancRes)}`);

            that.on_state = fancRes.value === '1';

            if (that.on_state) {
                // Nur wenn eingeschaltet, speedc abrufen
                that.makeAuthenticatedRequest('get', `apiv2/hubs/${hub}/attributes/speedc`, null, function(err2, speedRes) {
                    if (err2) {
                        that.log.debug(`Fehler beim Abrufen von speedc: ${err2}`);
                        return callback(err2);
                    }

                    that.log.debug(`speedRes erhalten: ${JSON.stringify(speedRes)}`);

                    that.fan_speed = parseInt(speedRes.value);
                    that.cache.fan_speed = that.fan_speed;
                    that.cache.on_state = that.on_state;
                    that.cacheTimestamp.getCurrentState = now;

                    that.log.debug(`Aktueller Zustand -> on_state: ${that.on_state}, fan_speed: ${that.fan_speed}`);

                    callback(null, that.on_state);
                });
            } else {
                // Ausgeschaltet → keine speedc-Abfrage
                that.fan_speed = 0;
                that.cache.fan_speed = that.fan_speed;
                that.cache.on_state = that.on_state;
                that.cacheTimestamp.getCurrentState = now;

                that.log.debug(`Aktueller Zustand -> on_state: ${that.on_state}, fan_speed: ${that.fan_speed}`);

                callback(null, that.on_state);
            }
        });

        this.log.debug('RitualsAccessory -> finish :: getCurrentState()');
    },

    setActiveState: function(active, callback) {
        const that = this;
        const hub = that.hub;
        const setValue = active ? '1' : '0';

        this.log.info(`${that.name} :: Set ActiveState to => ${setValue}`);

        const path = `apiv2/hubs/${hub}/attributes/fanc`;  // KEIN fanc in body + URL
        const body = `fanc=${setValue}`; // URL-encoded (kein JSON)

        this.makeAuthenticatedRequest('post', path, body, function(err, response) {
            if (err) {
                that.log.warn(`Set ActiveState fehlgeschlagen mit Fehler: ${err.message}`);
                return callback(err, that.on_state);
            }

            that.on_state = active;
            that.cache.on_state = active;
            that.cacheTimestamp.getCurrentState = Date.now();

            callback(null, active);
        });
    },

    setFanSpeed: function(value, callback) {
        const that = this;
        const hub = that.hub;
        const body = `speedc=${value.toString()}`;

        this.log.info(`${that.name} :: Set FanSpeed to => ${value}`);

        this.makeAuthenticatedRequest('post', `apiv2/hubs/${hub}/attributes/speedc`, body, function(err, response) {
            if (err) return callback(err, that.fan_speed);

            that.fan_speed = value;
            that.cache.fan_speed = value;
            that.cacheTimestamp.getCurrentState = Date.now();

            callback(null, value);
        });
    },

    identify: function(callback) {
        callback();
    },

    getServices: function() {
        return this.services;
    },
};