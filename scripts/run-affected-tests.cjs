#!/usr/bin/env node
'use strict';

const { runAffectedTests } = require('./affected-tests-lib.cjs');
const { runMain } = require('./lib/cli-exit.cjs');

runMain(runAffectedTests);
