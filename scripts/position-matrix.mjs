import { positionDataAvailabilityMatrix } from "../src/index.ts";

process.stdout.write(JSON.stringify(positionDataAvailabilityMatrix(), null, 2) + "\n");
