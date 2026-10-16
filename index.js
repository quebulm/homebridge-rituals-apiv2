'use strict';

const os = require('os');
const path = require('path');
const store = require('node-storage');
const axios = require('axios');
const qs = require('querystring');

const version = require('./package.json').version;

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

    this.on_state = false;
    this.fan_speed = 1;
    this.account = config.account;
    this.password = config.password;
    // Opt-in: Fan stays the default so existing scenes/automations keep working after an update
    this.humidifierMode = config.humidifier === true;
    // Opt-out: preserves the existing Battery service for upgrading users; set to false to remove it
    this.hasBattery = config.battery !== false;

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

    if (this.humidifierMode) {
        this.service = new Service.HumidifierDehumidifier(this.name, 'AirFresher');
        this.service
            .getCharacteristic(Characteristic.Active)
            .on('get', this.getActiveState.bind(this))
            .on('set', this.setActiveState.bind(this));

        this.service
            .getCharacteristic(Characteristic.CurrentHumidifierDehumidifierState)
            .on('get', this.getHumidifierState.bind(this));

        // Shows the remaining perfume cartridge fill level (not scent intensity, that's RotationSpeed below)
        this.service
            .getCharacteristic(Characteristic.CurrentRelativeHumidity)
            .on('get', this.getFillState.bind(this));

        this.service
            .getCharacteristic(Characteristic.TargetHumidifierDehumidifierState)
            .setProps({
                validValues: [Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER]
            })
            .on('get', (callback) => {
                callback(null, Characteristic.TargetHumidifierDehumidifierState.HUMIDIFIER);
            })
            .on('set', (value, callback) => {
                callback();
            });
    } else {
        this.service = new Service.Fan(this.name, 'AirFresher');
        this.service
            .getCharacteristic(Characteristic.On)
            .on('get', this.getCurrentState.bind(this))
            .on('set', this.setFanOn.bind(this));
    }

    // Intensity control, mapped to speedc (1/2/3 = low/med/high) - shared by Fan and Humidifier mode
    this.service
        .getCharacteristic(Characteristic.RotationSpeed)
        .setProps({
            minValue: 0,
            maxValue: 100,
            minStep: 1
        })
        .on('get', this.getSpeedState.bind(this))
        .on('set', this.setSpeedState.bind(this));

    this.serviceInfo = new Service.AccessoryInformation();
    this.serviceInfo
        .setCharacteristic(Characteristic.Manufacturer, 'Rituals')
        .setCharacteristic(Characteristic.Model, 'Rituals Genie')
        .setCharacteristic(Characteristic.SerialNumber, this.hublot)
        .setCharacteristic(Characteristic.FirmwareRevision, this.version);

    if (this.hasBattery) {
        this.serviceBatt = new Service.Battery('Battery', 'AirFresher');
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
            if (this.hub) {
                this.log.warn('No hub found in storage. Using hub from config (first start): ' + this.hub);
            } else {
                this.log.warn('No hub found in storage. Probably first start.');
            }
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

            that.log.debug('==== REQUEST DUMP =================================');
            that.log.debug('URL     : ' + url);
            that.log.debug('Method  : POST');
            that.log.debug('Headers : ' + JSON.stringify(headers));
            that.log.debug('BodyHex : ' + Buffer.from(bodyStr).toString('hex'));
            that.log.debug('BodyUtf8: ' + bodyStr);
            that.log.debug('===============================================');
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

    resolveHub: function() {
        const hubFromStorage = this.storage.get('hub');
        const hub = hubFromStorage || this.hub;
        if (!hub) {
            this.log.warn('No hub resolved yet (neither storage nor config). Waiting for discovery...');
        }
        return hub;
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

            that.storeGenieVersion(that.hub);

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

                    // Ensure hub is also persisted and normalized when matching by config
                    that.hub = hub.hash;
                    that.storage.put('hub', that.hub);

                    that.storage.put('key', key);
                    that.storage.put('name', that.name);
                    that.storage.put('hublot', that.hublot);
                    that.storage.put('fragance', that.fragance);

                    that.storeGenieVersion(that.hub);

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

    storeGenieVersion: function(hub) {
        const that = this;

        that.makeAuthenticatedRequest('get', `apiv2/hubs/${hub}/sensors/versionc`, null, function(err, versionRes) {
            if (err) {
                that.log.debug(`Error while retrieving versionc: ${err}`);
                return;
            }

            const firmwareVersion = versionRes && (versionRes.title || versionRes.raw);
            if (firmwareVersion) {
                that.version = firmwareVersion;
                that.storage.put('version', firmwareVersion);
                that.log.debug(`RitualsAccessory -> Genie firmware version stored :: ${firmwareVersion}`);

                try {
                    that.serviceInfo.updateCharacteristic(Characteristic.FirmwareRevision, firmwareVersion);
                } catch (_) {}
            }
        });
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

        const hub = that.resolveHub();
        if (!hub) {
            return callback(new Error('Hub not resolved yet'));
        }
        that.log.debug(`Retrieving the current status for hub: ${hub}`);

        that.makeAuthenticatedRequest('get', `apiv2/hubs/${hub}/attributes/fanc`, null, function(err1, fancRes) {
            if (err1) {
                that.log.debug(`Error while retrieving fanc: ${err1}`);
                return callback(err1);
            }

            that.log.debug(`fancRes received: ${JSON.stringify(fancRes)}`);

            that.on_state = fancRes.value === '1';
            that.cache.on_state = that.on_state;
            that.cacheTimestamp.getCurrentState = now;

            that.log.debug(`Current status -> on_state: ${that.on_state}`);

            callback(null, that.on_state);
        });

        this.log.debug('RitualsAccessory -> finish :: getCurrentState()');
    },

    getActiveState: function(callback) {
        this.getCurrentState((err, on_state) => {
            if (err) return callback(err);
            callback(null, on_state ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
        });
    },

    getHumidifierState: function(callback) {
        this.getCurrentState((err, on_state) => {
            if (err) return callback(err);
            callback(null, on_state
                ? Characteristic.CurrentHumidifierDehumidifierState.HUMIDIFYING
                : Characteristic.CurrentHumidifierDehumidifierState.INACTIVE);
        });
    },

    getSpeedState: function(callback) {
        const that = this;
        this.log.debug('RitualsAccessory -> init :: getSpeedState()');

        const now = Date.now();
        if (this.cacheTimestamp.getSpeedState && (now - this.cacheTimestamp.getSpeedState) < this.cacheDuration) {
            that.log.debug('Using cached data for getSpeedState');
            // Fan mode reports 0% while off (as before); the stored intensity is kept for when it's back on
            if (!this.humidifierMode && !this.on_state) return callback(null, 0);
            const speed = this.cache.fan_speed ?? 1;
            return callback(null, speed === 1 ? 33 : speed === 2 ? 66 : 100);
        }

        const hub = that.resolveHub();
        if (!hub) {
            return callback(new Error('Hub not resolved yet'));
        }

        that.makeAuthenticatedRequest('get', `apiv2/hubs/${hub}/attributes/speedc`, null, function(err, speedRes) {
            if (err) {
                that.log.debug(`Error while retrieving speedc: ${err}`);
                return callback(err);
            }

            that.log.debug(`speedRes received: ${JSON.stringify(speedRes)}`);

            that.fan_speed = parseInt(speedRes.value, 10) || 1;
            that.cache.fan_speed = that.fan_speed;
            that.cacheTimestamp.getSpeedState = now;

            if (!that.humidifierMode && !that.on_state) return callback(null, 0);
            const pct = that.fan_speed === 1 ? 33 : that.fan_speed === 2 ? 66 : 100;
            callback(null, pct);
        });
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

        const hub = that.resolveHub();
        if (!hub) {
            return callback(new Error('Hub not resolved yet'));
        }
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

    // Shared by Fan's On and Humidifier's Active - does the actual POST + state/cache bookkeeping
    setPowerState: function(on_state, callback) {
        const that = this;
        const hub = that.resolveHub();
        if (!hub) {
            return callback(new Error('Hub not resolved yet'), this.on_state);
        }
        const setValue = on_state ? '1' : '0';

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

            that.on_state = on_state;
            that.cache.on_state = on_state;
            that.cacheTimestamp.getCurrentState = Date.now();

            try {
                if (that.humidifierMode) {
                    that.service.updateCharacteristic(
                        Characteristic.Active,
                        on_state ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE
                    );
                    that.service.updateCharacteristic(
                        Characteristic.CurrentHumidifierDehumidifierState,
                        on_state
                            ? Characteristic.CurrentHumidifierDehumidifierState.HUMIDIFYING
                            : Characteristic.CurrentHumidifierDehumidifierState.INACTIVE
                    );
                } else {
                    that.service.updateCharacteristic(Characteristic.On, on_state);
                }
            } catch (_) {}

            callback();
        });
    },

    // Humidifier mode's Active set handler
    setActiveState: function(active, callback) {
        this.setPowerState(active === Characteristic.Active.ACTIVE, callback);
    },

    // Fan mode's On set handler
    setFanOn: function(on, callback) {
        this.setPowerState(!!on, callback);
    },

    setSpeedState: function(value, callback) {
        const that = this;
        const pct = Math.max(0, Math.min(100, Math.round(Number(value))));
        const mapped = (pct >= 67) ? 3 : (pct >= 34) ? 2 : 1;

        this.log.info(`${that.name} :: Set Speed to => ${mapped}`);

        // If off, turn on first
        if (!that.on_state) {
            this.log.debug('Genie is off – turn it on first');

            return this.setPowerState(true, function(err) {
                if (err) return callback(err);
                that.setSpeedState(value, callback);
            });
        }

        const hub = that.resolveHub();
        if (!hub) {
            return callback(new Error('Hub not resolved yet'));
        }

        const path = `apiv2/hubs/${hub}/attributes/speedc`;
        const body = qs.stringify({ speedc: mapped.toString() });

        this.log.debug(`POST URL: ${path}`);
        this.log.debug(`POST Body (x-www-form-urlencoded): ${body}`);

        that.makeAuthenticatedRequest('post', path, body, function(err, response) {
            if (err) {
                that.log.error(`Error while setting speed: ${err.message}`);
                return callback(err);
            }

            that.log.debug(`Response from server: ${JSON.stringify(response)}`);

            that.fan_speed = mapped;
            that.cache.fan_speed = mapped;
            that.cacheTimestamp.getSpeedState = Date.now();

            // Snap the slider to the exact bucket (33/66/100%) instead of leaving the dragged value
            const snapPct = mapped === 3 ? 100 : mapped === 2 ? 66 : 33;
            try { that.service.updateCharacteristic(Characteristic.RotationSpeed, snapPct); } catch (_) {}

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
