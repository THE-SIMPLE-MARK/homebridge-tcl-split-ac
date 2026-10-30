import { TclHomePlatform } from './platform.js';

export default (homebridge: any): void => {
  homebridge.registerPlatform('@the-simple-mark/homebridge-tcl-split-ac', 'TclHome', TclHomePlatform);
};
