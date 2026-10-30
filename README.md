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

The primary service is HomeKit's **Heater-Cooler** service. Its Active
characteristic controls power, while Auto/Heat/Cool select the TCL operating
mode. Heating and cooling threshold temperatures are intentionally kept at the
same value because the appliance has one setpoint. Fan speed is exposed as a
separate Fan service. TCL Dry and Fan-only modes are reported as unsupported
idle states rather than being presented as a different HomeKit mode.

## License

[MIT](LICENSE) © SIMPLE MARK; originally created by Askar Kurymbayev
