# homebridge-tcl-split-ac

[![npm version](https://img.shields.io/npm/v/homebridge-tcl-split-ac.svg)](https://www.npmjs.com/package/homebridge-tcl-split-ac)
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

## License

[MIT](LICENSE) © Askar Kurymbayev
