'use strict';

const os = require('os');
const path = require('path');
const store = require('node-storage');
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
        'homebridge-rituals-apiv2',
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
            minValue: 0,   // HomeKit needs 0–100 %
            maxValue: 100,
            minStep: 1
        })
        .on('get', (callback) => {
            // If off -> 0%, otherwise mapping 1..3 -> percentage values
            if (!this.on_state) return callback(null, 0);
            const speed = this.fan_speed ?? 1; // 1..3
            const pct = speed === 1 ? 33 : speed === 2 ? 66 : 100;
            callback(null, pct);
        })
        .on('set', (value, callback) => {
            // 1-3 intern values
            const pct = Number(value);
            const mapped =
                pct <= 33 ? 1 :
                    pct <= 66 ? 2 : 3;

            this.setFanSpeed(mapped, callback);
        });

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

    // FilterMaintenance service: display fill level + scent
    this.serviceFilter = new Service.FilterMaintenance('Filter', 'AirFresher');

    // Retrieve the default scent from memory
    this.serviceFilter.setCharacteristic(Characteristic.Name, this.fragance);

    // Fill level as FilterLifeLevel in % (0 = empty, 100 = full)
    this.serviceFilter
        .getCharacteristic(Characteristic.FilterLifeLevel)
        .on('get', this.getFillState.bind(this));

    // Trigger maintenance when the fill level is low
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

        // Fallback: validate hub from storage
        if (!storedHub) {
            this.log.warn('No hub found in storage. Probably first start.');
        } else {
            this.log.debug(`Hub loaded from storage: ${storedHub}`);
        }

        // Validate token
        if (!this.token) {
            this.log.debug('No valid token found – starting authentication…');
            this.authenticateV2();
        } else {
            this.log.debug('Token available – attempting to access hub data');
            this.getHub(); // diese Methode macht jetzt den echten Request via makeAuthenticatedRequest
        }

        this.log.debug('RitualsAccessory -> finish :: discover()');
    },

    makeAuthenticatedRequest: function (method, path, data, callback, retry = true) {
        const that = this;
        const token = this.token || this.storage.get('token');

        if (!token) {
            this.log.warn('No valid token available → authenticating…');
            return this.authenticateV2AndThen(() => {
                that.makeAuthenticatedRequest(method, path, data, callback, false);
            });
        }

        const url = 'https://rituals.apiv2.sense-company.com/' + path;

        const headers = {
            'Authorization': token,
            'Accept': '*/*'
        };

        const config = {
            method: method,
            url: url,
            headers: headers,
            timeout: 5000
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
                    that.log.warn(`401 Unauthorized for ${path} - fetching new token`);
                    that.storage.remove('token');
                    that.token = null;
                    return that.authenticateV2AndThen(() => {
                        that.makeAuthenticatedRequest(method, path, data, callback, false);
                    });
                }

                that.log.warn(`Error ${res.status} in ${method.toUpperCase()} ${path}`);
                that.log.debug('Body:    ' + JSON.stringify(res.data));
                that.log.debug('Headers: ' + JSON.stringify(res.headers));
                return callback(new Error(`HTTP ${res.status} – ${JSON.stringify(res.data)}`));
            } else {
                that.log.warn(`${method.toUpperCase()} ${path} failed: ${error}`);
                return callback(error);
            }
        });
    },

    authenticateV2AndThen: function (next) {
        const that = this;

        if (this.retryCount >= this.maxRetries) {
            this.log.error('Authentication failed after multiple attempts. Aborting..');
            return;
        }

        const url = 'https://rituals.apiv2.sense-company.com/apiv2/account/token';
        const data = {
            email: this.account,
            password: this.password
        };

        axios.post(url, data)
            .then(response => {
                const body = response.data;

                if (!body.success) {
                    throw new Error('No success token received');
                }

                that.token = body.success;
                that.storage.put('token', that.token);
                that.retryCount = 0;

                that.log.debug('Token successfully retrieved: ' + that.token);
                next();
            })
            .catch(err => {
                that.retryCount++;
                const status = err.response?.status || 'no response';
                that.log.warn(`Token retrieval failed (attempt ${that.retryCount}): ${status}`);
                setTimeout(() => that.authenticateV2AndThen(next), that.retryDelay);
            });
    },

    authenticateV2: function () {
        const that = this;

        if (this.retryCount >= this.maxRetries) {
            this.log.error('Authentication failed after multiple attempts. Process aborted.');
            return;
        }

        this.log.debug(`Authentication attempt ${this.retryCount + 1}/${this.maxRetries}`);

        const url = 'https://rituals.apiv2.sense-company.com/apiv2/account/token';
        const data = {
            email: this.account,
            password: this.password
        };

        axios.post(url, data)
            .then(response => {
                const body = response.data;

                if (!body || typeof body.success !== 'string') {
                    const msg = body?.message || 'no success token';
                    that.log.warn(`Authentication denied: ${msg}`);
                    that.log.debug('Server-Body:', JSON.stringify(body));

                    const m = /(\d+)\s+seconds/.exec(msg);
                    if (m) {
                        const wait = parseInt(m[1], 10) * 1000;
                        that.log.info(`Next attempt in ${m[1]} s`);
                        setTimeout(() => that.authenticateV2(), wait);
                    } else {
                        that._scheduleRetry();
                    }
                    return;
                }

                that.token = body.success;
                that.storage.put('token', that.token);
                that.retryCount = 0;
                that.log.debug('New token received:', that.token);
                that.getHub();
            })
            .catch(err => {
                const status = err.response?.status || 'Network error';
                that.log.warn(`Authentication HTTP error: ${status}`);
                if (err.response?.data) that.log.debug('Body:', JSON.stringify(err.response.data));
                that._scheduleRetry();
            });
    },

    // Helper method to retry after retryDelay in a standardized way
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
                that.log.warn('Invalid response structure received, no hubs found.');
                return;
            }

            that.log.debug(`RitualsAccessory -> apiv2/account/hubs OK :: ${body.length} Genies found`);

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
            that.log.warn('No Genies found in the account.');
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
        that.log.debug(`Retrieving the current status for hub: ${hub}`);

        that.makeAuthenticatedRequest('get', `apiv2/hubs/${hub}/attributes/fanc`, null, function(err1, fancRes) {
            if (err1) {
                that.log.debug(`Error while retrieving fanc: ${err1}`);
                return callback(err1);
            }

            that.log.debug(`fancRes received: ${JSON.stringify(fancRes)}`);

            that.on_state = fancRes.value === '1';

            if (that.on_state) {
                // Nur wenn eingeschaltet, speedc abrufen TODO: Returns {}
                that.makeAuthenticatedRequest('get', `apiv2/hubs/${hub}/attributes/speedc`, null, function(err2, speedRes) {
                    if (err2) {
                        that.log.debug(`Error while retrieving speedc: ${err2}`);
                        return callback(err2);
                    }

                    that.log.debug(`speedRes received: ${JSON.stringify(speedRes)}`);

                    if (that.on_state) {
                        that.fan_speed = parseInt(speedRes.value) || 1; // wenn API leer, mind. 1
                    } else {
                        that.fan_speed = 1; // wenn aus, trotzdem min gültiger Wert
                    }
                    that.cache.fan_speed = that.fan_speed;
                    that.cache.on_state = that.on_state;
                    that.cacheTimestamp.getCurrentState = now;

                    that.log.debug(`Current status -> on_state: ${that.on_state}, fan_speed: ${that.fan_speed}`);

                    callback(null, that.on_state);
                });
            } else {
                // Ausgeschaltet → keine speedc-Abfrage
                that.fan_speed = 0;
                that.cache.fan_speed = that.fan_speed;
                that.cache.on_state = that.on_state;
                that.cacheTimestamp.getCurrentState = now;

                that.log.debug(`Current status -> on_state: ${that.on_state}, fan_speed: ${that.fan_speed}`);

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
        that.log.debug(`Retrieving fill level for hub: ${hub}`);

        // 1. Retrieve fill level
        that.makeAuthenticatedRequest('get', `apiv2/hubs/${hub}/sensors/fillc`, null, function(err, fillRes) {
            if (err) {
                that.log.debug(`Error while retrieving fillc: ${err}`);
                return callback(err);
            }

            that.log.debug(`fillRes received: ${JSON.stringify(fillRes)}`);

            // fillRes.title is e.g. “50-60%”
            let fillPercent = 0;
            if (fillRes && fillRes.title) {
                const match = fillRes.title.match(/(\d+)-(\d+)%/);
                if (match) {
                    // Average value from the range
                    const low = parseInt(match[1], 10);
                    const high = parseInt(match[2], 10);
                    fillPercent = Math.round((low + high) / 2);
                } else {
                    // In case only a single value like “80%” is returned
                    const singleMatch = fillRes.title.match(/(\d+)%/);
                    if (singleMatch) {
                        fillPercent = parseInt(singleMatch[1], 10);
                    }
                }
            }

            // Clamp to 0–100 in case something goes wrong
            if (fillPercent < 0 || fillPercent > 100) {
                fillPercent = 0;
            }

            // Save cache
            that.cache.fill_level = fillPercent;
            that.cacheTimestamp.getFillState = now;

            that.log.debug(`Current fill level -> ${fillPercent}%`);

            // 2. Retrieve fragrance note
            that.makeAuthenticatedRequest('get', `apiv2/hubs/${hub}/sensors/rfidc`, null, function(err2, fragRes) {
                if (!err2 && fragRes && fragRes.title) {
                    const fragranceName = fragRes.title;
                    that.cache.fragrance_name = fragranceName;
                    that.log.debug(`Current fragrance note -> ${fragranceName}`);

                    // HomeKit Filter-Namen aktualisieren
                    that.serviceFilter.updateCharacteristic(Characteristic.Name, fragranceName);
                } else if (err2) {
                    that.log.debug(`Error while retrieving rfidc: ${err2}`);
                }

                // Now return callback with fill level
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
                that.log.warn(`Set ActiveState failed with error: ${err.message}`);
                return callback(err, that.on_state);
            }

            that.log.debug(`Response from server: ${JSON.stringify(response)}`);

            that.on_state = active;
            that.cache.on_state = active;
            that.cacheTimestamp.getCurrentState = Date.now();

            callback();
        });
    },

    setFanSpeed: function(value, callback) {
        const that = this;

        this.log.info(`${that.name} :: Set FanSpeed to => ${value}`);

        // If fan is off, turn it on first
        if (!that.on_state) {
            this.log.debug('Fan is off – turn it on first');

            return this.setActiveState(true, function(err) {
                if (err) {
                    that.log.error(`Turning on before setting speed failed: ${err.message}`);
                    return callback(err, that.fan_speed);
                }

                // Now set FanSpeed
                that.setFanSpeed(value, callback);
            });
        }

        // Fan is on – set FanSpeed directly
        const hub = that.hub;
        const body = qs.stringify({ speedc: value.toString() });
        const url = `apiv2/hubs/${hub}/attributes/speedc`;

        that.log.debug(`POST URL: ${url}`);
        that.log.debug(`POST Body (x-www-form-urlencoded): ${body}`);

        that.makeAuthenticatedRequest('post', url, body, function(err, response) {
            if (err) {
                that.log.error(`Error while setting FanSpeed: ${err.message}`);
                return callback(err, that.fan_speed);
            }

            that.log.debug(`Response from server: ${JSON.stringify(response)}`);

            that.fan_speed = value;
            that.cache.fan_speed = value;
            that.cacheTimestamp.getCurrentState = Date.now();

            callback();
        });
    },

    identify: function(callback) {
        callback();
    },

    getServices: function() {
        return this.services;
    },
};