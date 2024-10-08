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

    this.discover();

    this.log.debug('RitualsAccessory -> finish :: RitualsAccessory(log, config)');
}

RitualsAccessory.prototype = {
    discover: function() {
        this.log.debug('RitualsAccessory -> init :: discover: function ()');
        this.log.debug('RitualsAccessory -> package :: ' + version);
        this.storage.put('hub', this.hub);
        var hash = this.storage.get('hash') || null;
        var hb = this.storage.get('hub') || null;
        if (hash) {
            this.log.debug('RitualsAccessory -> hash found in local storage');
            this.log.debug('RitualsAccessory -> HASH :: ' + hash);
            if (hb) {
                this.log.debug('RitualsAccessory -> hub found in local storage');
                this.log.debug('RitualsAccessory -> HUB :: ' + hb);
            } else {
                this.getHub();
            }
        } else {
            this.getHash();
        }
        this.log.debug('RitualsAccessory -> finish :: discover: function ()');
    },

    getHash: function() {
        const that = this;
        this.log.debug('RitualsAccessory -> init :: getHash: function()');
        var client = reqson.createClient('https://rituals.sense-company.com/');
        var data = { email: this.account, password: this.password };
        client.post('ocapi/login', data, function(err, res, body) {
            if (err) {
                that.log.info(
                    that.name + ' :: ERROR :: ocapi/login :: getHash() > ' + err
                );
            }
            if (!err && res.statusCode != 200) {
                that.log.debug(
                    'RitualsAccessory -> ajax :: ocapi/login -> INVALID STATUS CODE :: ' +
                    res.statusCode
                );
            } else {
                that.log.debug(
                    'RitualsAccessory -> ajax :: ocapi/login :: OK ' + res.statusCode
                );
                that.log.debug(
                    'RitualsAccessory -> ajax :: ocapi/login :: RESPONSE :: ' + JSON.stringify(body)
                );
                that.storage.put('hash', body.account_hash);
                that.log.debug(
                    'RitualsAccessory -> ajax :: ocapi/login :: Setting hash in storage :: ' +
                    body.account_hash
                );
                that.getHub();
            }
        });
        this.log.debug('RitualsAccessory -> finish :: getHash: function()');
    },

    getHub: function() {
        const that = this;
        this.log.debug('RitualsAccessory -> init :: getHub: function()');

        const now = Date.now();
        if (this.cacheTimestamp.getHub && (now - this.cacheTimestamp.getHub) < this.cacheDuration) {
            that.log.debug('Using cached data for getHub');
            that.applyHubData(this.cache.getHubData);
            return;
        }

        var client = reqson.createClient('https://rituals.sense-company.com/');
        client.get('api/account/hubs/' + that.storage.get('hash'), function(
            err,
            res,
            body
        ) {
            if (err) {
                that.log.info(
                    that.name + ' :: ERROR :: api/account/hubs :: getHub() > ' + err
                );
                that.log.info('That means GENIE servers are down!');
            } else {
                if (!err && res.statusCode != 200) {
                    that.log.debug(
                        'RitualsAccessory -> ajax :: api/account/hubs/ -> INVALID STATUS CODE :: ' +
                        res.statusCode
                    );
                } else {
                    that.log.debug(
                        'RitualsAccessory -> ajax :: api/account/hubs/ OK :: ' +
                        res.statusCode
                    );
                    that.log.debug(
                        'RitualsAccessory -> ajax :: api/account/hubs/ BODY.LENGTH :: ' +
                        body.length +
                        ' Genie in your account'
                    );

                    // Cache the data
                    that.cache.getHubData = body;
                    that.cacheTimestamp.getHub = now;

                    that.applyHubData(body);
                }
            }
        });
        this.log.debug('RitualsAccessory -> finish :: getHub: function()');
    },

    applyHubData: function(body) {
        const that = this;
        if (body.length == 1) {
            that.key = 0;
            that.name = body[that.key].hub.attributes.roomnamec;
            that.hublot = body[that.key].hub.hublot;
            that.hub = body[that.key].hub.hash;
            that.storage.put('key', that.key);
            that.storage.put('name', body[that.key].hub.attributes.roomnamec);
            that.storage.put('hublot', body[that.key].hub.hublot);
            that.storage.put('hub', body[that.key].hub.hash);
            that.storage.put(
                'fragance',
                body[that.key].hub.sensors.rfidc.title
            );
            that.log.debug('RitualsAccessory -> hub 1 genie updated');
        } else {
            var found = false;
            Object.keys(body).forEach(function(key) {
                if (body[key].hub.hash == that.hub) {
                    that.log.debug(
                        'RitualsAccessory -> ajax :: api/account/hubs/ :: HUB declared in config VALIDATED OK '
                    );
                    found = true;
                    that.key = key;
                    that.log.debug(
                        'RitualsAccessory -> ajax :: api/account/hubs/ :: HUB Key is :: ' +
                        key
                    );
                    that.name = body[key].hub.attributes.roomnamec;
                    that.log.debug(
                        'RitualsAccessory -> ajax :: api/account/hubs/ :: HUB Name :: ' +
                        body[key].hub.attributes.roomnamec
                    );
                    that.hublot = body[key].hub.hublot;
                    that.log.debug(
                        'RitualsAccessory -> ajax :: api/account/hubs/ :: HUB Hublot :: ' +
                        body[key].hub.hublot
                    );
                    that.fragance = body[key].hub.sensors.rfidc.title;
                    that.log.debug(
                        'RitualsAccessory -> ajax :: api/account/hubs/ :: SENSORS Fragance :: ' +
                        body[key].hub.sensors.rfidc.title
                    );
                    that.storage.put('key', key);
                    that.storage.put('name', body[key].hub.attributes.roomnamec);
                    that.storage.put('hublot', body[key].hub.hublot);
                    that.storage.put(
                        'fragance',
                        body[key].hub.sensors.rfidc.title
                    );
                    that.log.debug(
                        'RitualsAccessory -> ajax :: api/account/hubs/ :: Saved HUB preferences in Storage'
                    );
                }
            });
            if (!found) {
                that.log.info('************************************************');
                that.log.info('HUB in Config NOT validated! or NOT in Config');
                that.log.info('please declare a correct section in config.json');
                that.log.info('************************************************');
                that.log.info('There are multiple Genies found on your account');
                that.log.info(
                    'The HUB Key to identify Genie in your config.json is invalid, select the proper HUB key.'
                );
                that.log.info(
                    'Put one of the following your config.json > https://github.com/myluna08/homebridge-rituals'
                );
                Object.keys(body).forEach(function(key) {
                    that.log.info('********************');
                    that.log.info('Name   : ' + body[key].hub.attributes.roomnamec);
                    that.log.info('Hublot : ' + body[key].hub.hublot);
                    that.log.info('Hub    : ' + body[key].hub.hash);
                    that.log.info('Key    : ' + key);
                });
                that.log.info('************************************************');
            }
        }
    },

    getCurrentState: function(callback) {
        const that = this;
        this.log.debug(
            'RitualsAccessory -> init :: getCurrentState: function(callback)'
        );

        const now = Date.now();
        if (this.cacheTimestamp.getCurrentState && (now - this.cacheTimestamp.getCurrentState) < this.cacheDuration) {
            that.log.debug('Using cached data for getCurrentState');
            callback(null, this.cache.on_state);
            return;
        }

        var client = reqson.createClient('https://rituals.sense-company.com/');
        client.get('api/account/hub/' + that.storage.get('hub'), function(
            err,
            res,
            body
        ) {
            if (err) {
                that.log.info(
                    that.name +
                    ' :: ERROR :: api/account/hub :: getCurrentState() > ' +
                    err
                );
                that.log.info('That means GENIE servers are down!');
                callback(err);
            }
            else if (!err && res.statusCode != 200) {
                that.log.debug(
                    'RitualsAccessory -> ajax :: getCurrentState :: api/account/hub/ -> INVALID STATUS CODE :: ' +
                    res.statusCode
                );
                that.log.info(
                    that.name + ' getCurrentState => ' + res.statusCode
                );
                callback(new Error('Invalid status code: ' + res.statusCode));
            } else {
                that.log.debug(
                    'RitualsAccessory -> ajax :: getCurrentState :: api/account/hub/ OK :: ' +
                    res.statusCode
                );
                that.key = that.storage.get('key');
                that.on_state =
                    body.hub.attributes.fanc == '0' ? false : true;
                that.fan_speed = parseInt(body.hub.attributes.speedc);
                that.storage.put('version', body.hub.sensors.versionc);

                // Update cache
                that.cache.on_state = that.on_state;
                that.cache.fan_speed = that.fan_speed;
                that.cacheTimestamp.getCurrentState = now;
            }
            callback(null, that.on_state);
        });
        this.log.debug(
            'RitualsAccessory -> finish :: getCurrentState: function(callback)'
        );
    },

    setActiveState: function(active, callback) {
        const that = this;
        this.log.debug(
            'RitualsAccessory -> init :: setActiveState: function(active, callback)'
        );
        this.log.debug('RitualsAccessory ->  setActiveState to ' + active);
        this.log.info(that.name + ' :: Set ActiveState to => ' + active);
        var setValue = active == true ? '1' : '0';
        var client = reqson.createClient('https://rituals.sense-company.com/');
        var data = { hub: that.hub, json: { attr: { fanc: setValue } } };
        client.post('api/hub/update/attr', data, function(err, res, body) {
            if (err) {
                that.log.info(
                    that.name +
                    ' :: ERROR :: api/hub/update/attr :: setActiveState() > ' +
                    err
                );
                callback(undefined, that.on_state);
            } else if (!err && res.statusCode != 200) {
                that.log.debug(
                    'RitualsAccessory -> ajax :: setActiveState :: api/hub/update/attr/ -> INVALID STATUS CODE :: ' +
                    res.statusCode
                );
                that.log.info(
                    that.name + ' :: setActiveState => ' + res.statusCode + ' :: ' + err
                );
                callback(undefined, that.on_state);
            } else {
                that.log.debug(
                    'RitualsAccessory -> ajax :: setActiveState :: api/hub/update/attr/ OK :: ' +
                    res.statusCode
                );
                that.log.debug(
                    'RitualsAccessory -> ajax :: setActiveState :: api/hub/update/attr/ BODY :: ' +
                    JSON.stringify(body)
                );

                // Update cache
                that.on_state = active;
                that.cache.on_state = active;
                that.cacheTimestamp.getCurrentState = Date.now();

                callback(undefined, active);
            }
        });
        this.log.debug(
            'RitualsAccessory -> finish :: setActiveState: function(active, callback)'
        );
    },

    setFanSpeed: function(value, callback) {
        const that = this;
        this.log.debug(
            'RitualsAccessory -> init :: setFanSpeed: function(value, callback)'
        );
        this.log.info(that.name + ' :: Set FanSpeed to => ' + value);
        var client = reqson.createClient('https://rituals.sense-company.com/');
        var data = { hub: that.hub, json: { attr: { speedc: value.toString() } } };
        client.post('api/hub/update/attr', data, function(err, res, body) {
            if (err) {
                that.log.info(
                    that.name + ' :: ERROR :: api/hub/update/attr :: setFanSpeed() > ' + err
                );
                callback(undefined, that.fan_speed);
            }
            else if (!err && res.statusCode != 200) {
                that.log.debug(
                    'RitualsAccessory -> ajax :: setFanSpeed :: api/hub/update/attr/ -> INVALID STATUS CODE :: ' +
                    res.statusCode
                );
                that.log.info(
                    that.name + ' :: setFanSpeed => ' + res.statusCode + ' :: ' + err
                );
                callback(undefined, that.fan_speed);
            } else {
                that.log.debug(
                    'RitualsAccessory -> ajax :: setFanSpeed :: api/hub/update/attr/ OK :: ' +
                    res.statusCode
                );
                that.log.debug(
                    'RitualsAccessory -> ajax :: setFanSpeed :: api/hub/update/attr/ BODY :: ' +
                    JSON.stringify(body)
                );

                // Update cache
                that.fan_speed = value;
                that.cache.fan_speed = value;
                that.cacheTimestamp.getCurrentState = Date.now();

                callback(undefined, value);
            }
        });
        this.log.debug(
            'RitualsAccessory -> finish :: setFanSpeed: function(value, callback)'
        );
    },

    identify: function(callback) {
        callback();
    },

    getServices: function() {
        return this.services;
    },
};