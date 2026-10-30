export const MODE = {
  AUTO: 0,
  COOL: 1,
  DRY:  2,
  FAN:  3,
  HEAT: 4,
} as const;

export const WIND = {
  AUTO:     0,
  SILENT:   2,
  LOW:      2,
  MED_LOW:  3,
  MED:      4,
  MED_HIGH: 5,
  HIGH:     6,
  TURBO:    6,
} as const;

export const TIMEOUTS = {
  HTTP:        10000,
  IOT_SHADOW:   6000,
  HOMEKIT_GET:  5000,
} as const;
