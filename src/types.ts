import { Logging } from 'homebridge';

export interface TclDevice {
  deviceId: string;
  deviceName: string;
  category?: string;
  firmwareVersion?: string;
}

export interface PluginConfig {
  username: string;
  password: string;
  appLoginUrl?: string;
  cloudUrls?: string;
  appId?: string;
  log: Logging;
}

export interface DeviceState {
  powerSwitch:        number;
  workMode:           number;
  windSpeed:          number;
  targetTemperature:  number;
  currentTemperature: number | undefined;
  minTemp:            number;
  maxTemp:            number;
  isOnline:           boolean;
  lastUpdated:        number;
}

export interface AuthData {
  status: number;
  msg:    string;
  token:  string;
  user: {
    username:    string;
    countryAbbr: string;
  };
}

export interface CloudUrlsData {
  data: {
    cloud_url:    string;
    device_url:   string;
    cloud_region: string;
  };
}

export interface RefreshTokensData {
  data: {
    saasToken:    string;
    cognitoToken: string;
  };
}

export interface AwsCredentials {
  Credentials: {
    AccessKeyId:      string;
    SecretAccessKey?: string;
    SecretKey?:       string;
    SessionToken:     string;
  };
}
