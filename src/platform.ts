import { API, Logging } from 'homebridge';
import { TclHomeApi } from './api.js';
import { TclAirConditioner } from './accessory.js';
import { errMsg } from './utils.js';

export class TclHomePlatform {
  public log:         Logging;
  public config:      any;
  public api:         API;
  public accessories: any[] = [];
  public tclApi!:     TclHomeApi;

  constructor(log: Logging, config: any, api: API) {
    this.log    = log;
    this.config = config;
    this.api    = api;

    if (!config?.username || !config?.password) {
      this.log.error('Username and password are required in config');
      return;
    }

    this.tclApi = new TclHomeApi({
      username:    config.username,
      password:    config.password,
      appLoginUrl: config.appLoginUrl,
      cloudUrls:   config.cloudUrls,
      appId:       config.appId,
      log:         this.log,
    });

    this.api.on('didFinishLaunching', () => this.discoverDevices());
  }

  async discoverDevices(): Promise<void> {
    const MAX_RETRIES = 5;
    const RETRY_DELAY = 15000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        this.log.info('Discovering TCL devices...');
        await this.tclApi.initialize();
        const devices = await this.tclApi.getDevices();
        this.log.info(`Found ${devices.length} device(s)`);
        for (const device of devices) {
          if (device.category === 'AC') this.addAccessory(device);
        }
        return;
      } catch (err) {
        this.log.warn(`discoverDevices attempt ${attempt}/${MAX_RETRIES}: ${errMsg(err)}`);
        if (attempt < MAX_RETRIES) {
          this.log.debug(`Retrying in ${RETRY_DELAY / 1000}s...`);
          await new Promise(r => setTimeout(r, RETRY_DELAY));
        } else {
          this.log.error('discoverDevices failed after all retries. Restart Homebridge manually.');
        }
      }
    }
  }

  addAccessory(device: any): void {
    const uuid     = this.api.hap.uuid.generate(device.deviceId);
    const existing = this.accessories.find((a: any) => a.UUID === uuid);

    if (existing) {
      if (!existing._acInitialized) {
        existing._acInitialized = true;
        new TclAirConditioner(this, existing, device);
      } else {
        this.log.debug(`${device.deviceName} already initialized, skipping`);
      }
    } else {
      const acc: any = new this.api.platformAccessory(device.deviceName, uuid);
      acc._acInitialized = true;
      new TclAirConditioner(this, acc, device);
      this.api.registerPlatformAccessories('homebridge-tcl-split-ac', 'TclHome', [acc]);
      this.accessories.push(acc);
    }
  }

  configureAccessory(acc: any): void {
    this.accessories.push(acc);
  }
}
