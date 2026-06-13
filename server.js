#!/usr/bin/env node

import { main } from './scripts/mtheriosd.mjs';

await main(process.argv.slice(2));
