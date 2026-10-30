import { TclHomePlatform } from './platform.js';

export default (homebridge: any): void => {
  homebridge.registerPlatform('homebridge-tcl-split-ac', 'TclHome', TclHomePlatform);
};
