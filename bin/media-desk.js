#!/usr/bin/env node
import { runCli } from '../src/automation/cli.js'
process.exitCode = await runCli()
