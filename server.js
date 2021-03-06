'use strict';

var https = require('https');
var http = require('http');
var httpShutdownExtend = require('http-shutdown');
var urlModule = require('url');
var querystring = require('querystring');
var fs = require('fs');
var os = require('os');
var child_process = require('child_process');
var st = require('st');
var auth = require('basic-auth');
var crypto = require('crypto');
var ExifImage = require('exif').ExifImage;
var vcgencmd = require('vcgencmd');
var diskusage = require('diskusage');
var getInterfaceInfo = require('./build/Release/binding').getInterfaceInfo;
var cron = require('cron');

var configFilename = __dirname + '/config/timelapse.json';
var config = {
    username: 'timelapse',
    password: 'timelapse',
    isCapturing: false,
    capturePath:  __dirname + '/../capture',
    captureFolder: 'default',
    timelapseInterval: 1,
    timelapseActiveHours: "7-18",
    timelapseActiveDays: "1-6",
    exposure: 'auto',
    ev: 0,
    iso: 100,
    shutterSpeed: 'auto',
    awb: 'auto',
    awbRedGain: 'auto',
    awbBlueGain: 'auto',
    hflip: false,
    vflip: false,
    width: 1920,
    height: 1080,
    thumbnailWidth: 480,
    thumbnailHeight: 270,
    jpegQuality: 100,
}

var cameraDetected = vcgencmd.getCamera().detected;

console.logFormatted = console.log.bind(console);
console.log = function(data){
    var timestamp = "[" + new Date().toString() + "]";
    this.logFormatted(timestamp, data);
}

function loadConfig() {
    try {
        var savedConfig = fs.readFileSync(configFilename, 'utf8');
        savedConfig = JSON.parse(savedConfig);

        if (savedConfig) {
            for (var name in savedConfig) {
                if (typeof config[name] !== 'undefined') {
                    config[name] = savedConfig[name];
                }
            }
        }
    } catch (err) {
        // ignore config errors - we start with default config
    }
}

loadConfig();

function saveConfig(callback) {
    fs.writeFile(configFilename, JSON.stringify(config), callback);
}

var cronMakeCapture = new cron.CronJob({
    cronTime: '*/' + config.timelapseInterval + ' * ' + config.timelapseActiveHours + ' * * ' + config.timelapseActiveDays,
    onTick: function() {
        apiActions.startCapture(null, function(){});
    },
    start: false
});

// var serverOptions = {
//     key: fs.readFileSync(__dirname + '/config/timelapse.key'),
//     cert: fs.readFileSync(__dirname + '/config/timelapse.crt')
// };

var mounts = [st({
    path: __dirname + '/node_modules/bootstrap/dist',
    url: '/bootstrap'
}), st({
    path: __dirname + '/node_modules/jquery/dist',
    url: '/jquery'
}), st({
    path: __dirname + '/node_modules/popper.js/dist',
    url: '/popper'
}), st({
    path: __dirname + '/webapp',
    index: 'index.html'
})];

var previewImage = null;
var previewImageName = null;
var previewImageHash = null;
var previewImageInfo = null;

function updatePreviewImage() {
    previewImageName = config.capturePath + '/latest.jpg';

    function onError(err) {
        previewImage = null;
        previewImageHash = null;
        previewImageInfo = null;
    }

    fs.stat(previewImageName, function (err, stat) {
        if (err) return onError(err);

        var newHash = crypto.createHash('md5').
            update('' + stat.mtime + '#' + stat.size).
            digest('hex');

        if (newHash === previewImageHash) return;

        try {
            new ExifImage({image: previewImageName}, function (err, exifData) {
                if (err) return onError(err);

                fs.open(previewImageName, 'r', function (err, fd) {
                    if (err) return onError(err);

                    var offset = exifData.thumbnail.ThumbnailOffset + 12; // see https://github.com/gomfunkel/node-exif/issues/31
                    var length = exifData.thumbnail.ThumbnailLength;
                    var thumbnail = new Buffer(length);

                    fs.read(fd, thumbnail, 0, length, offset, function (err) {
                        fs.close(fd);
                        if (err) return onError(err);

                        // Thumbnail is padded to 24KB by raspistill - remove 0x00 bytes at the end:
                        var length = thumbnail.length;
                        while (length > 0 && thumbnail[length - 1] === 0) length--;
                        thumbnail = thumbnail.slice(0, length);

                        previewImage = thumbnail;
                        previewImageHash = newHash;
                        previewImageInfo = formatDateTime(stat.mtime) + ' (' + formatBytes(stat.size) + ')';
                    });
                });
            });
        } catch (err) {
            onError(err);
        }
    });
}

var updatePreviewImageInterval = setInterval(updatePreviewImage, 1000);
updatePreviewImage();

var status = {
    isCapturing: false,
    latestPictureHash: null,
    captureMode: {title: 'Capture mode', value: 'unknown', type: 'default'},
    latestPicture: {title: 'Latest picture', value: 'unknown', type: 'default'},
    freeDiskSpace: {title: 'Free disk space', value: 'unknown', type: 'default'},
    cpuTemp: {title: 'CPU temperature', value: 'unknown', type: 'default'},
    systemLoad: {title: 'System load', value: 'unknown', type: 'default'},
    uptime: {title: 'Uptime', value: 'unknown', type: 'default'},
    visitors: {title: 'Visitors', value: 'unknown', type: 'default'}
};

var visitors = {};

function updateStatus(partial) {
    status.isCapturing = config.isCapturing;
    status.latestPictureHash = previewImageHash;

    status.latestPicture.value = previewImage ? previewImageInfo : '(none)';
    status.latestPicture.type = previewImage ? 'success' : 'danger';

    if (!cameraDetected) {
        status.captureMode.value = 'No camera detected';
        status.captureMode.type = 'danger';
    } else if (!config.isCapturing) {
        status.captureMode.value = 'Not capturing';
        status.captureMode.type = 'danger';
    } else {
        status.captureMode.value = cronMakeCapture.running ? 'Cron capturing' : 'Cron not started';
        status.captureMode.type = cronMakeCapture.running ? 'success' : 'warning';
    }

    if (!partial) {
        fs.stat('/', function(err2, sdStat) {
            fs.stat(config.capturePath, function (err1, captureStat) {
                diskusage.check('/', function (err4, sdInfo) {
                    diskusage.check(config.capturePath, function (err3, captureInfo) {
                        if (err1 || err2 || err3 || err4) {
                            status.freeDiskSpace.value = 'error';
                            status.freeDiskSpace.type = 'danger';
                            return;
                        }

                        var sdFreePercent = Math.round(sdInfo.available / sdInfo.total * 1000) / 10;
                        var captureFreePercent = Math.round(captureInfo.available / captureInfo.total * 1000) / 10;
                        var minFreePercent = Math.min(sdFreePercent, captureFreePercent);
                        status.freeDiskSpace.value = 'SD-Card: ' + formatBytes(sdInfo.available) + ' (' + sdFreePercent + ' %)';
                        if (captureStat.dev !== sdStat.dev) {
                            status.freeDiskSpace.value += ' - Capture: ' + formatBytes(captureInfo.available) + ' (' + captureFreePercent + ' %)';
                        }
                        status.freeDiskSpace.type = minFreePercent < 10 ? (minFreePercent < 3 ? 'danger' : 'warning') : 'success';

                        // Check if we should stop the cron due to insufficient diskspace
                        if (minFreePercent < 5) {
                            console.log("Stopping due to insufficient free diskspace");
                            apiActions.stopCapture(null, function(){});
                        }
                    });
                });
            });
        });

        var cpuTemp = vcgencmd.measureTemp();
        status.cpuTemp.value = '' + cpuTemp + ' °C';
        status.cpuTemp.type = cpuTemp >= 65 ? (cpuTemp >= 75 ? 'danger' : 'warning') : 'success';
    }

    var systemLoad = os.loadavg();
    status.systemLoad.value = systemLoad.map(function (load) {return load.toFixed(2);}).join(', ');
    status.systemLoad.type = systemLoad[0] >= 2 ? (systemLoad[0] >= 5 ? 'danger' : 'warning') : 'success';

    var uptime = os.uptime();
    var days = Math.floor(uptime / (3600 * 24)); uptime -= days * (3600 * 24);
    var hours = Math.floor(uptime / 3600); uptime -= hours * 3600;
    var minutes = Math.floor(uptime / 60); uptime -= minutes * 60;
    var seconds = uptime;
    status.uptime.value = (days > 0 ? days + 'd ' : '') +
        pad2(hours) + ':' + pad2(minutes) + ':' + pad2(seconds);

    if (!partial) {
        // visitor garbage collection:
        var expirationTime = Date.now() - 10 * 1000;
        Object.keys(visitors).forEach(function (deviceId) {
            if (visitors[deviceId] < expirationTime) {
                delete visitors[deviceId];
            }
        });
    }
    status.visitors.value = '' + Object.keys(visitors).length + ' users online';

    if (!partial) {
        var networkInterfaces = os.networkInterfaces();
        for (var interfaceName in networkInterfaces) {
            var interfaceInfo = getInterfaceInfo(interfaceName);
            if (interfaceInfo.loopback) continue;
            if (!interfaceInfo.running) continue;

            status['interface_' + interfaceName] = {
                title: 'Interface ' + interfaceName,
                value: interfaceInfo.essid ? (interfaceInfo.essid + ': ' + (interfaceInfo.signalLevel - 256) + ' dBm') : 'link detected',
                type: interfaceInfo.essid && interfaceInfo.signalLevel < 50 ? (interfaceInfo.signalLevel < 20 ? 'danger' : 'warning') : 'success'
            };
        }
    }
}

var updateStatusInterval = setInterval(updateStatus, 10000);
updateStatus();

function formatDateTime(date) {
    return pad2(date.getFullYear()) +
        '-' + pad2(date.getMonth() + 1) +
        '-' + pad2(date.getDate()) +
        ' ' + pad2(date.getHours()) +
        '' + pad2(date.getMinutes()) +
        '' + pad2(date.getSeconds());
};

function formatDate(date) {
    return pad2(date.getFullYear()) +
        '-' + pad2(date.getMonth() + 1) +
        '-' + pad2(date.getDate());
};

function pad2(number) {
    if (number < 10) return '0' + number;
    return '' + number;
}

function formatBytes(bytes) {
    var unit = 'B', units = ['KB', 'MB', 'GB'];

    for (var i = 0; i < units.length; i++) {
        if (bytes < 1024) break;
        bytes /= 1024;
        unit = units[i];
    }
    return bytes.toFixed(2) + ' ' + unit;
}

function parseCookies(request) {
    var cookies = {}, header = request.headers.cookie;

    if (header) {
        header.split(';').forEach(function(cookie) {
            var parts = cookie.split('=', 2);
            cookies[parts.shift().trim()] = decodeURIComponent(parts.join(''));
        });
    }

    return cookies;
}

function updateVisitors(request, response) {
    var cookies = parseCookies(request);
    var maxAge = 10 * 365 * 24 * 60 * 60 * 1000;
    var deviceId;

    if (cookies.deviceId) {
        deviceId = cookies.deviceId;
    } else {
        deviceId = crypto.randomBytes(16).toString('hex');
        response.setHeader('Set-Cookie', 'deviceId=' + deviceId + ';' +
            'expires=' + (new Date(Date.now() + maxAge)).toGMTString());
    }

    visitors[deviceId] = Date.now();
}

function generateDaemonArguments() {
    var raspistillOptions = {
        width: config.width,
        height: config.height,
        encoding: 'jpg',
        quality: config.jpegQuality,
        thumb: config.thumbnailWidth + ':' + config.thumbnailHeight + ':70',
        output: config.capturePath + '/' + config.captureFolder + '/' + formatDateTime(new Date()) + '.jpg',
        latest: config.capturePath + '/latest.jpg',

        exposure: config.exposure,
        ev: config.ev != 0 ? config.ev : undefined,
        ISO: config.iso,
        shutter: config.shutterSpeed !== 'auto' ? Math.round(1 / config.shutterSpeed * 1000000) : undefined,
        awb: config.awb,
        awbgains: config.awbRedGain !== 'auto' && config.awbBlueGain !== 'auto' ?
            config.awbRedGain + ',' + config.awbBlueGain : undefined,
        hflip: config.hflip ? null : undefined,
        vflip: config.vflip ? null : undefined,

        verbose: null,
    };

    console.log(raspistillOptions.output);

    var raspistillOptionsRaw = [];
    for (var name in raspistillOptions) {
        if (typeof raspistillOptions[name] === 'undefined') continue;
        raspistillOptionsRaw.push('--' + name);
        if (raspistillOptions[name] !== null) {
            raspistillOptionsRaw.push('' + raspistillOptions[name]);
        }
    }

    return raspistillOptionsRaw;
}

var apiActions = {
    startCapture: function (data, callback) {
        if (!cronMakeCapture.running){
            cronMakeCapture.start();
        }

        config.isCapturing = true;
        config.captureFolder = formatDate(new Date()).replace(/:/g, '.');

        if (!fs.exists(config.capturePath + '/' + config.captureFolder)){
            fs.mkdir(config.capturePath + '/' + config.captureFolder, function (err) {
                if (err) return callback('Error creating capture folder');
                console.log("Created captureFolder: " + config.captureFolder);
            });
        }

        var child = child_process.spawn('/usr/bin/raspistill', generateDaemonArguments(), {
            cwd: config.capturePath,
            stdio: 'ignore',
            detached: true
        });
        child.unref();

        saveConfig(function (err) {
            if (err) return callback('Error saving config');
            callback(status, 200);
        });
    },
    stopCapture: function (data, callback) {
        config.isCapturing = false;
        cronMakeCapture.stop();

        saveConfig(function (err) {
            if (err) return callback('Error saving config');
            updateStatus(true);
            callback(status, 200);
        });
    },
    loadStatus: function (data, callback) {
        updateStatus(true);
        callback(status, 200);
    },
    loadConfig: function (data, callback) {
        callback(config, 200);
    },
    saveConfig: function (newConfig, callback) {
        for (var name in newConfig) {
            if (typeof config[name] !== 'undefined') {
                config[name] = newConfig[name];
            }
        }

        saveConfig(function (err) {
            if (err) return callback({error: 'Error saving config'}, 500);
            callback(config, 200);
        });
    },
    unknown: function (data, callback) {
        callback({error: 'Unknown API-Action'}, 404);
    }
};

var server = http.createServer(function (request, response) {
    var startTime = process.hrtime();
    var credentials = auth(request);

    if (!credentials || credentials.name !== config.username || credentials.pass !== config.password) {
        response.writeHead(401, {
            'WWW-Authenticate': 'Basic realm="RaspiCam-Timelapse"'
        });
        response.end('Access denied');
        return;
    }

    var url = urlModule.parse(request.url);

    if (url.pathname === '/api') {
        var query = querystring.parse(url.query);
        var action = query.action;

        if (action === 'loadStatus') {
            updateVisitors(request, response);
        }

        if (request.method === 'POST') {
            var body = '';
            request.on('data', function (data) {
                body += data;
                if (body.length > 65536) request.connection.destroy();
            });
            request.on('end', function () {
                try {
                    var requestData = JSON.parse(body);
                    if (typeof requestData !== 'object') throw new Error();
                } catch (err) {
                    response.writeHead(400);
                    response.end('Invalid JSON');
                    return;
                }

                handleApiCall(action, requestData);
            });
        } else {
            handleApiCall(action, null);
        }
        return;
    }

    function handleApiCall(action, requestData) {
        if (!apiActions[action]) action = 'unknown';

        apiActions[action](requestData, function (data, statusCode) {
            var json = JSON.stringify(data);
            var duration = process.hrtime(startTime);

            response.writeHead(statusCode || 200, {
                'Content-Type': 'application/json',
                'X-Duration': Math.round((duration[0] * 1000 + duration[1] / 1000000) * 10) / 10
            });
            response.end(json);
        });
    }

    if (url.pathname === '/preview' || url.pathname === '/full-preview') {
        if (!previewImage) {
            response.writeHead(404);
            response.end('No preview image available');
            return;
        }

        response.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'must-revalidate',
            'Expires': '0'
        });

        if (url.pathname === '/preview') {
            response.end(previewImage);
        } else if (url.pathname === '/full-preview') {
            fs.createReadStream(previewImageName).pipe(response);
        }
        return;
    }

    // serve static files:
    for (var i = 0; i < mounts.length; i++) {
        if (mounts[i](request, response)) break;
    }
});

httpShutdownExtend(server);
server.listen(3000);

function shutdown() {
    if (cronMakeCapture.running){
        console.log("Capture cron still running, shutting it down");
        apiActions.stopCapture(null, function(){});
    }
    

    clearInterval(updatePreviewImageInterval);
    clearInterval(updateStatusInterval);
    server.shutdown();
}

//catches ctrl+c event
process.on('SIGINT', shutdown);

process.on('SIGTERM', shutdown);

// Auto start the cron upon starting of node js
if (!cronMakeCapture.running){
    cronMakeCapture.start();
}