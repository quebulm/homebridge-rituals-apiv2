# Homebridge-Rituals-apiv2

This project is a update of homebridge-rituals by myluna08.
It has been adapted to work with the current Rituals API (v2) using Axios.

> **Note:** This README and Projekt is adapted from the original [homebridge-rituals project by myluna08](https://github.com/myluna08/homebridge-rituals/tree/master).
> Changes reflect a modernization of the original plugin with updated Rituals API v2 support. 

<img src="https://img.shields.io/badge/license-MIT-green"> 

<img src="https://user-images.githubusercontent.com/19808920/58770949-bd9c7900-857f-11e9-8558-5dfaffddffda.png" height="100"> <img src="https://www.rituals.com/dw/image/v2/BBKL_PRD/on/demandware.static/-/Sites-rituals-products/default/dw7656c020/images/zoom/1106834_WirelessperfumeDiffuserPROAPrimary.png?sw=500&sh=500&sm=fit&q=100" height="100" align="right">

Homebridge Rituals is a homebridge-plugin to manage a Rituals Genie over homebridge infrastructure.
Homebridge is a lightweight NodeJS server you can run on your home network that emulates the iOS HomeKit API.

Since Siri supports devices added through HomeKit, this means that with Homebridge you can ask Siri to control devices that don't have any support for HomeKit at all. For instance, using just some of the available plugins, you can say:

With this plugin you can do

- _Siri, turn on the Genie._
- _Siri, turn off the Genie._

#### Before begin, (assumptions)

- Your genie has been registered using Official Rituals App.
- Your genie is working fine. (obviously)
- Your <a href="https://github.com/nfarina/homebridge">homebridge</a> is working fine and has been added to your home app as bridge. If not, please take a look to <a href="#considerations">Installation from zero</a>.

Find more about on <a href="https://www.rituals.com/es-es/faqs.html?catid=faq-perfume-genie&qid=fag-what-is-the-perfume-genie-and-what-can-it-do">Official Rituals Site</a>

## 01. Installation

With npm -i or if you are using manual plugin module installation.

```sh
npm -i homebridge-rituals-apiv2
```

Otherwise you can use throught Homebridge UI-X the plugin search engine and just write : "homebridge-rituals-apiv2" and click INSTALL


## 03. Configuration in config.json

One installed, you must modify your config.json file and add the following data:

1. accessory (Required) = "Rituals"
2. account (Required) = "xxxx@xxx.com" < that is the mail you are using in Rituals App Registration.
3. password (Required) = "yyyyyyyy" < that is the password you are using in Rituals App.
4. name (Optional) = "my Genie" < a name that you can assign, if not, "Genie" name has been assigned.

SAVE your config.json file and RESTART homebridge.

```json
    "accessories": [
        {
            "accessory": "Rituals",
            "name": "My Genie",
            "account": "xxx@xxx.com",
            "password": "yyyyyyy"
        }
    ],
```

4. Restart Homebridge

## 06. Credits && Trademarks
This project is a fork and update of homebridge-rituals by myluna08.
Rituals & Genie are registered trademarks of Rituals Cosmetics Enterprise B.V.

## 07. ChangeLog

- 2.0.0 Breaking Changes:
  - Migrated from legacy API (ocapi, api/account/hubs) to API v2 (apiv2/...)
  - New login mechanism using apiv2/account/token with bearer token handling
  - Replaced per-call request-json with unified Axios-based makeAuthenticatedRequest()
  - Added short-term caching to avoid redundant API calls
  - Retry mechanism with exponential delay on auth failure
  - Improved logging and error handling, including automatic reauthentication on 401 errors
  - Access to hub state via apiv2/hubs/{hub}/attributes/{fanc,speedc} endpoints

  -------------------------- API V2 --------------------------

by myluna08:
- 1.1.15 Added API request rate limiting to avoid exceeding the maximum of 30 requests per hour.
- 1.1.14 Fix error when homekit starts
- 1.1.13 Fix error with StatusCodes
- 1.1.12 Added control for rituals servers down on currentState
- 1.1.11 Added control for 503 unresponsive rituals server
- 1.1.10 Add linting and fix up reference errors
- 1.1.9 Added control if Rituals Servers are down.
- 1.1.8 fix mistake
- 1.1.7 fix HUB in only one genie
- 1.1.6 fix UUID for persistance.
- 1.1.5 fix over log functions & fragance added.
- 1.1.4 force change UUID to avoid same
- 1.1.3 fix a defect with key with 1 genie only.
- 1.1.2 fix a defect with package.json in some cases.
- 1.1.1 Error ReferenceError: config is not defined solved.
- 1.1.0 adding debug traces, support more than 1 genie in your account and current version of genie 1.0 or 2.0, fragance only in (homebridge)
- 1.0.8 fix error using functions exposed by homebridge and adding new characteristic to use FAN rotator speed.
- 1.0.7 wrong, unstable version!
- 1.0.6 fix error with secure store, in some cases appears in homebridge logs permission errors.
- 1.0.5 too many logins to get hash, implementing secure store.
- 1.0.4 first release functional
- 1.0.3 fix errors on request, json bad fomatted
- 1.0.2 fix errors on_state, active_state
- 1.0.1 scheme works but nothing do
- 1.0.0 accessory registered successfully
