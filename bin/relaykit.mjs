#!/usr/bin/env node
// Entry point for `relaykit` (and its old name, `ai-kit`). All logic is in lib/cli.mjs.
import { main } from '../lib/cli.mjs';

process.exitCode = await main(process.argv.slice(2));
