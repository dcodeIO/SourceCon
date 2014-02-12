SourceCon - Simple SRCDS RCON for node.js
=========================================

Features
--------
* Executes arbitrary RCON commands
* Properly handles multi-part responses
* Emits push messages / server log, like sent by Rust
* Includes a command line RCON console

Usage
-----
`npm install sourcecon`

```js
var SourceCon = require("sourcecon");
var con = new SourceCon("127.0.0.1", 25080);
con.connect(function(err) {
    if (err) {
        throw(err);
    }
    con.auth("rconpass", function(err) {
        if (err) {
            throw(err);
        }
        con.send("status", function(err, res) {
            if (err) {
                throw(err);
            }
            console.log("STATUS: "+res);
        });
        ...
    });
});
```

Command line
------------
* `npm install -g sourcecon`
* Run `sourcecon` on the command line to start the RCON console

License: Apache License, Version 2.0
