import { API, Logging, PlatformAccessory } from 'homebridge';
import { TclHomeApi } from './api.js';
import { TclAirConditioner } from './accessory.js';
import { errMsg } from './utils.js';
import { TclDevice } from './types.js';

export class TclHomePlatform {
  public log:         Logging;
  public config:      Record<string, unknown>;
  public api:         API;
  public accessories: PlatformAccessory[] = [];
  public tclApi!:     TclHomeApi;
  private readonly controllers = new Map<string, TclAirConditioner>();
  private discoveryPromise?: Promise<void>;
  private readonly credentialTimer?: ReturnType<typeof setInterval>;
  private readonly didFinishLaunchingListener = () => { void this.discoverDevices(); };
  private readonly shutdownListener = () => this.shutdown();
  private stopped = false;

  constructor(log: Logging, config: Record<string, unknown>, api: API) {
    this.log    = log;
    this.config = config;
    this.api    = api;

    if (!config?.username || !config?.password) {
      this.log.error('Username and password are required in config');
      return;
    }

    this.tclApi = new TclHomeApi({
      username:    String(config.username),
      password:    String(config.password),
      appLoginUrl: typeof config.appLoginUrl === 'string' ? config.appLoginUrl : undefined,
      cloudUrls:   typeof config.cloudUrls === 'string' ? config.cloudUrls : undefined,
      appId:       typeof config.appId === 'string' ? config.appId : undefined,
      log:         this.log,
    });
    this.credentialTimer = setInterval(() => { void this.tclApi.refreshCredentials(); }, 50 * 60 * 1000);
    this.credentialTimer.unref();

    this.api.on('didFinishLaunching', this.didFinishLaunchingListener);
    this.api.on('shutdown', this.shutdownListener);
  }

  async discoverDevices(): Promise<void> {
    if (this.stopped) return;
    if (this.discoveryPromise) return this.discoveryPromise;
    this.discoveryPromise = this.discoverWithRetries().finally(() => { this.discoveryPromise = undefined; });
    return this.discoveryPromise;
  }

  private async discoverWithRetries(): Promise<void> {
    const MAX_RETRIES = 5;
    const RETRY_DELAY = 15000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (this.stopped) return;
      try {
        this.log.info('Discovering TCL devices...');
        await this.tclApi.initialize();
        const devices = await this.tclApi.getDevices();
        if (this.stopped) return;
        this.log.info(`Found ${devices.length} device(s)`);
        for (const device of devices) {
          if (device.category === 'AC') this.addAccessory(device as TclDevice);
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

  addAccessory(device: TclDevice): void {
    if (this.stopped) return;
    const uuid     = this.api.hap.uuid.generate(device.deviceId);
    const existing = this.accessories.find((a) => a.UUID === uuid);

    if (existing) {
      if (!this.controllers.has(uuid)) {
        this.controllers.set(uuid, new TclAirConditioner(this, existing, device));
      } else {
        this.log.debug(`${device.deviceName} already initialized, skipping`);
      }
    } else {
      const acc = new this.api.platformAccessory(device.deviceName, uuid) as PlatformAccessory;
      this.controllers.set(uuid, new TclAirConditioner(this, acc, device));
      this.api.registerPlatformAccessories('homebridge-tcl-split-ac', 'TclHome', [acc]);
      this.accessories.push(acc);
    }
  }

  configureAccessory(acc: PlatformAccessory): void {
    if (!this.accessories.some((a) => a.UUID === acc.UUID)) this.accessories.push(acc);
  }

  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.credentialTimer) clearInterval(this.credentialTimer);
    for (const controller of this.controllers.values()) controller.stop();
    this.controllers.clear();
    (this.api as any).removeListener?.('didFinishLaunching', this.didFinishLaunchingListener);
    (this.api as any).removeListener?.('shutdown', this.shutdownListener);
  }
}
