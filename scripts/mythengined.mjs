#!/usr/bin/env node
import { main } from './mtheriosd.mjs';
await main(process.argv.slice(2));
