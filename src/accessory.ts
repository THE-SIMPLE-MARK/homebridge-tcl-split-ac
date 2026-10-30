import { Logging } from 'homebridge';
import { TclHomePlatform } from './platform.js';
import { MODE, TIMEOUTS, WIND } from './constants.js';
import { DeviceState } from './types.js';
import { errMsg, withTimeout } from './utils.js';

export class TclAirConditioner {
  private platform:  TclHomePlatform;
  private accessory: any;
  private device:    any;
  private log:       Logging;
  private api:       any;
  private hap:       any;

  private thermo:   any;
  private fanSvc:   any;

  private _lastMode:       number;
  private _lastWindSpeed:  number;
  private _minTemp:        number = 16;
  private _maxTemp:        number = 31;
  private _errCount:       number = 0;
  private _lastOkPoll:     number;
  private _lastStateKey:   string = '';
  private _lastKnownTemp:  number | undefined;

  // Serial command queue — prevents parallel publishes from racing.
  private commandQueue:     Promise<any>  = Promise.resolve();
  private _lastCommandKey:  string | null = null;
  private _lastCommandTime: number        = 0;

  constructor(platform: TclHomePlatform, accessory: any, device: any) {
    this.platform  = platform;
    this.accessory = accessory;
    this.device    = device;
    this.log       = platform.log;
    this.api       = platform.tclApi;
    this.hap       = platform.api.hap;

    this._lastMode      = MODE.COOL;
    this._lastWindSpeed = WIND.AUTO;
    this._lastOkPoll    = Date.now();

    this.setupAccessoryInfo();
    this.setupThermostat();
    this.removeLegacyServices();
    this.setupFanSpeedControl();
    this.startPolling();

    this.log.info(`${device.deviceName} ready (TAC-09CHSD/XA41IN | Cool/Heat/Auto | 16-31C | 8 fan speeds)`);
  }

  private setupAccessoryInfo(): void {
    this.accessory
      .getService(this.hap.Service.AccessoryInformation)
      .setCharacteristic(this.hap.Characteristic.Manufacturer, 'TCL')
      .setCharacteristic(this.hap.Characteristic.Model, 'TAC-09CHSD/XA41IN')
      .setCharacteristic(this.hap.Characteristic.SerialNumber, this.device.deviceId)
      .setCharacteristic(this.hap.Characteristic.FirmwareRevision, this.device.firmwareVersion || '1.0.0');
  }

  private setupThermostat(): void {
    const C = this.hap.Characteristic;
    this.thermo = this.accessory.getService(this.hap.Service.Thermostat)
               || this.accessory.addService(this.hap.Service.Thermostat);
    this.thermo.setCharacteristic(C.Name, this.device.deviceName);

    this.thermo.getCharacteristic(C.CurrentHeatingCoolingState)
      .onGet(this.getCurrentMode.bind(this));

    this.thermo.getCharacteristic(C.TargetHeatingCoolingState)
      .setProps({ validValues: [
        C.TargetHeatingCoolingState.OFF,
        C.TargetHeatingCoolingState.COOL,
        C.TargetHeatingCoolingState.HEAT,
        C.TargetHeatingCoolingState.AUTO,
      ]})
      .onGet(this.getTargetMode.bind(this))
      .onSet(this.setTargetMode.bind(this));

    this.thermo.getCharacteristic(C.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 100, minStep: 0.1 })
      .onGet(this.getCurrentTemp.bind(this));

    this.thermo.getCharacteristic(C.TargetTemperature)
      .setProps({ minValue: 16, maxValue: 31, minStep: 1 })
      .onGet(this.getTargetTemp.bind(this))
      .onSet(this.setTargetTemp.bind(this));

    this.thermo.getCharacteristic(C.TemperatureDisplayUnits)
      .onGet(() => C.TemperatureDisplayUnits.CELSIUS);
  }

  private removeLegacyServices(): void {
    const names = ['Sleep Mode', 'Fan Speed', 'Fan Mode', 'Cool Fan Speed', 'AC Fan', 'Fan Speed Control'];
    for (const name of names) {
      const svc = this.accessory.getService(name);
      if (svc) {
        this.accessory.removeService(svc);
        this.log.debug(`Removed legacy service: ${name}`);
      }
    }
  }

  private setupFanSpeedControl(): void {
    const C = this.hap.Characteristic;
    this.fanSvc = this.accessory.getService('Fan Speed Control')
               || this.accessory.addService(this.hap.Service.Fan, 'Fan Speed Control', 'fanSpeedControl');

    this.fanSvc.getCharacteristic(C.On)
      .onGet(this.getFanActive.bind(this))
      .onSet(this.setFanActive.bind(this));

    this.fanSvc.getCharacteristic(C.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 12.5 })
      .onGet(this.getFanSpeed.bind(this))
      .onSet(this.setFanSpeed.bind(this));
  }

  // ---- Getters — read from cache; polling keeps it fresh ----

  async getCurrentMode(): Promise<number> {
    try {
      const s: DeviceState = await withTimeout(
        this.api.getDeviceState(this.device.deviceId, false),
        TIMEOUTS.HOMEKIT_GET, 'getCurrentMode',
      );
      if (!s.powerSwitch) return this.hap.Characteristic.CurrentHeatingCoolingState.OFF;
      return s.workMode === MODE.HEAT
        ? this.hap.Characteristic.CurrentHeatingCoolingState.HEAT
        : this.hap.Characteristic.CurrentHeatingCoolingState.COOL;
    } catch (_e) { return this.hap.Characteristic.CurrentHeatingCoolingState.OFF; }
  }

  async getTargetMode(): Promise<number> {
    try {
      const s: DeviceState = await withTimeout(
        this.api.getDeviceState(this.device.deviceId, false),
        TIMEOUTS.HOMEKIT_GET, 'getTargetMode',
      );
      if (!s.powerSwitch) return this.hap.Characteristic.TargetHeatingCoolingState.OFF;
      return this.workModeToHk(s.workMode);
    } catch (_e) { return this.hap.Characteristic.TargetHeatingCoolingState.OFF; }
  }

  async getCurrentTemp(): Promise<number> {
    try {
      const s: DeviceState = await withTimeout(
        this.api.getDeviceState(this.device.deviceId, false),
        TIMEOUTS.HOMEKIT_GET, 'getCurrentTemp',
      );
      if (s.currentTemperature !== undefined) {
        this._lastKnownTemp = s.currentTemperature;
        return s.currentTemperature;
      }
      return this._lastKnownTemp ?? 0;
    } catch (_e) {
      return this._lastKnownTemp ?? 0;
    }
  }

  async getTargetTemp(): Promise<number> {
    try {
      const s: DeviceState = await withTimeout(
        this.api.getDeviceState(this.device.deviceId, false),
        TIMEOUTS.HOMEKIT_GET, 'getTargetTemp',
      );
      return s.targetTemperature ?? 22;
    } catch (_e) { return 22; }
  }

  async getFanActive(): Promise<boolean> {
    try {
      const s: DeviceState = await withTimeout(
        this.api.getDeviceState(this.device.deviceId, false),
        TIMEOUTS.HOMEKIT_GET, 'getFanActive',
      );
      return s.powerSwitch === 1;
    } catch (_e) { return false; }
  }

  async getFanSpeed(): Promise<number> {
    try {
      const s: DeviceState = await withTimeout(
        this.api.getDeviceState(this.device.deviceId, false),
        TIMEOUTS.HOMEKIT_GET, 'getFanSpeed',
      );
      if (!s.powerSwitch) return 0;
      return this.windToPercent(s.windSpeed);
    } catch (_e) { return 0; }
  }

  // ---- Command queue — prevents duplicate rapid-fire HomeKit taps ----

  private queueCommand(props: Record<string, unknown>, ctx: string): Promise<any> {
    const commandKey = JSON.stringify(props);
    if (this._lastCommandKey === commandKey &&
        Date.now() - this._lastCommandTime < 3000) {
      this.log.debug(`Duplicate command skipped: ${ctx}`);
      return Promise.resolve(true);
    }
    this._lastCommandKey  = commandKey;
    this._lastCommandTime = Date.now();

    const next = this.commandQueue
      .then(() => this.sendOnce(props, ctx))
      .catch((e) => {
        this.log.error(`Command queue error (${ctx}): ${errMsg(e)}`);
      });

    this.commandQueue = next.then(() => {}, () => {});
    return next;
  }

  private async sendOnce(props: Record<string, unknown>, ctx: string): Promise<boolean> {
    const ok = await this.api.sendCommand(this.device.deviceId, props);
    if (ok) {
      setTimeout(async () => {
        try {
          const ns = await this.api.getDeviceState(this.device.deviceId, true);
          if (ns) this.updateFromState(ns);
        } catch (_e) {}
      }, 1200);
      return true;
    }
    this.log.error(`${ctx} failed`);
    return false;
  }

  // ---- Setters ----

  async setTargetMode(value: number): Promise<void> {
    const C         = this.hap.Characteristic;
    const modeNames = ['OFF', 'COOL', 'HEAT', 'AUTO'];
    try {
      this.log.info(`setTargetMode -> ${modeNames[value] ?? value}`);
      const cur  = this.api.stateCache[this.device.deviceId] || this.api.defaultState();
      const temp = cur.targetTemperature ?? 22;
      const wind = cur.windSpeed         ?? this._lastWindSpeed;
      let props: Record<string, unknown>;

      switch (value) {
        case C.TargetHeatingCoolingState.OFF:
          props = { powerSwitch: 0 };
          break;
        case C.TargetHeatingCoolingState.HEAT:
          this._lastMode = MODE.HEAT;
          props = { powerSwitch: 1, workMode: MODE.HEAT, windSpeed: wind,
                    targetCelsiusDegree: temp, targetTemperature: temp,
                    ECO: 0, sleep: 0, turbo: 0, silenceSwitch: 0 };
          break;
        case C.TargetHeatingCoolingState.AUTO:
          this._lastMode = MODE.AUTO;
          props = { powerSwitch: 1, workMode: MODE.AUTO, windSpeed: wind,
                    targetCelsiusDegree: temp, targetTemperature: temp,
                    ECO: 0, sleep: 0, turbo: 0, silenceSwitch: 0 };
          break;
        case C.TargetHeatingCoolingState.COOL:
        default:
          this._lastMode = MODE.COOL;
          props = { powerSwitch: 1, workMode: MODE.COOL, windSpeed: wind,
                    targetCelsiusDegree: temp, targetTemperature: temp,
                    ECO: 0, sleep: 0, turbo: 0, silenceSwitch: 0 };
          break;
      }
      await this.queueCommand(props, 'setTargetMode');
    } catch (e) {
      this.log.error(`setTargetMode: ${errMsg(e)}`);
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async setTargetTemp(value: number): Promise<void> {
    try {
      const temp = Math.max(this._minTemp, Math.min(this._maxTemp, Math.round(value)));
      const cur  = this.api.stateCache[this.device.deviceId] || this.api.defaultState();
      this.log.info(`setTargetTemp -> ${temp}C (power=${cur.powerSwitch}, mode=${cur.workMode})`);

      let props: Record<string, unknown>;
      if (!cur.powerSwitch) {
        props = { powerSwitch: 1, workMode: this._lastMode, windSpeed: this._lastWindSpeed,
                  targetCelsiusDegree: temp, targetTemperature: temp };
      } else {
        props = { targetCelsiusDegree: temp, targetTemperature: temp };
      }

      await this.queueCommand(props, 'setTargetTemp');
      this.thermo.getCharacteristic(this.hap.Characteristic.TargetTemperature).updateValue(temp);
    } catch (e) {
      this.log.error(`setTargetTemp: ${errMsg(e)}`);
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async setFanActive(value: boolean): Promise<void> {
    try {
      this.log.info(`setFanActive -> ${value ? 'ON' : 'OFF'}`);
      if (!value) {
        await this.queueCommand({ powerSwitch: 0 }, 'setFanActive:off');
      } else {
        const cur = this.api.stateCache[this.device.deviceId] || this.api.defaultState();
        if (!cur.powerSwitch) {
          await this.queueCommand(
            { powerSwitch: 1, workMode: this._lastMode, windSpeed: this._lastWindSpeed },
            'setFanActive:on',
          );
        }
      }
    } catch (e) {
      this.log.error(`setFanActive: ${errMsg(e)}`);
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async setFanSpeed(value: number): Promise<void> {
    try {
      const wind          = this.percentToWind(value);
      this._lastWindSpeed = wind;
      const cur           = this.api.stateCache[this.device.deviceId] || this.api.defaultState();
      const windNames: Record<number, string> = {
        0: 'Auto', 2: 'Silent', 3: 'Low', 4: 'Medium', 5: 'Med-High', 6: 'High',
      };
      this.log.info(
        `setFanSpeed -> ${value}% -> wind=${wind} (${windNames[wind]}) | power=${cur.powerSwitch}`,
      );
      if (!cur.powerSwitch) { this.log.debug('Device is off, speed saved for next start'); return; }
      await this.queueCommand({ windSpeed: wind }, 'setFanSpeed');
    } catch (e) {
      this.log.error(`setFanSpeed: ${errMsg(e)}`);
      throw new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // ---- HomeKit state push ----

  updateFromState(s: DeviceState): void {
    const key = `${s.powerSwitch}-${s.workMode}-${s.windSpeed}-${s.currentTemperature}-${s.targetTemperature}`;
    if (key === this._lastStateKey) return;
    this._lastStateKey = key;

    this.log.debug(
      `power=${s.powerSwitch} mode=${s.workMode} wind=${s.windSpeed} ` +
      `room=${s.currentTemperature ?? '?'}C target=${s.targetTemperature}C`,
    );

    if (s.powerSwitch && s.workMode !== undefined) this._lastMode      = s.workMode;
    if (s.windSpeed  !== undefined)                this._lastWindSpeed = s.windSpeed;
    if (s.minTemp)                                 this._minTemp       = s.minTemp;
    if (s.maxTemp)                                 this._maxTemp       = s.maxTemp;

    const C = this.hap.Characteristic;

    if (s.currentTemperature !== undefined) {
      this._lastKnownTemp = s.currentTemperature;
      this.thermo.updateCharacteristic(C.CurrentTemperature, s.currentTemperature);
    } else if (this._lastKnownTemp !== undefined && this._lastKnownTemp !== null) {
      this.thermo.updateCharacteristic(C.CurrentTemperature, this._lastKnownTemp);
    }

    if (s.targetTemperature !== undefined)
      this.thermo.updateCharacteristic(C.TargetTemperature, s.targetTemperature);

    const curMode = !s.powerSwitch
      ? C.CurrentHeatingCoolingState.OFF
      : s.workMode === MODE.HEAT
        ? C.CurrentHeatingCoolingState.HEAT
        : C.CurrentHeatingCoolingState.COOL;

    const tgtMode = !s.powerSwitch
      ? C.TargetHeatingCoolingState.OFF
      : this.workModeToHk(s.workMode);

    this.thermo.updateCharacteristic(C.CurrentHeatingCoolingState, curMode);
    this.thermo.updateCharacteristic(C.TargetHeatingCoolingState, tgtMode);
    this.fanSvc.updateCharacteristic(C.On, s.powerSwitch === 1);
    this.fanSvc.updateCharacteristic(C.RotationSpeed, s.powerSwitch ? this.windToPercent(s.windSpeed) : 0);
  }

  // ---- Helpers ----

  private workModeToHk(workMode: number): number {
    const C = this.hap.Characteristic;
    switch (workMode) {
      case MODE.COOL: return C.TargetHeatingCoolingState.COOL;
      case MODE.HEAT: return C.TargetHeatingCoolingState.HEAT;
      case MODE.AUTO: return C.TargetHeatingCoolingState.AUTO;
      default:        return C.TargetHeatingCoolingState.COOL;
    }
  }

  private windToPercent(wind: number): number {
    switch (wind) {
      case 0: return 0;
      case 2: return 12.5;
      case 3: return 37.5;
      case 4: return 50;
      case 5: return 62.5;
      case 6: return 87.5;
      default: return 0;
    }
  }

  private percentToWind(pct: number): number {
    if (pct <= 0)    return 0;
    if (pct <= 25)   return 2;
    if (pct <= 37.5) return 3;
    if (pct <= 50)   return 4;
    if (pct <= 62.5) return 5;
    return 6;
  }

  // ---- Polling ----

  private startPolling(): void {
    setInterval(async () => {
      try {
        const force = Date.now() - this._lastOkPoll > 10000;
        const s     = await this.api.getDeviceState(this.device.deviceId, force);
        if (s) {
          this._errCount   = 0;
          this._lastOkPoll = Date.now();
          this.updateFromState(s);
        }
      } catch (err) {
        this._errCount++;
        const msg       = errMsg(err);
        const isAuthErr = msg.includes('Forbidden') || msg.includes('expired') || msg.includes('InvalidToken');
        if (isAuthErr || this._errCount >= 3) {
          this.log.warn('Re-authenticating...');
          this._errCount = 0;
          await this.api.reAuth();
        }
      }
    }, 3000).unref();

    setInterval(() => {
      const cached = this.api.stateCache[this.device.deviceId];
      if (cached && Date.now() - cached.lastUpdated > 45000) {
        delete this.api.stateCache[this.device.deviceId];
        this.log.debug(`State cache cleared for ${this.device.deviceId}`);
      }
    }, 30000).unref();

    if (!this.api._credRefreshStarted) {
      this.api._credRefreshStarted = true;
      setInterval(() => this.api.refreshCredentials(), 50 * 60 * 1000).unref();
      this.log.debug('AWS credentials auto-refresh scheduled (every 50 min)');
    }
  }
}
