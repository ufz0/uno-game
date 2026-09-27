// Give every test process its own persistence file, so tables left behind by
// a real server run (or another test file) can't leak into the rooms map.
// Import this before importing ../server.js.
import os from 'node:os';
import path from 'node:path';

process.env.DATA_FILE = path.join(os.tmpdir(), `uno-test-${process.pid}.json`);
