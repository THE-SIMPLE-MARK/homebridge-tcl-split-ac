import axios from 'axios';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import * as AWS from 'aws-sdk';
import * as https from 'https';
import { Logging } from 'homebridge';
import {
  AuthData,
  AwsCredentials,
  CloudUrlsData,
  DeviceState,
  PluginConfig,
  RefreshTokensData,
  TclDevice,
} from './types.js';
import { MODE, TIMEOUTS, WIND } from './constants.js';
import { errMsg, withTimeout } from './utils.js';

// Persistent keep-alive connection — reused between commands to avoid a new
// TLS handshake (~200-500 ms) on every publish.
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 5, keepAliveMsecs: 60000 });

export class TclHomeApi {
  private username:          string;
  private password:          string;
  private appLoginUrl:       string;
  private cloudUrls:         string;
  private appId:             string;
  private log:               Logging;

  private authData:          AuthData | null          = null;
  private cloudUrlsData:     CloudUrlsData | null     = null;
  private refreshTokensData: RefreshTokensData | null = null;
  private awsCredentials:    AwsCredentials | null    = null;
  private iotData:           AWS.IotData | null       = null;

  public  stateCache:          Record<string, DeviceState> = {};
  private lastCall:            Record<string, number>      = {};
  private stateRequestSequence: Record<string, number>   = {};
  private stateCommitSequence:  Record<string, number>    = {};
  private authRetry:           number  = 0;
  private maxAuthRetry:        number  = 3;
  private _reAuthInProgress:   boolean = false;
  private _reAuthPromise:      Promise<void> | null = null;
  public  _credRefreshStarted: boolean = false;

  constructor(config: PluginConfig) {
    this.username    = config.username;
    this.password    = config.password;
    this.appLoginUrl = config.appLoginUrl || 'https://pa.account.tcl.com/account/login?clientId=54148614';
    this.cloudUrls   = config.cloudUrls   || 'https://prod-center.aws.tcljd.com/v3/global/cloud_url_get';
    this.appId       = config.appId       || 'wx6e1af3fa84fbe523';
    this.log         = config.log;
  }

  async initialize(): Promise<void> {
    this.log.info('Authenticating...');
    await this.authenticate();
    await this.fetchCloudUrls();
    await this.refreshTokens();
    await this.fetchAwsCredentials();
    this.setupIot();
    this.log.info('TCL API ready');
  }

  async authenticate(): Promise<void> {
    const passHash = crypto.createHash('md5').update(this.password).digest('hex');
    const resp = await withTimeout(
      axios.post(this.appLoginUrl, {
        equipment: 2, password: passHash, osType: 1,
        username: this.username, clientVersion: '4.8.1',
        osVersion: '6.0', deviceModel: 'AndroidAndroid SDK built for x86',
        captchaRule: 2, channel: 'app',
      }, {
        timeout: TIMEOUTS.HTTP,
        headers: {
          'th_platform': 'android', 'th_version': '4.8.1',
          'th_appbulid': '830', 'user-agent': 'Android',
          'content-type': 'application/json; charset=UTF-8',
        },
      }),
      TIMEOUTS.HTTP, 'authenticate',
    );
    if (resp.data.status !== 1) throw new Error('Auth failed: ' + resp.data.msg);
    this.authData  = resp.data as AuthData;
    this.authRetry = 0;
    this.log.info('Authenticated');
  }

  async fetchCloudUrls(): Promise<void> {
    const resp = await withTimeout(
      axios.post(this.cloudUrls, {
        ssoId:    this.authData!.user.username,
        ssoToken: this.authData!.token,
      }, {
        timeout: TIMEOUTS.HTTP,
        headers: { 'user-agent': 'Android', 'content-type': 'application/json; charset=UTF-8' },
      }),
      TIMEOUTS.HTTP, 'fetchCloudUrls',
    );
    this.cloudUrlsData = resp.data as CloudUrlsData;
  }

  async refreshTokens(): Promise<void> {
    const url  = `${this.cloudUrlsData!.data.cloud_url}/v3/auth/refresh_tokens`;
    const resp = await withTimeout(
      axios.post(url, {
        userId:   this.authData!.user.username,
        ssoToken: this.authData!.token,
        appId:    this.appId,
      }, {
        timeout: TIMEOUTS.HTTP,
        headers: { 'user-agent': 'Android', 'content-type': 'application/json; charset=UTF-8' },
      }),
      TIMEOUTS.HTTP, 'refreshTokens',
    );
    this.refreshTokensData = resp.data as RefreshTokensData;
  }

  async fetchAwsCredentials(): Promise<void> {
    const region  = this.cloudUrlsData!.data.cloud_region;
    const decoded = jwt.decode(this.refreshTokensData!.data.cognitoToken) as Record<string, unknown> | null;
    if (!decoded?.['sub']) throw new Error('Invalid cognitoToken: failed to decode JWT');

    const resp = await withTimeout(
      axios.post(
        `https://cognito-identity.${region}.amazonaws.com/`,
        {
          IdentityId: decoded['sub'],
          Logins: { 'cognito-identity.amazonaws.com': this.refreshTokensData!.data.cognitoToken },
        },
        {
          timeout: TIMEOUTS.HTTP,
          headers: {
            'User-agent': 'aws-sdk-android/2.22.6 Linux/6.1.23 Dalvik/2.1.0/0 en_US',
            'X-Amz-Target': 'AWSCognitoIdentityService.GetCredentialsForIdentity',
            'content-type': 'application/x-amz-json-1.1',
          },
        },
      ),
      TIMEOUTS.HTTP, 'fetchAwsCredentials',
    );
    this.awsCredentials = resp.data as AwsCredentials;
    this.log.info('AWS credentials OK');
  }

  setupIot(): void {
    const region = this.cloudUrlsData!.data.cloud_region;
    const creds  = this.awsCredentials!.Credentials;

    // AWS Cognito returns SecretKey; the SDK expects secretAccessKey — support both field names.
    const secretKey = creds.SecretAccessKey || creds.SecretKey;

    if (!creds.AccessKeyId || !secretKey || !creds.SessionToken) {
      this.log.error('setupIot: missing credentials fields:', JSON.stringify(Object.keys(creds)));
      throw new Error('Invalid AWS credentials structure');
    }

    this.log.debug(`Credentials fields: ${Object.keys(creds).join(', ')}`);

    this.iotData = new AWS.IotData({
      endpoint:        `https://data-ats.iot.${region}.amazonaws.com`,
      accessKeyId:     creds.AccessKeyId,
      secretAccessKey: secretKey,
      sessionToken:    creds.SessionToken,
      region,
      maxRetries:      0,
      httpOptions:     { timeout: 5000, connectTimeout: 3000, agent: keepAliveAgent as any },
    });
    this.log.info('AWS IoT ready');
  }

  async getDevices(): Promise<TclDevice[]> {
    const url       = `${this.cloudUrlsData!.data.device_url}/v3/user/get_things`;
    const timestamp = Date.now().toString();
    const nonce     = Math.random().toString(36).substr(2, 16);
    const sign      = this.md5(timestamp + nonce + this.refreshTokensData!.data.saasToken);
    const resp      = await withTimeout(
      axios.post(url, {}, {
        timeout: TIMEOUTS.HTTP,
        headers: {
          platform: 'android', appversion: '5.4.1', thomeversion: '4.8.1',
          accesstoken: this.refreshTokensData!.data.saasToken,
          countrycode: this.authData!.user.countryAbbr,
          'accept-language': 'en', timestamp, nonce, sign,
          'user-agent': 'Android', 'content-type': 'application/json; charset=UTF-8',
        },
      }),
      TIMEOUTS.HTTP, 'getDevices',
    );
    return (resp.data.data || []) as TclDevice[];
  }

  async getDeviceState(deviceId: string, force = false): Promise<DeviceState> {
    const now = Date.now();
    const requestSequence = (this.stateRequestSequence[deviceId] || 0) + 1;
    this.stateRequestSequence[deviceId] = requestSequence;

    // Debounce: don't hammer AWS more than once per 200 ms.
    if (!force && this.lastCall[deviceId] && now - this.lastCall[deviceId] < 200) {
      return this.stateCache[deviceId] || this.defaultState();
    }
    this.lastCall[deviceId] = now;

    // Wait for any in-progress re-auth before sending a request with stale credentials.
    if (this._reAuthInProgress && this._reAuthPromise) {
      this.log.debug('Waiting for re-auth before reading shadow...');
      try { await this._reAuthPromise; } catch (_) {}
      force = true;
    }

    if (!this.iotData) return this.stateCache[deviceId] || this.defaultState();

    try {
      const result = await withTimeout(
        this.iotData.getThingShadow({ thingName: deviceId }).promise(),
        TIMEOUTS.IOT_SHADOW, 'getThingShadow',
      );
      const shadow = JSON.parse((result.payload as Buffer).toString());
      const rep    = shadow.state?.reported || {};

      const state: DeviceState = {
        powerSwitch:        rep.powerSwitch         ?? 0,
        workMode:           rep.workMode            ?? MODE.COOL,
        windSpeed:          rep.windSpeed           ?? WIND.AUTO,
        targetTemperature:  rep.targetCelsiusDegree ?? rep.targetTemperature ?? 22,
        currentTemperature: rep.currentTemperature,
        minTemp:            rep.lowerTemperatureLimit ?? 16,
        maxTemp:            rep.upperTemperatureLimit ?? 31,
        isOnline:           true,
        lastUpdated:        now,
      };

      this.log.debug(
        '%s: power=%d mode=%d wind=%d target=%dC room=%sC',
        deviceId, state.powerSwitch, state.workMode, state.windSpeed,
        state.targetTemperature, state.currentTemperature ?? '?',
      );
      // A slower shadow response must not replace a result from a request
      // that started later.
      if (requestSequence >= (this.stateCommitSequence[deviceId] || 0)) {
        this.stateCache[deviceId] = state;
        this.stateCommitSequence[deviceId] = requestSequence;
        return state;
      }
      return this.stateCache[deviceId] || state;

    } catch (err) {
      this.log.debug(`Shadow read failed: ${errMsg(err)}`);
      const cached = this.stateCache[deviceId];
      if (requestSequence < (this.stateCommitSequence[deviceId] || 0)) {
        return cached || this.defaultState();
      }
      if (cached && now - cached.lastUpdated > 30000) {
        delete this.stateCache[deviceId];
        return this.defaultState();
      }
      if (cached) {
        cached.isOnline = false;
        return cached;
      }
      return this.defaultState();
    }
  }

  defaultState(): DeviceState {
    return {
      powerSwitch: 0, workMode: MODE.COOL, windSpeed: WIND.AUTO,
      targetTemperature: 22, currentTemperature: undefined,
      minTemp: 16, maxTemp: 31, isOnline: false, lastUpdated: Date.now(),
    };
  }

  async sendCommand(deviceId: string, props: Record<string, unknown>): Promise<boolean> {
    if (!this.iotData) { this.log.error('IoT not initialized'); return false; }

    // Wait for any in-progress re-auth before sending.
    if (this._reAuthInProgress && this._reAuthPromise) {
      this.log.debug('Waiting for re-auth before sending command...');
      try { await this._reAuthPromise; } catch (_) {}
    }

    const topic   = `$aws/things/${deviceId}/shadow/update`;
    const payload = JSON.stringify({ state: { desired: props }, clientToken: `hb_${Date.now()}` });
    this.log.info(`-> ${deviceId}: ${JSON.stringify(props)}`);

    const MAX_ATTEMPTS    = 2;
    const PUBLISH_TIMEOUT = 4000;

    let reauthed = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const cached = this.stateCache[deviceId];
        const cachedTimestamp = cached?.lastUpdated;
        await withTimeout(
          this.iotData.publish({ topic, payload, qos: 0 }).promise(),
          PUBLISH_TIMEOUT, 'publish',
        );

        // Optimistically update the cache so HomeKit reflects the change immediately.
        const current = this.stateCache[deviceId];
        // A poll may have replaced the cache while publish was in flight. Never
        // let an older optimistic write overwrite that newer reported state.
        if (current && current === cached && current.lastUpdated === cachedTimestamp) {
          Object.assign(current, props);
          const p = props as any;
          if (p.targetCelsiusDegree !== undefined)
            current.targetTemperature = p.targetCelsiusDegree;
        }

        this.log.debug(`Command sent (attempt ${attempt})`);
        return true;

      } catch (err) {
        const msg = errMsg(err);
        this.log.warn(`Publish attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}`);

        if (!reauthed && (msg.includes('Forbidden') || msg.includes('expired') || msg.includes('InvalidToken'))) {
          this.log.warn('Credentials expired, triggering re-auth...');
          await this.reAuth();
          reauthed = true;
          continue;
        }
      }
    }

    this.log.error('Publish failed after all attempts');
    return false;
  }

  // Single shared promise — concurrent callers all wait on the same re-auth.
  reAuth(): Promise<void> {
    if (this._reAuthPromise) {
      this.log.debug('re-auth already in progress, reusing promise');
      return this._reAuthPromise;
    }

    this._reAuthPromise = this._doReAuth().finally(() => {
      this._reAuthPromise    = null;
      this._reAuthInProgress = false;
    });

    return this._reAuthPromise;
  }

  private async _doReAuth(): Promise<void> {
    if (this.authRetry >= this.maxAuthRetry) {
      this.log.error('Max re-auth attempts reached. Will retry on next poll error.');
      this.authRetry = 0;
      return;
    }
    this.authRetry++;
    this._reAuthInProgress = true;
    this.log.info(`Re-auth attempt ${this.authRetry}/${this.maxAuthRetry}`);

    const MAX_RETRIES = 3;
    const RETRY_DELAY = 20000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.initialize();
        this.authRetry = 0;
        this.log.info('Re-auth successful');
        return;
      } catch (err) {
        this.log.error(`Re-auth attempt ${attempt}/${MAX_RETRIES} failed: ${errMsg(err)}`);
        if (attempt < MAX_RETRIES) {
          this.log.debug(`Retrying in ${RETRY_DELAY / 1000}s...`);
          await new Promise(r => setTimeout(r, RETRY_DELAY));
        }
      }
    }
    this.log.error('Re-auth failed after all retries. Will retry on next poll cycle.');
  }

  // Refresh only the AWS credentials every 50 minutes without a full re-login.
  async refreshCredentials(): Promise<void> {
    this.log.debug('Refreshing AWS credentials...');
    try {
      await this.refreshTokens();
      await this.fetchAwsCredentials();
      this.setupIot();
      this.log.info('AWS credentials refreshed');
    } catch (err) {
      this.log.error(`Credentials refresh failed: ${errMsg(err)}`);
      await this.reAuth();
    }
  }

  private md5(input: string): string {
    const hash = crypto.createHash('md5').update(input, 'utf8').digest();
    return Array.from(hash).map(b => ((b & 0xFF) < 16 ? '0' : '') + (b & 0xFF).toString(16)).join('');
  }
}
