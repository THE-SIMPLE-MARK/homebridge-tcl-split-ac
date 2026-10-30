import { Logging } from 'homebridge';
import { TclHomePlatform } from './platform.js';
import { MODE, TIMEOUTS, WIND } from './constants.js';
import { DeviceState, TclDevice } from './types.js';
import { errMsg, withTimeout } from './utils.js';

type Props = Record<string, unknown>;

export class TclAirConditioner {
  private readonly platform: TclHomePlatform;
  private readonly accessory: any;
  private readonly device: TclDevice;
  private readonly log: Logging;
  private readonly api: any;
  private readonly hap: any;
  private thermostat: any;
  private fanSvc: any;
  private pollTimer?: ReturnType<typeof setInterval>;
  private staleTimer?: ReturnType<typeof setInterval>;
  private lastMode?: number;
  private lastWindSpeed?: number;
  private requestedWindSpeed?: number;
  private lastPowerSwitch?: number;
  private lastKnownTarget?: number;
  private lastSupportedTargetMode?: number;
  private fanSpeedSelected = false;
  private minTemp = 16;
  private maxTemp = 31;
  private lastKnownTemp?: number;
  private lastStateKey = '';
  private errCount = 0;
  private lastOkPoll = Date.now();
  private commandQueue: Promise<void> = Promise.resolve();
  private lastCommandKey: string | null = null;
  private lastCommandTime = 0;
  private lastCommandPromise?: Promise<void>;
  private commandGeneration = 0;
  private optimisticState: Partial<DeviceState> = {};
  private lastAppliedStateTime = 0;
  private pollInFlight?: Promise<void>;
  private stopped = false;

  constructor(platform: TclHomePlatform, accessory: any, device: TclDevice) {
    this.platform = platform;
    this.accessory = accessory;
    this.device = device;
    this.log = platform.log;
    this.api = platform.tclApi;
    this.hap = platform.api.hap;
    this.setupAccessoryInfo();
    this.setupThermostat();
    this.setupFan();
    this.startPolling();
    this.log.info(`${device.deviceName} ready (Thermostat | 16-31C | 8 fan speeds)`);
  }

  stop(): void {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.pollTimer = undefined;
    this.staleTimer = undefined;
  }

  private setupAccessoryInfo(): void {
    const info = this.accessory.getService(this.hap.Service.AccessoryInformation);
    info.setCharacteristic(this.hap.Characteristic.Manufacturer, 'TCL')
      .setCharacteristic(this.hap.Characteristic.Model, 'TAC-09CHSD/XA41IN')
      .setCharacteristic(this.hap.Characteristic.SerialNumber, this.device.deviceId)
      .setCharacteristic(this.hap.Characteristic.FirmwareRevision, this.device.firmwareVersion || '1.0.0');
  }

  private setupThermostat(): void {
    const C = this.hap.Characteristic;
    this.thermostat = this.accessory.getService(this.hap.Service.Thermostat)
      || this.accessory.addService(this.hap.Service.Thermostat, this.device.deviceName, 'thermostat');
    this.thermostat.setCharacteristic(C.Name, this.device.deviceName);
    this.thermostat.getCharacteristic(C.CurrentHeatingCoolingState)
      .onGet(() => this.getCurrentState());
    this.thermostat.getCharacteristic(C.TargetHeatingCoolingState)
      .setProps({ validValues: [C.TargetHeatingCoolingState.OFF, C.TargetHeatingCoolingState.AUTO, C.TargetHeatingCoolingState.HEAT, C.TargetHeatingCoolingState.COOL] })
      .onGet(() => this.getTargetMode())
      .onSet((v: number) => this.setTargetMode(v));
    this.thermostat.getCharacteristic(C.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 100, minStep: 0.1 })
      .onGet(() => this.getCurrentTemp());
    this.thermostat.getCharacteristic(C.TargetTemperature)
      .setProps({ minValue: 16, maxValue: 31, minStep: 1 })
      .onGet(() => this.getTargetTemp())
      .onSet((v: number) => this.setTargetTemp(v));
    this.thermostat.getCharacteristic(C.TemperatureDisplayUnits)
      .onGet(() => C.TemperatureDisplayUnits.CELSIUS);
  }

  private setupFan(): void {
    const C = this.hap.Characteristic;
    this.fanSvc = this.accessory.getService('Fan Speed Control')
      || this.accessory.addService(this.hap.Service.Fan, 'Fan Speed Control', 'fanSpeedControl');
    this.fanSvc.getCharacteristic(C.On).onGet(() => this.getActive()).onSet((v: boolean) => this.setFanActive(v));
    this.fanSvc.getCharacteristic(C.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 12.5 })
      .onGet(() => this.getFanSpeed()).onSet((v: number) => this.setFanSpeed(v));
  }

  private async state(ctx: string): Promise<DeviceState> {
    const state = await withTimeout(this.api.getDeviceState(this.device.deviceId, false), TIMEOUTS.HOMEKIT_GET, ctx) as DeviceState;
    this.rememberState(state);
    return state;
  }

  private rememberState(s: DeviceState): void {
    if (!s.isOnline) return;
    this.lastPowerSwitch = s.powerSwitch;
    this.lastMode = s.workMode;
    this.lastKnownTarget = s.targetTemperature;
    if (this.lastWindSpeed === undefined || !this.fanSpeedSelected) {
      this.lastWindSpeed = s.windSpeed;
    }
  }

  private async commandState(ctx: string): Promise<DeviceState> {
    const cached = this.api.stateCache[this.device.deviceId] as DeviceState | undefined;
    let current = cached && cached.isOnline && Date.now() - cached.lastUpdated <= 45000 ? cached : undefined;
    if (!current) {
      const fresh = await withTimeout(
        this.api.getDeviceState(this.device.deviceId, true), TIMEOUTS.HOMEKIT_GET, `${ctx} refresh`,
      ) as DeviceState;
      this.rememberState(fresh);
      if (fresh.isOnline) current = fresh;
    }
    if (current) return current;

    if (this.lastPowerSwitch !== undefined && this.lastMode !== undefined &&
        this.lastWindSpeed !== undefined && this.lastKnownTarget !== undefined) {
      this.log.warn(`${this.device.deviceName}: ${ctx} using last-known state while a fresh state is unavailable`);
      return {
        powerSwitch: this.lastPowerSwitch,
        workMode: this.lastMode,
        windSpeed: this.lastWindSpeed,
        targetTemperature: this.lastKnownTarget,
        currentTemperature: this.lastKnownTemp,
        minTemp: this.minTemp,
        maxTemp: this.maxTemp,
        isOnline: false,
        lastUpdated: Date.now(),
      };
    }
    throw new Error(`${ctx}: device state unavailable`);
  }

  private async getActive(): Promise<number> {
    try { return (await this.state('getActive')).powerSwitch ? 1 : 0; } catch (_) { return 0; }
  }
  private async getCurrentState(): Promise<number> {
    try {
      const s = await this.state('getCurrentState');
      if (!s.powerSwitch) return this.hap.Characteristic.CurrentHeatingCoolingState.OFF;
      if (s.workMode === MODE.HEAT) return this.hap.Characteristic.CurrentHeatingCoolingState.HEAT;
      if (s.workMode === MODE.COOL) return this.hap.Characteristic.CurrentHeatingCoolingState.COOL;
      if (s.workMode === MODE.AUTO) return this.hap.Characteristic.CurrentHeatingCoolingState.COOL;
      this.log.warn(`${this.device.deviceName}: unsupported TCL mode ${s.workMode}; reporting OFF`);
      return this.hap.Characteristic.CurrentHeatingCoolingState.OFF;
    } catch (_) { return this.hap.Characteristic.CurrentHeatingCoolingState.OFF; }
  }
  private async getTargetMode(): Promise<number> {
    try {
      const s = await this.state('getTargetMode');
      if (!s.isOnline) {
        if (this.lastPowerSwitch === 0) return this.hap.Characteristic.TargetHeatingCoolingState.OFF;
        if (this.lastSupportedTargetMode !== undefined) return this.lastSupportedTargetMode;
        if (this.lastMode !== undefined) return this.workModeToHk(this.lastMode);
        return this.hap.Characteristic.TargetHeatingCoolingState.OFF;
      }
      return s.powerSwitch ? this.workModeToHk(s.workMode) : this.hap.Characteristic.TargetHeatingCoolingState.OFF;
    }
    catch (_) {
      this.log.warn(`${this.device.deviceName}: target mode unavailable; retaining last supported target mode`);
      return this.lastSupportedTargetMode ?? this.hap.Characteristic.TargetHeatingCoolingState.OFF;
    }
  }
  private async getCurrentTemp(): Promise<number> {
    try {
      const s = await this.state('getCurrentTemp');
      if (s.currentTemperature !== undefined) this.lastKnownTemp = s.currentTemperature;
    } catch (_) { /* use last known value */ }
    return this.lastKnownTemp ?? 0;
  }
  private async getTargetTemp(): Promise<number> {
    try {
      const s = await this.state('getTargetTemp');
      if (!s.isOnline && this.lastKnownTarget !== undefined) return this.lastKnownTarget;
      return s.targetTemperature;
    } catch (_) {
      return this.lastKnownTarget ?? 22;
    }
  }
  private async getFanSpeed(): Promise<number> {
    try {
      const s = await this.state('getFanSpeed');
      return s.powerSwitch ? this.windToPercent(s.windSpeed) :
        this.windToPercent(this.requestedWindSpeed ?? this.lastWindSpeed ?? s.windSpeed);
    } catch (_) { return this.windToPercent(this.requestedWindSpeed ?? this.lastWindSpeed ?? WIND.AUTO); }
  }

  private queueCommand(props: Props | (() => Props | Promise<Props>), ctx: string, keyProps?: Props): Promise<void> {
    const key = JSON.stringify(keyProps ?? (typeof props === 'function' ? ctx : props));
    if (key === this.lastCommandKey && Date.now() - this.lastCommandTime < 3000 && this.lastCommandPromise) {
      return this.lastCommandPromise;
    }
    this.lastCommandKey = key;
    this.lastCommandTime = Date.now();
    const generation = ++this.commandGeneration;
    const run = this.commandQueue.then(async () => {
      // Resolve dynamic commands only after earlier queued commands have
      // completed, so mode/power payloads use the current target setpoint.
      const commandProps = typeof props === 'function' ? await props() : props;
      if (!await this.api.sendCommand(this.device.deviceId, commandProps)) throw new Error(`${ctx} failed`);
      this.log.debug(`Command succeeded (${ctx})`);
      this.rememberOptimisticProps(commandProps);
      setTimeout(() => {
        if (this.stopped || generation !== this.commandGeneration) return;
        this.api.getDeviceState(this.device.deviceId, true)
          .then((s: DeviceState) => {
            if (!this.stopped && generation === this.commandGeneration) this.updateFromState(s);
          })
          .catch((e: unknown) => this.log.debug(`Command refresh failed: ${errMsg(e)}`));
      }, 1200).unref();
    });
    this.lastCommandPromise = run;
    this.commandQueue = run.catch(() => undefined);
    void run.catch(() => {
      if (this.lastCommandPromise === run) {
        this.lastCommandKey = null;
        this.lastCommandPromise = undefined;
      }
    });
    return run;
  }

  private async setActive(value: number): Promise<void> {
    try {
      const cur = await this.commandState('setActive');
      await this.queueCommand(value ? async () => {
        const latest = await this.commandState('setActive latest');
        return this.modeProps(latest.workMode, latest);
      } : { powerSwitch: 0 }, 'setActive', { powerSwitch: value ? 1 : 0 });
      if (value && [MODE.AUTO, MODE.COOL, MODE.HEAT].includes(cur.workMode as 0 | 1 | 4)) {
        this.lastMode = cur.workMode;
      }
    } catch (e) { throw this.hapError('setActive', e); }
  }
  private async setTargetMode(value: number): Promise<void> {
    try {
      const cur = await this.commandState('setTargetMode');
      const C = this.hap.Characteristic.TargetHeatingCoolingState;
      if (value === C.OFF) {
        await this.queueCommand({ powerSwitch: 0 }, 'setTargetMode', { powerSwitch: 0 });
        return;
      }
      const mode = this.hkToWorkMode(value);
      await this.queueCommand(async () => {
        const latest = await this.commandState('setTargetMode latest');
        return this.modeProps(mode, latest);
      }, 'setTargetMode', this.modeProps(mode, cur));
      this.lastMode = mode;
      this.lastSupportedTargetMode = value;
    } catch (e) { throw this.hapError('setTargetMode', e); }
  }
  private async setTargetTemp(value: number): Promise<void> {
    try {
      const temp = Math.max(this.minTemp, Math.min(this.maxTemp, Math.round(value)));
      const cur = await this.commandState('setTargetTemp');
      const target = { targetCelsiusDegree: temp, targetTemperature: temp };
      if (cur.powerSwitch) {
        await this.queueCommand(target, 'setTargetTemp');
      } else {
        if (!cur.isOnline) throw new Error('setTargetTemp: fresh device state unavailable while off');
        const windSpeed = this.requestedWindSpeed ?? this.lastWindSpeed ?? cur.windSpeed;
        await this.queueCommand(async () => {
          const latest = await this.commandState('setTargetTemp latest');
          const latestWind = this.requestedWindSpeed ?? this.lastWindSpeed ?? latest.windSpeed;
          return {
            powerSwitch: latest.powerSwitch, workMode: latest.workMode,
            windSpeed: latestWind, ...target,
          };
        }, 'setTargetTemp', {
          powerSwitch: cur.powerSwitch, workMode: cur.workMode, windSpeed, ...target,
        });
      }
      this.updateTargetTemperature(temp);
    } catch (e) { throw this.hapError('setTargetTemp', e); }
  }
  private async setFanActive(value: boolean): Promise<void> {
    try {
      const cur = await this.commandState('setFanActive');
      if (value !== !!cur.powerSwitch) {
        await this.queueCommand(value ? async () => {
          const latest = await this.commandState('setFanActive latest');
          return this.modeProps(latest.workMode, latest);
        } : { powerSwitch: 0 }, 'setFanActive', { powerSwitch: value ? 1 : 0 });
        if (value && [MODE.AUTO, MODE.COOL, MODE.HEAT].includes(cur.workMode as 0 | 1 | 4)) {
          this.lastMode = cur.workMode;
        }
      }
    } catch (e) { throw this.hapError('setFanActive', e); }
  }
  private async setFanSpeed(value: number): Promise<void> {
    try {
      const wind = this.percentToWind(value);
      const cur = await this.commandState('setFanSpeed');
      if (cur.powerSwitch) {
        await this.queueCommand({ windSpeed: wind }, 'setFanSpeed');
        this.lastWindSpeed = wind;
        this.requestedWindSpeed = undefined;
      } else {
        this.requestedWindSpeed = wind;
      }
      this.fanSpeedSelected = true;
    } catch (e) { throw this.hapError('setFanSpeed', e); }
  }

  private modeProps(mode: number, cur: DeviceState): Props {
    if (![MODE.AUTO, MODE.COOL, MODE.HEAT].includes(mode as 0 | 1 | 4)) {
      this.log.warn(`${this.device.deviceName}: unsupported TCL mode ${mode}; retaining AUTO fallback`);
      mode = this.lastSupportedTargetMode === undefined ? MODE.AUTO : this.hkToWorkMode(this.lastSupportedTargetMode);
    }
    const windSpeed = cur.powerSwitch ? cur.windSpeed :
      this.requestedWindSpeed ?? this.lastWindSpeed ?? cur.windSpeed;
    return { powerSwitch: 1, workMode: mode, windSpeed,
      targetCelsiusDegree: cur.targetTemperature, targetTemperature: cur.targetTemperature,
      ECO: 0, sleep: 0, turbo: 0, silenceSwitch: 0 };
  }
  private hkToWorkMode(value: number): number {
    const C = this.hap.Characteristic.TargetHeatingCoolingState;
    return value === C.HEAT ? MODE.HEAT : value === C.AUTO ? MODE.AUTO : MODE.COOL;
  }
  private workModeToHk(mode: number): number {
    const C = this.hap.Characteristic.TargetHeatingCoolingState;
    if (mode === MODE.HEAT) { this.lastSupportedTargetMode = C.HEAT; return C.HEAT; }
    if (mode === MODE.AUTO) { this.lastSupportedTargetMode = C.AUTO; return C.AUTO; }
    if (mode === MODE.COOL) { this.lastSupportedTargetMode = C.COOL; return C.COOL; }
    this.log.warn(`${this.device.deviceName}: unsupported TCL mode ${mode}; reporting AUTO`);
    return C.AUTO;
  }
  private hapError(ctx: string, error: unknown): Error {
    this.log.error(`${ctx}: ${errMsg(error)}`);
    return new this.hap.HapStatusError(this.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  updateFromState(s: DeviceState): void {
    if (s.lastUpdated < this.lastAppliedStateTime) return;
    this.lastAppliedStateTime = s.lastUpdated;
    const reconciled = { ...s };
    for (const key of ['powerSwitch', 'workMode', 'windSpeed', 'targetTemperature'] as const) {
      const desired = this.optimisticState[key];
      if (desired === undefined) continue;
      if (s[key] === desired) delete this.optimisticState[key];
      else reconciled[key] = desired;
    }
    this.rememberState(reconciled);
    const key = `${reconciled.powerSwitch}-${reconciled.workMode}-${reconciled.windSpeed}-${reconciled.currentTemperature}-${reconciled.targetTemperature}`;
    if (key === this.lastStateKey) return;
    this.lastStateKey = key;
    this.minTemp = reconciled.minTemp || this.minTemp;
    this.maxTemp = reconciled.maxTemp || this.maxTemp;
    this.lastKnownTarget = reconciled.targetTemperature;
    if (reconciled.currentTemperature !== undefined) this.lastKnownTemp = reconciled.currentTemperature;
    const C = this.hap.Characteristic;
    if (this.lastKnownTemp !== undefined) this.thermostat.updateCharacteristic(C.CurrentTemperature, this.lastKnownTemp);
    if (reconciled.targetTemperature !== undefined) this.updateTargetTemperature(reconciled.targetTemperature);
    this.thermostat.updateCharacteristic(C.CurrentHeatingCoolingState, !reconciled.powerSwitch ? C.CurrentHeatingCoolingState.OFF :
      reconciled.workMode === MODE.HEAT ? C.CurrentHeatingCoolingState.HEAT :
      reconciled.workMode === MODE.COOL || reconciled.workMode === MODE.AUTO ? C.CurrentHeatingCoolingState.COOL :
      C.CurrentHeatingCoolingState.OFF);
    this.thermostat.updateCharacteristic(C.TargetHeatingCoolingState,
      reconciled.powerSwitch ? this.workModeToHk(reconciled.workMode) : C.TargetHeatingCoolingState.OFF);
    this.fanSvc.updateCharacteristic(C.On, !!reconciled.powerSwitch);
    this.fanSvc.updateCharacteristic(C.RotationSpeed,
      reconciled.powerSwitch ? this.windToPercent(reconciled.windSpeed) :
        this.windToPercent(this.requestedWindSpeed ?? this.lastWindSpeed ?? reconciled.windSpeed));
  }
  private rememberOptimisticProps(props: Props): void {
    for (const key of ['powerSwitch', 'workMode', 'windSpeed'] as const) {
      if (typeof props[key] === 'number') this.optimisticState[key] = props[key] as number;
    }
    const target = props.targetCelsiusDegree ?? props.targetTemperature;
    if (typeof target === 'number') this.optimisticState.targetTemperature = target;
  }
  private updateTargetTemperature(temp: number): void {
    const C = this.hap.Characteristic;
    this.thermostat.updateCharacteristic(C.TargetTemperature, temp);
  }
  private windToPercent(wind: number): number {
    return ({ [WIND.AUTO]: 0, [WIND.SILENT]: 12.5, [WIND.MED_LOW]: 37.5, [WIND.MED]: 50, [WIND.MED_HIGH]: 62.5, [WIND.HIGH]: 87.5 } as Record<number, number>)[wind] ?? 0;
  }
  private percentToWind(value: number): number {
    if (value <= 0) return WIND.AUTO;
    if (value <= 25) return WIND.SILENT;
    if (value <= 37.5) return WIND.MED_LOW;
    if (value <= 50) return WIND.MED;
    if (value <= 62.5) return WIND.MED_HIGH;
    return WIND.HIGH;
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => this.poll(), 3000);
    this.pollTimer.unref();
    this.staleTimer = setInterval(() => {
      const cached = this.api.stateCache[this.device.deviceId];
      if (cached && Date.now() - cached.lastUpdated > 45000) delete this.api.stateCache[this.device.deviceId];
    }, 30000);
    this.staleTimer.unref();
  }
  private async poll(): Promise<void> {
    if (this.stopped) return;
    if (this.pollInFlight) return this.pollInFlight;
    const run = (async () => {
      try {
        const s = await this.api.getDeviceState(this.device.deviceId, Date.now() - this.lastOkPoll > 10000);
        if (this.stopped) return;
        if (!s.isOnline) throw new Error('device state is offline');
        this.errCount = 0; this.lastOkPoll = Date.now(); this.updateFromState(s);
      } catch (e) {
        this.errCount++;
        this.log.warn(`${this.device.deviceName}: poll failed (${this.errCount}): ${errMsg(e)}`);
        if (this.errCount >= 3) { this.errCount = 0; await this.api.reAuth(); }
      }
    })();
    this.pollInFlight = run;
    void run.then(() => {
      if (this.pollInFlight === run) this.pollInFlight = undefined;
    }, () => {
      if (this.pollInFlight === run) this.pollInFlight = undefined;
    });
    return run;
  }
}
