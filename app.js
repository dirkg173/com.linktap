/*jslint node: true */
'use strict';

if (process.env.DEBUG === '1')
{
    require('inspector').open(9222, '0.0.0.0', true);
}

const Homey = require('homey');
const https = require("https");

class MyApp extends Homey.App
{
    /**
     * onInit is called when the app is initialized.
     */
    async onInit()
    {
        this.log('MyApp has been initialized');
        this.diagLog = "";

        if (process.env.DEBUG === '1')
        {
            this.homey.settings.set('debugMode', true);
        }
        else
        {
            this.homey.settings.set('debugMode', false);
        }

        this.APIToken = this.homey.settings.get('APIToken');
        this.UserName = this.homey.settings.get('UserName');
        this.lastDetectionTime = this.homey.settings.get('lastDetectionTime');
        this.detectedDevices = this.homey.settings.get('detectedDevices');

        this.onDevicePoll = this.onDevicePoll.bind(this);
        this.restartPolling (5);
    }

    restartPolling(initialDelay)
    {
        clearTimeout(this.timerPollID);
        this.timerPollID = this.homey.setTimeout(this.onDevicePoll, (1000 * initialDelay));
    }

    async onDevicePoll()
    {
        const searchData = await this.getDeviceData();
        const promises = [];
        const drivers = this.homey.drivers.getDrivers();
        for (const driver in drivers)
        {
            let devices = this.homey.drivers.getDriver(driver).getDevices();
            let numDevices = devices.length;
            for (var i = 0; i < numDevices; i++)
            {
                let device = devices[i];
                if (device.updateDeviceValues)
                {
                    promises.push(device.updateDeviceValues(searchData));
                }
            }
        }

        await Promise.all(promises);

        this.timerPollID = this.homey.setTimeout(this.onDevicePoll, (1000 * 60 * 5));
    }

    async getDeviceData()
    {
        let searchData;

        if (!this.lastDetectionTime || (Date.now() - this.lastDetectionTime > (1000 * 60 * 5)))
        {
            // More than 5 minutes since last request
            //https://www.link-tap.com/api/getAllDevices
            const url = "getAllDevices";
            let response = await this.PostURL(url, {});
            searchData = response.devices;
            this.detectedDevices = this.homey.app.varToString(searchData);
            this.lastDetectionTime = Date.now();
            this.homey.settings.set('detectedDevices', this.detectedDevices);
            this.homey.settings.set('lastDetectionTime', this.lastDetectionTime);
            this.homey.api.realtime('com.linktap.detectedDevicesUpdated', { 'devices': this.detectedDevices });
        }
        else
        {
            searchData = JSON.parse(this.detectedDevices);
        }

        return searchData;
    }

    async getDevices()
    {
        const devices = [];
        const searchData = await this.getDeviceData();

        if (searchData)
        {
            // Create an array of devices
            for (const gateway of searchData)
            {
                for (const tapLinker of gateway.taplinker)
                {
                    this.homey.app.updateLog("Found tapLinker: ");
                    this.homey.app.updateLog(tapLinker);

                    let data = {};
                    data = {
                        "id": tapLinker.taplinkerId,
                        "gatewayId": gateway.gatewayId
                    };

                    // Add this device to the table
                    devices.push(
                    {
                        "name": tapLinker.location + " - " + tapLinker.taplinkerName,
                        data
                    });
                }
            }
            return devices;
        }
        else
        {
            this.homey.app.updateLog("HTTPS Error: Nothing returned");
            throw (new Error("HTTPS Error: Nothing returned"));
        }
    }

    async PostURL(url, body)
    {
        //this.homey.app.updateLog(url);

        if (!this.homey.app.UserName)
        {
            throw (new Error("HTTPS: No user name specified"));
        }

        if (!this.homey.app.APIToken)
        {
            throw (new Error("HTTPS: No API Key specified"));
        }

        body.username = this.homey.app.UserName;
        body.apiKey = this.homey.app.APIToken;

        let bodyText = JSON.stringify(body);
        //this.homey.app.updateLog(bodyText);

        return new Promise((resolve, reject) =>
        {
            try
            {
                const safeUrl = encodeURI(url);

                let https_options = {
                    host: "www.link-tap.com",
                    path: "/api/" + safeUrl,
                    method: "POST",
                    headers:
                    {
                        "Content-type": "application/json",
                        "Content-Length": bodyText.length
                    },
                };

                //this.homey.app.updateLog(https_options);

                let req = https.request(https_options, (res) =>
                {
                    let body = [];
                    res.on('data', (chunk) =>
                    {
                        //this.homey.app.updateLog("Post: retrieve data");
                        body.push(chunk);
                    });

                    res.on('end', () =>
                    {
                        let returnData = JSON.parse(Buffer.concat(body));
                        //this.homey.app.updateLog("Post response: " + this.homey.app.varToString(returnData));
                        if (res.statusCode === 200)
                        {
                            resolve(returnData);
                            return;
                        }
                        else
                        {
                            this.homey.app.updateLog("HTTPS Error: " + res.statusCode);
                            reject(new Error("HTTPS Error - " + res.statusCode));
                            return;
                        }
                    });
                });

                req.on('error', (err) =>
                {
                    this.homey.app.updateLog(err);
                    reject(new Error("HTTPS Catch: " + err));
                    return;
                });

                req.setTimeout(5000, function()
                {
                    req.destroy();
                    reject(new Error("HTTP Catch: Timeout"));
                    return;
                });

                req.write(bodyText);
                req.end();
            }
            catch (err)
            {
                this.homey.app.updateLog(this.homey.app.varToString(err));
                reject(new Error("HTTPS Catch: " + err));
                return;
            }
        });
    }

    varToString(source)
    {
        try
        {
            if (source === null)
            {
                return "null";
            }
            if (source === undefined)
            {
                return "undefined";
            }
            if (source instanceof Error)
            {
                let stack = source.stack.replace('/\\n/g', '\n');
                return source.message + '\n' + stack;
            }
            if (typeof(source) === "object")
            {
                const getCircularReplacer = () =>
                {
                    const seen = new WeakSet();
                    return (key, value) =>
                    {
                        if (typeof value === "object" && value !== null)
                        {
                            if (seen.has(value))
                            {
                                return;
                            }
                            seen.add(value);
                        }
                        return value;
                    };
                };

                return JSON.stringify(source, getCircularReplacer(), 2);
            }
            if (typeof(source) === "string")
            {
                return source;
            }
        }
        catch (err)
        {
            this.log("VarToString Error: ", err);
        }

        return source.toString();
    }

    updateLog(newMessage, errorLevel = 1)
    {
        if ((errorLevel == 0) || this.homey.settings.get('logEnabled'))
        {
            console.log(newMessage);
            this.diagLog += "* ";
            this.diagLog += newMessage;
            this.diagLog += "\r\n";
            if (this.diagLog.length > 60000)
            {
                this.diagLog = this.diagLog.substr(this.diagLog.length - 60000);
            }
            this.homey.api.realtime('com.linktap.logupdated', { 'log': this.diagLog });
        }
    }

}

module.exports = MyApp;