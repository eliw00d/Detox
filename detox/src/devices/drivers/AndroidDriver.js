const fs = require('fs');
const URL = require('url').URL;
const _ = require('lodash');
const { encodeBase64 } = require('../../utils/encoding');
const logger = require('../../utils/logger');
const log = logger.child({ __filename });
const invoke = require('../../invoke');
const InvocationManager = invoke.InvocationManager;
const ADB = require('../android/ADB');
const AAPT = require('../android/AAPT');
const APKPath = require('../android/APKPath');
const DeviceDriverBase = require('./DeviceDriverBase');
const DetoxApi = require('../../android/espressoapi/Detox');
const EspressoDetoxApi = require('../../android/espressoapi/EspressoDetox');
const UiDeviceProxy = require('../../android/espressoapi/UiDeviceProxy');
const AndroidInstrumentsPlugin = require('../../artifacts/instruments/android/AndroidInstrumentsPlugin');
const ADBLogcatPlugin = require('../../artifacts/log/android/ADBLogcatPlugin');
const ADBScreencapPlugin = require('../../artifacts/screenshot/ADBScreencapPlugin');
const ADBScreenrecorderPlugin = require('../../artifacts/video/ADBScreenrecorderPlugin');
const AndroidDevicePathBuilder = require('../../artifacts/utils/AndroidDevicePathBuilder');
const temporaryPath = require('../../artifacts/utils/temporaryPath');
const sleep = require('../../utils/sleep');
const retry = require('../../utils/retry');
const { interruptProcess, spawnAndLog } = require('../../utils/exec');
const AndroidExpect = require('../../android/expect');

const reservedInstrumentationArgs = ['class', 'package', 'func', 'unit', 'size', 'perf', 'debug', 'log', 'emma', 'coverageFile'];
const isReservedInstrumentationArg = (arg) => reservedInstrumentationArgs.includes(arg);

class AndroidDriver extends DeviceDriverBase {
  constructor(config) {
    super(config);

    this.invocationManager = new InvocationManager(this.client);
    this.matchers = new AndroidExpect(this.invocationManager);
    this.uiDevice = new UiDeviceProxy(this.invocationManager).getUIDevice();

    this.adb = new ADB();
    this.aapt = new AAPT();
    this.devicePathBuilder = new AndroidDevicePathBuilder();

    this.pendingUrl = undefined;
  }

  declareArtifactPlugins() {
    const { adb, client, devicePathBuilder } = this;

    return {
      instruments: (api) => new AndroidInstrumentsPlugin({ api, adb, client, devicePathBuilder }),
      log: (api) => new ADBLogcatPlugin({ api, adb, devicePathBuilder }),
      screenshot: (api) => new ADBScreencapPlugin({ api, adb, devicePathBuilder }),
      video: (api) => new ADBScreenrecorderPlugin({ api, adb, devicePathBuilder }),
    };
  }

  async getBundleIdFromBinary(apkPath) {
    return await this.aapt.getPackageName(apkPath);
  }

  async installApp(deviceId, binaryPath, testBinaryPath) {
    await this.adb.install(deviceId, binaryPath);
    await this.adb.install(deviceId, testBinaryPath ? testBinaryPath : this.getTestApkPath(binaryPath));
  }

  async pressBack(deviceId) {
    await this.uiDevice.pressBack();
  }

  getTestApkPath(originalApkPath) {
    const testApkPath = APKPath.getTestApkPath(originalApkPath);

    if (!fs.existsSync(testApkPath)) {
      throw new Error(`'${testApkPath}' could not be found, did you run './gradlew assembleAndroidTest' ?`);
    }

    return testApkPath;
  }

  async uninstallApp(deviceId, bundleId) {
    await this.emitter.emit('beforeUninstallApp', { deviceId, bundleId });

    if (await this.adb.isPackageInstalled(deviceId, bundleId)) {
      await this.adb.uninstall(deviceId, bundleId);
    }

    const testBundle = `${bundleId}.test`;
    if (await this.adb.isPackageInstalled(deviceId, testBundle)) {
      await this.adb.uninstall(deviceId, testBundle);
    }
  }

  async launchApp(deviceId, bundleId, launchArgs, languageAndLocale) {
    await this.emitter.emit('beforeLaunchApp', { deviceId, bundleId, launchArgs });

    if (!this.instrumentationProcess) {
      await this._launchInstrumentationProcess(deviceId, bundleId, launchArgs);
      await sleep(500);
    } else {
      if (this.pendingUrl) {
        await this._startActivityWithUrl(this._getAndClearPendingUrl());
      } else {
        await this._resumeMainActivity();
      }
    }

    let pid = NaN;
    try {
      pid = await retry(() => this._queryPID(deviceId, bundleId));
    } catch (e) {
      log.warn(await this.adb.shell(deviceId, 'ps'));
      throw e;
    }

    await this.emitter.emit('launchApp', { deviceId, bundleId, launchArgs, pid });
    return pid;
  }

  async deliverPayload(params) {
    const {delayPayload, url} = params;

    if (url) {
      await (delayPayload ? this._setPendingUrl(url) : this._startActivityWithUrl(url));
    }

    // Other payload content types are not yet supported.
  }

  async waitUntilReady() {
    let intervalId;
    try {
        await Promise.race([
          super.waitUntilReady(),
          new Promise((resolve, reject) => {
            intervalId = setInterval(() => {
              if (!this.instrumentationProcess) {
                reject('Failed to instrument application on the device!\n' + this.instrumentationStackTrace);
              }
            }, 100);
          }),
        ]);
    } finally {
      !_.isUndefined(intervalId) && clearInterval(intervalId);
    }
  }

  async sendToHome(deviceId, params) {
    await this.uiDevice.pressHome();
  }

  async terminate(deviceId, bundleId) {
    await this.emitter.emit('beforeTerminateApp', { deviceId, bundleId });
    await this._terminateInstrumentation();
    await this.adb.terminate(deviceId, bundleId);
    await this.emitter.emit('terminateApp', { deviceId, bundleId });
  }

  async _terminateInstrumentation() {
    if (this.instrumentationProcess) {
      await interruptProcess(this.instrumentationProcess);
      this.instrumentationProcess = null;
    }
  }

  async cleanup(deviceId, bundleId) {
    await this._terminateInstrumentation();
    await super.cleanup(deviceId, bundleId);
  }

  getPlatform() {
    return 'android';
  }

  getUiDevice() {
    return this.uiDevice;
  }

  async reverseTcpPort(deviceId, port) {
    await this.adb.reverse(deviceId, port);
  }

  async unreverseTcpPort(deviceId, port) {
    await this.adb.reverseRemove(deviceId, port);
  }

  async setURLBlacklist(urlList) {
    const call = EspressoDetoxApi.setURLBlacklist(urlList);
    await this.invocationManager.execute(call);
  }

  async enableSynchronization() {
    const call = EspressoDetoxApi.setSynchronization(true);
    await this.invocationManager.execute(call);
  }

  async disableSynchronization() {
    const call = EspressoDetoxApi.setSynchronization(false);
    await this.invocationManager.execute(call);
  }

  async takeScreenshot(deviceId, screenshotName) {
    const adb = this.adb;

    const pathOnDevice = this.devicePathBuilder.buildTemporaryArtifactPath('.png');
    await adb.screencap(deviceId, pathOnDevice);

    const tempPath = temporaryPath.for.png();
    await adb.pull(deviceId, pathOnDevice, tempPath);
    await adb.rm(deviceId, pathOnDevice);

    await this.emitter.emit('createExternalArtifact', {
      pluginId: 'screenshot',
      artifactName: screenshotName,
      artifactPath: tempPath,
    });

    return tempPath;
  }

  async setOrientation(deviceId, orientation) {
    const orientationMapping = {
      landscape: 1, // top at left side landscape
      portrait: 0 // non-reversed portrait.
    };

    const call = EspressoDetoxApi.changeOrientation(orientationMapping[orientation]);
    await this.invocationManager.execute(call);
  }

  async _launchInstrumentationProcess(deviceId, bundleId, rawLaunchArgs) {
    const launchArgs = this._prepareLaunchArgs(rawLaunchArgs, true);
    const additionalLaunchArgs = this._prepareLaunchArgs({debug: false});
    const serverPort = new URL(this.client.configuration.server).port;
    await this.adb.reverse(deviceId, serverPort);
    const testRunner = await this.adb.getInstrumentationRunner(deviceId, bundleId);
    const spawnFlags = [`-s`, `${deviceId}`, `shell`, `am`, `instrument`, `-w`, `-r`, ...launchArgs, ...additionalLaunchArgs, testRunner];

    this.instrumentationProcess = spawnAndLog(this.adb.adbBin, spawnFlags, { detached: false });
    this.instrumentationProcess.childProcess.stdout.on('data', (raw) => {
      const stackTrace = this._findAndParseInstrumentationStackTraceLog(raw.toString());
      if (stackTrace) {
        this.instrumentationStackTrace = stackTrace;
      }
    });
    this.instrumentationProcess.childProcess.on('close', async () => {
      await this._terminateInstrumentation();
      await this.adb.reverseRemove(deviceId, serverPort);
    });
  }

  _findAndParseInstrumentationStackTraceLog(text) {
    const INSTRUMENTATION_LOGS_PREFIX = 'INSTRUMENTATION_STATUS:';
    const STACKTRACE_PREFIX_TEXT = INSTRUMENTATION_LOGS_PREFIX + ' stack=';

    let stackTrace = '';
    if (text.includes(STACKTRACE_PREFIX_TEXT)) {
      const lines = text.split('\n');

      let i;
      for (i = 0; i < lines.length && !lines[i].includes(STACKTRACE_PREFIX_TEXT); i++) {}

      lines[i] = lines[i].replace(STACKTRACE_PREFIX_TEXT, '');
      for (; i < lines.length && lines[i].trim() && !lines[i].includes(INSTRUMENTATION_LOGS_PREFIX); i++) {
        stackTrace = stackTrace.concat(lines[i], '\n');
      }
    }
    return stackTrace;
  }

  async _queryPID(deviceId, bundleId, waitAtStart = true) {
    if (waitAtStart) {
      await sleep(500);
    }

    for (let attempts = 5; attempts > 0; attempts--) {
      const pid = await this.adb.pidof(deviceId, bundleId);

      if (pid > 0) {
        return pid;
      }

      await sleep(1000);
    }

    return NaN;
  }

  _setPendingUrl(url) {
    this.pendingUrl = url;
  }

  _getAndClearPendingUrl() {
    const pendingUrl = this.pendingUrl;
    this.pendingUrl = undefined;
    return pendingUrl;
  }

  _startActivityWithUrl(url) {
    return this.invocationManager.execute(DetoxApi.startActivityFromUrl(url));
  }

  _resumeMainActivity() {
    return this.invocationManager.execute(DetoxApi.launchMainActivity());
  }

  _prepareLaunchArgs(launchArgs, verbose = false) {
    const usedReservedArgs = [];
    const preparedLaunchArgs = _.reduce(launchArgs, (result, value, key) => {
      const valueAsString = _.isString(value) ? value : JSON.stringify(value);

      let valueEncoded = valueAsString;
      if (isReservedInstrumentationArg(key)) {
        usedReservedArgs.push(key);
      } else if (!key.startsWith('detox')) {
        valueEncoded = encodeBase64(valueAsString);
      }

      result.push('-e', key, valueEncoded);
      return result;
    }, []);

    if (verbose && usedReservedArgs.length) {
      logger.warn([`Arguments [${usedReservedArgs}] were passed in as launchArgs to device.launchApp() `,
                   'but are reserved to Android\'s test-instrumentation and will not be passed into the app. ',
                   'Ignore this message if this is what you meant to do. Refer to ',
                   'https://developer.android.com/studio/test/command-line#AMOptionsSyntax for ',
                   'further details.'].join(''));
    }
    return preparedLaunchArgs;
  }
}

module.exports = AndroidDriver;
