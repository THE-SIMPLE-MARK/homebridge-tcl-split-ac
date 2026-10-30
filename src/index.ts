import { TclHomePlatform } from './platform.js';
import { API } from 'homebridge';

export default (homebridge: API): void => {
  homebridge.registerPlatform('@the-simple-mark/homebridge-tcl-split-ac', 'TclHome', TclHomePlatform);
};
