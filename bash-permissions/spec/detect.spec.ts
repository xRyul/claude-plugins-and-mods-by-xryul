// Plain `bun test` from the mod's folder runs this; bunfig.toml points bun here.
import { expect, test } from "bun:test";

import { defineDetectionSuite } from "../tests/suite";

defineDetectionSuite(test, expect);
