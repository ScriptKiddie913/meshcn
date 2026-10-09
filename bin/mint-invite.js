#!/usr/bin/env node
"use strict";

const { mintInvite } = require("../src/invites");

const code = mintInvite();
console.log(`Generated single-use invite code: ${code}`);
