# @the-simple-mark/homebridge-tcl-split-ac

[![npm version](https://img.shields.io/npm/v/%40the-simple-mark%2Fhomebridge-tcl-split-ac.svg)](https://www.npmjs.com/package/@the-simple-mark/homebridge-tcl-split-ac)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Homebridge plugin for TCL inverter split ACs. Tested on the **TCL TAC-09CHSD/XA41IN**; other models on the TCL Home cloud platform should work too.

## Configuration

```json
{
  "platforms": [
    {
      "platform": "TclHome",
      "name": "TCL Home",
      "username": "your@email.com",
      "password": "yourpassword"
    }
  ]
}
```

| Parameter  | Required | Description               |
|------------|----------|---------------------------|
| `username` | yes      | TCL Home account email    |
| `password` | yes      | TCL Home account password |

Run Homebridge with `-D` to enable debug logging.

The primary service is HomeKit's **Thermostat** service with one target
temperature setpoint. Its target heating/cooling state controls power and
selects Auto/Heat/Cool for the TCL operating mode. Fan power is exposed as a
separate Fan service, while discrete fan speeds are selectable through the
linked Fan Speed input selector (Auto, Silent, Low, Medium, Medium-High, and
High). TCL Dry and Fan-only modes use a safe supported-mode fallback rather
than being falsely presented as Cool. Commands are serialized and reconciled with fresh device state;
offline reads use the last known state where possible, and polling and command
refreshes are cleaned up on shutdown.

## License

[MIT](LICENSE) © SIMPLE MARK; originally created by Askar Kurymbayev
