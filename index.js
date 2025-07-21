'use strict';

const os = require('os');
const path = require('path');
const store = require('node-storage');
// const reqson = require('request-json');
const axios = require('axios');
const qs = require('querystring');

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

    // Add cache variables
    this.cache = {};
    this.cacheTimestamp = {};
    this.cacheDuration = 6 * 1000; // Cache duration in milliseconds (e.g., 6 seconds)

    this.retryCount = 0;
    this.maxRetries = 3;
    this.retryDelay = 10000; // 10 Sekunden

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
            minStep: 1
        })
        .on('get', (callback) => {
            // Wenn der Ventilator aus ist, liefere einen gültigen Minimalwert
            const speed = this.on_state ? (this.fan_speed ?? 1) : 1;
            callback(null, speed);
        })
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

    //ChargingState.NOT_CHARGING (0)
    //ChargingState.CHARGING (1)
    //ChargingState.NOT_CHARGAEABLE (2)
    //StatusLowBattery.BATTERY_LEVEL_NORMAL (0)
    //StatusLowBattery.BATTERY_LEVEL_LOW (1)

    // FilterMaintenance-Service: Füllstand + Duft anzeigen
    this.serviceFilter = new Service.FilterMaintenance('Filter', 'AirFresher');

    // Default-Duft aus dem Speicher nehmen
    this.serviceFilter.setCharacteristic(Characteristic.Name, this.fragance);

    // Füllstand als FilterLifeLevel in % (0 = leer, 100 = voll)
    this.serviceFilter
        .getCharacteristic(Characteristic.FilterLifeLevel)
        .on('get', this.getFillState.bind(this));

    // Wenn der Füllstand niedrig ist, Wartung auslösen
    this.serviceFilter
        .getCharacteristic(Characteristic.FilterChangeIndication)
        .on('get', (callback) => {
            const level = this.cache.fill_level || 100;
            const indication = (level <= 20)
                ? Characteristic.FilterChangeIndication.CHANGE_FILTER
                : Characteristic.FilterChangeIndication.FILTER_OK;
            callback(null, indication);
        });

    this.services.push(this.service);
    this.services.push(this.serviceInfo);
    if (this.serviceBatt) this.services.push(this.serviceBatt);
    this.services.push(this.serviceFilter);

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
            this.log.warn('Kein gültiger Token vorhanden → authentifiziere …');
            return this.authenticateV2AndThen(() => {
                that.makeAuthenticatedRequest(method, path, data, callback, false);
            });
        }

        const url = 'https://rituals.sense-company.com/' + path;

        const headers = {
            'Authorization': token,
            'Accept': '*/*'
        };

        const config = {
            method: method,
            url: url,
            headers: headers,
        };

        if (method === 'post') {
            const bodyStr = typeof data === 'string'
                ? data
                : qs.stringify(data);

            headers['Content-Type'] = 'application/x-www-form-urlencoded';
            config.data = bodyStr;

            that.log.warn('==== REQUEST DUMP =================================');
            that.log.warn('URL     : ' + url);
            that.log.warn('Method  : POST');
            that.log.warn('Headers : ' + JSON.stringify(headers));
            that.log.warn('BodyHex : ' + Buffer.from(bodyStr).toString('hex'));
            that.log.warn('BodyUtf8: ' + bodyStr);
            that.log.warn('===============================================');
        }

        if (method === 'get') {
            that.log.debug(`→ GET ${path}`);
        }

        axios(config).then(response => {
            callback(null, response.data);
        }).catch(error => {
            if (error.response) {
                const res = error.response;

                if (res.status === 401 && retry) {
                    that.log.warn(`401 Unauthorized für ${path} – hole neuen Token`);
                    that.storage.remove('token');
                    that.token = null;
                    return that.authenticateV2AndThen(() => {
                        that.makeAuthenticatedRequest(method, path, data, callback, false);
                    });
                }

                that.log.warn(`Fehler ${res.status} bei ${method.toUpperCase()} ${path}`);
                that.log.debug('Body:    ' + JSON.stringify(res.data));
                that.log.debug('Headers: ' + JSON.stringify(res.headers));
                return callback(new Error(`HTTP ${res.status} – ${JSON.stringify(res.data)}`));
            } else {
                that.log.warn(`${method.toUpperCase()} ${path} fehlgeschlagen: ${error}`);
                return callback(error);
            }
        });
    },

    authenticateV2AndThen: function (next) {
        const that = this;

        if (this.retryCount >= this.maxRetries) {
            this.log.error('Authentifizierung fehlgeschlagen nach mehreren Versuchen. Abbruch.');
            return;
        }

        const url = 'https://rituals.sense-company.com/apiv2/account/token';
        const data = {
            email: this.account,
            password: this.password
        };

        axios.post(url, data)
            .then(response => {
                const body = response.data;

                if (!body.success) {
                    throw new Error('Kein success-Token erhalten');
                }

                that.token = body.success;
                that.storage.put('token', that.token);
                that.retryCount = 0;

                that.log.debug('Token erfolgreich geholt: ' + that.token);
                next();
            })
            .catch(err => {
                that.retryCount++;
                const status = err.response?.status || 'keine Antwort';
                that.log.warn(`Token holen fehlgeschlagen (Versuch ${that.retryCount}): ${status}`);
                setTimeout(() => that.authenticateV2AndThen(next), that.retryDelay);
            });
    },

    authenticateV2: function () {
        const that = this;

        if (this.retryCount >= this.maxRetries) {
            this.log.error('Authentifizierung fehlgeschlagen nach mehreren Versuchen. Vorgang abgebrochen.');
            return;
        }

        this.log.debug(`Authentifizierung Versuch ${this.retryCount + 1}/${this.maxRetries}`);

        const url = 'https://rituals.sense-company.com/apiv2/account/token';
        const data = {
            email: this.account,
            password: this.password
        };

        axios.post(url, data)
            .then(response => {
                const body = response.data;

                if (!body || typeof body.success !== 'string') {
                    const msg = body?.message || 'kein success-Token';
                    that.log.warn(`Authentifizierung abgelehnt: ${msg}`);
                    that.log.debug('Server-Body:', JSON.stringify(body));

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

                that.token = body.success;
                that.storage.put('token', that.token);
                that.retryCount = 0;
                that.log.debug('Neuer Token erhalten:', that.token);
                that.getHub();
            })
            .catch(err => {
                const status = err.response?.status || 'Netzwerkfehler';
                that.log.warn(`Authentifizierung HTTP-Fehler: ${status}`);
                if (err.response?.data) that.log.debug('Body:', JSON.stringify(err.response.data));
                that._scheduleRetry();
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
                // Nur wenn eingeschaltet, speedc abrufen TODO: Returns {}
                that.makeAuthenticatedRequest('get', `apiv2/hubs/${hub}/attributes/speedc`, null, function(err2, speedRes) {
                    if (err2) {
                        that.log.debug(`Fehler beim Abrufen von speedc: ${err2}`);
                        return callback(err2);
                    }

                    that.log.debug(`speedRes erhalten: ${JSON.stringify(speedRes)}`);

                    if (that.on_state) {
                        that.fan_speed = parseInt(speedRes.value) || 1; // wenn API leer, mind. 1
                    } else {
                        that.fan_speed = 1; // wenn aus, trotzdem min gültiger Wert
                    }
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

    getFillState: function(callback) {
        const that = this;
        this.log.debug('RitualsAccessory -> init :: getFillState()');

        const now = Date.now();
        if (this.cacheTimestamp.getFillState && (now - this.cacheTimestamp.getFillState) < this.cacheDuration) {
            that.log.debug('Using cached data for getFillState');

            // Zusätzlich sicherstellen, dass der Duftname in HomeKit aktuell ist
            if (this.cache.fragrance_name) {
                this.serviceFilter.updateCharacteristic(Characteristic.Name, this.cache.fragrance_name);
            }

            return callback(null, this.cache.fill_level);
        }

        const hub = that.storage.get('hub');
        that.log.debug(`Abrufen des Füllstands für Hub: ${hub}`);

        // 1. Fill-Level holen
        that.makeAuthenticatedRequest('get', `apiv2/hubs/${hub}/sensors/fillc`, null, function(err, fillRes) {
            if (err) {
                that.log.debug(`Fehler beim Abrufen von fillc: ${err}`);
                return callback(err);
            }

            that.log.debug(`fillRes erhalten: ${JSON.stringify(fillRes)}`);

            // fillRes.title ist z.B. "50-60%"
            let fillPercent = 0;
            if (fillRes && fillRes.title) {
                const match = fillRes.title.match(/(\d+)-(\d+)%/);
                if (match) {
                    // Mittelwert aus der Range
                    const low = parseInt(match[1], 10);
                    const high = parseInt(match[2], 10);
                    fillPercent = Math.round((low + high) / 2);
                } else {
                    // Falls nur ein einzelner Wert wie "80%" kommt
                    const singleMatch = fillRes.title.match(/(\d+)%/);
                    if (singleMatch) {
                        fillPercent = parseInt(singleMatch[1], 10);
                    }
                }
            }

            // Clamp auf 0–100, falls was schiefgeht
            if (fillPercent < 0 || fillPercent > 100) {
                fillPercent = 0;
            }

            // Cache speichern
            that.cache.fill_level = fillPercent;
            that.cacheTimestamp.getFillState = now;

            that.log.debug(`Aktueller Füllstand -> ${fillPercent}%`);

            // 2. Duftnote abrufen
            that.makeAuthenticatedRequest('get', `apiv2/hubs/${hub}/sensors/rfidc`, null, function(err2, fragRes) {
                if (!err2 && fragRes && fragRes.title) {
                    const fragranceName = fragRes.title;
                    that.cache.fragrance_name = fragranceName;
                    that.log.debug(`Aktuelle Duftnote -> ${fragranceName}`);

                    // HomeKit Filter-Namen aktualisieren
                    that.serviceFilter.updateCharacteristic(Characteristic.Name, fragranceName);
                } else if (err2) {
                    that.log.debug(`Fehler beim Abrufen von rfidc: ${err2}`);
                }

                // Jetzt Callback mit Füllstand zurückgeben
                callback(null, fillPercent);
            });
        });

        this.log.debug('RitualsAccessory -> finish :: getFillState()');
    },

    setActiveState: function(active, callback) {
        const that = this;
        const hub = that.hub;
        const setValue = active ? '1' : '0';

        const path = `apiv2/hubs/${hub}/attributes/fanc`;
        const body = qs.stringify({ fanc: setValue });

        this.log.info(`${that.name} :: Set ActiveState to => ${setValue}`);
        this.log.debug(`POST URL: ${path}`);
        this.log.debug(`POST Body (x-www-form-urlencoded): ${body}`);

        this.makeAuthenticatedRequest('post', path, body, function(err, response) {
            if (err) {
                that.log.warn(`Set ActiveState fehlgeschlagen mit Fehler: ${err.message}`);
                return callback(err, that.on_state);
            }

            that.log.debug(`Antwort von Server: ${JSON.stringify(response)}`);

            that.on_state = active;
            that.cache.on_state = active;
            that.cacheTimestamp.getCurrentState = Date.now();

            callback(null, active);
        });
    },

    setFanSpeed: function(value, callback) {
        const that = this;

        this.log.info(`${that.name} :: Set FanSpeed to => ${value}`);

        // Wenn Fan aus, erst einschalten
        if (!that.on_state) {
            this.log.debug('Fan ist aus – schalte zuerst ein');

            return this.setActiveState(true, function(err) {
                if (err) {
                    that.log.error(`Einschalten vor Speed-Setzen fehlgeschlagen: ${err.message}`);
                    return callback(err, that.fan_speed);
                }

                // Jetzt FanSpeed setzen
                that.setFanSpeed(value, callback);
            });
        }

        // Fan ist an – direkt FanSpeed setzen
        const hub = that.hub;
        const body = qs.stringify({ speedc: value.toString() });
        const url = `apiv2/hubs/${hub}/attributes/speedc`;

        that.log.debug(`POST URL: ${url}`);
        that.log.debug(`POST Body (x-www-form-urlencoded): ${body}`);

        that.makeAuthenticatedRequest('post', url, body, function(err, response) {
            if (err) {
                that.log.error(`Fehler beim Setzen der FanSpeed: ${err.message}`);
                return callback(err, that.fan_speed);
            }

            that.log.debug(`Antwort von Server: ${JSON.stringify(response)}`);

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